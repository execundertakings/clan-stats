#!/usr/bin/env node
'use strict';
// ── Clan Stats — local web server ───────────────────────────────────────
// No npm dependencies — uses only Node.js built-ins.
// Run: node server.js  →  open http://localhost:3002

const http = require('http');
const fs   = require('fs');
const path = require('path');

const { PORT, BASE, DATA, loadEnv, loadClanConfig, frontendClanConfig, resolveInside } = require('./lib/config');
const { MIME, jsonRes, errRes, htmlRes, buildSecurityHeaders }   = require('./lib/http');
const { handlePlayers }                    = require('./routes/players');
const { handleSeasons }                    = require('./routes/seasons');
const { handleMatches }                    = require('./routes/matches');
const { handleBotInteraction }             = require('./routes/bot');
const { startNotifier, notifierState, scan: notifierScan } = require('./lib/notifier');
const { startGateway, gatewayState }       = require('./lib/discord-gateway');
const { prewarm, prewarmStats, diskCacheHasRealStats } = require('./lib/prewarm');
const { clearCache, cacheSize } = require('./lib/pubg');
const { requireAdmin, verifyAdminRequest } = require('./lib/admin-auth');

function combineLifetimeStats(lifetime) {
  const modes = lifetime?.data?.attributes?.gameModeStats;
  if (!modes) return null;

  const fpp = modes['squad-fpp'] || {};
  const tpp = modes.squad || {};
  const fppRounds = fpp.roundsPlayed || 0;
  const tppRounds = tpp.roundsPlayed || 0;

  if (fppRounds === 0 && tppRounds === 0) return null;
  if (fppRounds === 0) return tpp;
  if (tppRounds === 0) return fpp;

  const combined = {};
  const keys = new Set([...Object.keys(fpp), ...Object.keys(tpp)]);
  for (const key of keys) {
    const fv = typeof fpp[key] === 'number' ? fpp[key] : 0;
    const tv = typeof tpp[key] === 'number' ? tpp[key] : 0;
    combined[key] = fv + tv;
  }
  return combined;
}

// ── Validate API key on startup ───────────────────────────────────────────────
const env = loadEnv();
if (!env.PUBG_API_KEY) {
  console.error('[3PI] ⚠️  No PUBG_API_KEY found in .env — API calls will fail.');
} else {
  console.log('[3PI] ✓  PUBG API key loaded.');
}

// ── Static file server ────────────────────────────────────────────────────────
function serveStatic(res, filePath) {
  const ext  = path.extname(filePath).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';
  try {
    const data = fs.readFileSync(filePath);
    res.writeHead(200, buildSecurityHeaders(mime, {
      'Content-Type': mime,
      'Content-Length': data.length,
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
    }, res.req));
    res.end(data);
  } catch {
    res.writeHead(404, buildSecurityHeaders('text/plain; charset=utf-8', {}, res.req));
    res.end('Not found');
  }
}

// Serve index.html with clan branding injected from config (single source).
// Replaces {{CLAN_*}} tokens and injects window.__CLAN_CONFIG__ for the bundle.
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, ch => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

function serializeScriptJson(value) {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, ch => ({
    '<': '\\u003c',
    '>': '\\u003e',
    '&': '\\u0026',
    '\u2028': '\\u2028',
    '\u2029': '\\u2029',
  }[ch]));
}

function serveIndex(res) {
  try {
    const c   = loadClanConfig();
    const fe  = frontendClanConfig();
    let html  = fs.readFileSync(path.join(BASE, 'index.html'), 'utf8');
    const repl = {
      '{{CLAN_TITLE}}':     escapeHtml(`${c.clan.shortName} Stats`),
      '{{CLAN_NAME}}':      escapeHtml(c.clan.name),
      '{{CLAN_BOOT_TITLE}}': escapeHtml(c.clan.bootTitle),
      '{{CLAN_BOOT_BODY}}':  escapeHtml(c.clan.bootBody),
    };
    for (const [k, v] of Object.entries(repl)) html = html.split(k).join(v);
    // Inject the non-secret config object so the bundle can read it synchronously.
    const inject = `<script>window.__CLAN_CONFIG__ = ${serializeScriptJson(fe)};</script>`;
    html = html.replace('</head>', `${inject}\n</head>`);

    const buf = Buffer.from(html, 'utf8');
    res.writeHead(200, buildSecurityHeaders('text/html; charset=utf-8', {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': buf.length,
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
    }, res.req));
    res.end(buf);
  } catch {
    res.writeHead(404, buildSecurityHeaders('text/plain; charset=utf-8', {}, res.req));
    res.end('Not found');
  }
}

function publicStaticPath(pathname) {
  const exact = new Set([
    '/icon-192.png',
    '/icon-512.png',
    '/sw.js',
    '/security.txt',
    '/.well-known/security.txt',
  ]);
  if (exact.has(pathname)) return resolveInside(BASE, pathname.replace(/^\//, ''));
  if (pathname.startsWith('/dist/') || pathname.startsWith('/images/')) {
    return resolveInside(BASE, pathname.replace(/^\//, ''));
  }
  return null;
}

function maybeRedirectToHttps(req, res) {
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  if (proto !== 'http') return false;
  const host = String(req.headers.host || '').trim();
  if (!host) return false;
  res.writeHead(308, { Location: `https://${host}${req.url || '/'}` });
  res.end('');
  return true;
}

// ── Request router ────────────────────────────────────────────────────────────
async function router(req, res) {
  const rawUrl = req.url || '/';
  const url    = new URL(rawUrl, `http://localhost:${PORT}`);
  const p      = url.pathname;

  if (maybeRedirectToHttps(req, res)) return;

  // CORS for local dev
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  // ── Discord bot interactions (/interactions — must come before body parsing) ─
  if (req.method === 'POST' && (p === '/interactions' || p === '/api/bot/interactions')) {
    try {
      await handleBotInteraction(req, res, url);
    } catch (e) {
      console.error('[3PI Bot] Unhandled error:', e.message);
      if (!res.writableEnded) { res.writeHead(500); res.end('Internal error'); }
    }
    return;
  }

  // ── API routes ──────────────────────────────────────────────────────────────
  if (p.startsWith('/api/')) {
    try {
      // Cache management
      if (req.method === 'POST' && p === '/api/cache/clear') {
        if (!requireAdmin(req, res)) return;
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

      // Server-side admin verification for the hidden Settings tools.
      if (req.method === 'POST' && p === '/api/admin/verify') {
        const { parseBody } = require('./lib/http');
        const body = await parseBody(req).catch(() => ({}));
        const result = verifyAdminRequest(req, body.password || '');
        if (!result.ok) return errRes(res, result.error, result.status);
        return jsonRes(res, { ok: true });
      }

      // Pre-warm status
      if (req.method === 'GET' && p === '/api/prewarm/status') {
        return jsonRes(res, { ...prewarm, elapsed: prewarm.startedAt ? Math.round((Date.now() - prewarm.startedAt) / 1000) : null });
      }
      // Trigger pre-warm manually
      if (req.method === 'POST' && p === '/api/prewarm') {
        if (!requireAdmin(req, res, { allowLocal: true })) return;
        prewarm.done = false;
        prewarmStats();
        return jsonRes(res, { ok: true, message: 'Pre-warm started' });
      }

      // (/api/trends removed 2026-06-10 — trends are computed client-side from
      // resolvedStats; the trends_cache.json it served was last written Apr 20.)

      // Analysis — AI per-player profiles from analysis_cache.json (written by
      // the daily Cowork task, Phase B5; consumed by app.js player cards)
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

      // Telemetry playbook — deterministic telemetry-derived coaching cards
      if (req.method === 'GET' && p === '/api/telemetry-insights') {
        const FILE = path.join(DATA, 'telemetry_insights_cache.json');
        if (!fs.existsSync(FILE)) return errRes(res, 'No telemetry insights cache — run build_telemetry_insights.js first', 404);
        return jsonRes(res, JSON.parse(fs.readFileSync(FILE, 'utf8')));
      }

      // Season archive index — list of all archived seasons
      if (req.method === 'GET' && p === '/api/archive/seasons') {
        const { buildSeasonIndex } = require('./scripts/archive_season');
        return jsonRes(res, buildSeasonIndex());
      }

      // Archived season stats — serve a specific season's stats like /api/stats would
      if (req.method === 'GET' && p.startsWith('/api/archive/seasons/')) {
        const seasonId = decodeURIComponent(p.replace('/api/archive/seasons/', ''));
        const { loadArchivedSeason } = require('./scripts/archive_season');
        const data = loadArchivedSeason(seasonId);
        if (!data) return errRes(res, `No archive for season: ${seasonId}`, 404);
        return jsonRes(res, data);
      }

      // Lifetime (career) stats — combined official squad-fpp + squad totals from stats_cache lifetime payloads
      if (req.method === 'GET' && p === '/api/lifetime') {
        const STATS_FILE = path.join(DATA, 'stats_cache.json');
        if (!fs.existsSync(STATS_FILE)) return errRes(res, 'No stats cache — run prewarm first', 404);
        const cache = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
        const out = {};
        for (const entry of cache.stats || []) {
          const accountId = entry.member?.accountId;
          const t = combineLifetimeStats(entry.lifetime);
          if (!accountId || !entry.member?.name) continue;
          if (!t || !t.roundsPlayed) continue;
          const rounds = t.roundsPlayed;
          out[accountId] = {
            name:      entry.member.name,
            games:     rounds,
            kills:     t.kills     || 0,
            wins:      t.wins      || 0,
            losses:    t.losses    ?? 0,
            kd:        t.losses > 0 ? +(t.kills / t.losses).toFixed(2) : +(t.kills || 0).toFixed(2),
            winRate:   +(t.wins / rounds).toFixed(4),
            hsRate:    t.kills > 0 ? +(t.headshotKills / t.kills).toFixed(4) : 0,
            avgDamage: +((t.damageDealt || 0) / rounds).toFixed(1),
            top10Rate: +((t.top10s || 0) / rounds).toFixed(4),
            assists:   t.assists   || 0,
            dBNOs:     t.dBNOs    || 0,
          };
        }
        return jsonRes(res, { players: out, builtAt: cache.savedAt || null, seasonId: cache.seasonId || null });
      }

      // AI-generated spotlight insights — written by scripts/generate_ai_insights.js
      // during the daily run. Cache only — never re-generates on request.
      if (req.method === 'GET' && p === '/api/ai-insights') {
        const AI_FILE = path.join(DATA, 'ai_insights_cache.json');
        if (!fs.existsSync(AI_FILE)) return errRes(res, 'No AI insights cache yet — runs nightly via daily_clan.js', 404);
        return jsonRes(res, JSON.parse(fs.readFileSync(AI_FILE, 'utf8')));
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

      // Clan branding/config — non-secret subset for the frontend
      if (req.method === 'GET' && p === '/api/config') {
        return jsonRes(res, frontendClanConfig());
      }

      // Discord Gateway status
      if (req.method === 'GET' && p === '/api/gateway/status') {
        return jsonRes(res, gatewayState());
      }

      // Notifier status + manual trigger
      if (req.method === 'GET' && (p === '/api/notifier/status' || p === '/api/notifier/state')) {
        if (!requireAdmin(req, res)) return;
        const env = loadEnv();
        return jsonRes(res, {
          ...notifierState,
          webhookConfigured: !!env.DISCORD_WEBHOOK_URL,
        });
      }
      if (req.method === 'POST' && p === '/api/notifier/scan') {
        if (!requireAdmin(req, res)) return;
        notifierScan().catch(e => console.error('[3PI] Manual notifier scan error:', e.message));
        return jsonRes(res, { ok: true, message: 'Scan triggered' });
      }

      // Delegate to route handlers
      await handleSeasons(req, res, url);
      if (!res.writableEnded) await handlePlayers(req, res, url);
      if (!res.writableEnded) await handleMatches(req, res, url);
      if (!res.writableEnded) errRes(res, 'Not found', 404);
    } catch (e) {
      console.error('[3PI] Unhandled error:', e.message);
      errRes(res, 'Internal server error', 500);
    }
    return;
  }

  // ── OBS Overlay ─────────────────────────────────────────────────────────────
  if (p === '/overlay' || p === '/overlay.html') {
    return serveStatic(res, path.join(BASE, 'overlay.html'));
  }

  // ── Dynamic PWA manifest (built from clan config) ───────────────────────────
  if (p === '/manifest.json') {
    const c = loadClanConfig();
    const manifest = {
      name:             c.clan.name,
      short_name:       c.clan.shortName,
      description:      `PUBG clan statistics for ${c.clan.name}`,
      start_url:        '/',
      display:          'standalone',
      background_color: '#070b12',
      theme_color:      '#070b12',
      orientation:      'any',
      icons: [
        { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
      ],
      categories:  ['games', 'sports'],
      screenshots: [],
    };
    return jsonRes(res, manifest);
  }

  // ── Static files ────────────────────────────────────────────────────────────
  // index.html is served with clan branding injected (title, boot screen,
  // window.__CLAN_CONFIG__) so the frontend reads from the single config source.
  if (p === '/' || p === '/index.html') {
    return serveIndex(res);
  }

  // Public static allow-list only. Do not expose source, config, docs, or .env.
  const safePath = publicStaticPath(p);
  if (safePath && fs.existsSync(safePath) && fs.statSync(safePath).isFile()) {
    return serveStatic(res, safePath);
  }

  res.writeHead(404); res.end('Not found');
}

// ── Global error guards — prevent unhandled rejections/exceptions from crashing ─
// Node v15+ treats unhandledRejection as fatal by default. Log and stay alive.
process.on('unhandledRejection', (reason, promise) => {
  console.error('[3PI] ⚠ Unhandled rejection (staying alive):', reason?.message || reason);
});
process.on('uncaughtException', (err) => {
  console.error('[3PI] ⚠ Uncaught exception (staying alive):', err.message);
});

// ── Start server ──────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  router(req, res).catch(e => {
    console.error('[3PI] Request error:', e.message);
    try { res.writeHead(500); res.end('Server error'); } catch {}
  });
});

// ── PID lockfile — prevent multiple instances from stacking up ────────────────
const PID_FILE = path.join(DATA, 'server.pid');

function writePid()  { try { fs.writeFileSync(PID_FILE, String(process.pid)); } catch {} }
function clearPid()  { try { if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE); } catch {} }

function isOtherInstanceRunning() {
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim());
    if (pid === process.pid) return false;
    process.kill(pid, 0); // signal 0 = check if alive, throws if not
    return true;
  } catch {
    return false; // PID file missing, stale, or unreadable
  }
}

if (isOtherInstanceRunning()) {
  console.error(`[3PI] Another instance is already running (PID in ${PID_FILE}) — exiting.`);
  process.exit(0);
}
writePid();
process.on('exit',    clearPid);
process.on('SIGINT',  () => { clearPid(); process.exit(0); });
process.on('SIGTERM', () => { clearPid(); process.exit(0); });

// Handle port-in-use gracefully — launchd may restart before the OS releases the port
// Limited to 3 retries to prevent infinite loops if the PID check races
let _portRetries = 0;
const MAX_PORT_RETRIES = 3;

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    _portRetries++;
    if (_portRetries > MAX_PORT_RETRIES) {
      console.error(`[3PI] Port ${PORT} still in use after ${MAX_PORT_RETRIES} retries — giving up.`);
      clearPid();
      process.exit(1);
    }
    console.error(`[3PI] Port ${PORT} in use — retry ${_portRetries}/${MAX_PORT_RETRIES} in 5s…`);
    setTimeout(() => {
      server.close();
      server.listen(PORT, '127.0.0.1');
    }, 5000);
  } else {
    console.error('[3PI] Server error:', err.message);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[3PI] 🎮 Clan Stats running → http://localhost:${PORT}`);

  const hasCache = diskCacheHasRealStats();
  // If disk cache is good, wait 3 minutes before prewarm (rate limit recovery window).
  // If no disk cache, wait 90 seconds (let any current rate-limit window roll over).
  const startupDelay = hasCache ? 3 * 60 * 1000 : 90 * 1000;
  console.log(`[3PI] ⏳ Prewarm scheduled in ${startupDelay/1000}s (${hasCache ? 'disk cache exists' : 'no disk cache'})`);
  // Wrap in .catch() so a prewarm failure never becomes an unhandled rejection
  setTimeout(() => prewarmStats().catch(e => console.error('[3PI] Prewarm failed:', e.message)), startupDelay);

  // Start Discord notifier (polls every 5 min for new achievements).
  // When new matches are detected, schedule a prewarm ~45 s later so stats
  // are current within ~5-10 min of a game ending rather than up to 2 hours.
  let _prewarmScheduled = false;
  startNotifier({
    onNewMatches: (count) => {
      if (_prewarmScheduled) {
        console.log(`[3PI] [notifier] ${count} new match(es) — prewarm already scheduled, skipping`);
        return;
      }
      _prewarmScheduled = true;
      console.log(`[3PI] [notifier] ${count} new match(es) detected — prewarm in 45 s`);
      setTimeout(() => {
        _prewarmScheduled = false;
        if (!prewarm.running) {
          console.log('[3PI] [notifier] Triggering prewarm after new match detection');
          prewarmStats()
            .then(() => {
              const { buildMatchHistory } = require('./scripts/build_match_history');
              buildMatchHistory({ verbose: false });
              console.log('[3PI] [notifier] Match history rebuilt after notifier-triggered prewarm');
            })
            .catch(e => console.error('[3PI] Notifier-triggered prewarm/history rebuild failed:', e.message));
        } else {
          console.log('[3PI] [notifier] Prewarm already running — skipping notifier-triggered prewarm');
        }
      }, 45_000);
    },
  });

  // Start Discord Gateway (WebSocket) for role-based auto-add/remove.
  // Clan wiring (guild + membership role) comes from config/clan.config.json;
  // secrets (bot token, webhook) stay in .env.
  const gwEnv = loadEnv();
  const clan  = loadClanConfig();
  startGateway({
    botToken:    gwEnv.DISCORD_BOT_TOKEN,
    guildId:     clan.discord.guildId,
    roleName:    clan.discord.membershipRole,
    webhookUrl:  gwEnv.DISCORD_WEBHOOK_URL,
    membersFile: path.join(DATA, 'members.json'),
  });
});
