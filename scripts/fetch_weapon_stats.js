#!/usr/bin/env node
'use strict';
// ── scripts/fetch_weapon_stats.js ─────────────────────────────────────────────
// Fetches telemetry for all cached clan matches, extracts per-player weapon kill
// data from LogPlayerKillV2 events, and writes data/weapon_cache.json.
//
// Incremental: tracks which match IDs have already been processed so each run
// only fetches new matches.
//
// Writes: data/weapon_cache.json
// Called by: scripts/daily_clan.js

const fs    = require('fs');
const path  = require('path');

const { weaponDisplayName, weaponStatus, isIgnoredCauser } = require('../lib/weapons');
const { ensureSeasonStateFromMatchCache, isCurrentSeasonMatch } = require('../lib/season-state');
const { getTelemetry } = require('../lib/telemetry');
const {
  MATCH_FILTER_POLICY_VERSION,
  getMatchFilterDecision,
  formatMatchDebug,
} = require('../lib/match-filters');
const { ensureMatchCacheDir, listMatchCacheFiles } = require('./cache_paths');

// Vehicle damageCauserName patterns — kills via running over players (roadKills)
const VEHICLE_KILL_PATTERNS = [
  /^Buggy_/i, /^BP_Buggy/i,
  /^Dacia_/i, /^BP_Dacia/i,
  /^Uaz_/i,   /^BP_Uaz/i,
  /^Motorbike_/i, /^BP_Motorbike/i,
  /^Bicycle_/i,   /^BP_Bicycle/i,
  /^SnowMobile_/i, /^Snowbike_/i,
  /^Boat_/i, /^PG117_/i, /^AquaRail_/i,
  /^Coupe_/i, /^BRDM/i, /^Mirado_/i,
  /^Scooter_/i, /^PickupTruck_/i,
  /^Spikestrip_/i,
  /DrivingVehicle/i,
];

function isVehicleKill(name) {
  return name && VEHICLE_KILL_PATTERNS.some(p => p.test(name));
}

// Item ID prefixes for heals and boosts in LogPlayerUseItem
const BOOST_PREFIX = 'Item_Boost_';
const HEAL_PREFIX  = 'Item_Heal_';

const DATA        = path.join(__dirname, '..', 'data');
const MATCH_DIR   = path.join(DATA, 'match_cache');
const MEMBERS_FILE = path.join(DATA, 'members.json');
const OUT         = path.join(DATA, 'weapon_cache.json');
const CACHE_SCHEMA_VERSION = 3;

const CONCURRENCY   = 4;   // parallel telemetry fetches
// ── Helpers ───────────────────────────────────────────────────────────────────

function loadMembers() {
  try { return JSON.parse(fs.readFileSync(MEMBERS_FILE, 'utf8')); } catch { return []; }
}

function emptyWeaponCache(seasonState) {
  return {
    version:        CACHE_SCHEMA_VERSION,
    filterPolicyVersion: MATCH_FILTER_POLICY_VERSION,
    seasonId:       seasonState.cacheSeasonId || seasonState.seasonId || null,
    seasonStartAt:  seasonState.seasonStartAt || null,
    updatedAt:      null,
    processedMatches: [],
    players:        {},
  };
}

function loadWeaponCache(seasonState) {
  try {
    const cache = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    const seasonId = seasonState.cacheSeasonId || seasonState.seasonId || null;
    const seasonStartAt = seasonState.seasonStartAt || null;
    if ((cache.version || 0) > CACHE_SCHEMA_VERSION) return emptyWeaponCache(seasonState);
    if ((cache.filterPolicyVersion || null) !== MATCH_FILTER_POLICY_VERSION) return emptyWeaponCache(seasonState);
    if ((cache.seasonId || null) !== seasonId) return emptyWeaponCache(seasonState);
    if ((cache.seasonStartAt || null) !== seasonStartAt) return emptyWeaponCache(seasonState);
    cache.version = CACHE_SCHEMA_VERSION;
    cache.filterPolicyVersion = MATCH_FILTER_POLICY_VERSION;
    if (!Array.isArray(cache.processedMatches)) cache.processedMatches = [];
    if (!cache.players || typeof cache.players !== 'object') cache.players = {};
    return cache;
  } catch {
    return emptyWeaponCache(seasonState);
  }
}

// Normalize LogWeaponFireCount weaponId format → same WeapX_C format as kill events
// e.g. "Item_Weapon_M9_C" → "WeapM9_C"
function normalizeFireCountWeapon(weaponId) {
  if (!weaponId) return null;
  if (weaponId.startsWith('Item_Weapon_')) return weaponId.replace('Item_Weapon_', 'Weap');
  return weaponId;
}

// Process one telemetry file: extract weapon kills, shots fired, and knockdowns for clan members
function processTelemetry(events, memberIdSet) {
  // { accountId -> { weapons: { weaponClass -> {...} }, blueZoneDamage, blueZoneMatchFlag } }
  // blueZoneMatchFlag: 1 if this player took ANY blue zone damage this match (for per-game average)
  const result = {};

  function ensurePlayer(accountId) {
    if (!result[accountId]) result[accountId] = {
      weapons: {},
      blueZoneDamage: 0, blueZoneMatchFlag: 0,
      revives: 0, heals: 0, boosts: 0,
      vehicleDestroys: 0, roadKills: 0, longestKill: 0,
    };
    return result[accountId];
  }

  function ensureWeapon(accountId, weaponClass) {
    const p = ensurePlayer(accountId);
    if (!p.weapons[weaponClass]) {
      p.weapons[weaponClass] = { kills: 0, hsKills: 0, distanceSum: 0, distanceMax: 0, fireCount: 0, knockdowns: 0 };
    }
    return p.weapons[weaponClass];
  }

  for (const evt of events) {

    // ── Kills ──────────────────────────────────────────────────────────────────
    if (evt._T === 'LogPlayerKillV2') {
      const killer = evt.killer;
      if (!killer || !memberIdSet.has(killer.accountId)) continue;

      const damageInfo = evt.killerDamageInfo || evt.dBNODamageInfo;
      if (!damageInfo) continue;

      const weaponClass = damageInfo.damageCauserName;
      const distance   = Math.round((damageInfo.distance || 0) / 100); // cm → m

      // Road kills — vehicle runs over player; count separately, not as weapon kill
      if (isVehicleKill(weaponClass)) {
        ensurePlayer(killer.accountId).roadKills++;
        continue;
      }

      if (!weaponClass || isIgnoredCauser(weaponClass)) continue;

      const isHeadshot = damageInfo.damageReason === 'HeadShot';

      const p = ensurePlayer(killer.accountId);
      if (distance > p.longestKill) p.longestKill = distance;

      const w = ensureWeapon(killer.accountId, weaponClass);
      w.kills++;
      if (isHeadshot) w.hsKills++;
      w.distanceSum += distance;
      if (distance > w.distanceMax) w.distanceMax = distance;

    // ── Knockdowns ────────────────────────────────────────────────────────────
    } else if (evt._T === 'LogPlayerMakeGroggy') {
      const attacker = evt.attacker;
      if (!attacker || !memberIdSet.has(attacker.accountId)) continue;

      const weaponClass = evt.damageCauserName;
      if (!weaponClass || isIgnoredCauser(weaponClass)) continue;

      ensureWeapon(attacker.accountId, weaponClass).knockdowns++;

    // ── Shots fired ───────────────────────────────────────────────────────────
    } else if (evt._T === 'LogWeaponFireCount') {
      const character = evt.character;
      if (!character || !memberIdSet.has(character.accountId)) continue;

      const weaponClass = normalizeFireCountWeapon(evt.weaponId);
      if (!weaponClass || isIgnoredCauser(weaponClass)) continue;

      ensureWeapon(character.accountId, weaponClass).fireCount += evt.fireCount || 0;

    // ── Revives ───────────────────────────────────────────────────────────────
    } else if (evt._T === 'LogPlayerRevive') {
      const reviver = evt.reviver;
      if (!reviver || !memberIdSet.has(reviver.accountId)) continue;
      ensurePlayer(reviver.accountId).revives++;

    // ── Heals & boosts ────────────────────────────────────────────────────────
    } else if (evt._T === 'LogItemUse' || evt._T === 'LogPlayerUseItem') {
      const character = evt.character;
      if (!character || !memberIdSet.has(character.accountId)) continue;
      const itemId = evt.item?.itemId || '';
      const p = ensurePlayer(character.accountId);
      if (itemId.startsWith(BOOST_PREFIX)) {
        p.boosts++;
      } else if (itemId.startsWith(HEAL_PREFIX)) {
        p.heals++;
      }

    // ── Vehicle destroys ──────────────────────────────────────────────────────
    } else if (evt._T === 'LogVehicleDestroy') {
      const attacker = evt.attacker;
      if (!attacker || !memberIdSet.has(attacker.accountId)) continue;
      ensurePlayer(attacker.accountId).vehicleDestroys++;

    // ── Blue zone damage taken ────────────────────────────────────────────────
    } else if (evt._T === 'LogPlayerTakeDamage' && evt.damageTypeCategory === 'Damage_BlueZone') {
      const victim = evt.victim;
      if (!victim || !memberIdSet.has(victim.accountId)) continue;
      const p = ensurePlayer(victim.accountId);
      p.blueZoneDamage    += evt.damage || 0;
      p.blueZoneMatchFlag  = 1; // at least one event this match
    }
  }

  return result;
}

// Merge per-match weapon data into the running totals
function mergeInto(cache, matchData) {
  for (const [accountId, data] of Object.entries(matchData)) {
    if (!cache.players[accountId]) {
      cache.players[accountId] = {
        name: null, weapons: {},
        blueZoneDamage: 0, blueZoneMatches: 0,
        revives: 0, heals: 0, boosts: 0,
        vehicleDestroys: 0, roadKills: 0, longestKill: 0,
      };
    }
    const player = cache.players[accountId];

    // Weapon stats
    const weapons = data.weapons || data; // backwards-compat: old data was flat {weaponClass: stats}
    for (const [weaponClass, stats] of Object.entries(weapons)) {
      if (!player.weapons[weaponClass]) {
        player.weapons[weaponClass] = { kills: 0, hsKills: 0, distanceSum: 0, distanceMax: 0, fireCount: 0, knockdowns: 0 };
      }
      const w = player.weapons[weaponClass];
      w.kills       += stats.kills       || 0;
      w.hsKills     += stats.hsKills     || 0;
      w.distanceSum += stats.distanceSum || 0;
      w.fireCount   += stats.fireCount   || 0;
      w.knockdowns  += stats.knockdowns  || 0;
      if ((stats.distanceMax || 0) > w.distanceMax) w.distanceMax = stats.distanceMax;
    }

    // Blue zone
    player.blueZoneDamage  = (player.blueZoneDamage  || 0) + (data.blueZoneDamage  || 0);
    player.blueZoneMatches = (player.blueZoneMatches || 0) + (data.blueZoneMatchFlag || 0);

    // New telemetry-derived fields
    player.revives         = (player.revives         || 0) + (data.revives         || 0);
    player.heals           = (player.heals           || 0) + (data.heals           || 0);
    player.boosts          = (player.boosts          || 0) + (data.boosts          || 0);
    player.vehicleDestroys = (player.vehicleDestroys || 0) + (data.vehicleDestroys || 0);
    player.roadKills       = (player.roadKills       || 0) + (data.roadKills       || 0);
    if ((data.longestKill || 0) > (player.longestKill || 0)) player.longestKill = data.longestKill;
  }
}

// Build the final player summary with display names and sorted weapons
function buildSummary(cache, members) {
  const nameMap = {};
  for (const m of members) nameMap[m.accountId] = m.name;

  const summary = {};
  for (const [accountId, player] of Object.entries(cache.players)) {
    const name = nameMap[accountId] || player.name || accountId;
    const weapons = [];

    for (const [weaponClass, stats] of Object.entries(player.weapons)) {
      if (stats.kills === 0) continue;
      weapons.push({
        weaponClass,
        displayName:  weaponDisplayName(weaponClass),
        status:       weaponStatus(weaponClass),
        kills:        stats.kills,
        hsKills:      stats.hsKills,
        hsRate:       +(stats.hsKills / stats.kills).toFixed(3),
        avgDist:      stats.kills > 0 ? Math.round(stats.distanceSum / stats.kills) : 0,
        maxDist:      stats.distanceMax,
        fireCount:    stats.fireCount  || 0,
        shotsPerKill: stats.kills > 0 && stats.fireCount > 0
          ? +(stats.fireCount / stats.kills).toFixed(1)
          : 0,
        knockdowns:   stats.knockdowns || 0,
      });
    }

    weapons.sort((a, b) => b.kills - a.kills);

    const bzMatches = player.blueZoneMatches || 0;
    const bzDamage  = player.blueZoneDamage  || 0;

    summary[accountId] = {
      name,
      weapons,
      blueZone: {
        totalDamage:   +bzDamage.toFixed(1),
        matches:       bzMatches,
        avgDmgPerGame: bzMatches > 0 ? +(bzDamage / bzMatches).toFixed(1) : 0,
      },
      // Telemetry-derived fields (counting matches only — filtered via match-filters.js)
      revives:        player.revives         || 0,
      heals:          player.heals           || 0,
      boosts:         player.boosts          || 0,
      vehicleDestroys: player.vehicleDestroys || 0,
      roadKills:      player.roadKills       || 0,
      longestKill:    player.longestKill     || 0,
    };
  }
  return summary;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function fetchWeaponStats({ verbose = true } = {}) {
  const members   = loadMembers();
  const memberIds = new Set(members.map(m => m.accountId));
  ensureMatchCacheDir();
  const seasonState = ensureSeasonStateFromMatchCache(MATCH_DIR);
  const seasonStartAt = seasonState.seasonStartAt || null;

  if (members.length === 0) {
    throw new Error('No members found in members.json');
  }

  const cache = loadWeaponCache(seasonState);
  const processedSet = new Set(cache.processedMatches);

  // Load all match files, filter to unprocessed
  const matchFiles = listMatchCacheFiles();
  const toProcess = [];

  for (const f of matchFiles) {
    const matchId = f.replace('.json', '');
    if (processedSet.has(matchId)) continue;

    const matchData = JSON.parse(fs.readFileSync(path.join(MATCH_DIR, f), 'utf8'));

    const attrs = matchData.data?.attributes || {};
    const filterDecision = getMatchFilterDecision(attrs);
    if (filterDecision.review && verbose) {
      console.warn(`[weapons] Review match shape ${matchId}: ${formatMatchDebug(filterDecision)}`);
    }
    if (!filterDecision.counts) continue;
    if (!isCurrentSeasonMatch(attrs.createdAt, seasonStartAt)) continue;

    const asset  = matchData.included?.find(i => i.type === 'asset');
    const telUrl = asset?.attributes?.URL;
    if (!telUrl) continue;

    toProcess.push({ matchId, telUrl });
  }

  if (verbose) {
    console.log(`[weapons] ${matchFiles.length} total matches · ${processedSet.size} already processed · ${toProcess.length} new to fetch`);
  }

  if (toProcess.length === 0) {
    if (verbose) console.log('[weapons] Nothing new to process.');
    fs.writeFileSync(OUT, JSON.stringify(cache, null, 2));
    return buildSummary(cache, members);
  }

  // Process in batches of CONCURRENCY
  let fetched = 0;
  let errors  = 0;

  for (let i = 0; i < toProcess.length; i += CONCURRENCY) {
    const batch = toProcess.slice(i, i + CONCURRENCY);

    await Promise.all(batch.map(async ({ matchId, telUrl }) => {
      try {
        const events    = await getTelemetry(matchId, telUrl);
        const matchData = processTelemetry(events, memberIds);
        mergeInto(cache, matchData);
        cache.processedMatches.push(matchId);
        fetched++;

        if (verbose && fetched % 10 === 0) {
          console.log(`[weapons] ${fetched}/${toProcess.length} fetched…`);
        }
      } catch (e) {
        errors++;
        if (verbose) console.warn(`[weapons] ✗ ${matchId}: ${e.message}`);
        // Permanent failures (expired telemetry, 4xx) — mark as processed so
        // we don't re-attempt them on every future run
        const isPermanent = e.message.includes('HTTP 4') || e.message.includes('XML');
        if (isPermanent) cache.processedMatches.push(matchId);
      }
    }));
  }

  // Stamp names from members list
  for (const m of members) {
    if (cache.players[m.accountId]) {
      cache.players[m.accountId].name = m.name;
    }
  }

  cache.updatedAt = new Date().toISOString();
  cache.version = CACHE_SCHEMA_VERSION;
  cache.filterPolicyVersion = MATCH_FILTER_POLICY_VERSION;
  cache.seasonId = seasonState.cacheSeasonId || seasonState.seasonId || null;
  cache.seasonStartAt = seasonStartAt;

  // Write raw cache (with distanceSum for future incremental merging)
  fs.writeFileSync(OUT, JSON.stringify(cache, null, 2));

  if (verbose) {
    console.log(`[weapons] ✓ Done — ${fetched} fetched · ${errors} errors`);
    console.log(`[weapons] ✓ Written weapon_cache.json`);
  }

  return buildSummary(cache, members);
}

// ── Reporting helpers ─────────────────────────────────────────────────────────

function topWeapons(summary, accountId, limit = 3) {
  return (summary[accountId]?.weapons || []).slice(0, limit);
}

function formatWeaponLine(w) {
  const hs = w.hsRate > 0 ? ` · ${Math.round(w.hsRate * 100)}% HS` : '';
  const dist = w.avgDist > 0 ? ` · ${w.avgDist}m avg` : '';
  return `${w.displayName}: **${w.kills}** kills${hs}${dist}`;
}

module.exports = { fetchWeaponStats, topWeapons, formatWeaponLine, buildSummary };

// ── Run directly ──────────────────────────────────────────────────────────────
if (require.main === module) {
  fetchWeaponStats({ verbose: true })
    .then(summary => {
      console.log('\n[weapons] Top weapons per player:');
      for (const [, p] of Object.entries(summary)) {
        if (!p.weapons.length) continue;
        const top3 = p.weapons.slice(0, 3).map(w => `${w.displayName}(${w.kills})`).join(', ');
        console.log(`  ${(p.name || '?').padEnd(20)} ${top3}`);
      }
    })
    .catch(e => { console.error('[weapons] Fatal:', e.message); process.exit(1); });
}
