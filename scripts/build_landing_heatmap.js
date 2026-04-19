'use strict';
// ── scripts/build_landing_heatmap.js ─────────────────────────────────────────
// Processes match telemetry to extract LogParachuteLanding events for APES members.
// Builds per-player landing spot lists, normalized to 0–1 per map.
// Output: data/landing_cache.json
//
// Incremental: only processes matches not yet in processedMatches.
// Reset cache by deleting data/landing_cache.json or clearing processedMatches.

const fs      = require('fs');
const path    = require('path');
const https   = require('https');
const zlib    = require('zlib');

const ROOT          = path.join(__dirname, '..');
const MATCH_DIR     = path.join(ROOT, 'data', 'match_cache');
const MEMBERS_FILE  = path.join(ROOT, 'data', 'members.json');
const LANDING_FILE  = path.join(ROOT, 'data', 'landing_cache.json');

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
  Chimera_Main:   408000, // Chimera (smaller map)
  Summerland_Main:408000, // Summerland
  Boardwalk_Main: 816000, // Boardwalk
  Haven_Main:     204000, // Haven
  Paramo_Main:    408000, // Paramo
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

// ── HTTP helpers ──────────────────────────────────────────────────────────────
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : require('http');
    const req = mod.get(url, { headers: { 'Accept-Encoding': 'gzip, deflate' } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const enc = res.headers['content-encoding'];
        const decompress = enc === 'gzip'    ? zlib.gunzipSync
                         : enc === 'deflate' ? zlib.inflateSync
                         : null;
        try {
          const text = decompress ? decompress(buf).toString() : buf.toString();
          resolve(JSON.parse(text));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// ── Load / save cache ─────────────────────────────────────────────────────────
function loadCache() {
  if (!fs.existsSync(LANDING_FILE)) return { processedMatches: [], landings: {} };
  try { return JSON.parse(fs.readFileSync(LANDING_FILE, 'utf8')); }
  catch { return { processedMatches: [], landings: {} }; }
}
function saveCache(cache) {
  fs.writeFileSync(LANDING_FILE, JSON.stringify(cache, null, 2));
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
  const cache      = loadCache();
  const processed  = new Set(cache.processedMatches || []);

  const matchFiles = fs.readdirSync(MATCH_DIR).filter(f => f.endsWith('.json'));
  const toProcess  = [];

  for (const file of matchFiles) {
    const matchId = file.replace('.json', '');
    if (processed.has(matchId)) continue;
    const matchData  = JSON.parse(fs.readFileSync(path.join(MATCH_DIR, file), 'utf8'));
    const matchType  = matchData?.data?.attributes?.matchType;
    if (matchType !== 'official') continue;   // skip casual/event/arcade
    const asset   = matchData?.included?.find(i => i.type === 'asset');
    const telUrl  = asset?.attributes?.URL;
    const mapName = matchData?.data?.attributes?.mapName;
    if (!telUrl) continue;
    toProcess.push({ matchId, telUrl, mapName: mapName || 'Unknown' });
  }

  if (verbose) console.log(`[Heatmap] ${toProcess.length} new matches to process (${processed.size} already done)`);
  if (!toProcess.length) {
    if (verbose) console.log('[Heatmap] Nothing to do');
    return summarise(cache);
  }

  let done = 0, errors = 0;

  // Process in batches
  for (let i = 0; i < toProcess.length; i += CONCURRENCY) {
    const batch = toProcess.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async ({ matchId, telUrl, mapName }) => {
      try {
        const events = await fetchJson(telUrl);
        const matchLandings = processLandings(events, memberIds, mapName);
        mergeInto(cache, matchLandings, mapName);
        cache.processedMatches.push(matchId);
        done++;
        if (verbose && done % 20 === 0) console.log(`  [Heatmap] ${done}/${toProcess.length} matches processed…`);
      } catch (e) {
        errors++;
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
  return { playerCount, totalSpots, processedMatches: cache.processedMatches.length };
}

// ── CLI entry point ───────────────────────────────────────────────────────────
if (require.main === module) {
  buildLandingHeatmap({ verbose: true })
    .then(r => console.log(`\n[Heatmap] Summary: ${r.playerCount} players, ${r.totalSpots} landing spots, ${r.processedMatches} matches`))
    .catch(e => { console.error('[Heatmap] Fatal:', e.message); process.exit(1); });
}

module.exports = { buildLandingHeatmap };
