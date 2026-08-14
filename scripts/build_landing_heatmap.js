'use strict';
// ── scripts/build_landing_heatmap.js ─────────────────────────────────────────
// Processes match telemetry to extract LogParachuteLanding events for clan members.
// Builds per-player landing spot lists, normalized to 0–1 per map.
// Output: data/landing_cache.json
//
// Incremental: only processes matches not yet in processedMatches.
// Reset cache by deleting data/landing_cache.json or clearing processedMatches.

const fs      = require('fs');
const path    = require('path');
const { ensureSeasonStateFromMatchCache, isCurrentSeasonMatch } = require('../lib/season-state');
const { getTelemetry } = require('../lib/telemetry');
const { MATCH_FILTER_POLICY_VERSION, isCountingSquadMatch } = require('../lib/match-filters');
const { ensureMatchCacheDir, listMatchCacheFiles } = require('./cache_paths');

const ROOT          = path.join(__dirname, '..');
const MATCH_DIR     = path.join(ROOT, 'data', 'match_cache');
const MEMBERS_FILE  = path.join(ROOT, 'data', 'members.json');
const LANDING_FILE  = path.join(ROOT, 'data', 'landing_cache.json');
const CACHE_SCHEMA_VERSION = 3;

const CONCURRENCY = 4;

// ── Map sizes (cm) for coordinate normalisation ───────────────────────────────
// PUBG map coordinates are in cm, origin at top-left.
// Normalised x = rawX / mapSize, normalised y = rawY / mapSize
const MAP_SIZES = {
  Baltic_Main:    816000, // Erangel
  Erangel:        816000,
  Desert_Main:    816000, // Miramar
  Miramar:        816000,
  Savage_Main:    408000, // Sanhok
  Sanhok:         408000,
  DihorOtok_Main: 612000, // Vikendi
  Vikendi:        612000,
  Karakin:        204000,
  Tiger_Main:     816000, // Taego
  Taego:          816000,
  Rondo:          816000,
  Deston:         816000,
  Kiki_Main:      816000, // Deston
  Neon_Main:      816000, // Neon (newer map)
  Chimera_Main:   306000, // Paramo — 3×3 km (was 408000; landings compressed to ~75% of map)
  Summerland_Main:204000, // Karakin — 2×2 km (was 408000; landings compressed to ~50% of map)
  Boardwalk_Main: 816000, // Boardwalk
  Haven_Main:     204000, // Haven
  Paramo_Main:    306000, // Paramo (alias) — 3×3 km
};

// Friendly map names for display
const MAP_LABELS = {
  Baltic_Main:    'Erangel',
  Desert_Main:    'Miramar',
  Savage_Main:    'Sanhok',
  DihorOtok_Main: 'Vikendi',
  Tiger_Main:     'Taego',
  Kiki_Main:      'Deston',
  Neon_Main:      'Neon',
  Chimera_Main:   'Chimera',
  Summerland_Main:'Summerland',
  Boardwalk_Main: 'Boardwalk',
  Haven_Main:     'Haven',
  Paramo_Main:    'Paramo',
};
function mapLabel(mapId) { return MAP_LABELS[mapId] || mapId; }

// ── Load / save cache ─────────────────────────────────────────────────────────
function emptyCache(seasonState) {
  return {
    version:        CACHE_SCHEMA_VERSION,
    filterPolicyVersion: MATCH_FILTER_POLICY_VERSION,
    seasonId:       seasonState.cacheSeasonId || seasonState.seasonId || null,
    seasonStartAt:  seasonState.seasonStartAt || null,
    processedMatches: [],
    failedMatches:  {},
    landings:       {},
  };
}

function loadCache(seasonState) {
  if (!fs.existsSync(LANDING_FILE)) return emptyCache(seasonState);
  try {
    const cache = JSON.parse(fs.readFileSync(LANDING_FILE, 'utf8'));
    const seasonId = seasonState.cacheSeasonId || seasonState.seasonId || null;
    const seasonStartAt = seasonState.seasonStartAt || null;
    if ((cache.version || 0) > CACHE_SCHEMA_VERSION) return emptyCache(seasonState);
    if ((cache.filterPolicyVersion || null) !== MATCH_FILTER_POLICY_VERSION) return emptyCache(seasonState);
    if ((cache.seasonId || null) !== seasonId) return emptyCache(seasonState);
    if ((cache.seasonStartAt || null) !== seasonStartAt) return emptyCache(seasonState);
    cache.version = CACHE_SCHEMA_VERSION;
    cache.filterPolicyVersion = MATCH_FILTER_POLICY_VERSION;
    if (!Array.isArray(cache.processedMatches)) cache.processedMatches = [];
    if (!cache.failedMatches || typeof cache.failedMatches !== 'object') cache.failedMatches = {};
    if (!cache.landings || typeof cache.landings !== 'object') cache.landings = {};
    return cache;
  } catch {
    return emptyCache(seasonState);
  }
}
function saveCache(cache) {
  fs.writeFileSync(LANDING_FILE, JSON.stringify(cache, null, 2));
}

function isExpiredTelemetryError(error) {
  const msg = String(error?.message || '');
  return msg.includes('HTTP 403') || msg.includes('telemetry expired');
}

// ── Process one telemetry blob ────────────────────────────────────────────────
function processLandings(events, memberIdSet, mapName) {
  // { accountId -> [{ x, y }] } normalised to 0-1
  const result = {};
  const size   = MAP_SIZES[mapName] || 816000;

  for (const evt of events) {
    if (evt._T !== 'LogParachuteLanding') continue;
    const ch = evt.character;
    if (!ch || !memberIdSet.has(ch.accountId)) continue;
    const loc = ch.location;
    if (!loc) continue;
    // Clamp to [0,1] in case of edge cases
    const nx = Math.max(0, Math.min(1, loc.x / size));
    const ny = Math.max(0, Math.min(1, loc.y / size));
    if (!result[ch.accountId]) result[ch.accountId] = { name: ch.name, spots: [] };
    result[ch.accountId].spots.push({ x: +nx.toFixed(4), y: +ny.toFixed(4) });
  }
  return result;
}

// ── Merge one match's landing data into the running cache ─────────────────────
function mergeInto(cache, matchLandings, mapName) {
  const displayMap = mapLabel(mapName) || mapName;
  for (const [accountId, data] of Object.entries(matchLandings)) {
    if (!cache.landings[accountId]) {
      cache.landings[accountId] = { name: data.name, maps: {} };
    }
    const player = cache.landings[accountId];
    if (!player.name && data.name) player.name = data.name;
    if (!player.maps[displayMap]) player.maps[displayMap] = [];
    player.maps[displayMap].push(...data.spots);
  }
}

// ── Main export ───────────────────────────────────────────────────────────────
async function buildLandingHeatmap({ verbose = false } = {}) {
  if (!fs.existsSync(MEMBERS_FILE)) throw new Error('members.json not found');
  const members    = JSON.parse(fs.readFileSync(MEMBERS_FILE, 'utf8'));
  const memberIds  = new Set(members.map(m => m.accountId));
  ensureMatchCacheDir();
  const seasonState = ensureSeasonStateFromMatchCache(MATCH_DIR);
  const seasonStartAt = seasonState.seasonStartAt || null;
  const cache      = loadCache(seasonState);
  const processed  = new Set(cache.processedMatches || []);
  const failed     = cache.failedMatches || {};

  const matchFiles = listMatchCacheFiles();
  const toProcess  = [];

  for (const file of matchFiles) {
    const matchId = file.replace('.json', '');
    if (processed.has(matchId)) continue;
    if (failed[matchId]?.expired) continue;
    const matchData  = JSON.parse(fs.readFileSync(path.join(MATCH_DIR, file), 'utf8'));
    const attrs = matchData?.data?.attributes;
    // Counting filter shared with build_match_history / build_squad_stats —
    // see lib/match-filters.js. Only applicable official squad matches count.
    if (!isCountingSquadMatch(attrs)) continue;
    if (!isCurrentSeasonMatch(attrs?.createdAt, seasonStartAt)) continue;
    const asset   = matchData?.included?.find(i => i.type === 'asset');
    const telUrl  = asset?.attributes?.URL;
    const mapName = attrs?.mapName;
    if (!telUrl) continue;
    toProcess.push({ matchId, telUrl, mapName: mapName || 'Unknown' });
  }

  if (verbose) console.log(`[Heatmap] ${toProcess.length} new matches to process (${processed.size} already done)`);
  if (!toProcess.length) {
    if (verbose) console.log('[Heatmap] Nothing to do');
    saveCache(cache);
    return summarise(cache);
  }

  let done = 0, errors = 0;
  cache.version = CACHE_SCHEMA_VERSION;
  cache.filterPolicyVersion = MATCH_FILTER_POLICY_VERSION;
  cache.seasonId = seasonState.cacheSeasonId || seasonState.seasonId || null;
  cache.seasonStartAt = seasonStartAt;
  if (!cache.failedMatches) cache.failedMatches = {};

  // Process in batches
  for (let i = 0; i < toProcess.length; i += CONCURRENCY) {
    const batch = toProcess.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async ({ matchId, telUrl, mapName }) => {
      try {
        const events = await getTelemetry(matchId, telUrl);
        const matchLandings = processLandings(events, memberIds, mapName);
        mergeInto(cache, matchLandings, mapName);
        cache.processedMatches.push(matchId);
        delete cache.failedMatches[matchId];
        done++;
        if (verbose && done % 20 === 0) console.log(`  [Heatmap] ${done}/${toProcess.length} matches processed…`);
      } catch (e) {
        errors++;
        if (isExpiredTelemetryError(e)) {
          cache.failedMatches[matchId] = {
            expired: true,
            error: e.message,
            notedAt: new Date().toISOString(),
          };
        }
        if (verbose) console.warn(`  [Heatmap] Error on ${matchId}: ${e.message}`);
      }
    }));
    // Save progress every batch
    saveCache(cache);
  }

  if (verbose) console.log(`[Heatmap] Done: ${done} processed, ${errors} errors`);
  return summarise(cache);
}

function summarise(cache) {
  const playerCount = Object.keys(cache.landings).length;
  const totalSpots  = Object.values(cache.landings).reduce((s, p) =>
    s + Object.values(p.maps).reduce((ss, spots) => ss + spots.length, 0), 0);
  return {
    playerCount,
    totalSpots,
    processedMatches: cache.processedMatches.length,
    failedMatches: Object.keys(cache.failedMatches || {}).length,
  };
}

// ── CLI entry point ───────────────────────────────────────────────────────────
if (require.main === module) {
  buildLandingHeatmap({ verbose: true })
    .then(r => console.log(`\n[Heatmap] Summary: ${r.playerCount} players, ${r.totalSpots} landing spots, ${r.processedMatches} matches, ${r.failedMatches} expired`))
    .catch(e => { console.error('[Heatmap] Fatal:', e.message); process.exit(1); });
}

module.exports = { buildLandingHeatmap };
