#!/usr/bin/env node
'use strict';
// ── APES Clan Stats — local web server ───────────────────────────────────────
// No npm dependencies — uses only Node.js built-ins.
// Run: node server.js  →  open http://localhost:3002

const http = require('http');
const fs   = require('fs');
const path = require('path');

const { PORT, BASE, DATA, loadEnv }        = require('./lib/config');
const { MIME, jsonRes, errRes, htmlRes }   = require('./lib/http');
const { handlePlayers }                    = require('./routes/players');
const { handleSeasons }                    = require('./routes/seasons');
const { handleMatches }                    = require('./routes/matches');
const {
  clearCache, cacheSize,
  getCurrentSeason,
  getPlayerSeasonStats,
  getPlayerLifetime,
} = require('./lib/pubg');

// ── Pre-warm state ────────────────────────────────────────────────────────────
const prewarm = {
  running:   false,
  done:      false,
  total:     0,
  completed: 0,
  errors:    0,
  startedAt: null,
  log:       [],
};

function loadMembers() {
  const f = require('path').join(DATA, 'members.json');
  try { return JSON.parse(require('fs').readFileSync(f, 'utf8')); } catch { return []; }
}

async function prewarmStats() {
  if (prewarm.running) return;
  prewarm.running   = true;
  prewarm.done      = false;
  prewarm.completed = 0;
  prewarm.errors    = 0;
  prewarm.startedAt = Date.now();
  prewarm.log       = [];

  const members = loadMembers();
  if (!members.length) { prewarm.running = false; prewarm.done = true; return; }

  prewarm.total = members.length;
  prewarm.log.push(`Starting pre-warm for ${members.length} members…`);
  console.log(`[APES] 🔄 Pre-warming stats cache for ${members.length} members…`);

  let seasonId;
  try {
    const s = await getCurrentSeason();
    seasonId = s?.id;
    prewarm.log.push(`Season: ${seasonId}`);
  } catch (e) {
    prewarm.log.push(`Season lookup failed: ${e.message}`);
    prewarm.running = false;
    prewarm.done    = true;
    return;
  }

  for (const m of members) {
    try {
      await Promise.allSettled([
        getPlayerSeasonStats(m.accountId, seasonId),
        getPlayerLifetime(m.accountId),
      ]);
      prewarm.completed++;
      prewarm.log.push(`✓ ${m.name}`);
      console.log(`[APES] cached ${m.name} (${prewarm.completed}/${prewarm.total})`);
    } catch (e) {
      prewarm.errors++;
      prewarm.log.push(`✗ ${m.name}: ${e.message}`);
    }
  }

  prewarm.running = false;
  prewarm.done    = true;
  const elapsed = Math.round((Date.now() - prewarm.startedAt) / 1000);
  console.log(`[APES] ✅ Pre-warm done in ${elapsed}s — ${prewarm.completed} cached, ${prewarm.errors} errors`);
}

// ── Validate API key on startup ───────────────────────────────────────────────
const env = loadEnv();
if (!env.PUBG_API_KEY) {
  console.error('[APES] ⚠️  No PUBG_API_KEY found in .env — API calls will fail.');
} else {
  console.log('[APES] ✓  PUBG API key loaded.');
}

// ── Static file server ────────────────────────────────────────────────────────
function serveStatic(res, filePath) {
  const ext  = path.extname(filePath).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';
  try {
    const data = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': mime, 'Content-Length': data.length });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

// ── Request router ────────────────────────────────────────────────────────────
async function router(req, res) {
  const rawUrl = req.url || '/';
  const url    = new URL(rawUrl, `http://localhost:${PORT}`);
  const p      = url.pathname;

  // CORS for local dev
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  // ── API routes ──────────────────────────────────────────────────────────────
  if (p.startsWith('/api/')) {
    try {
      // Cache management
      if (req.method === 'POST' && p === '/api/cache/clear') {
        clearCache();
        return jsonRes(res, { ok: true, message: 'Cache cleared' });
      }
      if (req.method === 'GET' && p === '/api/cache/stats') {
        return jsonRes(res, { entries: cacheSize() });
      }

      // Health check
      if (req.method === 'GET' && p === '/api/health') {
        const env = loadEnv();
        return jsonRes(res, {
          ok:        true,
          port:      PORT,
          hasApiKey: !!env.PUBG_API_KEY,
          cache:     cacheSize(),
          uptime:    Math.floor(process.uptime()),
        });
      }

      // Pre-warm status
      if (req.method === 'GET' && p === '/api/prewarm/status') {
        return jsonRes(res, { ...prewarm, elapsed: prewarm.startedAt ? Math.round((Date.now() - prewarm.startedAt) / 1000) : null });
      }
      // Trigger pre-warm manually
      if (req.method === 'POST' && p === '/api/prewarm') {
        prewarm.done = false;
        prewarmStats();
        return jsonRes(res, { ok: true, message: 'Pre-warm started' });
      }

      // Delegate to route handlers
      let handled = await handleSeasons(req, res, url);
      if (!handled) handled = await handlePlayers(req, res, url);
      if (!handled) handled = await handleMatches(req, res, url);
      if (!handled) errRes(res, 'Not found', 404);
    } catch (e) {
      console.error('[APES] Unhandled error:', e.message);
      errRes(res, 'Internal server error', 500);
    }
    return;
  }

  // ── Static files ────────────────────────────────────────────────────────────
  if (p === '/' || p === '/index.html') {
    return serveStatic(res, path.join(BASE, 'index.html'));
  }

  // Anything else in project root (icons, manifest, etc.)
  const safePath = path.join(BASE, p.replace(/^\//, ''));
  if (fs.existsSync(safePath) && fs.statSync(safePath).isFile()) {
    return serveStatic(res, safePath);
  }

  res.writeHead(404); res.end('Not found');
}

// ── Start server ──────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  router(req, res).catch(e => {
    console.error('[APES] Fatal:', e);
    try { res.writeHead(500); res.end('Server error'); } catch {}
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[APES] 🎮 Clan Stats running → http://localhost:${PORT}`);
  // Kick off background stats cache warming after a short delay
  setTimeout(() => prewarmStats(), 2000);
});
