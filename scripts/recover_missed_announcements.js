'use strict';
// ── scripts/recover_missed_announcements.js ───────────────────────────────────
// Self-healing safety net for the achievement notifier (lib/notifier.js).
//
// During an outage (drive unmounted, server crash-loop, or webhook missing) the
// live notifier advances its seen-list WITHOUT posting — via the flood guard
// (>15 unseen matches re-synced) or the no-webhook scan path. Those announce-able
// games are then permanently swallowed: they're older than the 2h age filter by
// the time posting resumes, so the live notifier will never announce them.
//
// This script runs once a day (wired into daily_clan.js after Check Milestones).
// It finds announce-able official squad / solo-duo games from the last few days
// that the notifier SEEN but never POSTED, and posts ONE consolidated catch-up
// digest for them — then marks them posted so it never double-announces.
//
// Idempotency / no-duplicate guarantees:
//   • A match counts as "announced" only if its id is in notified._posted, which
//     the live notifier now writes for every individual AND squad post.
//   • First run seeds the ledger: every candidate already settled is marked
//     posted and NOTHING is posted (avoids recapping already-announced history).
//   • After a recap, the recapped ids are added to _posted, so a second run is a
//     no-op.
//
// Safe to run repeatedly. Requires DISCORD_WEBHOOK_URL in .env to actually post;
// without it, it still seeds / records but logs a dry summary.

const fs   = require('fs');
const path = require('path');
const { DATA, loadEnv, loadClanConfig } = require('../lib/config');
const { postWebhook } = require('../lib/discord');
const { getMatchFilterDecision } = require('../lib/match-filters');

const ROOT          = path.join(__dirname, '..');
const MEMBERS_FILE  = path.join(DATA, 'members.json');
const NOTIFIED_FILE = path.join(DATA, 'notified.json');
const STATE_FILE    = path.join(DATA, 'recovery_state.json');
const MATCH_DIR     = path.join(DATA, 'match_cache');

// Window: recap games older than the live notifier's reach (so we never race it)
// but no older than LOOKBACK days (don't dredge up ancient history).
const LIVE_WINDOW_HOURS = 3;     // notifier age filter is 2h; add margin
const LOOKBACK_DAYS     = 4;
const POSTED_CAP        = 3000;  // keep notified._posted bounded

// Achievement thresholds — kept in sync with lib/notifier.js
const KMIN = 5, KNUKE = 10, LRT = 300, HSK = 4, HSR = 0.60, REV = 3, BIGKILL = 6;

const MAP_SHORT = {
  Baltic_Main: 'Erangel', Desert_Main: 'Miramar', Savage_Main: 'Sanhok',
  DihorOtok_Main: 'Vikendi', Summerland_Main: 'Karakin', Tiger_Main: 'Taego',
  Kiki_Main: 'Deston', Neon_Main: 'Rondo', Range_Main: 'Camp Jackal',
};
const shortMap = m => MAP_SHORT[m] || (m || '').replace('_Main', '') || 'Unknown';

function loadJson(file, def) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return def; }
}
function saveJson(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }

// Build the per-match clan achievement summary used by both seeding and recap.
function scanCandidates(idToName, ids, log) {
  const now   = Date.now();
  const start = now - LOOKBACK_DAYS * 24 * 3600 * 1000;
  const end   = now - LIVE_WINDOW_HOURS * 3600 * 1000;
  let files = [];
  try { files = fs.readdirSync(MATCH_DIR).filter(f => f.endsWith('.json')); }
  catch (e) { log(`⚠ cannot read match_cache: ${e.message}`); return []; }

  const out = [];
  for (const f of files) {
    let d;
    try { d = JSON.parse(fs.readFileSync(path.join(MATCH_DIR, f), 'utf8')); } catch { continue; }
    const at = d?.data?.attributes || {};
    if (!at.createdAt) continue;
    const c = new Date(at.createdAt).getTime();
    if (c < start || c > end) continue;

    const fd = getMatchFilterDecision(at);
    if (!(fd.counts || fd.reason === 'non-squad-mode')) continue;

    const map = shortMap(at.mapName);
    const dinner = [], nearmiss = [], bigkills = [], snipes = [], medics = [], surgical = [];
    for (const p of (d.included || [])) {
      if (p.type !== 'participant') continue;
      const s = p.attributes?.stats || {};
      if (!ids.has(s.playerId)) continue;
      const nm = idToName[s.playerId];
      const k = s.kills || 0, hk = s.headshotKills || 0, lk = s.longestKill || 0,
            rv = s.revives || 0, wp = s.winPlace || 99;
      if (wp === 1) dinner.push(nm);
      if (wp === 2) nearmiss.push(nm);
      if (k >= BIGKILL) bigkills.push({ nm, k, map });
      if (lk >= LRT) snipes.push({ nm, m: Math.round(lk), map });
      if (rv >= REV) medics.push({ nm, rv });
      if (k >= HSK && hk >= k * HSR) surgical.push({ nm, k, hk, map });
    }
    if (dinner.length || nearmiss.length || bigkills.length || snipes.length || medics.length || surgical.length) {
      out.push({ id: d.data.id, c, iso: at.createdAt, map, dinner, nearmiss, bigkills, snipes, medics, surgical });
    }
  }
  out.sort((a, b) => a.c - b.c);
  return out;
}

function field(name, value) {
  if (!value) return null;
  // Discord field value cap is 1024 chars
  return { name, value: value.length > 1024 ? value.slice(0, 1010) + ' …' : value };
}

function buildDigest(missed, tag, publicUrl) {
  const dinners = {}, nearmiss = {}, bigkills = [], snipes = [], medics = {}, surgical = [];
  for (const m of missed) {
    m.dinner.forEach(n => dinners[n] = (dinners[n] || 0) + 1);
    m.nearmiss.forEach(n => nearmiss[n] = (nearmiss[n] || 0) + 1);
    bigkills.push(...m.bigkills);
    snipes.push(...m.snipes);
    m.medics.forEach(x => medics[x.nm] = (medics[x.nm] || 0) + 1);
    surgical.push(...m.surgical);
  }
  const cnt = o => Object.entries(o).sort((a, b) => b[1] - a[1])
    .map(([n, c]) => c > 1 ? `${n} ×${c}` : n).join(' · ');
  bigkills.sort((a, b) => b.k - a.k);
  snipes.sort((a, b) => b.m - a.m);

  const dinnerMatches = missed.filter(m => m.dinner.length).length;
  const from = new Date(missed[0].c), to = new Date(missed[missed.length - 1].c);
  const dfmt = d => `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;

  const fields = [
    field(`🍗  Chicken Dinners  (${dinnerMatches} squad win${dinnerMatches === 1 ? '' : 's'})`, cnt(dinners)),
    field('🔥  Big Kill Games  (6+)',
      bigkills.slice(0, 12).map(b => `${b.nm} ${b.k} (${b.map})`).join(' · ')),
    field('🎯  Longest Snipes',
      snipes.slice(0, 10).map(s => `${s.nm} ${s.m}m (${s.map})`).join(' · ')),
    field('🏥  Clutch Medics  (3+ revives)', cnt(medics)),
    field('🔫  Surgical',
      surgical.map(s => `${s.nm} ${Math.round(s.hk / s.k * 100)}% HS (${s.k}k, ${s.map})`).join(' · ')),
    field('😤  So Close  (#2 finishes)', cnt(nearmiss)),
  ].filter(Boolean);

  return {
    title: '📡  Catch-Up — Recent Games',
    description: `Catching up on notable games from ${dfmt(from)}–${dfmt(to)}. Stats, leaderboards and records are already up to date.`,
    color: 0x58b9ff,
    fields,
    footer: { text: `${tag}${publicUrl ? ' • ' + publicUrl.replace(/^https?:\/\//, '') : ''}` },
  };
}

async function recoverMissedAnnouncements({ verbose = false, dry = false } = {}) {
  const log = (...a) => { if (verbose) console.log('[Recovery]', ...a); };

  const members = loadJson(MEMBERS_FILE, []);
  const mlist = Array.isArray(members) ? members : (members.members || Object.values(members));
  const idToName = {}; const ids = new Set();
  mlist.forEach(m => { if (m && m.accountId) { idToName[m.accountId] = m.name; ids.add(m.accountId); } });
  if (!ids.size) return { reason: 'no members' };

  const notified = loadJson(NOTIFIED_FILE, {});
  if (!Array.isArray(notified._posted)) notified._posted = [];
  const posted = new Set(notified._posted);

  const candidates = scanCandidates(idToName, ids, log);
  log(`${candidates.length} announce-able match(es) in window`);

  const state = loadJson(STATE_FILE, null);

  // ── First run: seed the ledger, post nothing ────────────────────────────────
  if (!state || !state.initialized) {
    for (const m of candidates) if (!posted.has(m.id)) { notified._posted.push(m.id); posted.add(m.id); }
    notified._posted = notified._posted.slice(-POSTED_CAP);
    saveJson(NOTIFIED_FILE, notified);
    saveJson(STATE_FILE, { initialized: true, seededAt: new Date().toISOString(), seededCount: candidates.length });
    log(`seeded ${candidates.length} settled match(es) — no recap on first run`);
    return { seeded: true, count: candidates.length };
  }

  // ── Normal run: recap anything seen-but-never-posted ────────────────────────
  const missed = candidates.filter(m => !posted.has(m.id));
  if (!missed.length) { log('nothing missed'); return { missed: 0 }; }

  const env = loadEnv();
  const webhook = env.DISCORD_TEST_WEBHOOK_URL || env.DISCORD_WEBHOOK_URL || null;
  let cfg = {}; try { cfg = loadClanConfig(); } catch { /* ignore */ }
  const tag = cfg?.clan?.tag ? `[${cfg.clan.tag}]` : '[3PI]';
  const publicUrl = cfg?.site?.publicUrl || '';

  const embed = buildDigest(missed, tag, publicUrl);

  if (dry || !webhook) {
    log(`${dry ? 'DRY' : 'NO WEBHOOK'} — would recap ${missed.length} missed match(es)`);
    log(JSON.stringify(embed.fields, null, 2));
    return { missed: missed.length, posted: false, dry: dry || !webhook };
  }

  await postWebhook(webhook, { embeds: [embed] });
  for (const m of missed) if (!posted.has(m.id)) notified._posted.push(m.id);
  notified._posted = notified._posted.slice(-POSTED_CAP);
  saveJson(NOTIFIED_FILE, notified);
  log(`recapped ${missed.length} missed match(es)`);
  return { missed: missed.length, posted: true };
}

module.exports = { recoverMissedAnnouncements };

// CLI: `node scripts/recover_missed_announcements.js [--dry]`
if (require.main === module) {
  const dry = process.argv.includes('--dry');
  recoverMissedAnnouncements({ verbose: true, dry })
    .then(r => { console.log('[Recovery] result:', JSON.stringify(r)); process.exit(0); })
    .catch(e => { console.error('[Recovery] error:', e.message); process.exit(1); });
}
