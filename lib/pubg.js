'use strict';
// ── lib/pubg.js — PUBG API wrapper with in-memory caching ────────────────────
// All PUBG API calls go through here. Handles auth headers, rate-limit-safe
// caching, and normalised error responses.
//
// Free tier: 10 requests/minute. Cache TTL defaults keep us well under that.
// Shard: 'steam' (PC). Change SHARD if needed (xbox, psn, etc.)

const https = require('https');
const { loadEnv } = require('./config');

const SHARD    = 'steam';
const API_HOST = 'api.pubg.com';
const ACCEPT   = 'application/vnd.api+json';

// ── Rate limiter — 10 RPM hard ceiling ────────────────────────────────────────
// Tracks timestamps of the last N calls and queues excess requests.
// 10 req/min = one request every 6 seconds burst-safe with a sliding window.
const RATE_LIMIT    = 10;  // max requests per window
const RATE_WINDOW   = 60 * 1000; // 1 minute in ms
const _callTimes    = [];  // timestamps of recent raw API calls
let   _rateLimitQ   = Promise.resolve(); // serial queue for rate-limited calls

function _throttledGet(apiPath) {
  // Chain every call onto the queue so they run one at a time
  _rateLimitQ = _rateLimitQ.then(() => _doRateLimitedGet(apiPath));
  return _rateLimitQ;
}

async function _doRateLimitedGet(apiPath) {
  // Drop timestamps older than the window
  const now = Date.now();
  while (_callTimes.length && now - _callTimes[0] > RATE_WINDOW) {
    _callTimes.shift();
  }

  if (_callTimes.length >= RATE_LIMIT) {
    // Wait until the oldest call falls out of the window
    const wait = RATE_WINDOW - (now - _callTimes[0]) + 50; // +50ms safety margin
    console.log(`[PUBG] Rate limit approached — waiting ${wait}ms before next call`);
    await new Promise(r => setTimeout(r, wait));
    // Re-prune after waiting
    const n2 = Date.now();
    while (_callTimes.length && n2 - _callTimes[0] > RATE_WINDOW) _callTimes.shift();
  }

  _callTimes.push(Date.now());
  return pubgGet(apiPath);
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
          return reject(new Error('PUBG API rate limit hit — try again in a moment'));
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
async function getPlayer(accountId) {
  return cachedGet(`/shards/${SHARD}/players/${accountId}`, 10 * 60 * 1000);
}

// ── Season stats for a player ─────────────────────────────────────────────────
// Cache 5 minutes.
async function getPlayerSeasonStats(accountId, seasonId) {
  const path = `/shards/${SHARD}/players/${accountId}/seasons/${seasonId}`;
  return cachedGet(path, 5 * 60 * 1000);
}

// ── Ranked season stats ───────────────────────────────────────────────────────
async function getPlayerRankedStats(accountId, seasonId) {
  const path = `/shards/${SHARD}/players/${accountId}/seasons/${seasonId}/ranked`;
  return cachedGet(path, 5 * 60 * 1000);
}

// ── Lifetime stats ────────────────────────────────────────────────────────────
// Cache 15 minutes.
async function getPlayerLifetime(accountId) {
  return cachedGet(`/shards/${SHARD}/players/${accountId}/lifetime`, 15 * 60 * 1000);
}

// ── Match details ─────────────────────────────────────────────────────────────
// Cache 30 minutes — matches are immutable.
async function getMatch(matchId) {
  return cachedGet(`/shards/${SHARD}/matches/${matchId}`, 30 * 60 * 1000);
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

// ── Cache management ──────────────────────────────────────────────────────────
function clearCache() { _cache.clear(); }
function cacheSize()  { return _cache.size; }

module.exports = {
  SHARD,
  pubgGet,
  cachedGet,
  getSeasons,
  getCurrentSeason,
  getPlayersByName,
  getPlayer,
  getPlayerSeasonStats,
  getPlayerRankedStats,
  getPlayerLifetime,
  getMatch,
  getClan,
  discoverClanFromPlayer,
  bulkResolvePlayers,
  clearCache,
  cacheSize,
};
