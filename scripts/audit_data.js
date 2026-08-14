#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { isCountingSquadMatch } = require('../lib/match-filters');
const { isCurrentSeasonMatch } = require('../lib/season-state');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const MATCH_DIR = path.join(DATA, 'match_cache');
const TELEMETRY_DIR = path.join(DATA, 'telemetry_cache');

const PEAK_FIELDS = new Set(['longestKill', 'maxKillStreaks', 'roundMostKills', 'mostSurvivalTime', 'maxRoundDamage']);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function extractStats(seasonData, mode = 'squad') {
  if (!seasonData) return null;
  const attrs = seasonData.data?.attributes?.gameModeStats;
  if (!attrs) return null;

  const fpp = attrs[`${mode}-fpp`] || {};
  const tpp = attrs[mode] || {};
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
    combined[key] = PEAK_FIELDS.has(key) ? Math.max(fv, tv) : fv + tv;
  }
  return combined;
}

function extractCacheStats(totals) {
  if (!totals?.roundsPlayed) return null;
  return {
    roundsPlayed: totals.roundsPlayed,
    kills: totals.kills || 0,
    wins: totals.wins || 0,
    top10s: totals.top10s || 0,
    damageDealt: totals.damageDealt || 0,
    assists: totals.assists || 0,
    headshotKills: totals.headshotKills || 0,
    dBNOs: totals.dBNOs || 0,
    timeSurvived: totals.timeSurvived || 0,
  };
}

function cacheMatchesApiShape(apiStats, cachedStats) {
  if (!apiStats || !cachedStats) return false;

  const apiGames = apiStats.roundsPlayed || 0;
  const apiKills = apiStats.kills || 0;
  const apiDamage = apiStats.damageDealt || 0;
  const apiTop10s = apiStats.top10s || 0;
  const apiWins = apiStats.wins || 0;

  const gameGap = Math.abs((cachedStats.roundsPlayed || 0) - apiGames);
  const killGap = Math.abs((cachedStats.kills || 0) - apiKills);
  const damageGap = Math.abs((cachedStats.damageDealt || 0) - apiDamage);
  const top10Gap = Math.abs((cachedStats.top10s || 0) - apiTop10s);
  const winGap = Math.abs((cachedStats.wins || 0) - apiWins);

  return (
    gameGap <= Math.max(2, Math.round(apiGames * 0.03)) &&
    killGap <= Math.max(4, Math.round(apiKills * 0.05)) &&
    damageGap <= Math.max(500, Math.round(apiDamage * 0.05)) &&
    top10Gap <= Math.max(2, Math.round(apiTop10s * 0.05)) &&
    winGap <= Math.max(1, Math.round(apiWins * 0.10))
  );
}

function asPct(n, d) {
  if (!d) return '0.0%';
  return `${((n / d) * 100).toFixed(1)}%`;
}

function getRecentMatchStats(matchData, seasonStartAt) {
  const attrs = matchData?.data?.attributes || {};
  if (!isCountingSquadMatch(attrs)) return null;
  if (!isCurrentSeasonMatch(attrs.createdAt, seasonStartAt)) return null;
  return {
    matchId: matchData?.data?.id,
    createdAt: attrs.createdAt,
    hasTelemetry: !!(matchData?.included || []).find(i => i.type === 'asset')?.attributes?.URL,
    participantIds: (matchData?.included || [])
      .filter(i => i.type === 'participant')
      .map(i => i?.attributes?.stats?.playerId)
      .filter(Boolean),
  };
}

function main() {
  const members = readJson(path.join(DATA, 'members.json'));
  const statsCache = readJson(path.join(DATA, 'stats_cache.json'));
  const history = readJson(path.join(DATA, 'match_history_cache.json'));
  const weapons = readJson(path.join(DATA, 'weapon_cache.json'));
  const landing = readJson(path.join(DATA, 'landing_cache.json'));
  const season = readJson(path.join(DATA, 'season.json'));
  const seasonStartAt = season.seasonStartAt || null;

  const memberById = new Map(members.map(m => [m.accountId, m]));
  const historyById = history.result || {};
  const weaponById = weapons.players || {};
  const statsById = new Map((statsCache.stats || []).map(entry => [entry.member.accountId, entry]));

  const perPlayerMatches = new Map(members.map(m => [m.accountId, []]));
  let eligibleMatches = 0;
  let eligibleWithTelemetry = 0;

  for (const file of fs.readdirSync(MATCH_DIR)) {
    if (!file.endsWith('.json')) continue;
    const matchData = readJson(path.join(MATCH_DIR, file));
    const match = getRecentMatchStats(matchData, seasonStartAt);
    if (!match) continue;

    eligibleMatches++;
    if (match.hasTelemetry) eligibleWithTelemetry++;
    for (const accountId of match.participantIds) {
      if (perPlayerMatches.has(accountId)) {
        perPlayerMatches.get(accountId).push(match.createdAt);
      }
    }
  }

  const historyMismatches = [];
  const telemetryMismatches = [];
  const seasonWindows = [];
  let activePlayers = 0;
  let apiPreferred = 0;
  let cachePreferred = 0;

  for (const member of members) {
    const statsEntry = statsById.get(member.accountId);
    const api = extractStats(statsEntry?.season);
    const cached = extractCacheStats(historyById[member.accountId]?.totals);
    const telemetry = weaponById[member.accountId] || null;

    if (!api?.roundsPlayed) continue;
    activePlayers++;

    const useCache = cached && cacheMatchesApiShape(api, cached);
    if (useCache) cachePreferred++;
    else apiPreferred++;

    if (cached) {
      const diffs = [
        ['games', api.roundsPlayed || 0, cached.roundsPlayed || 0],
        ['kills', api.kills || 0, cached.kills || 0],
        ['wins', api.wins || 0, cached.wins || 0],
        ['top10s', api.top10s || 0, cached.top10s || 0],
        ['damage', Math.round(api.damageDealt || 0), Math.round(cached.damageDealt || 0)],
      ]
        .filter(([, a, b]) => a !== b)
        .map(([field, apiVal, cachedVal]) => ({ field, api: apiVal, cached: cachedVal, diff: cachedVal - apiVal }));

      if (diffs.length) {
        historyMismatches.push({
          name: member.name,
          apiGames: api.roundsPlayed || 0,
          cachedGames: cached.roundsPlayed || 0,
          diffs,
        });
      }
    }

    if (telemetry) {
      const diffs = [
        ['boosts', api.boosts || 0, telemetry.boosts || 0],
        ['heals', api.heals || 0, telemetry.heals || 0],
        ['revives', api.revives || 0, telemetry.revives || 0],
        ['roadKills', api.roadKills || 0, telemetry.roadKills || 0],
        ['vehicleDestroys', api.vehicleDestroys || 0, telemetry.vehicleDestroys || 0],
        ['longestKill', Math.round(api.longestKill || 0), telemetry.longestKill || 0],
      ]
        .filter(([, a, b]) => a !== b)
        .map(([field, apiVal, telemetryVal]) => ({ field, api: apiVal, telemetry: telemetryVal, diff: telemetryVal - apiVal }));

      if (diffs.length) {
        telemetryMismatches.push({
          name: member.name,
          apiGames: api.roundsPlayed || 0,
          diffs,
        });
      }
    }

    const dates = (perPlayerMatches.get(member.accountId) || []).sort((a, b) => new Date(b) - new Date(a));
    if (!dates.length) continue;

    const apiGames = api.roundsPlayed || 0;
    seasonWindows.push({
      name: member.name,
      apiGames,
      cachedMatches: dates.length,
      diff: dates.length - apiGames,
      earliestIncluded: dates[Math.min(apiGames - 1, dates.length - 1)] || null,
      latestExcluded: dates.length > apiGames ? dates[apiGames] : null,
    });
  }

  historyMismatches.sort((a, b) => Math.abs(b.cachedGames - b.apiGames) - Math.abs(a.cachedGames - a.apiGames));
  telemetryMismatches.sort((a, b) => {
    const aGap = a.diffs.reduce((sum, diff) => sum + Math.abs(diff.diff), 0);
    const bGap = b.diffs.reduce((sum, diff) => sum + Math.abs(diff.diff), 0);
    return bGap - aGap;
  });
  seasonWindows.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));

  const telemetryCacheFiles = fs.existsSync(TELEMETRY_DIR)
    ? fs.readdirSync(TELEMETRY_DIR).filter(file => file.endsWith('.json') || file.endsWith('.json.gz')).length
    : 0;

  console.log('\nclan data audit\n');
  console.log(`Members: ${members.length}`);
  console.log(`Active players: ${activePlayers}`);
  console.log(`Season ID: ${statsCache.seasonId}`);
  console.log(`Season start in cache: ${season.seasonStartAt || 'unset'}`);
  console.log(`Core totals using cache: ${cachePreferred}`);
  console.log(`Core totals forced to API: ${apiPreferred}`);
  console.log(`History/API mismatches: ${historyMismatches.length}`);
  console.log(`Telemetry/API mismatches: ${telemetryMismatches.length}`);
  console.log(`Landing coverage: ${landing.processedMatches?.length || 0}/${eligibleWithTelemetry} (${asPct(landing.processedMatches?.length || 0, eligibleWithTelemetry)})`);
  console.log(`Weapon coverage: ${weapons.processedMatches?.length || 0}/${eligibleWithTelemetry} (${asPct(weapons.processedMatches?.length || 0, eligibleWithTelemetry)})`);
  console.log(`Telemetry cache files on disk: ${telemetryCacheFiles}`);

  if (historyMismatches.length) {
    console.log('\nTop history mismatches:');
    for (const item of historyMismatches.slice(0, 8)) {
      const summary = item.diffs.slice(0, 3).map(diff => `${diff.field}:${diff.diff > 0 ? '+' : ''}${diff.diff}`).join(' · ');
      console.log(`- ${item.name}: API ${item.apiGames} vs cache ${item.cachedGames} (${summary})`);
    }
  }

  if (telemetryMismatches.length) {
    console.log('\nTop telemetry mismatches:');
    for (const item of telemetryMismatches.slice(0, 8)) {
      const summary = item.diffs.slice(0, 3).map(diff => `${diff.field}:${diff.diff > 0 ? '+' : ''}${diff.diff}`).join(' · ');
      console.log(`- ${item.name}: ${summary}`);
    }
  }

  const over = seasonWindows.filter(item => item.diff > 0 && item.latestExcluded).slice(0, 8);
  if (over.length) {
    console.log('\nPotential overcount windows:');
    for (const item of over) {
      console.log(`- ${item.name}: keep through ${item.earliestIncluded}, exclude older than ${item.latestExcluded}`);
    }
  }

  const under = seasonWindows.filter(item => item.diff < 0).slice(0, 8);
  if (under.length) {
    console.log('\nLikely missing-match coverage:');
    for (const item of under) {
      console.log(`- ${item.name}: API ${item.apiGames}, cached ${item.cachedMatches}, oldest cached ${item.earliestIncluded}`);
    }
  }
}

main();
