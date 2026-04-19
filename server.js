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
const { handleBotInteraction }             = require('./routes/bot');
const { startNotifier, notifierState, scan: notifierScan } = require('./lib/notifier');
const {
  clearCache, cacheSize,
  getCurrentSeason,
  batchGetSeasonStats,
  batchGetLifetimeStats,
  _batchSeasonStatsByMode,
  _batchLifetimeStatsByMode,
  getPlayer,
} = require('./lib/pubg');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const PREWARM_CALL_DELAY = 7000; // 7s between API calls → ~8.5 RPM for 26 members

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

const SEASON_CACHE_FILE = path.join(DATA, 'season.json');

function loadMembers() {
  const f = path.join(DATA, 'members.json');
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return []; }
}

// Persist season ID to disk so server restarts don't need an API call
function saveSeasonId(seasonId) {
  try { fs.writeFileSync(SEASON_CACHE_FILE, JSON.stringify({ seasonId, savedAt: Date.now() })); } catch {}
}
function loadSavedSeasonId() {
  try {
    const d = JSON.parse(fs.readFileSync(SEASON_CACHE_FILE, 'utf8'));
    // Treat saved season as valid for up to 14 days (seasons last ~6 weeks)
    if (d.seasonId && Date.now() - d.savedAt < 14 * 24 * 60 * 60 * 1000) return d.seasonId;
  } catch {}
  return null;
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

  // 2 batch operations: season stats + lifetime stats
  prewarm.total = 2;
  const accountIds = members.map(m => m.accountId);
  const batches    = Math.ceil(members.length / 10);

  const totalCalls = batches * 4 + 1; // 4 modes × batches + 1 season call
  prewarm.log.push(`Starting pre-warm for ${members.length} members (${totalCalls} API calls, ~${Math.ceil(totalCalls * PREWARM_CALL_DELAY / 60000)}min)…`);
  console.log(`[APES] 🔄 Pre-warming stats cache for ${members.length} members — ${totalCalls} calls, paced at 1 per ${PREWARM_CALL_DELAY/1000}s…`);

  // Try API first; fall back to disk-cached season ID on rate limit
  let seasonId;
  try {
    const s = await getCurrentSeason();
    seasonId = s?.id;
    if (seasonId) { saveSeasonId(seasonId); prewarm.log.push(`Season: ${seasonId} (live)`); }
  } catch (e) {
    const saved = loadSavedSeasonId();
    if (saved) {
      seasonId = saved;
      prewarm.log.push(`Season API rate-limited — using cached ID: ${seasonId}`);
      console.log(`[APES] ⚠ Season API rate-limited, using saved season: ${seasonId}`);
    } else {
      prewarm.log.push(`Season lookup failed: ${e.message}`);
      prewarm.running = false;
      prewarm.done    = true;
      return;
    }
  }

  // Sequential batch calls with delay between each — stays well under 10 RPM
  // Each _batchSeasonStatsByMode call is 1 API call per batch-of-10 players
  const modes = ['squad-fpp', 'squad'];
  let seasonOk = 0, lifetimeOk = 0;

  // Season stats — 2 modes × batches calls, one at a time
  prewarm.log.push(`Fetching season stats (${batches * 2} calls, paced)…`);
  for (const mode of modes) {
    for (let offset = 0; offset < accountIds.length; offset += 10) {
      const batch = accountIds.slice(offset, offset + 10);
      await sleep(PREWARM_CALL_DELAY);
      try {
        await _batchSeasonStatsByMode(batch, seasonId, mode);
        seasonOk++;
      } catch (e) {
        prewarm.errors++;
        console.warn(`[APES] Season ${mode} batch ${Math.floor(offset/10)+1} failed:`, e.message);
      }
    }
  }
  if (seasonOk > 0) {
    prewarm.completed++;
    prewarm.log.push(`✓ Season stats cached (${seasonOk}/${batches*2} batches ok)`);
    console.log(`[APES] ✓ Season stats cached (${prewarm.completed}/2)`);
  } else {
    prewarm.errors++;
    prewarm.log.push(`✗ Season stats — all batches failed`);
  }

  // Lifetime stats — 2 modes × batches calls, one at a time
  prewarm.log.push(`Fetching lifetime stats (${batches * 2} calls, paced)…`);
  for (const mode of modes) {
    for (let offset = 0; offset < accountIds.length; offset += 10) {
      const batch = accountIds.slice(offset, offset + 10);
      await sleep(PREWARM_CALL_DELAY);
      try {
        await _batchLifetimeStatsByMode(batch, mode);
        lifetimeOk++;
      } catch (e) {
        prewarm.errors++;
        console.warn(`[APES] Lifetime ${mode} batch ${Math.floor(offset/10)+1} failed:`, e.message);
      }
    }
  }
  if (lifetimeOk > 0) {
    prewarm.completed++;
    prewarm.log.push(`✓ Lifetime stats cached (${lifetimeOk}/${batches*2} batches ok)`);
    console.log(`[APES] ✓ Lifetime stats cached (${prewarm.completed}/2)`);
  } else {
    prewarm.errors++;
    prewarm.log.push(`✗ Lifetime stats — all batches failed`);
  }

  // Player object pre-warm — fetch each member's player object so the first
  // match-history click costs 0 API calls for the player lookup (disk-cached).
  // Paced at 7s per call, same as the other prewarm passes.
  prewarm.log.push(`Fetching player objects (${members.length} calls, paced)…`);
  prewarm.total += members.length;
  let playerOk = 0;
  for (const m of members) {
    await sleep(PREWARM_CALL_DELAY);
    try {
      await getPlayer(m.accountId); // writes to player_cache/ on disk automatically
      playerOk++;
    } catch (e) {
      prewarm.errors++;
      console.warn(`[APES] Player prewarm failed for ${m.name}:`, e.message);
    }
  }
  if (playerOk > 0) {
    prewarm.completed++;
    prewarm.log.push(`✓ Player objects cached (${playerOk}/${members.length} ok)`);
    console.log(`[APES] ✓ Player objects disk-cached (${playerOk}/${members.length})`);
  } else {
    prewarm.log.push(`✗ Player objects — all failed`);
  }

  prewarm.running = false;
  prewarm.done    = true;
  const elapsed = Math.round((Date.now() - prewarm.startedAt) / 1000);
  console.log(`[APES] ✅ Pre-warm done in ${elapsed}s — ${prewarm.completed}/3 passes cached, ${prewarm.errors} errors`);

  // Persist stats to disk — but only if we actually got real data (not all-null from rate limit)
  if (prewarm.completed > 0 && seasonId) {
    try {
      const { batchGetSeasonStats: bgs, batchGetLifetimeStats: bgl } = require('./lib/pubg');
      const accountIds = members.map(m => m.accountId);
      // These hit in-memory cache (populated above), so no extra API calls
      const seasonMap   = await bgs(accountIds, seasonId).catch(() => new Map());
      const lifetimeMap = await bgl(accountIds).catch(() => new Map());
      const stats = members.map(m => ({
        member:   m,
        seasonId,
        season:   seasonMap.get(m.accountId)   || null,
        lifetime: lifetimeMap.get(m.accountId) || null,
      }));
      // Validate: only write if at least one player has actual rounds played
      const hasRealStats = stats.some(s => {
        const gms = s.season?.data?.attributes?.gameModeStats;
        return (gms?.squad?.roundsPlayed > 0) || (gms?.['squad-fpp']?.roundsPlayed > 0);
      });
      if (hasRealStats) {
        const STATS_FILE = path.join(DATA, 'stats_cache.json');
        // Archive previous season before overwriting if seasonId changed
        try {
          const { archiveIfSeasonChanged } = require('./scripts/archive_season');
          const result = archiveIfSeasonChanged(seasonId);
          if (result.archived) {
            console.log(`[APES] 🔄 Season rollover: ${result.fromSeasonId} → ${result.toSeasonId}`);
          }
        } catch (e) {
          console.warn('[APES] Could not archive previous season:', e.message);
        }
        fs.writeFileSync(STATS_FILE, JSON.stringify({ stats, seasonId, savedAt: Date.now() }, null, 2));
        console.log(`[APES] 💾 Stats persisted to disk (${stats.length} members)`);
      } else {
        console.warn('[APES] Skipping disk write — all season stats are null (rate limit during prewarm)');
      }
    } catch (e) {
      console.warn('[APES] Could not persist stats to disk:', e.message);
    }
  }
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

  // ── Discord bot interactions (/interactions — must come before body parsing) ─
  if (req.method === 'POST' && p === '/interactions') {
    try {
      await handleBotInteraction(req, res, url);
    } catch (e) {
      console.error('[APES Bot] Unhandled error:', e.message);
      if (!res.writableEnded) { res.writeHead(500); res.end('Internal error'); }
    }
    return;
  }

  // ── API routes ──────────────────────────────────────────────────────────────
  if (p.startsWith('/api/')) {
    try {
      // Cache management
      if (req.method === 'POST' && p === '/api/cache/clear') {
        const { parseBody } = require('./lib/http');
        const body = await parseBody(req).catch(() => ({}));
        clearCache({ disk: !!body.disk, matches: !!body.matches });
        return jsonRes(res, { ok: true, message: 'Cache cleared', disk: !!body.disk, matches: !!body.matches });
      }
      if (req.method === 'GET' && p === '/api/cache/stats') {
        return jsonRes(res, cacheSize());
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

      // Trends — pre-computed correlations + history
      if (req.method === 'GET' && p === '/api/trends') {
        const TRENDS_FILE = path.join(DATA, 'trends_cache.json');
        const HIST_FILE   = path.join(DATA, 'trends_history.json');
        if (!fs.existsSync(TRENDS_FILE)) return errRes(res, 'No trends cache — run daily_clan.js first', 404);
        const trends  = JSON.parse(fs.readFileSync(TRENDS_FILE, 'utf8'));
        let history = [];
        if (fs.existsSync(HIST_FILE)) {
          try { history = JSON.parse(fs.readFileSync(HIST_FILE, 'utf8')); } catch {}
        }
        return jsonRes(res, { ...trends, history });
      }

      // Analysis — non-circular player analysis (close-out rate, HS%, assists, archetypes)
      if (req.method === 'GET' && p === '/api/analysis') {
        const ANALYSIS_FILE = path.join(DATA, 'analysis_cache.json');
        if (!fs.existsSync(ANALYSIS_FILE)) return errRes(res, 'No analysis cache — run daily_clan.js first', 404);
        return jsonRes(res, JSON.parse(fs.readFileSync(ANALYSIS_FILE, 'utf8')));
      }

      // Squad chemistry — duo/trio win rate combos
      if (req.method === 'GET' && p === '/api/squad-stats') {
        const SQUAD_FILE = path.join(DATA, 'squad_stats_cache.json');
        if (!fs.existsSync(SQUAD_FILE)) return errRes(res, 'No squad stats cache — run build_squad_stats.js first', 404);
        return jsonRes(res, JSON.parse(fs.readFileSync(SQUAD_FILE, 'utf8')));
      }

      // Match history — per-player recent form, map stats, last 10 matches
      if (req.method === 'GET' && p === '/api/match-history') {
        const HISTORY_FILE = path.join(DATA, 'match_history_cache.json');
        if (!fs.existsSync(HISTORY_FILE)) return errRes(res, 'No match history cache — run build_match_history.js first', 404);
        const cache = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
        const { buildHistorySummary } = require('./scripts/build_match_history');
        return jsonRes(res, buildHistorySummary(cache));
      }

      // Landing heatmap — per-player landing spots per map
      if (req.method === 'GET' && p === '/api/heatmap') {
        const LANDING_FILE = path.join(DATA, 'landing_cache.json');
        if (!fs.existsSync(LANDING_FILE)) return errRes(res, 'No landing cache — run build_landing_heatmap.js first', 404);
        const cache = JSON.parse(fs.readFileSync(LANDING_FILE, 'utf8'));
        return jsonRes(res, { landings: cache.landings || {}, processedMatches: cache.processedMatches?.length || 0 });
      }

      // Season archive index — list of all archived seasons
      if (req.method === 'GET' && p === '/api/seasons') {
        const { buildSeasonIndex } = require('./scripts/archive_season');
        return jsonRes(res, buildSeasonIndex());
      }

      // Archived season stats — serve a specific season's stats like /api/stats would
      if (req.method === 'GET' && p.startsWith('/api/seasons/')) {
        const seasonId = decodeURIComponent(p.replace('/api/seasons/', ''));
        const { loadArchivedSeason } = require('./scripts/archive_season');
        const data = loadArchivedSeason(seasonId);
        if (!data) return errRes(res, `No archive for season: ${seasonId}`, 404);
        return jsonRes(res, data);
      }

      // Lifetime stats — per-player career totals from stats_cache
      if (req.method === 'GET' && p === '/api/lifetime') {
        const STATS_FILE = path.join(DATA, 'stats_cache.json');
        if (!fs.existsSync(STATS_FILE)) return errRes(res, 'No stats cache — run prewarm first', 404);
        const { extractLifetimeStats } = require('./lib/discord-interactions');
        const cache = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
        const out = {};
        (cache.stats || []).forEach(p => {
          const lt = extractLifetimeStats(p.lifetime);
          if (!lt || !lt.roundsPlayed) return;
          const rounds = lt.roundsPlayed;
          out[p.member.accountId] = {
            name:      p.member.name,
            games:     rounds,
            kills:     lt.kills,
            wins:      lt.wins,
            losses:    lt.losses,
            kd:        lt.losses > 0 ? +(lt.kills / lt.losses).toFixed(2) : +lt.kills.toFixed(2),
            winRate:   +(lt.wins  / rounds).toFixed(4),
            hsRate:    lt.kills > 0 ? +(lt.headshotKills / lt.kills).toFixed(4) : 0,
            avgDamage: +(lt.damageDealt / rounds).toFixed(1),
            top10Rate: +(lt.top10s / rounds).toFixed(4),
            revives:   lt.revives,
            revivesPg: +(lt.revives / rounds).toFixed(3),
          };
        });
        return jsonRes(res, { players: out, seasonId: cache.seasonId, savedAt: cache.savedAt });
      }

      // Weapon stats — per-player weapon kill summary from telemetry
      if (req.method === 'GET' && p === '/api/weapons') {
        const WEAPON_FILE   = path.join(DATA, 'weapon_cache.json');
        const MEMBERS_FILE  = path.join(DATA, 'members.json');
        if (!fs.existsSync(WEAPON_FILE)) return errRes(res, 'No weapon cache — run daily_clan.js first', 404);
        const cache   = JSON.parse(fs.readFileSync(WEAPON_FILE, 'utf8'));
        const members = fs.existsSync(MEMBERS_FILE) ? JSON.parse(fs.readFileSync(MEMBERS_FILE, 'utf8')) : [];
        const { buildSummary } = require('./scripts/fetch_weapon_stats');
        return jsonRes(res, buildSummary(cache, members));
      }

      // Notifier status + manual trigger
      if (req.method === 'GET' && p === '/api/notifier/status') {
        const env = loadEnv();
        return jsonRes(res, {
          ...notifierState,
          webhookConfigured: !!env.DISCORD_WEBHOOK_URL,
        });
      }
      if (req.method === 'POST' && p === '/api/notifier/scan') {
        notifierScan().catch(e => console.error('[APES] Manual notifier scan error:', e.message));
        return jsonRes(res, { ok: true, message: 'Scan triggered' });
      }

      // Delegate to route handlers
      await handleSeasons(req, res, url);
      if (!res.writableEnded) await handlePlayers(req, res, url);
      if (!res.writableEnded) await handleMatches(req, res, url);
      if (!res.writableEnded) errRes(res, 'Not found', 404);
    } catch (e) {
      console.error('[APES] Unhandled error:', e.message);
      errRes(res, 'Internal server error', 500);
    }
    return;
  }

  // ── OBS Overlay ─────────────────────────────────────────────────────────────
  if (p === '/overlay' || p === '/overlay.html') {
    return serveStatic(res, path.join(BASE, 'overlay.html'));
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

// ── Global error guards — prevent unhandled rejections/exceptions from crashing ─
// Node v15+ treats unhandledRejection as fatal by default. Log and stay alive.
process.on('unhandledRejection', (reason, promise) => {
  console.error('[APES] ⚠ Unhandled rejection (staying alive):', reason?.message || reason);
});
process.on('uncaughtException', (err) => {
  console.error('[APES] ⚠ Uncaught exception (staying alive):', err.message);
});

// ── Start server ──────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  router(req, res).catch(e => {
    console.error('[APES] Request error:', e.message);
    try { res.writeHead(500); res.end('Server error'); } catch {}
  });
});

// Handle port-in-use gracefully — launchd may restart before the OS releases the port
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[APES] Port ${PORT} in use — retrying in 5s…`);
    setTimeout(() => {
      server.close();
      server.listen(PORT, '127.0.0.1');
    }, 5000);
  } else {
    console.error('[APES] Server error:', err.message);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[APES] 🎮 Clan Stats running → http://localhost:${PORT}`);

  function diskCacheHasRealStats() {
    try {
      const STATS_FILE = path.join(DATA, 'stats_cache.json');
      const cached = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
      return cached?.stats?.some(s => {
        const gms = s.season?.data?.attributes?.gameModeStats;
        return (gms?.squad?.roundsPlayed > 0) || (gms?.['squad-fpp']?.roundsPlayed > 0);
      });
    } catch { return false; }
  }

  // If disk cache is good, wait 3 minutes before prewarm (rate limit recovery window).
  // If no disk cache, wait 90 seconds (let any current rate-limit window roll over).
  const startupDelay = diskCacheHasRealStats() ? 3 * 60 * 1000 : 90 * 1000;
  console.log(`[APES] ⏳ Prewarm scheduled in ${startupDelay/1000}s (${diskCacheHasRealStats() ? 'disk cache exists' : 'no disk cache'})`);
  // Wrap in .catch() so a prewarm failure never becomes an unhandled rejection
  setTimeout(() => prewarmStats().catch(e => console.error('[APES] Prewarm failed:', e.message)), startupDelay);

  // Start Discord notifier (polls every 5 min for new achievements)
  startNotifier();
});
