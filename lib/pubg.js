'use strict';
// ── lib/pubg.js — PUBG API wrapper with in-memory + disk caching ─────────────
// All PUBG API calls go through here. Handles auth headers, rate-limit-safe
// caching, and normalised error responses.
//
// Free tier: 10 requests/minute. Cache TTL defaults keep us well under that.
// Shard: 'steam' (PC). Change SHARD if needed (xbox, psn, etc.)
//
// Disk cache strategy (bypasses rate limiter entirely):
//   matches/  — immutable; cached forever, never re-fetched
//   players/  — TTL 15m; avoids re-fetching match-ID lists on every request

const https = require('https');
const fs    = require('fs');
const path  = require('path');
const { loadEnv, DATA } = require('./config');
const { SharedSlidingWindowLimiter, parseRetryAfterMs } = require('./pubg-rate-limiter');

// ── Disk cache dirs ───────────────────────────────────────────────────────────
const MATCH_DISK_DIR  = path.join(DATA, 'match_cache');
const PLAYER_DISK_DIR = path.join(DATA, 'player_cache');
const PLAYER_DISK_TTL = 15 * 60 * 1000; // 15 minutes — balances freshness vs API calls

try { fs.mkdirSync(MATCH_DISK_DIR,  { recursive: true }); } catch {}
try { fs.mkdirSync(PLAYER_DISK_DIR, { recursive: true }); } catch {}

// ── Match disk cache (immutable — TTL = forever) ──────────────────────────────
function _matchFromDisk(matchId) {
  try {
    const raw = fs.readFileSync(path.join(MATCH_DISK_DIR, `${matchId}.json`), 'utf8');
    return JSON.parse(raw);
  } catch { return null; }
}
function _matchToDisk(matchId, data) {
  try {
    fs.writeFileSync(path.join(MATCH_DISK_DIR, `${matchId}.json`), JSON.stringify(data));
  } catch {}
}

// ── Player disk cache (TTL 15m — contains recent match-ID list) ──────────────
function _playerFromDisk(accountId) {
  try {
    const { data, savedAt } = JSON.parse(
      fs.readFileSync(path.join(PLAYER_DISK_DIR, `${accountId}.json`), 'utf8')
    );
    if (Date.now() - savedAt < PLAYER_DISK_TTL) return data;
  } catch {}
  return null;
}
function _playerToDisk(accountId, data) {
  try {
    fs.writeFileSync(
      path.join(PLAYER_DISK_DIR, `${accountId}.json`),
      JSON.stringify({ data, savedAt: Date.now() })
    );
  } catch {}
}

const SHARD    = 'steam';
const API_HOST = 'api.pubg.com';
const ACCEPT   = 'application/vnd.api+json';

// ── Rate limiter — shared 9 RPM ceiling ───────────────────────────────────────
// The free tier allows 10 RPM. Keep one request of headroom and coordinate via
// a tiny state file because the server/notifier and pipeline are separate Node
// processes. A per-process queue alone caused overlapping bursts and 429s.
const MAX_429_RETRIES  = 3;
const RETRY_BACKOFF_MS = [5000, 15000, 30000];
const _pubgRateLimiter = new SharedSlidingWindowLimiter({ dataDir: DATA, limit: 9 });
let   _rateLimitQ = Promise.resolve();

function _throttledGet(apiPath) {
  // Capture the tail of the current queue, then extend it.
  // Each caller gets back THEIR OWN promise (resolved by their fetch),
  // not the shared tail reference (which would shift under concurrent use).
  const myPromise = _rateLimitQ.then(() => _doRateLimitedGet(apiPath));
  // Swallow rejections on the shared tail so one failure doesn't stall the queue.
  _rateLimitQ = myPromise.catch(() => {});
  return myPromise;
}

async function _doRateLimitedGet(apiPath) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_429_RETRIES; attempt++) {
    await _pubgRateLimiter.takeSlot({
      onWait: (wait, count, limit) => {
        console.log(`[PUBG] Shared rate limit: queuing ${wait}ms (${count}/${limit} calls in window)`);
      },
    });
    try {
      return await pubgGet(apiPath);
    } catch (e) {
      lastErr = e;
      if (e.status !== 429 || attempt === MAX_429_RETRIES) break;
      const wait = e.retryAfterMs || RETRY_BACKOFF_MS[attempt] || 30000;
      console.log(`[PUBG] 429 — retry ${attempt + 1}/${MAX_429_RETRIES} in ${wait}ms`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

// ── In-memory cache ───────────────────────────────────────────────────────────
const _cache = new Map();

function _cacheKey(path) { return path; }

function _fromCache(key, ttlMs) {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > ttlMs) { _cache.delete(key); return null; }
  return entry.data;
}

function _toCache(key, data) {
  _cache.set(key, { data, at: Date.now() });
}

// ── Core HTTPS GET ────────────────────────────────────────────────────────────
function pubgGet(apiPath) {
  const env = loadEnv();
  const apiKey = env.PUBG_API_KEY;
  if (!apiKey) return Promise.reject(new Error('PUBG_API_KEY not set in .env'));

  return new Promise((resolve, reject) => {
    const options = {
      hostname: API_HOST,
      path: apiPath,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Accept': ACCEPT,
      },
    };

    const req = https.request(options, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode === 429) {
          const err = new Error('PUBG API rate limit hit — try again in a moment');
          err.status = 429;
          err.retryAfterMs = parseRetryAfterMs(res.headers['retry-after']);
          return reject(err);
        }
        if (res.statusCode === 401) {
          return reject(new Error('PUBG API key invalid or expired'));
        }
        if (res.statusCode === 404) {
          return reject(new Error('Not found (404)'));
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`PUBG API error ${res.statusCode}: ${body.slice(0, 200)}`));
        }
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error('Invalid JSON from PUBG API')); }
      });
    });

    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('PUBG API timeout')); });
    req.end();
  });
}

// ── Cached GET ────────────────────────────────────────────────────────────────
// Cache hits bypass the rate limiter entirely — no API call made.
async function cachedGet(apiPath, ttlMs = 5 * 60 * 1000) {
  const key = _cacheKey(apiPath);
  const hit = _fromCache(key, ttlMs);
  if (hit) return hit;
  const data = await _throttledGet(apiPath);
  _toCache(key, data);
  return data;
}

// ── Season list ───────────────────────────────────────────────────────────────
// Cache seasons for 1 hour — they change rarely.
async function getSeasons() {
  return cachedGet(`/shards/${SHARD}/seasons`, 60 * 60 * 1000);
}

async function getCurrentSeason() {
  const data = await getSeasons();
  return data.data.find(s => s.attributes.isCurrentSeason);
}

// ── Player lookup by name ─────────────────────────────────────────────────────
// Returns array of player objects. Names is a comma-separated string or array.
// Cache 10 minutes.
async function getPlayersByName(names) {
  const nameList = Array.isArray(names) ? names.join(',') : names;
  const path = `/shards/${SHARD}/players?filter[playerNames]=${encodeURIComponent(nameList)}`;
  return cachedGet(path, 10 * 60 * 1000);
}

// ── Player by account ID ──────────────────────────────────────────────────────
// Disk cache (15min TTL) → in-memory cache (10min) → API
async function getPlayer(accountId) {
  const apiPath = `/shards/${SHARD}/players/${accountId}`;
  const disk = _playerFromDisk(accountId);
  if (disk) {
    _toCache(apiPath, disk); // warm in-memory cache too
    return disk;
  }
  const data = await cachedGet(apiPath, 10 * 60 * 1000);
  _playerToDisk(accountId, data);
  return data;
}

// Force-fresh player fetch — bypasses disk and in-memory cache.
// Used by the ↻ refresh button so new matches appear immediately.
async function getPlayerFresh(accountId) {
  const apiPath = `/shards/${SHARD}/players/${accountId}`;
  _cache.delete(apiPath); // evict in-memory entry
  const data = await _throttledGet(apiPath);
  _toCache(apiPath, data);
  _playerToDisk(accountId, data); // update disk cache
  return data;
}

// ── Season stats for a player ─────────────────────────────────────────────────
// Cache 5 minutes. bust=true bypasses in-memory cache (forces live API fetch).
async function getPlayerSeasonStats(accountId, seasonId, bust = false) {
  const apiPath = `/shards/${SHARD}/players/${accountId}/seasons/${seasonId}`;
  if (bust) {
    _cache.delete(_cacheKey(apiPath)); // evict stale entry
    const data = await _throttledGet(apiPath);
    _toCache(apiPath, data);
    return data;
  }
  return cachedGet(apiPath, 5 * 60 * 1000);
}

// ── Ranked season stats ───────────────────────────────────────────────────────
async function getPlayerRankedStats(accountId, seasonId) {
  const path = `/shards/${SHARD}/players/${accountId}/seasons/${seasonId}/ranked`;
  return cachedGet(path, 5 * 60 * 1000);
}

// ── Lifetime stats ────────────────────────────────────────────────────────────
// Cache 15 minutes. bust=true bypasses in-memory cache (forces live API fetch).
async function getPlayerLifetime(accountId, bust = false) {
  const apiPath = `/shards/${SHARD}/players/${accountId}/lifetime`;
  if (bust) {
    _cache.delete(_cacheKey(apiPath));
    const data = await _throttledGet(apiPath);
    _toCache(apiPath, data);
    return data;
  }
  return cachedGet(apiPath, 15 * 60 * 1000);
}

// ── Match details ─────────────────────────────────────────────────────────────
// Disk cache (permanent) → in-memory cache → API
// Matches are immutable so once on disk they never need re-fetching.
//
// trainingroom matches are never persisted to disk: they can't count toward
// any stats (lib/match-filters.js) and they'd pollute match_cache/ forever.
// Callers that loop over recent matches (fetch_recent_matches.js) keep their
// own skip list so non-persisted matches aren't re-fetched on every run.
const NEVER_PERSIST_MATCH_TYPES = new Set(['trainingroom']);

function shouldPersistMatch(data) {
  const matchType = data?.data?.attributes?.matchType;
  return !NEVER_PERSIST_MATCH_TYPES.has(matchType);
}

async function getMatch(matchId) {
  const apiPath = `/shards/${SHARD}/matches/${matchId}`;
  const disk = _matchFromDisk(matchId);
  if (disk) {
    _toCache(apiPath, disk); // warm in-memory cache
    return disk;
  }
  const data = await cachedGet(apiPath, 30 * 60 * 1000);
  if (shouldPersistMatch(data)) {
    _matchToDisk(matchId, data); // persist — never need to fetch again
  }
  return data;
}

// ── Clan info ─────────────────────────────────────────────────────────────────
// Cache 30 minutes — membership list changes rarely.
async function getClan(clanId) {
  return cachedGet(`/shards/${SHARD}/clans/${clanId}`, 30 * 60 * 1000);
}

// ── Clan discovery ────────────────────────────────────────────────────────────
// Given one player's username, looks up their clan ID and returns clan metadata.
// Note: PUBG's public API clan endpoint returns metadata only (name, tag, level,
// member count) — it does NOT expose the full member roster. Use bulkResolvePlayers
// to import members by name.
async function discoverClanFromPlayer(playerName) {
  // Step 1: look up the seed player
  const seedData = await getPlayersByName(playerName);
  const seedPlayer = (seedData.data || [])[0];
  if (!seedPlayer) throw new Error(`Player "${playerName}" not found`);

  // Step 2: clan ID lives in attributes.clanId (not relationships)
  const clanId = seedPlayer.attributes?.clanId;
  if (!clanId) {
    throw new Error(`Player "${playerName}" is not in an in-game PUBG clan`);
  }

  // Step 3: fetch clan metadata
  const clanData = await getClan(clanId);
  const clan = clanData.data;
  if (!clan) throw new Error(`Clan ${clanId} not found`);

  const clanName        = clan.attributes?.clanName  || 'Unknown';
  const clanTag         = clan.attributes?.clanTag   || '';
  const clanLevel       = clan.attributes?.clanLevel || 0;
  const clanMemberCount = clan.attributes?.clanMemberCount || 0;

  // Seed player is the first resolved member
  const seedMember = {
    name:      seedPlayer.attributes.name,
    accountId: seedPlayer.id,
    addedAt:   new Date().toISOString(),
    source:    'clan',
  };

  return { clanId, clanName, clanTag, clanLevel, clanMemberCount, seedMember };
}

// ── Bulk player name resolution ───────────────────────────────────────────────
// Resolves an array of player names → account IDs via batched API calls.
// PUBG allows up to 10 names per filter[playerNames] request.
async function bulkResolvePlayers(names) {
  const BATCH = 10;
  const resolved = [];
  const notFound = [];

  for (let i = 0; i < names.length; i += BATCH) {
    const batch = names.slice(i, i + BATCH).filter(Boolean);
    if (!batch.length) continue;
    const endpoint = `/shards/${SHARD}/players?filter[playerNames]=${encodeURIComponent(batch.join(','))}`;
    try {
      const result = await cachedGet(endpoint, 10 * 60 * 1000);
      const found  = new Set((result.data || []).map(p => p.attributes.name.toLowerCase()));
      for (const p of (result.data || [])) {
        resolved.push({
          name:      p.attributes.name,
          accountId: p.id,
          clanId:    p.attributes?.clanId || null,
          addedAt:   new Date().toISOString(),
          source:    'bulk',
        });
      }
      for (const n of batch) {
        if (!found.has(n.toLowerCase())) notFound.push(n);
      }
    } catch (e) {
      for (const n of batch) notFound.push(n);
    }
  }

  return { resolved, notFound };
}

// ── Per-player stats cache ────────────────────────────────────────────────────
// Sits on top of the URL-based cache. Keyed by accountId + mode + context.
// Survives member list changes (unlike URL-keyed batch cache).
const _playerCache = new Map();
const PLAYER_CACHE_TTL = 25 * 60 * 1000; // 25 minutes

function _playerCacheKey(accountId, mode, context) {
  return `${accountId}:${mode}:${context}`;
}

function _getPlayerCache(accountId, mode, context) {
  const key = _playerCacheKey(accountId, mode, context);
  const entry = _playerCache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.at > PLAYER_CACHE_TTL) { _playerCache.delete(key); return undefined; }
  return entry.data;
}

function _setPlayerCache(accountId, mode, context, data) {
  _playerCache.set(_playerCacheKey(accountId, mode, context), { data, at: Date.now() });
}

// ── Batch season stats ────────────────────────────────────────────────────────
// Uses /seasons/{seasonId}/gameMode/{gameMode}/players — up to 10 IDs per call.
// Returns Map of accountId -> raw gameModeStats object for that mode.
// Per-player cache layer means removing a member doesn't invalidate others.
async function _batchSeasonStatsByMode(accountIds, seasonId, gameMode) {
  const BATCH = 10;
  const result = new Map();

  // 1. Check per-player cache first — skip already-cached players
  const uncached = [];
  for (const id of accountIds) {
    const cached = _getPlayerCache(id, gameMode, `season:${seasonId}`);
    if (cached !== undefined) {
      result.set(id, cached);
    } else {
      uncached.push(id);
    }
  }

  // 2. Batch-fetch only uncached players
  for (let i = 0; i < uncached.length; i += BATCH) {
    const batch = uncached.slice(i, i + BATCH);
    const path = `/shards/${SHARD}/seasons/${encodeURIComponent(seasonId)}/gameMode/${gameMode}/players` +
                 `?filter[playerIds]=${batch.join(',')}`;
    try {
      const data = await cachedGet(path, 25 * 60 * 1000);
      for (const item of (data.data || [])) {
        const pid = item.relationships?.player?.data?.id || item.id;
        const stats = item.attributes?.gameModeStats?.[gameMode] || null;
        result.set(pid, stats);
        _setPlayerCache(pid, gameMode, `season:${seasonId}`, stats);
      }
      // Mark any batch members not returned by API as null (they exist but have no data)
      for (const bid of batch) {
        if (!result.has(bid)) {
          result.set(bid, null);
          _setPlayerCache(bid, gameMode, `season:${seasonId}`, null);
        }
      }
    } catch (e) {
      console.warn(`[PUBG] batch season ${gameMode} batch ${Math.floor(i/BATCH)+1} failed: ${e.message}`);
    }
  }
  return result;
}

// ── Batch lifetime stats ──────────────────────────────────────────────────────
// Uses /seasons/lifetime/gameMode/{gameMode}/players — up to 10 IDs per call.
// Per-player cache layer means removing a member doesn't invalidate others.
async function _batchLifetimeStatsByMode(accountIds, gameMode) {
  const BATCH = 10;
  const result = new Map();

  // 1. Check per-player cache first
  const uncached = [];
  for (const id of accountIds) {
    const cached = _getPlayerCache(id, gameMode, 'lifetime');
    if (cached !== undefined) {
      result.set(id, cached);
    } else {
      uncached.push(id);
    }
  }

  // 2. Batch-fetch only uncached players
  for (let i = 0; i < uncached.length; i += BATCH) {
    const batch = uncached.slice(i, i + BATCH);
    const path = `/shards/${SHARD}/seasons/lifetime/gameMode/${gameMode}/players` +
                 `?filter[playerIds]=${batch.join(',')}`;
    try {
      const data = await cachedGet(path, 25 * 60 * 1000);
      for (const item of (data.data || [])) {
        const pid = item.relationships?.player?.data?.id || item.id;
        const stats = item.attributes?.gameModeStats?.[gameMode] || null;
        result.set(pid, stats);
        _setPlayerCache(pid, gameMode, 'lifetime', stats);
      }
      for (const bid of batch) {
        if (!result.has(bid)) {
          result.set(bid, null);
          _setPlayerCache(bid, gameMode, 'lifetime', null);
        }
      }
    } catch (e) {
      console.warn(`[PUBG] batch lifetime ${gameMode} batch ${Math.floor(i/BATCH)+1} failed: ${e.message}`);
    }
  }
  return result;
}

// ── batchGetSeasonStats ───────────────────────────────────────────────────────
// Fetches squad + squad-fpp season stats for all accountIds in batches of 10.
// Returns Map of accountId -> synthetic season object matching the individual
// endpoint shape so the frontend's extractStats() works without changes.
// 28 members = 3 batches × 2 modes = 6 API calls (vs 28 with individual calls).
async function batchGetSeasonStats(accountIds, seasonId) {
  const [fpp, tpp] = await Promise.all([
    _batchSeasonStatsByMode(accountIds, seasonId, 'squad-fpp'),
    _batchSeasonStatsByMode(accountIds, seasonId, 'squad'),
  ]);
  const result = new Map();
  for (const id of accountIds) {
    result.set(id, {
      data: {
        type: 'playerSeason',
        attributes: {
          gameModeStats: {
            'squad-fpp': fpp.get(id) || null,
            'squad':     tpp.get(id) || null,
          },
        },
      },
    });
  }
  return result;
}

// ── batchGetLifetimeStats ─────────────────────────────────────────────────────
// Fetches squad + squad-fpp lifetime stats for all accountIds in batches of 10.
// Returns Map of accountId -> synthetic lifetime object matching individual shape.
// 28 members = 3 batches × 2 modes = 6 API calls (vs 28 with individual calls).
async function batchGetLifetimeStats(accountIds) {
  const [fpp, tpp] = await Promise.all([
    _batchLifetimeStatsByMode(accountIds, 'squad-fpp'),
    _batchLifetimeStatsByMode(accountIds, 'squad'),
  ]);
  const result = new Map();
  for (const id of accountIds) {
    result.set(id, {
      data: {
        type: 'playerSeason',
        attributes: {
          gameModeStats: {
            'squad-fpp': fpp.get(id) || null,
            'squad':     tpp.get(id) || null,
          },
        },
      },
    });
  }
  return result;
}

// ── Cache management ──────────────────────────────────────────────────────────
function clearCache(opts = {}) {
  _cache.clear();
  _playerCache.clear();
  // Optionally clear disk caches (not done by default — matches are immutable)
  if (opts.disk) {
    try { fs.readdirSync(PLAYER_DISK_DIR).forEach(f => fs.unlinkSync(path.join(PLAYER_DISK_DIR, f))); } catch {}
    console.log('[PUBG] 🗑️  Player disk cache cleared');
  }
  if (opts.matches) {
    try { fs.readdirSync(MATCH_DISK_DIR).forEach(f => fs.unlinkSync(path.join(MATCH_DISK_DIR, f))); } catch {}
    console.log('[PUBG] 🗑️  Match disk cache cleared');
  }
}
function cacheSize() {
  let matchDiskCount = 0, playerDiskCount = 0;
  try { matchDiskCount  = fs.readdirSync(MATCH_DISK_DIR).length;  } catch {}
  try { playerDiskCount = fs.readdirSync(PLAYER_DISK_DIR).length; } catch {}
  return { memory: _cache.size, matchDisk: matchDiskCount, playerDisk: playerDiskCount };
}

module.exports = {
  SHARD,
  pubgGet,
  cachedGet,
  getSeasons,
  getCurrentSeason,
  getPlayersByName,
  getPlayer,
  getPlayerFresh,
  getPlayerSeasonStats,
  getPlayerRankedStats,
  getPlayerLifetime,
  batchGetSeasonStats,
  batchGetLifetimeStats,
  _batchSeasonStatsByMode,
  _batchLifetimeStatsByMode,
  getMatch,
  shouldPersistMatch,
  getClan,
  discoverClanFromPlayer,
  bulkResolvePlayers,
  clearCache,
  cacheSize,
};
