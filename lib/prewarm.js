'use strict';
// ── lib/prewarm.js — paced PUBG stats refresh, shared between server + routes ─
// Exposes a singleton `prewarm` state object and an idempotent `prewarmStats()`.
// Both server.js (startup timer + manual /api/prewarm trigger) and routes/players.js
// (background refresh on stale cache) call into the same module so we never have
// two prewarms racing through the rate limiter.

const fs   = require('fs');
const path = require('path');
const { DATA } = require('./config');
const { loadSeasonState, saveSeasonState, loadSavedSeasonId, resolveSeasonBoundary } = require('./season-state');
const {
  getCurrentSeason,
  _batchSeasonStatsByMode,
  _batchLifetimeStatsByMode,
  getPlayer,
  batchGetSeasonStats,
  batchGetLifetimeStats,
} = require('./pubg');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const PREWARM_CALL_DELAY = 7000; // 7s between API calls → ~8.5 RPM for 26 members

// ── Season-rollover helpers ───────────────────────────────────────────────────
// PUBG PC seasons start at the end of patch-day maintenance, historically
// Wednesday 08:30 UTC (see lib/season-boundaries.js, Season 41). When we detect
// a rollover before an explicit boundary entry exists, anchor the provisional
// start to the most recent Wednesday 08:30 UTC instead of "now" — detection can
// lag the actual rollover by hours (next prewarm) and "now" would silently drop
// every match played that morning from the new season's counts.
function provisionalSeasonStart(now = new Date()) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 8, 30, 0));
  // Walk back to Wednesday (UTC day 3)
  while (d.getUTCDay() !== 3) d.setUTCDate(d.getUTCDate() - 1);
  // If today IS Wednesday but it's before 08:30 UTC, the boundary is last Wednesday
  if (d.getTime() > now.getTime()) d.setUTCDate(d.getUTCDate() - 7);
  return d.toISOString();
}

// DM a rollover alert to the admin(s) — operator info, never posted to the
// public clan channel (best-effort, never throws).
async function alertSeasonRollover(fromSeasonId, toSeasonId, provisionalStartAt) {
  try {
    const { sendAdminDms } = require('./discord');
    await sendAdminDms({
      embeds: [{
        title: '🔄 Season rollover detected',
        description:
          `PUBG API now reports **${toSeasonId}** as current (was ${fromSeasonId}).\n\n` +
          `Old season archived to \`data/seasons/\`. Season-scoped caches will reset on the next builds.\n\n` +
          `⚠️ Provisional season start: \`${provisionalStartAt}\` (most recent Wednesday 08:30 UTC). ` +
          `Verify against the patch notes and add a verified entry to \`lib/season-boundaries.js\`.`,
        color: 0xfacc15,
      }],
    });
  } catch (e) {
    console.warn('[3PI] Could not post season-rollover alert:', e.message);
  }
}

const SEASON_CACHE_FILE = path.join(DATA, 'season.json');
const STATS_FILE        = path.join(DATA, 'stats_cache.json');
const MEMBERS_FILE      = path.join(DATA, 'members.json');

// ── Singleton state ───────────────────────────────────────────────────────────
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
  try { return JSON.parse(fs.readFileSync(MEMBERS_FILE, 'utf8')); } catch { return []; }
}

function diskCacheHasRealStats() {
  try {
    const cached = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
    return cached?.stats?.some(s => {
      const gms = s.season?.data?.attributes?.gameModeStats;
      return (gms?.squad?.roundsPlayed > 0) || (gms?.['squad-fpp']?.roundsPlayed > 0);
    });
  } catch { return false; }
}

async function prewarmStats() {
  if (prewarm.running) return;
  prewarm.running   = true;
  prewarm.done      = false;
  prewarm.completed = 0;
  prewarm.errors    = 0;
  prewarm.startedAt = Date.now();
  prewarm.log       = [];

  const allMembers = loadMembers();
  // Skip members in grace-period departure — no point fetching stats for them
  const members = allMembers.filter(m => !m.removedAt);
  if (!members.length) { prewarm.running = false; prewarm.done = true; return; }

  prewarm.total = 2;
  const accountIds = members.map(m => m.accountId);
  const batches    = Math.ceil(members.length / 10);

  const totalCalls = batches * 4 + 1;
  prewarm.log.push(`Starting pre-warm for ${members.length} members (${totalCalls} API calls, ~${Math.ceil(totalCalls * PREWARM_CALL_DELAY / 60000)}min)…`);
  console.log(`[3PI] 🔄 Pre-warming stats cache for ${members.length} members — ${totalCalls} calls, paced at 1 per ${PREWARM_CALL_DELAY/1000}s…`);

  let seasonId;
  try {
    const s = await getCurrentSeason();
    seasonId = s?.id;
    if (seasonId) {
      const boundary = resolveSeasonBoundary(seasonId, null);
      saveSeasonState({
        seasonId,
        savedAt: Date.now(),
        seasonStartAt: boundary.seasonStartAt,
        seasonStartSource: boundary.seasonStartSource,
      });
      prewarm.log.push(`Season: ${seasonId} (live)`);
    }
  } catch (e) {
    const saved = loadSavedSeasonId();
    if (saved) {
      seasonId = saved;
      prewarm.log.push(`Season API rate-limited — using cached ID: ${seasonId}`);
      console.log(`[3PI] ⚠ Season API rate-limited, using saved season: ${seasonId}`);
    } else {
      prewarm.log.push(`Season lookup failed: ${e.message}`);
      prewarm.running = false;
      prewarm.done    = true;
      return;
    }
  }

  const modes = ['squad-fpp', 'squad'];
  let seasonOk = 0, lifetimeOk = 0;

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
        console.warn(`[3PI] Season ${mode} batch ${Math.floor(offset/10)+1} failed:`, e.message);
      }
    }
  }
  if (seasonOk > 0) {
    prewarm.completed++;
    prewarm.log.push(`✓ Season stats cached (${seasonOk}/${batches*2} batches ok)`);
    console.log(`[3PI] ✓ Season stats cached (${prewarm.completed}/2)`);
  } else {
    prewarm.errors++;
    prewarm.log.push(`✗ Season stats — all batches failed`);
  }

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
        console.warn(`[3PI] Lifetime ${mode} batch ${Math.floor(offset/10)+1} failed:`, e.message);
      }
    }
  }
  if (lifetimeOk > 0) {
    prewarm.completed++;
    prewarm.log.push(`✓ Lifetime stats cached (${lifetimeOk}/${batches*2} batches ok)`);
    console.log(`[3PI] ✓ Lifetime stats cached (${prewarm.completed}/2)`);
  } else {
    prewarm.errors++;
    prewarm.log.push(`✗ Lifetime stats — all batches failed`);
  }

  prewarm.log.push(`Fetching player objects (${members.length} calls, paced)…`);
  prewarm.total += members.length;
  let playerOk = 0;
  for (const m of members) {
    await sleep(PREWARM_CALL_DELAY);
    try {
      await getPlayer(m.accountId);
      playerOk++;
    } catch (e) {
      prewarm.errors++;
      console.warn(`[3PI] Player prewarm failed for ${m.name}:`, e.message);
    }
  }
  if (playerOk > 0) {
    prewarm.completed++;
    prewarm.log.push(`✓ Player objects cached (${playerOk}/${members.length} ok)`);
    console.log(`[3PI] ✓ Player objects disk-cached (${playerOk}/${members.length})`);
  } else {
    prewarm.log.push(`✗ Player objects — all failed`);
  }

  const elapsed = Math.round((Date.now() - prewarm.startedAt) / 1000);
  console.log(`[3PI] ✅ Pre-warm done in ${elapsed}s — ${prewarm.completed}/3 passes cached, ${prewarm.errors} errors`);

  // ── Persist to disk BEFORE signalling completion ─────────────────────────────
  // Critical: set running=false only AFTER the disk write. The frontend poll
  // triggers loadData() the moment running becomes false, which reads stats_cache.json.
  // If we set running=false first, the poll fires while the await below is still
  // pending (Node event loop can service HTTP requests during an await), causing
  // loadData() to read the old disk cache. Writing first guarantees freshness.
  if (prewarm.completed > 0 && seasonId) {
    try {
      const seasonMap   = await batchGetSeasonStats(accountIds, seasonId).catch(() => new Map());
      const lifetimeMap = await batchGetLifetimeStats(accountIds).catch(() => new Map());
      const stats = members.map(m => ({
        member:   m,
        seasonId,
        season:   seasonMap.get(m.accountId)   || null,
        lifetime: lifetimeMap.get(m.accountId) || null,
      }));
      const hasRealStats = stats.some(s => {
        const gms = s.season?.data?.attributes?.gameModeStats;
        return (gms?.squad?.roundsPlayed > 0) || (gms?.['squad-fpp']?.roundsPlayed > 0);
      });
      if (hasRealStats) {
        const seasonState = loadSeasonState();
        const rolled = !!(seasonState.cacheSeasonId && seasonState.cacheSeasonId !== seasonId);
        try {
          const { archiveIfSeasonChanged } = require('../scripts/archive_season');
          const result = archiveIfSeasonChanged(seasonId);
          if (result.archived) {
            console.log(`[3PI] 🔄 Season rollover: ${result.fromSeasonId} → ${result.toSeasonId}`);
          }
        } catch (e) {
          console.warn('[3PI] Could not archive previous season:', e.message);
        }
        // Atomic write: write to tmp then rename so readers never see a partial file
        const TMP_FILE = STATS_FILE + '.tmp';
        fs.writeFileSync(TMP_FILE, JSON.stringify({ stats, seasonId, savedAt: Date.now() }, null, 2));
        fs.renameSync(TMP_FILE, STATS_FILE);
        const boundary = resolveSeasonBoundary(
          seasonId,
          rolled ? provisionalSeasonStart() : (seasonState.seasonStartAt || null)
        );
        saveSeasonState({
          seasonId,
          savedAt: Date.now(),
          cacheSeasonId: seasonId,
          seasonStartAt: boundary.seasonStartAt,
          seasonStartSource: boundary.seasonStartSource === 'match-cache-earliest' && rolled
            ? 'rollover-provisional-wed-0830utc'
            : boundary.seasonStartSource,
        });
        if (rolled) {
          console.log(`[3PI] 🔄 Season state updated: ${seasonState.cacheSeasonId} → ${seasonId} (start ${boundary.seasonStartAt})`);
          alertSeasonRollover(seasonState.cacheSeasonId, seasonId, boundary.seasonStartAt);
        }
        console.log(`[3PI] 💾 Stats persisted to disk (${stats.length} members) — signalling completion`);
      } else {
        console.warn('[3PI] Skipping disk write — all season stats are null (rate limit during prewarm); disk cache unchanged');
      }
    } catch (e) {
      console.warn('[3PI] Could not persist stats to disk:', e.message);
    }
  }

  // Signal done only after disk write is complete so the frontend poll's loadData()
  // call always reads a fresh stats_cache.json.
  prewarm.running = false;
  prewarm.done    = true;
}

module.exports = { prewarm, prewarmStats, diskCacheHasRealStats };
