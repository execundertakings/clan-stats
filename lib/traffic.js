// ── Lightweight self-hosted traffic counter ──────────────────────────────────
// Records one event per SPA page load (GET / or /index.html). No third-party
// analytics, no cookies, no raw IPs on disk — visitors are counted by a salted
// SHA-256 hash of (ip + user-agent), truncated to 16 hex chars.
//
// Storage: data/traffic_log.json
//   { "days": { "2026-06-11": { "views": 12, "tunnel": 9, "lan": 3,
//                               "visitors": { "<hash>": true, ... } } } }
//
// Read via GET /api/traffic (aggregated counts only — hashes never leave disk).

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { DATA } = require('./config');

const FILE        = path.join(DATA, 'traffic_log.json');
const KEEP_DAYS   = 120;   // trim history beyond this
const WRITE_DELAY = 5000;  // debounce disk writes

// Stable per-install salt so hashes aren't rainbow-tableable but stay
// consistent across restarts (needed for daily unique counts).
const SALT_FILE = path.join(DATA, '.traffic_salt');
let SALT;
try { SALT = fs.readFileSync(SALT_FILE, 'utf8').trim(); } catch { SALT = ''; }
if (!SALT) {
  SALT = crypto.randomBytes(16).toString('hex');
  try { fs.writeFileSync(SALT_FILE, SALT); } catch { /* non-fatal */ }
}

const BOT_RE = /bot|crawl|spider|slurp|preview|fetch|monitor|uptime|headless|curl|wget|python-requests/i;

let state = null;
let writeTimer = null;

function load() {
  if (state) return state;
  try { state = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { state = null; }
  if (!state || typeof state !== 'object' || !state.days) state = { days: {} };
  return state;
}

function scheduleWrite() {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    try {
      const tmp = FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(state));
      fs.renameSync(tmp, FILE);
    } catch (e) {
      console.error('[3PI] [traffic] write failed:', e.message);
    }
  }, WRITE_DELAY);
}

function localDateKey() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function trim(days) {
  const keys = Object.keys(days).sort();
  while (keys.length > KEEP_DAYS) delete days[keys.shift()];
}

function clientInfo(req) {
  const cf  = String(req.headers['cf-connecting-ip'] || '').trim();
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const ip  = cf || xff || req.socket?.remoteAddress || 'unknown';
  // Cloudflare tunnel traffic always carries cf-connecting-ip; anything else
  // hitting the port directly is LAN/localhost.
  const viaTunnel = !!cf;
  return { ip, viaTunnel };
}

// Record one page view. Never throws — analytics must not break page serving.
function recordView(req) {
  try {
    const ua = String(req.headers['user-agent'] || '');
    if (!ua || BOT_RE.test(ua)) return;

    const { ip, viaTunnel } = clientInfo(req);
    const hash = crypto.createHash('sha256').update(SALT + ip + ua).digest('hex').slice(0, 16);

    const s   = load();
    const key = localDateKey();
    const day = s.days[key] || (s.days[key] = { views: 0, tunnel: 0, lan: 0, visitors: {} });
    day.views += 1;
    if (viaTunnel) day.tunnel += 1; else day.lan += 1;
    day.visitors[hash] = true;
    trim(s.days);
    scheduleWrite();
  } catch (e) {
    console.error('[3PI] [traffic] record failed:', e.message);
  }
}

// Aggregated summary for /api/traffic — counts only, no hashes.
function trafficSummary(lastNDays = 30) {
  const s    = load();
  const keys = Object.keys(s.days).sort().slice(-lastNDays);
  const days = keys.map(k => {
    const d = s.days[k];
    return { date: k, views: d.views, uniques: Object.keys(d.visitors || {}).length, tunnel: d.tunnel, lan: d.lan };
  });
  const totals = days.reduce((a, d) => ({
    views: a.views + d.views, tunnel: a.tunnel + d.tunnel, lan: a.lan + d.lan,
  }), { views: 0, tunnel: 0, lan: 0 });
  return { days, totals, trackedSince: Object.keys(s.days).sort()[0] || null };
}

module.exports = { recordView, trafficSummary };
