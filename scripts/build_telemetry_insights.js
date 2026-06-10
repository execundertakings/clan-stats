#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { DATA, loadClanConfig } = require('../lib/config');
const SHORT = loadClanConfig().clan.shortName; // clan short name used in coaching copy
const { loadSeasonState, isCurrentSeasonMatch } = require('../lib/season-state');
const { readCachedTelemetry } = require('../lib/telemetry');
const { isCountingSquadMatch, MATCH_FILTER_POLICY_VERSION } = require('../lib/match-filters');

const MATCH_DIR = path.join(DATA, 'match_cache');
const TELEMETRY_DIR = path.join(DATA, 'telemetry_cache');
const MEMBERS_FILE = path.join(DATA, 'members.json');
const HISTORY_FILE = path.join(DATA, 'match_history_cache.json');
const OUT_FILE = path.join(DATA, 'telemetry_insights_cache.json');

const ENGAGEMENT_GAP_MS = 75 * 1000;
const POSITION_SAMPLE_GAP_MS = 30 * 1000;
const POSITION_FRESHNESS_MS = 15 * 1000;
const CONTEST_RADIUS_M = 180;
const CONTEST_WINDOW_MS = 45 * 1000;
const MAP_NAMES = {
  Baltic_Main: 'Erangel',
  Desert_Main: 'Miramar',
  Savage_Main: 'Sanhok',
  DihorOtok_Main: 'Vikendi',
  Kiki_Main: 'Deston',
  Tiger_Main: 'Taego',
  Summerland_Main: 'Karakin',
  Chimera_Main: 'Paramo',
  Heaven_Main: 'Haven',
  Neon_Main: 'Rondo',
  Officiel_Main: 'Erangel (CE)',
};

function readJsonSafe(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}

function fmtPct(n, d, decimals = 0) {
  if (!d) return `0${decimals ? '.' + '0'.repeat(decimals) : ''}%`;
  return `${((n / d) * 100).toFixed(decimals)}%`;
}

function pctNum(n, d, decimals = 1) {
  if (!d) return 0;
  return +(((n / d) * 100).toFixed(decimals));
}

function avg(sum, count, decimals = 1) {
  if (!count) return 0;
  return +((sum / count).toFixed(decimals));
}

function safeDiv(n, d, decimals = 2) {
  if (!d) return 0;
  return +((n / d).toFixed(decimals));
}

function clamp(n, min = 0, max = 100) {
  return Math.min(max, Math.max(min, Number.isFinite(n) ? n : 0));
}

function sampleConfidence(samples, high, medium) {
  if (samples >= high) return { label: 'High confidence', score: 92 };
  if (samples >= medium) return { label: 'Moderate confidence', score: 68 };
  if (samples > 0) return { label: 'Early read', score: 42 };
  return { label: 'No sample', score: 8 };
}

function makeBar(label, percent, value, hint = '') {
  return {
    label,
    percent: clamp(percent),
    value,
    hint,
  };
}

function distanceMeters(a, b) {
  if (!a || !b) return null;
  const dx = (a.x || 0) - (b.x || 0);
  const dy = (a.y || 0) - (b.y || 0);
  return Math.round(Math.sqrt(dx * dx + dy * dy) / 100);
}

function zoneName(zone) {
  if (Array.isArray(zone)) return zone[0] || 'Unknown';
  if (typeof zone === 'string') return zone || 'Unknown';
  return 'Unknown';
}

function prettyZone(zone) {
  if (!zone || zone === 'Unknown') return 'Unknown';
  return String(zone)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, ch => ch.toUpperCase());
}

function mapDisplay(name) {
  return MAP_NAMES[name] || prettyZone(String(name || '').replace('_Main', '')) || 'Unknown';
}

function bucketRange(distance) {
  if (!Number.isFinite(distance)) return 'unknown';
  if (distance <= 40) return 'close';
  if (distance <= 120) return 'mid';
  return 'long';
}

function placementLabel(rank) {
  if (!rank) return '?';
  if (rank === 1) return '1st';
  if (rank === 2) return '2nd';
  if (rank === 3) return '3rd';
  return `${rank}th`;
}

function ensurePlayer(store, accountId, name) {
  if (!store[accountId]) {
    store[accountId] = {
      name,
      matches: 0,
      knocks: 0,
      kills: 0,
      conversionKills: 0,
      blueDamage: 0,
      blueDeaths: 0,
      contestedDrops: 0,
      contestedTop10s: 0,
      uncontestedDrops: 0,
      uncontestedTop10s: 0,
      vehicleMatches: 0,
      vehicleTop10s: 0,
      noVehicleMatches: 0,
      noVehicleTop10s: 0,
      openingFights: 0,
      openingConversions: 0,
      firstKnockAgainstMatches: 0,
      clutchRecoveries: 0,
      range: {
        close: { damage: 0, knocks: 0, kills: 0, events: 0 },
        mid:   { damage: 0, knocks: 0, kills: 0, events: 0 },
        long:  { damage: 0, knocks: 0, kills: 0, events: 0 },
      },
    };
  }
  return store[accountId];
}

function ensureTeam(store, teamKey, players) {
  if (!store[teamKey]) {
    store[teamKey] = {
      teamKey,
      players,
      matches: 0,
      wins: 0,
      top10s: 0,
      avgSpacingSum: 0,
      avgSpacingMatches: 0,
      knockSpacingSum: 0,
      knockSpacingEvents: 0,
      firstKnockAgainst: 0,
      clutchRecoveries: 0,
    };
  }
  return store[teamKey];
}

function ensureRoute(store, key) {
  if (!store[key]) store[key] = { matches: 0, wins: 0, top10s: 0, blueMatches: 0, placementSum: 0 };
  return store[key];
}

function ensureDropZone(store, key) {
  if (!store[key]) store[key] = { contested: 0, contestedTop10s: 0, free: 0, freeTop10s: 0 };
  return store[key];
}

function getPlacementMap(rawMatch) {
  const placements = {};
  const participants = new Map((rawMatch.included || []).filter(x => x.type === 'participant').map(x => [x.id, x]));
  for (const roster of (rawMatch.included || []).filter(x => x.type === 'roster')) {
    const rank = roster?.attributes?.stats?.rank || null;
    const won = roster?.attributes?.won === 'true';
    for (const ref of roster?.relationships?.participants?.data || []) {
      const part = participants.get(ref.id);
      const accountId = part?.attributes?.stats?.playerId;
      if (!accountId) continue;
      placements[accountId] = { placement: rank, won };
    }
  }
  return placements;
}

function buildApeTeamMap(rawMatch, memberSet) {
  const participants = new Map((rawMatch.included || []).filter(x => x.type === 'participant').map(x => [x.id, x]));
  const teams = new Map();
  for (const roster of (rawMatch.included || []).filter(x => x.type === 'roster')) {
    const clan = [];
    for (const ref of roster?.relationships?.participants?.data || []) {
      const part = participants.get(ref.id);
      const stats = part?.attributes?.stats;
      if (!stats?.playerId || !memberSet.has(stats.playerId)) continue;
      clan.push({ accountId: stats.playerId, name: stats.name || stats.playerName || stats.playerId, teamId: stats.teamId });
    }
    if (!clan.length) continue;
    const teamId = clan[0].teamId;
    teams.set(teamId, clan);
  }
  return teams;
}

function buildLocalPlayerMap(clanTeams, placements) {
  const out = {};
  for (const [teamId, players] of clanTeams.entries()) {
    for (const p of players) {
      out[p.accountId] = {
        accountId: p.accountId,
        name: p.name,
        teamId,
        placement: placements[p.accountId]?.placement || null,
        won: !!placements[p.accountId]?.won,
        route: [],
        lastRouteZone: null,
        landing: null,
        lastPositionAt: 0,
        lastPosition: null,
        vehicleUsed: false,
        blueDamage: 0,
      };
    }
  }
  return out;
}

function currentSpacing(teamPlayers, playerMap, nowTs) {
  const fresh = teamPlayers
    .map(p => playerMap[p.accountId])
    .filter(p => p?.lastPosition && nowTs - p.lastPositionAt <= POSITION_FRESHNESS_MS);
  if (fresh.length < 2) return null;
  let sum = 0;
  let pairs = 0;
  for (let i = 0; i < fresh.length; i++) {
    for (let j = i + 1; j < fresh.length; j++) {
      const d = distanceMeters(fresh[i].lastPosition, fresh[j].lastPosition);
      if (!Number.isFinite(d)) continue;
      sum += d;
      pairs++;
    }
  }
  if (!pairs) return null;
  return sum / pairs;
}

function finalizeEngagement(window, global) {
  if (!window) return;
  const durationSec = Math.max(1, Math.round((window.endTs - window.startTs) / 1000));
  const clanAdvantage = (window.clanKnocks + window.clanKills) - (window.enemyKnocks + window.enemyKills);
  const converted = window.firstDamageBy === 'clan' && clanAdvantage > 0;
  const collapsed = window.firstDamageBy === 'clan' && clanAdvantage <= 0;
  global.engagements.push({
    matchId: window.matchId,
    map: window.map,
    startTs: window.startTs,
    durationSec,
    clanTeamKey: window.clanTeamKey,
    firstDamageBy: window.firstDamageBy,
    firstKnockBy: window.firstKnockBy,
    clanDamage: Math.round(window.clanDamage),
    enemyDamage: Math.round(window.enemyDamage),
    clanKnocks: window.clanKnocks,
    enemyKnocks: window.enemyKnocks,
    clanKills: window.clanKills,
    enemyKills: window.enemyKills,
    converted,
    collapsed,
    placement: window.placement,
    won: window.won,
  });
}

function buildTelemetryInsights({ verbose = true } = {}) {
  const members = readJsonSafe(MEMBERS_FILE, []);
  const history = readJsonSafe(HISTORY_FILE, { result: {}, summary: {} });
  const memberSet = new Set(members.map(m => m.accountId));
  const memberNameById = Object.fromEntries(members.map(m => [m.accountId, m.name]));
  const seasonState = loadSeasonState();
  const seasonStartAt = seasonState.seasonStartAt || null;
  const seasonId = seasonState.cacheSeasonId || seasonState.seasonId || null;

  const matchFiles = fs.existsSync(MATCH_DIR)
    ? fs.readdirSync(MATCH_DIR).filter(f => f.endsWith('.json'))
    : [];

  const global = {
    officialMatches: 0,
    telemetryMatches: 0,
    positionsSampled: 0,
    players: {},
    teams: {},
    routes: {},
    dropZones: {},
    engagements: [],
    contestedTeams: { contested: 0, contestedTop10s: 0, contestedWins: 0, free: 0, freeTop10s: 0, freeWins: 0 },
    spacingBuckets: {
      tight: { matches: 0, top10s: 0, wins: 0 },
      balanced: { matches: 0, top10s: 0, wins: 0 },
      wide: { matches: 0, top10s: 0, wins: 0 },
    },
    zone: { blueDamage: 0, blueDeaths: 0, exposedMatches: 0, cleanMatches: 0 },
    vehicles: {
      withVehicle: { matches: 0, top10s: 0, wins: 0 },
      onFoot: { matches: 0, top10s: 0, wins: 0 },
      types: {},
    },
    range: {
      close: { damage: 0, knocks: 0, kills: 0, events: 0 },
      mid:   { damage: 0, knocks: 0, kills: 0, events: 0 },
      long:  { damage: 0, knocks: 0, kills: 0, events: 0 },
    },
    knocks: { knocks: 0, conversionKills: 0, totalKills: 0 },
    clutch: { firstKnockAgainst: 0, recoveredTop10: 0, recoveredWins: 0 },
  };

  for (const file of matchFiles) {
    const matchId = file.replace('.json', '');
    const rawMatch = readJsonSafe(path.join(MATCH_DIR, file), null);
    const attrs = rawMatch?.data?.attributes || {};
    if (!rawMatch || !isCountingSquadMatch(attrs)) continue;
    if (!isCurrentSeasonMatch(attrs.createdAt, seasonStartAt)) continue;
    global.officialMatches++;

    const events = readCachedTelemetry(matchId);
    if (!Array.isArray(events) || !events.length) continue;

    const clanTeams = buildApeTeamMap(rawMatch, memberSet);
    if (!clanTeams.size) continue;
    global.telemetryMatches++;

    const placements = getPlacementMap(rawMatch);
    const playerMap = buildLocalPlayerMap(clanTeams, placements);
    const teamMeta = {};
    const activeEngagements = new Map();
    const lastDamageTypeByVictim = {};
    const firstKnockState = {};
    const landingEvents = [];
    const lastSpacingSampleAt = {};
    const groggyOwnerByVictim = {};

    for (const [teamId, players] of clanTeams.entries()) {
      const names = players.map(p => memberNameById[p.accountId] || p.name).sort();
      const teamKey = names.join(' + ');
      teamMeta[teamId] = {
        teamId,
        teamKey,
        players,
        placement: Math.min(...players.map(p => placements[p.accountId]?.placement || 99)),
        won: players.some(p => placements[p.accountId]?.won),
        blueDamage: 0,
        blueDeaths: 0,
        spacingSum: 0,
        spacingSamples: 0,
        knockSpacingSum: 0,
        knockSpacingEvents: 0,
        vehicleUsed: false,
        firstKnockAgainst: false,
      };
      firstKnockState[teamId] = { clan: false, enemy: false };
    }

    function noteEngagement(clanTeamId, enemyTeamId, nowTs, update) {
      if (!teamMeta[clanTeamId] || !enemyTeamId || clanTeams.has(enemyTeamId)) return;
      const key = `${clanTeamId}:${enemyTeamId}`;
      let window = activeEngagements.get(key);
      if (window && nowTs - window.lastTs > ENGAGEMENT_GAP_MS) {
        finalizeEngagement(window, global);
        window = null;
      }
      if (!window) {
        window = {
          matchId,
          map: attrs.mapName || 'Unknown',
          clanTeamKey: teamMeta[clanTeamId].teamKey,
          placement: teamMeta[clanTeamId].placement,
          won: teamMeta[clanTeamId].won,
          startTs: nowTs,
          endTs: nowTs,
          lastTs: nowTs,
          firstDamageBy: null,
          firstKnockBy: null,
          clanDamage: 0,
          enemyDamage: 0,
          clanKnocks: 0,
          enemyKnocks: 0,
          clanKills: 0,
          enemyKills: 0,
        };
      }
      update(window);
      window.endTs = nowTs;
      window.lastTs = nowTs;
      activeEngagements.set(key, window);
    }

    for (const evt of events) {
      const ts = Date.parse(evt?._D || 0);
      if (!Number.isFinite(ts)) continue;

      if (evt._T === 'LogParachuteLanding') {
        const ch = evt.character;
        if (!ch?.accountId) continue;
        landingEvents.push({
          accountId: ch.accountId,
          teamId: ch.teamId,
          at: ts,
          location: ch.location || null,
          zone: zoneName(ch.zone),
          isApe: memberSet.has(ch.accountId),
        });
      }

      if (evt._T === 'LogPlayerPosition') {
        const ch = evt.character;
        if (!memberSet.has(ch?.accountId) || !playerMap[ch.accountId]) continue;
        const player = playerMap[ch.accountId];
        player.lastPosition = ch.location || null;
        player.lastPositionAt = ts;
        const z = zoneName(ch.zone);
        if (z && z !== 'Unknown' && z !== player.lastRouteZone) {
          player.lastRouteZone = z;
          player.route.push(z);
        }
        const team = teamMeta[player.teamId];
        if (!team) continue;
        const lastSample = lastSpacingSampleAt[player.teamId] || 0;
        if (ts - lastSample >= POSITION_SAMPLE_GAP_MS) {
          const spacing = currentSpacing(team.players, playerMap, ts);
          if (spacing != null) {
            team.spacingSum += spacing;
            team.spacingSamples++;
            lastSpacingSampleAt[player.teamId] = ts;
            global.positionsSampled++;
          }
        }
        continue;
      }

      if (evt._T === 'LogPlayerRevive') {
        const revivedId = evt.victim?.accountId;
        if (revivedId) delete groggyOwnerByVictim[revivedId];
        continue;
      }

      if (evt._T === 'LogVehicleRide' || evt._T === 'LogVehicleLeave') {
        const ch = evt.character;
        if (!memberSet.has(ch?.accountId) || !playerMap[ch.accountId]) continue;
        const player = playerMap[ch.accountId];
        player.vehicleUsed = true;
        const team = teamMeta[player.teamId];
        if (team) team.vehicleUsed = true;
        const type = evt.vehicle?.vehicleType || 'Vehicle';
        global.vehicles.types[type] = (global.vehicles.types[type] || 0) + 1;
        continue;
      }

      if (evt._T === 'LogPlayerTakeDamage') {
        const attacker = evt.attacker;
        const victim = evt.victim;
        const damage = evt.damage || 0;
        const attackerIsApe = memberSet.has(attacker?.accountId);
        const victimIsApe = memberSet.has(victim?.accountId);

        if (victimIsApe) {
          lastDamageTypeByVictim[victim.accountId] = {
            at: ts,
            type: evt.damageTypeCategory || '',
            isBlue: evt.damageTypeCategory === 'Damage_BlueZone',
          };
          const player = playerMap[victim.accountId];
          if (evt.damageTypeCategory === 'Damage_BlueZone' && player) {
            player.blueDamage += damage;
            const team = teamMeta[player.teamId];
            if (team) team.blueDamage += damage;
            global.zone.blueDamage += damage;
          }
        }

        if (attackerIsApe && victim?.teamId != null && playerMap[attacker.accountId]) {
          const player = ensurePlayer(global.players, attacker.accountId, playerMap[attacker.accountId].name);
          const dist = distanceMeters(attacker.location, victim.location);
          const bucket = bucketRange(dist);
          player.range[bucket].damage += damage;
          player.range[bucket].events++;
          global.range[bucket].damage += damage;
          global.range[bucket].events++;
          noteEngagement(playerMap[attacker.accountId].teamId, victim.teamId, ts, window => {
            window.clanDamage += damage;
            if (!window.firstDamageBy) window.firstDamageBy = 'clan';
          });
        } else if (victimIsApe && attacker?.teamId != null && playerMap[victim.accountId]) {
          noteEngagement(playerMap[victim.accountId].teamId, attacker.teamId, ts, window => {
            window.enemyDamage += damage;
            if (!window.firstDamageBy) window.firstDamageBy = 'enemy';
          });
        }
        continue;
      }

      if (evt._T === 'LogPlayerMakeGroggy') {
        const attacker = evt.attacker;
        const victim = evt.victim;
        const attackerIsApe = memberSet.has(attacker?.accountId);
        const victimIsApe = memberSet.has(victim?.accountId);

        if (attackerIsApe && victim?.teamId != null && playerMap[attacker.accountId]) {
          const player = ensurePlayer(global.players, attacker.accountId, playerMap[attacker.accountId].name);
          player.knocks++;
          global.knocks.knocks++;
          if (victim?.accountId) {
            groggyOwnerByVictim[victim.accountId] = { side: 'clan', teamId: playerMap[attacker.accountId].teamId };
          }
          const dist = distanceMeters(attacker.location, victim.location);
          const bucket = bucketRange(dist);
          player.range[bucket].knocks++;
          global.range[bucket].knocks++;
          const teamId = playerMap[attacker.accountId].teamId;
          const knockState = firstKnockState[teamId];
          if (!knockState.clan && !knockState.enemy) knockState.clan = true;
          noteEngagement(teamId, victim.teamId, ts, window => {
            window.clanKnocks++;
            if (!window.firstKnockBy) window.firstKnockBy = 'clan';
          });
        }

        if (victimIsApe && attacker?.teamId != null && playerMap[victim.accountId]) {
          const teamId = playerMap[victim.accountId].teamId;
          const knockState = firstKnockState[teamId];
          const team = teamMeta[teamId];
          if (!knockState || !team) continue;
          if (!knockState.clan && !knockState.enemy) {
            knockState.enemy = true;
            team.firstKnockAgainst = true;
          }
          const spacing = currentSpacing(team.players, playerMap, ts);
          if (spacing != null) {
            team.knockSpacingSum += spacing;
            team.knockSpacingEvents++;
          }
          noteEngagement(teamId, attacker.teamId, ts, window => {
            window.enemyKnocks++;
            if (!window.firstKnockBy) window.firstKnockBy = 'enemy';
          });
        }
        continue;
      }

      if (evt._T === 'LogPlayerKillV2') {
        const killer = evt.killer;
        const victim = evt.victim;
        const killerIsApe = memberSet.has(killer?.accountId);
        const victimIsApe = memberSet.has(victim?.accountId);
        const killerTeamId = killer?.teamId;
        const victimTeamId = victim?.teamId;
        const dist = evt.killerDamageInfo?.distance
          ? Math.round(evt.killerDamageInfo.distance / 100)
          : distanceMeters(killer?.location, victim?.location);

        if (killerIsApe && victimTeamId != null && playerMap[killer.accountId]) {
          const player = ensurePlayer(global.players, killer.accountId, playerMap[killer.accountId].name);
          player.kills++;
          global.knocks.totalKills++;
          if (victim?.accountId && groggyOwnerByVictim[victim.accountId]?.side === 'clan') {
            global.knocks.conversionKills++;
            player.conversionKills++;
            delete groggyOwnerByVictim[victim.accountId];
          }
          const bucket = bucketRange(dist);
          player.range[bucket].kills++;
          global.range[bucket].kills++;
          noteEngagement(playerMap[killer.accountId].teamId, victimTeamId, ts, window => {
            window.clanKills++;
            if (!window.firstKnockBy) window.firstKnockBy = 'clan';
          });
        }

        if (victimIsApe && victimTeamId != null && killerTeamId != null && playerMap[victim.accountId]) {
          const last = lastDamageTypeByVictim[victim.accountId];
          if (last?.isBlue && ts - last.at <= 20000) {
            global.zone.blueDeaths++;
            const player = ensurePlayer(global.players, victim.accountId, playerMap[victim.accountId].name);
            player.blueDeaths++;
            const team = teamMeta[playerMap[victim.accountId].teamId] || teamMeta[victimTeamId];
            if (team) team.blueDeaths++;
          }
          noteEngagement(victimTeamId, killerTeamId, ts, window => {
            window.enemyKills++;
            if (!window.firstKnockBy) window.firstKnockBy = 'enemy';
          });
        }
        continue;
      }
    }

    for (const window of activeEngagements.values()) finalizeEngagement(window, global);

    const enemyLandings = landingEvents.filter(e => !e.isApe && e.location);
    for (const [teamId, team] of Object.entries(teamMeta)) {
      const teamPlacement = team.placement || 99;
      const teamTop10 = teamPlacement <= 10;
      const spacingAvg = team.spacingSamples ? team.spacingSum / team.spacingSamples : null;
      const teamStore = ensureTeam(global.teams, team.teamKey, team.players.map(p => p.name).sort());
      teamStore.matches++;
      if (team.won) teamStore.wins++;
      if (teamTop10) teamStore.top10s++;
      if (spacingAvg != null) {
        teamStore.avgSpacingSum += spacingAvg;
        teamStore.avgSpacingMatches++;
        const bucket = spacingAvg < 40 ? 'tight' : spacingAvg <= 90 ? 'balanced' : 'wide';
        global.spacingBuckets[bucket].matches++;
        if (teamTop10) global.spacingBuckets[bucket].top10s++;
        if (team.won) global.spacingBuckets[bucket].wins++;
      }
      if (team.knockSpacingEvents) {
        teamStore.knockSpacingSum += team.knockSpacingSum;
        teamStore.knockSpacingEvents += team.knockSpacingEvents;
      }
      if (team.firstKnockAgainst) {
        teamStore.firstKnockAgainst++;
        global.clutch.firstKnockAgainst++;
        if (teamTop10) {
          teamStore.clutchRecoveries++;
          global.clutch.recoveredTop10++;
        }
        if (team.won) global.clutch.recoveredWins++;
      }

      const vehicleBucket = team.vehicleUsed ? global.vehicles.withVehicle : global.vehicles.onFoot;
      vehicleBucket.matches++;
      if (teamTop10) vehicleBucket.top10s++;
      if (team.won) vehicleBucket.wins++;

      const hadBlue = team.blueDamage > 0 || team.blueDeaths > 0;
      if (hadBlue) global.zone.exposedMatches++;
      else global.zone.cleanMatches++;

      let contested = false;
      let landingZoneKey = 'Unknown';
      for (const p of team.players) {
        const local = playerMap[p.accountId];
        const playerStore = ensurePlayer(global.players, p.accountId, memberNameById[p.accountId] || p.name);
        playerStore.matches++;
        playerStore.blueDamage += local.blueDamage;
        if (team.vehicleUsed) {
          playerStore.vehicleMatches++;
          if (teamTop10) playerStore.vehicleTop10s++;
        } else {
          playerStore.noVehicleMatches++;
          if (teamTop10) playerStore.noVehicleTop10s++;
        }

        if (local.route.length >= 2) {
          const routeKey = [...new Set(local.route)].slice(0, 4).map(prettyZone).join(' → ');
          const route = ensureRoute(global.routes, routeKey);
          route.matches++;
          route.placementSum += teamPlacement;
          if (teamTop10) route.top10s++;
          if (team.won) route.wins++;
          if (hadBlue) route.blueMatches++;
        }

        const apeLanding = landingEvents.find(e => e.accountId === p.accountId);
        if (apeLanding) {
          landingZoneKey = prettyZone(apeLanding.zone);
          const nearby = enemyLandings.some(enemy => {
            if (Math.abs(enemy.at - apeLanding.at) > CONTEST_WINDOW_MS) return false;
            const d = distanceMeters(enemy.location, apeLanding.location);
            return Number.isFinite(d) && d <= CONTEST_RADIUS_M;
          });
          if (nearby) contested = true;
        }
      }

      const zoneBucket = ensureDropZone(global.dropZones, landingZoneKey);
      if (contested) {
        global.contestedTeams.contested++;
        zoneBucket.contested++;
        if (teamTop10) {
          global.contestedTeams.contestedTop10s++;
          zoneBucket.contestedTop10s++;
        }
        if (team.won) global.contestedTeams.contestedWins++;
      } else {
        global.contestedTeams.free++;
        zoneBucket.free++;
        if (teamTop10) {
          global.contestedTeams.freeTop10s++;
          zoneBucket.freeTop10s++;
        }
        if (team.won) global.contestedTeams.freeWins++;
      }

      for (const p of team.players) {
        const playerStore = ensurePlayer(global.players, p.accountId, memberNameById[p.accountId] || p.name);
        if (contested) {
          playerStore.contestedDrops++;
          if (teamTop10) playerStore.contestedTop10s++;
        } else {
          playerStore.uncontestedDrops++;
          if (teamTop10) playerStore.uncontestedTop10s++;
        }
        if (team.firstKnockAgainst) {
          playerStore.firstKnockAgainstMatches++;
          if (teamTop10) playerStore.clutchRecoveries++;
        }
      }
    }
  }

  for (const eng of global.engagements) {
    const team = Object.values(global.teams).find(t => t.teamKey === eng.clanTeamKey);
    if (!team) continue;
    if (eng.firstDamageBy === 'clan') {
      for (const p of team.players) {
        const player = ensurePlayer(global.players, p.accountId, p.name);
        player.openingFights++;
        if (eng.converted) player.openingConversions++;
      }
    }
  }

  const officialGames = global.officialMatches;
  const telemetryRate = officialGames ? safeDiv(global.telemetryMatches, officialGames, 3) : 0;
  const players = Object.entries(global.players).map(([accountId, stats]) => ({ accountId, ...stats }));
  const teams = Object.values(global.teams);
  const routes = Object.entries(global.routes)
    .map(([route, s]) => ({ route, ...s, avgPlacement: avg(s.placementSum, s.matches, 1), top10Rate: pctNum(s.top10s, s.matches, 1), blueRate: pctNum(s.blueMatches, s.matches, 1) }))
    .sort((a, b) => b.matches - a.matches);
  const dropZones = Object.entries(global.dropZones)
    .map(([zone, s]) => ({
      zone,
      contested: s.contested,
      free: s.free,
      contestedTop10Rate: pctNum(s.contestedTop10s, s.contested, 1),
      freeTop10Rate: pctNum(s.freeTop10s, s.free, 1),
    }))
    .sort((a, b) => (b.contested + b.free) - (a.contested + a.free));

  const bestRoute = routes.filter(r => r.matches >= 5).sort((a, b) => b.top10Rate - a.top10Rate)[0] || routes[0] || null;
  const worstRoute = routes.filter(r => r.matches >= 5).sort((a, b) => a.top10Rate - b.top10Rate)[0] || null;
  const balancedSpacing = global.spacingBuckets.balanced;
  const wideSpacing = global.spacingBuckets.wide;
  const fightWindows = [...global.engagements].sort((a, b) => (b.clanDamage + b.enemyDamage + (b.clanKnocks + b.enemyKnocks) * 150) - (a.clanDamage + a.enemyDamage + (a.clanKnocks + a.enemyKnocks) * 150)).slice(0, 3);
  const avgFightDuration = avg(global.engagements.reduce((s, e) => s + e.durationSec, 0), global.engagements.length, 0);
  const openingFights = global.engagements.filter(e => e.firstDamageBy === 'clan').length;
  const openingConversions = global.engagements.filter(e => e.firstDamageBy === 'clan' && e.converted).length;
  const openingCollapses = global.engagements.filter(e => e.firstDamageBy === 'clan' && e.collapsed).length;
  const cleanRotatePct = pctNum(global.zone.cleanMatches, global.zone.cleanMatches + global.zone.exposedMatches, 1);
  const blueExposurePct = pctNum(global.zone.exposedMatches, global.zone.cleanMatches + global.zone.exposedMatches, 1);
  const openingConversionPct = pctNum(openingConversions, openingFights, 1);
  const openingCollapsePct = pctNum(openingCollapses, openingFights, 1);
  const contestedRate = pctNum(global.contestedTeams.contested, global.contestedTeams.contested + global.contestedTeams.free, 1);
  const contestedTop10 = pctNum(global.contestedTeams.contestedTop10s, global.contestedTeams.contested, 1);
  const freeTop10 = pctNum(global.contestedTeams.freeTop10s, global.contestedTeams.free, 1);
  const contestedHotspot = dropZones
    .filter(z => z.zone !== 'Unknown' && z.contested >= 3)
    .sort((a, b) => b.contested - a.contested)[0] || null;
  const knockLeaders = players
    .filter(p => p.knocks >= 5)
    .map(p => ({ name: p.name, finishRate: pctNum(p.conversionKills, p.knocks, 0), knocks: p.knocks, kills: p.conversionKills }))
    .sort((a, b) => b.finishRate - a.finishRate)
    .slice(0, 4);
  const vehicleTop10 = pctNum(global.vehicles.withVehicle.top10s, global.vehicles.withVehicle.matches, 1);
  const onFootTop10 = pctNum(global.vehicles.onFoot.top10s, global.vehicles.onFoot.matches, 1);
  const topVehicleType = Object.entries(global.vehicles.types).sort((a, b) => b[1] - a[1])[0] || null;
  const rangeRows = ['close', 'mid', 'long'].map(key => {
    const item = global.range[key];
    return {
      key,
      label: key === 'close' ? '0-40m' : key === 'mid' ? '41-120m' : '120m+',
      damage: Math.round(item.damage),
      knocks: item.knocks,
      kills: item.kills,
      killRate: pctNum(item.kills, Math.max(item.knocks, 1), 0),
    };
  });
  const bestRange = [...rangeRows].sort((a, b) => b.kills - a.kills)[0];
  const totalRangeKills = rangeRows.reduce((sum, row) => sum + row.kills, 0);
  const dominantRangeShare = bestRange ? pctNum(bestRange.kills, totalRangeKills, 1) : 0;
  const balancedTop10Pct = pctNum(balancedSpacing.top10s, balancedSpacing.matches, 1);
  const wideTop10Pct = pctNum(wideSpacing.top10s, wideSpacing.matches, 1);
  const knockConversionPct = pctNum(global.knocks.conversionKills, global.knocks.knocks, 1);
  const clutchTop10 = pctNum(global.clutch.recoveredTop10, global.clutch.firstKnockAgainst, 1);
  const clutchWins = pctNum(global.clutch.recoveredWins, global.clutch.firstKnockAgainst, 1);
  const bestClutchSquad = teams
    .filter(t => t.firstKnockAgainst >= 3)
    .map(t => ({ teamKey: t.teamKey, recoveryRate: pctNum(t.clutchRecoveries, t.firstKnockAgainst, 1), attempts: t.firstKnockAgainst }))
    .sort((a, b) => b.recoveryRate - a.recoveryRate)[0] || null;

  const cards = [
    {
      id: 'rotation_grade',
      title: 'Rotation Grade',
      accent: '#60a5fa',
      status: cleanRotatePct >= 62
        ? { label: 'Stable route discipline', tone: 'good' }
        : cleanRotatePct >= 50
          ? { label: 'Playable but taxed', tone: 'warn' }
          : { label: 'Late-rotate tax', tone: 'bad' },
      confidence: {
        ...sampleConfidence(global.telemetryMatches, 700, 250),
        basis: `${global.telemetryMatches} telemetry matches`,
      },
      hero: {
        value: `${Math.round(cleanRotatePct)}%`,
        unit: 'clean rotates',
        sub: `${global.telemetryMatches} tracked matches`,
        score: cleanRotatePct,
        scoreLabel: 'route health',
      },
      finding: bestRoute
        ? `The cleanest common route in tracked official matches is ${bestRoute.route}, which has turned into a top-10 ${bestRoute.top10Rate}% of the time across ${bestRoute.matches} samples. The main rotation tax right now is blue-zone exposure: ${fmtPct(global.zone.exposedMatches, global.zone.cleanMatches + global.zone.exposedMatches)} of tracked clan matches took meaningful zone damage during the move.`
        : 'Telemetry coverage is present, but there are not enough route samples yet to name a reliable common path.',
      meaning: bestRoute
        ? `This reads like a route-discipline issue more than a pure mechanics issue. 3PI already has a reusable safe lane; the wasted equity is coming from choosing slower or greedier move patterns often enough to drag the squad into blue-zone timing.`
        : 'Telemetry has started filling in, but the route tree is still too thin to promote one path into a repeatable macro rule.',
      tip: worstRoute
        ? `Copy the best route family more often and review the weak one. ${worstRoute.route} has been the least efficient frequent path so far at ${worstRoute.top10Rate}% top-10s with blue exposure in ${worstRoute.blueRate}% of its tracked matches.`
        : 'Use the route tracker to compare early rotates by map and cut paths that repeatedly force blue-zone play.',
      actions: [
        bestRoute ? `Default more often into the ${bestRoute.route} family when the plane and circle allow it.` : 'Keep collecting route samples before locking in a preferred macro path.',
        worstRoute ? `Trim loot and leave earlier on ${worstRoute.route}; it is the current route tax.` : 'Flag blue-zone games for route review instead of blaming final-fight variance.',
      ],
      bars: [
        makeBar('Clean rotates', cleanRotatePct, `${cleanRotatePct.toFixed(1)}%`, 'tracked official matches with no meaningful blue tax'),
        makeBar('Blue exposure', blueExposurePct, `${blueExposurePct.toFixed(1)}%`, 'matches that took meaningful blue-zone damage'),
        makeBar('Best route top-10', bestRoute?.top10Rate || 0, bestRoute ? `${bestRoute.top10Rate.toFixed(1)}%` : 'n/a', bestRoute ? bestRoute.route : 'not enough route samples'),
        makeBar('Worst route top-10', worstRoute?.top10Rate || 0, worstRoute ? `${worstRoute.top10Rate.toFixed(1)}%` : 'n/a', worstRoute ? worstRoute.route : 'not enough route samples'),
      ],
      stats: [
        { label: 'Best route', value: bestRoute ? `${bestRoute.route} · ${bestRoute.top10Rate}% top-10` : 'Not enough data' },
        { label: 'Worst frequent route', value: worstRoute ? `${worstRoute.route} · ${worstRoute.top10Rate}% top-10` : 'Not enough data' },
        { label: 'Blue exposure', value: `${Math.round(global.zone.blueDamage)} total blue dmg` },
      ],
    },
    {
      id: 'fight_timeline',
      title: 'Fight Timeline',
      accent: '#f87171',
      status: openingConversionPct >= 50
        ? { label: 'Fast closeouts', tone: 'good' }
        : openingConversionPct >= 38
          ? { label: 'Mixed closeouts', tone: 'warn' }
          : { label: 'Messy fight windows', tone: 'bad' },
      confidence: {
        ...sampleConfidence(global.engagements.length, 1000, 300),
        basis: `${global.engagements.length} fight windows`,
      },
      hero: {
        value: String(avgFightDuration),
        unit: 'sec avg fight length',
        sub: `${global.engagements.length} tracked fight windows`,
        score: openingConversionPct,
        scoreLabel: 'closeout health',
      },
      finding: `3PI fights are lasting about ${avgFightDuration} seconds on average in the telemetry sample. When the clan lands opening damage first, it converts that initiative ${fmtPct(openingConversions, openingFights)} of the time, but ${fmtPct(openingCollapses, openingFights)} of opening tags still fade into neutral or losing windows.`,
      meaning: 'The issue is not generating contact. The sample says 3PI is often good enough to start a fight on its terms, but too many of those fights stay open long enough for resets, third parties, or counter-knocks to erase the edge.',
      tip: 'Treat the first 20 seconds after opening damage as collapse time. The point of this card is to shrink long messy windows where 3PI tags first but lets the enemy reset.',
      actions: [
        'Call the first damage and turn it into an immediate timing cue for the whole squad.',
        'Review long fights for reset windows: late pushes, split angles, or one player arriving after the down.',
      ],
      bars: [
        makeBar('Openings converted', openingConversionPct, `${openingConversionPct.toFixed(1)}%`, '3PI opened the fight and came out ahead'),
        makeBar('Openings that stalled', openingCollapsePct, `${openingCollapsePct.toFixed(1)}%`, '3PI tagged first but did not keep the edge'),
        makeBar('Fight length pressure', clamp((avgFightDuration / 60) * 100), `${avgFightDuration}s`, 'longer windows create more reset opportunities'),
      ],
      rows: fightWindows.map(f => ({
        name: `${mapDisplay(f.map)} · ${placementLabel(f.placement)}`,
        value: `${f.durationSec}s · ${f.clanKnocks}-${f.enemyKnocks} knocks · ${Math.round(f.clanDamage)}-${Math.round(f.enemyDamage)} dmg`,
        sub: `${f.clanTeamKey} · ${f.firstDamageBy === 'clan' ? '3PI opened' : 'enemy opened'}`,
      })),
    },
    {
      id: 'squad_spacing',
      title: 'Squad Spacing',
      accent: '#34d399',
      status: balancedTop10Pct - wideTop10Pct >= 10
        ? { label: 'Balanced spacing wins', tone: 'good' }
        : balancedTop10Pct >= wideTop10Pct
          ? { label: 'Spacing matters', tone: 'warn' }
          : { label: 'Spacing model unclear', tone: 'neutral' },
      confidence: {
        ...sampleConfidence(balancedSpacing.matches, 220, 70),
        basis: `${balancedSpacing.matches} balanced-spacing samples`,
      },
      hero: {
        value: `${Math.round(balancedTop10Pct)}%`,
        unit: 'top-10 rate at 40-90m',
        sub: `${balancedSpacing.matches} balanced-spacing matches`,
        score: balancedTop10Pct,
        scoreLabel: 'collapse shape',
      },
      finding: `The healthiest squad shape in tracked matches has been a balanced ${balancedSpacing.matches ? '40-90m' : 'n/a'} spread. Teams in that spacing band are reaching top-10 at ${fmtPct(balancedSpacing.top10s, balancedSpacing.matches)} compared with ${fmtPct(wideSpacing.top10s, wideSpacing.matches)} when average spacing blows out past 90m.`,
      meaning: 'This is the cleanest evidence that 3PI does best when it keeps enough width to hold angles, but not so much width that trades turn into solo rescues.',
      tip: 'Keep a default collapse distance in mind. If the spacing trend drifts wide before first contact, expect slower trades and more staggered knocks.',
      actions: [
        'Treat 40-90m as the default “healthy spread” unless terrain forces a tighter stack.',
        'If first contact starts with a wide shape, collapse first and peek second.',
      ],
      bars: [
        makeBar('Balanced spacing', balancedTop10Pct, `${balancedTop10Pct.toFixed(1)}%`, 'top-10 rate when average spacing stays in the 40-90m band'),
        makeBar('Wide spacing', wideTop10Pct, `${wideTop10Pct.toFixed(1)}%`, 'top-10 rate when average spacing drifts beyond 90m'),
        makeBar('Spacing edge', clamp(50 + (balancedTop10Pct - wideTop10Pct) * 2), `${(balancedTop10Pct - wideTop10Pct).toFixed(1)} pts`, 'positive means balanced spacing is outperforming wide spacing'),
      ],
      stats: teams
        .filter(t => t.avgSpacingMatches >= 3)
        .sort((a, b) => safeDiv(b.top10s, b.matches, 3) - safeDiv(a.top10s, a.matches, 3))
        .slice(0, 3)
        .map(t => ({ label: t.teamKey, value: `${avg(t.avgSpacingSum, t.avgSpacingMatches, 0)}m avg spacing · ${fmtPct(t.top10s, t.matches)} top-10` })),
    },
    {
      id: 'zone_death_audit',
      title: 'Zone Death Audit',
      accent: '#fb923c',
      status: blueExposurePct <= 28
        ? { label: 'Zone under control', tone: 'good' }
        : blueExposurePct <= 40
          ? { label: 'Manageable tax', tone: 'warn' }
          : { label: 'Blue-zone leak', tone: 'bad' },
      confidence: {
        ...sampleConfidence(global.telemetryMatches, 700, 250),
        basis: `${global.telemetryMatches} telemetry matches`,
      },
      hero: {
        value: String(global.zone.blueDeaths),
        unit: 'blue-zone deaths',
        sub: `${Math.round(global.zone.blueDamage)} blue-zone damage tracked`,
        score: clamp(100 - blueExposurePct),
        scoreLabel: 'zone discipline',
      },
      finding: `Blue zone has directly killed 3PI ${global.zone.blueDeaths} times in cached telemetry and forced damage in ${fmtPct(global.zone.exposedMatches, global.zone.cleanMatches + global.zone.exposedMatches)} of tracked matches. That does not just cost health; it drags the whole rotation clock late.`,
      meaning: 'Blue damage is not just chip damage. It usually means the squad is entering the next decision late, low on meds, or too rushed to choose a clean fight.',
      tip: 'Use this as the anti-greed card. If a route or loot pattern repeatedly appears in blue-exposure games, cut it before it becomes a habit.',
      actions: [
        'Review loot exits, not just zone deaths; the real mistake often happens two minutes before the damage lands.',
        'If a map consistently produces blue-tax games, shorten the opener there before changing late-game fighting plans.',
      ],
      bars: [
        makeBar('Blue exposure', blueExposurePct, `${blueExposurePct.toFixed(1)}%`, 'tracked matches with meaningful blue damage'),
        makeBar('Clean rotations', cleanRotatePct, `${cleanRotatePct.toFixed(1)}%`, 'tracked matches without a meaningful blue tax'),
        makeBar('Blue death rate', pctNum(global.zone.blueDeaths, global.telemetryMatches, 1), `${global.zone.blueDeaths} deaths`, 'direct blue-zone deaths per telemetry sample'),
      ],
      stats: players
        .filter(p => p.blueDamage > 0)
        .sort((a, b) => b.blueDamage - a.blueDamage)
        .slice(0, 4)
        .map(p => ({ label: p.name, value: `${Math.round(p.blueDamage)} dmg · ${p.blueDeaths} blue deaths` })),
    },
    {
      id: 'opening_damage_conversion',
      title: 'Opening Damage Conversion',
      accent: '#38bdf8',
      status: openingConversionPct >= 45
        ? { label: 'Good first-hit value', tone: 'good' }
        : openingConversionPct >= 32
          ? { label: 'Edge not fully cashed', tone: 'warn' }
          : { label: 'First-hit leak', tone: 'bad' },
      confidence: {
        ...sampleConfidence(openingFights, 700, 250),
        basis: `${openingFights} 3PI-opened fights`,
      },
      hero: {
        value: `${Math.round(openingConversionPct)}%`,
        unit: 'of 3PI openings convert',
        sub: `${openingFights} 3PI-opened fight windows`,
        score: openingConversionPct,
        scoreLabel: 'first-hit value',
      },
      finding: `When 3PI gets the first real damage in a fight, the clan currently converts that edge ${fmtPct(openingConversions, openingFights)} of the time. That is solid, but the leak is obvious: ${openingCollapses} tracked windows started with 3PI damage and still ended without advantage.`,
      meaning: 'This is the fastest diagnostic card for “are we wasting free equity?” If the answer stays low, the problem is usually timing, not aim.',
      tip: 'Call the opening tag and force the follow-up immediately. This is the cleanest stat for “we start fights fine, then fail to cash them in.”',
      actions: [
        'Name the cracked player and force the whole squad onto the same collapse clock.',
        'If the team cannot close instantly, convert the tag into space or reset rather than dribbling out isolated peeks.',
      ],
      bars: [
        makeBar('Openings converted', openingConversionPct, `${openingConversionPct.toFixed(1)}%`, '3PI-created edges that became a real advantage'),
        makeBar('Openings wasted', openingCollapsePct, `${openingCollapsePct.toFixed(1)}%`, 'first-damage windows that flattened back out'),
      ],
      stats: players
        .filter(p => p.openingFights >= 3)
        .map(p => ({ label: p.name, value: `${fmtPct(p.openingConversions, p.openingFights)} on ${p.openingFights} openings` }))
        .sort((a, b) => parseFloat(b.value) - parseFloat(a.value))
        .slice(0, 4),
    },
    {
      id: 'drop_contest_intelligence',
      title: 'Drop Contest Intelligence',
      accent: '#facc15',
      status: contestedTop10 >= freeTop10 - 5
        ? { label: 'Contest-ready', tone: 'good' }
        : contestedTop10 >= freeTop10 - 15
          ? { label: 'Contests are costly', tone: 'warn' }
          : { label: 'Hot-drop tax', tone: 'bad' },
      confidence: {
        ...sampleConfidence(global.contestedTeams.contested + global.contestedTeams.free, 500, 150),
        basis: `${global.contestedTeams.contested + global.contestedTeams.free} team-drop reads`,
      },
      hero: {
        value: `${contestedRate.toFixed(0)}%`,
        unit: 'of tracked team drops contested',
        sub: contestedHotspot ? `${contestedHotspot.zone} is the busiest hot zone` : 'contest map still forming',
        score: clamp(100 - contestedRate),
        scoreLabel: 'drop stability',
      },
      finding: `Tracked team drops are contested ${contestedRate.toFixed(1)}% of the time. The clan reaches top-10 at ${contestedTop10.toFixed(1)}% from contested starts versus ${freeTop10.toFixed(1)}% from free ones, which gives a real answer to whether the hot drop tax is worth it.`,
      meaning: 'This card is really about opener stability. If contested starts are dragging placement well below free starts, 3PI is spending too much of its game budget surviving the first two minutes.',
      tip: 'If a zone is contested often and the top-10 rate collapses there, demote it from the regular rotation instead of pretending every bad opener was random.',
      actions: [
        contestedHotspot ? `Audit ${contestedHotspot.zone} first; it is the most repeated stress test in the sample.` : 'Keep flagging repeated contest zones until a stable hotspot emerges.',
        'Keep only the contested drops that still preserve a respectable path into top-10.',
      ],
      bars: [
        makeBar('Contest rate', contestedRate, `${contestedRate.toFixed(1)}%`, 'team drops that faced a nearby enemy landing'),
        makeBar('Contested top-10', contestedTop10, `${contestedTop10.toFixed(1)}%`, 'how often hot starts still become stable games'),
        makeBar('Free-start top-10', freeTop10, `${freeTop10.toFixed(1)}%`, 'placement floor when 3PI gets the opener it wants'),
      ],
      stats: [
        { label: 'Contested starts', value: `${global.contestedTeams.contested} teams · ${contestedTop10.toFixed(1)}% top-10` },
        { label: 'Free starts', value: `${global.contestedTeams.free} teams · ${freeTop10.toFixed(1)}% top-10` },
        { label: 'Top hotspot', value: contestedHotspot ? `${contestedHotspot.zone} · ${contestedHotspot.contested} contested drops` : 'Not enough data' },
      ],
    },
    {
      id: 'knock_conversion',
      title: 'Knock Conversion',
      accent: '#a78bfa',
      status: knockConversionPct >= 72
        ? { label: 'Clean finishes', tone: 'good' }
        : knockConversionPct >= 60
          ? { label: 'Some downs escape', tone: 'warn' }
          : { label: 'Finish discipline leak', tone: 'bad' },
      confidence: {
        ...sampleConfidence(global.knocks.knocks, 1200, 400),
        basis: `${global.knocks.knocks} 3PI knocks`,
      },
      hero: {
        value: `${Math.round(knockConversionPct)}%`,
        unit: 'self-converted knocks',
        sub: `${global.knocks.conversionKills} finishes from ${global.knocks.knocks} 3PI knocks`,
        score: knockConversionPct,
        scoreLabel: 'finish discipline',
      },
      finding: `The telemetry sample has 3PI converting ${fmtPct(global.knocks.conversionKills, global.knocks.knocks)} of its own tracked knocks into finishes. That is a cleaner collapse signal than raw kill totals, because it measures whether the clan cashes in the downs it actually created.`,
      meaning: 'This is the bridge between damage and actual round control. A good knock rate with a mediocre finish rate usually means the first angle is fine and the collapse timing is not.',
      tip: 'Use this next to the spacing card. Bad finish rate plus wide spacing is usually the same problem wearing different clothes.',
      actions: [
        'Call the down and have one player anchor while the other angles close immediately.',
        'If a knock turns into a long reset fight, review whether spacing or over-looting delayed the finish.',
      ],
      bars: [
        makeBar('Knocks finished', knockConversionPct, `${knockConversionPct.toFixed(1)}%`, '3PI-created downs turned into 3PI-confirmed finishes'),
        makeBar('Downs that escaped', clamp(100 - knockConversionPct), `${(100 - knockConversionPct).toFixed(1)}%`, 'downs that did not become 3PI conversion kills'),
      ],
      stats: knockLeaders.map(p => ({ label: p.name, value: `${p.finishRate.toFixed(0)}% · ${p.kills}/${p.knocks}` })),
    },
    {
      id: 'vehicle_rotation_report',
      title: 'Vehicle Rotation Report',
      accent: '#22d3ee',
      status: vehicleTop10 > onFootTop10 + 8
        ? { label: 'Vehicles are helping', tone: 'good' }
        : global.vehicles.onFoot.matches === 0
          ? { label: 'Vehicle-heavy sample', tone: 'neutral' }
          : { label: 'Vehicle edge unclear', tone: 'warn' },
      confidence: {
        ...sampleConfidence(global.vehicles.withVehicle.matches + global.vehicles.onFoot.matches, 400, 120),
        basis: `${global.vehicles.withVehicle.matches + global.vehicles.onFoot.matches} rotate samples`,
      },
      hero: {
        value: `${vehicleTop10.toFixed(0)}%`,
        unit: 'top-10 with vehicles',
        sub: topVehicleType ? `${topVehicleType[0]} most used` : 'vehicle mix still sparse',
        score: vehicleTop10,
        scoreLabel: 'vehicle value',
      },
      finding: `Tracked 3PI teams are reaching top-10 at ${vehicleTop10.toFixed(1)}% when they use a vehicle, compared with ${onFootTop10.toFixed(1)}% when they stay on foot. That does not automatically mean “always drive,” but it does tell us whether cars are helping or just getting exploded for content.`,
      meaning: 'Think of this as a rotate-efficiency card, not a driving card. If the vehicle bucket consistently beats the on-foot bucket, the cars are buying time and position, not just speed.',
      tip: 'Use the vehicle card map by map. If one map shows better survival on wheels, bake that into the rotate plan instead of freelancing every time.',
      actions: [
        'Prefer vehicles on maps where they clearly preserve placement value instead of making every rotate a vibes decision.',
        'If a vehicle route is getting punished, fix the path or the exit timing before deciding “cars are bad.”',
      ],
      bars: [
        makeBar('Top-10 with vehicles', vehicleTop10, `${vehicleTop10.toFixed(1)}%`, `${global.vehicles.withVehicle.matches} tracked vehicle matches`),
        makeBar('Top-10 on foot', onFootTop10, `${onFootTop10.toFixed(1)}%`, `${global.vehicles.onFoot.matches} tracked on-foot matches`),
      ],
      stats: [
        { label: 'With vehicle', value: `${global.vehicles.withVehicle.matches} matches · ${fmtPct(global.vehicles.withVehicle.top10s, global.vehicles.withVehicle.matches)} top-10` },
        { label: 'On foot', value: `${global.vehicles.onFoot.matches} matches · ${fmtPct(global.vehicles.onFoot.top10s, global.vehicles.onFoot.matches)} top-10` },
        { label: 'Most used vehicle', value: topVehicleType ? `${topVehicleType[0]} · ${topVehicleType[1]} rides` : 'Not enough data' },
      ],
    },
    {
      id: 'engagement_range_profile',
      title: 'Engagement Range Profile',
      accent: '#ef4444',
      status: bestRange?.label === '0-40m'
        ? { label: 'Close-range identity', tone: 'good' }
        : dominantRangeShare >= 45
          ? { label: 'Clear range identity', tone: 'warn' }
          : { label: 'Split fight profile', tone: 'neutral' },
      confidence: {
        ...sampleConfidence(totalRangeKills, 1200, 400),
        basis: `${totalRangeKills} tracked kills`,
      },
      hero: {
        value: bestRange ? bestRange.label : '—',
        unit: 'highest kill volume range',
        sub: bestRange ? `${dominantRangeShare.toFixed(1)}% of tracked kills` : '',
        score: dominantRangeShare,
        scoreLabel: 'identity strength',
      },
      finding: `Most 3PI kill volume in the telemetry sample is coming from ${bestRange ? bestRange.label : 'unknown range'} engagements. The range split matters because it tells us whether the clan is actually winning its preferred fights or just farming harmless poke damage.`,
      meaning: bestRange?.label === '0-40m'
        ? 'The sample is reading 3PI like a close-range squad. That is useful because it means rotates and compounds should be chosen to create finishable fights, not just poke opportunities.'
        : 'The range split is less about mechanics and more about fight selection. Where 3PI gets its kills should shape how it rotates, crashes, and decides when to keep pressure.',
      tip: 'Match your drop and rotate plan to the range where 3PI is strongest. If long-range poke is not converting, stop mistaking chip damage for control.',
      actions: [
        bestRange?.label === '0-40m' ? 'Favor compound entries, trade spacing, and crash setups that create short-range conversions.' : 'Bias the macro toward the range where 3PI is actually finishing fights.',
        'If your favorite range is not where your kill share lives, fix the pathing before trying to fix the aim.',
      ],
      bars: rangeRows.map(r => makeBar(r.label, pctNum(r.kills, totalRangeKills, 1), `${r.kills} kills`, `${r.knocks} knocks · ${r.damage} dmg`)),
      stats: rangeRows.map(r => ({ label: r.label, value: `${r.kills} kills · ${r.knocks} knocks · ${r.damage} dmg` })),
    },
    {
      id: 'clutch_recovery_index',
      title: 'Clutch / Recovery Index',
      accent: '#4ade80',
      status: clutchTop10 >= 45
        ? { label: 'Resilient resets', tone: 'good' }
        : clutchTop10 >= 32
          ? { label: 'Some recovery muscle', tone: 'warn' }
          : { label: 'Bad starts snowball', tone: 'bad' },
      confidence: {
        ...sampleConfidence(global.clutch.firstKnockAgainst, 300, 100),
        basis: `${global.clutch.firstKnockAgainst} bad-start samples`,
      },
      hero: {
        value: `${clutchTop10.toFixed(0)}%`,
        unit: 'top-10 after losing first knock',
        sub: `${global.clutch.firstKnockAgainst} tracked bad starts`,
        score: clutchTop10,
        scoreLabel: 'reset resilience',
      },
      finding: `When 3PI loses the first knock in a fight, the clan still claws back to a top-10 ${clutchTop10.toFixed(1)}% of the time and even wins ${clutchWins.toFixed(1)}% of those starts. That is the resilience signal: are bad fights instantly fatal, or does the team know how to reset?`,
      meaning: 'This is composure under stress. A healthy recovery rate means the squad still has a structure after the first mistake instead of instantly becoming four separate emergencies.',
      tip: 'Use the recovery card to study calm squads. The goal is not to normalize bad starts; it is to learn which teams keep structure after them.',
      actions: [
        'Study the squads that still stabilize after first-knock losses; they are probably trading, smoking, and re-spacing faster.',
        'Use low-recovery fights as film for panic moments: split peeks, late smokes, or one player re-committing alone.',
      ],
      bars: [
        makeBar('Top-10 recoveries', clutchTop10, `${clutchTop10.toFixed(1)}%`, 'bad starts that still became stable games'),
        makeBar('Win recoveries', clutchWins, `${clutchWins.toFixed(1)}%`, 'bad starts that still became wins'),
      ],
      stats: [
        { label: 'Top-10 recoveries', value: `${global.clutch.recoveredTop10}/${global.clutch.firstKnockAgainst}` },
        { label: 'Win recoveries', value: `${global.clutch.recoveredWins}/${global.clutch.firstKnockAgainst}` },
        { label: 'Best clutch squad', value: bestClutchSquad ? `${bestClutchSquad.teamKey} · ${bestClutchSquad.recoveryRate.toFixed(1)}% on ${bestClutchSquad.attempts}` : 'Not enough squad samples' },
      ],
    },
  ];

  const out = {
    schemaVersion: 2,
    builtAt: new Date().toISOString(),
    seasonId,
    seasonStartAt,
    filterPolicyVersion: MATCH_FILTER_POLICY_VERSION,
    source: {
      type: 'telemetry-cache',
      partial: global.telemetryMatches < officialGames,
    },
    coverage: {
      officialMatches: officialGames,
      telemetryMatches: global.telemetryMatches,
      telemetryRate,
      positionsSampled: global.positionsSampled,
      trackedPlayers: players.length,
    },
    cards,
  };

  // Rebrand pass: the coaching narrative in this file is authored with the
  // literal clan short name "3PI" as a placeholder. Swap standalone tokens only
  // so a re-skinned clan does not corrupt player names or IDs containing "3PI".
  // No-op when SHORT === "3PI".
  const rebrand = (value) => {
    if (!SHORT || SHORT === '3PI') return value;
    if (typeof value === 'string') return value.replace(/\b3PI\b/g, SHORT);
    if (Array.isArray(value)) return value.map(rebrand);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rebrand(v)]));
    }
    return value;
  };
  const written = rebrand(out);
  fs.writeFileSync(OUT_FILE, JSON.stringify(written, null, 2));
  if (verbose) {
    console.log(`[telemetry] ✓ ${global.telemetryMatches}/${officialGames} matches with cached telemetry (${fmtPct(global.telemetryMatches, officialGames, 1)})`);
    console.log(`[telemetry] ✓ Wrote telemetry_insights_cache.json with ${cards.length} cards`);
  }
  return out;
}

module.exports = { buildTelemetryInsights };

if (require.main === module) {
  buildTelemetryInsights({ verbose: true });
}
