#!/usr/bin/env node
// build_match_history.js — pre-compute per-player match history from local match cache
// Produces: data/match_history_cache.json
// Keeps up to MAX_MATCHES_PER_PLAYER recent matches per player, sorted newest first.
// Run daily after new matches are cached.

'use strict';
const fs   = require('fs');
const path = require('path');
const { ensureSeasonStateFromMatchCache, isCurrentSeasonMatch } = require('../lib/season-state');
const { getMatchFilterDecision, formatMatchDebug } = require('../lib/match-filters');

const BASE               = path.join(__dirname, '..');
const MATCH_CACHE_DIR    = path.join(BASE, 'data', 'match_cache');
const MEMBERS_FILE       = path.join(BASE, 'data', 'members.json');
const STATS_FILE         = path.join(BASE, 'data', 'stats_cache.json');
const OUT_FILE           = path.join(BASE, 'data', 'match_history_cache.json');
const MAX_MATCHES_PER_PLAYER = 30;

// Map internal name → short display name for the UI
const MAP_NAMES = {
  Baltic_Main:       'Erangel',
  Desert_Main:       'Miramar',
  Savage_Main:       'Sanhok',
  DihorOtok_Main:    'Vikendi',
  Kiki_Main:         'Deston',
  Tiger_Main:        'Taego',
  Summerland_Main:   'Karakin',
  Chimera_Main:      'Paramo',
  Heaven_Main:       'Haven',
  Neon_Main:         'Rondo',
  Officiel_Main:     'Erangel (CE)',
};

function mapDisplay(name) {
  return MAP_NAMES[name] || name?.replace('_Main', '') || 'Unknown';
}

function modeDisplay(mode) {
  if (!mode) return 'Squad';
  if (mode.includes('fpp')) return mode.includes('solo') ? 'Solo FPP' : mode.includes('duo') ? 'Duo FPP' : 'Squad FPP';
  if (mode.includes('solo')) return 'Solo';
  if (mode.includes('duo'))  return 'Duo';
  return 'Squad';
}

// Compute cumulative season totals from all official cached matches for a player.
// Stored alongside the 30-match display slice so the frontend can use clean stats.
function computeTotals(matches) {
  if (!matches || !matches.length) return null;
  let kills = 0, wins = 0, damage = 0, hs = 0, assists = 0, dbnos = 0,
      top10s = 0, survival = 0, maxKills = 0, maxDamage = 0, maxSurvival = 0,
      maxLongestKill = 0;
  for (const m of matches) {
    kills    += m.kills    || 0;
    damage   += m.damage   || 0;
    hs       += m.hs       || 0;
    assists  += m.assists  || 0;
    dbnos    += m.dbnos    || 0;
    survival += m.survival || 0;
    if (m.won) wins++;
    if (m.placement && m.placement <= 10) top10s++;
    if ((m.kills       || 0) > maxKills)       maxKills       = m.kills;
    if ((m.damage      || 0) > maxDamage)      maxDamage      = m.damage;
    if ((m.survival    || 0) > maxSurvival)    maxSurvival    = m.survival;
    if ((m.longestKill || 0) > maxLongestKill) maxLongestKill = m.longestKill;
  }
  return {
    roundsPlayed:     matches.length,
    kills,
    wins,
    losses:           matches.length - wins,
    damageDealt:      damage,
    headshotKills:    hs,
    assists,
    dBNOs:            dbnos,
    top10s,
    timeSurvived:     survival,
    roundMostKills:   maxKills,
    maxRoundDamage:   maxDamage,
    mostSurvivalTime: maxSurvival,
    longestKillMatch: maxLongestKill, // peak longest kill in any single match (from API data)
  };
}

function buildSeasonSummary(result, fallbackMatches = null) {
  if (fallbackMatches) return fallbackMatches;

  const seen = new Set();
  let uniqueGames = 0;
  let uniqueWins = 0;
  for (const data of Object.values(result || {})) {
    for (const match of data.matches || []) {
      if (!match.matchId || seen.has(match.matchId)) continue;
      seen.add(match.matchId);
      uniqueGames++;
      if (match.won) uniqueWins++;
    }
  }
  return { uniqueGames, uniqueWins };
}

function loadPreviousHistory(currentSeasonId) {
  if (!fs.existsSync(OUT_FILE)) return null;
  try {
    const previous = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8'));
    if ((previous?.seasonId || null) !== (currentSeasonId || null)) return null;
    return previous.result || null;
  } catch {
    return null;
  }
}

function extractApiRounds(seasonData) {
  const gms = seasonData?.data?.attributes?.gameModeStats;
  if (!gms || typeof gms !== 'object') return 0;
  return (gms['squad-fpp']?.roundsPlayed || 0) + (gms.squad?.roundsPlayed || 0);
}

function loadApiRoundsByAccount(currentSeasonId) {
  if (!fs.existsSync(STATS_FILE)) return new Map();
  try {
    const cached = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
    if (currentSeasonId && cached?.seasonId && cached.seasonId !== currentSeasonId) {
      return new Map();
    }
    const map = new Map();
    for (const entry of cached?.stats || []) {
      const accountId = entry?.member?.accountId;
      if (!accountId) continue;
      map.set(accountId, extractApiRounds(entry.season));
    }
    return map;
  } catch {
    return new Map();
  }
}

function shouldPreservePreviousEntry(previousEntry, nextEntry) {
  if (nextEntry?.coverage?.trimmedByApiCap) return false;
  const prevUsed = previousEntry?.coverage?.usedMatches || previousEntry?.totals?.roundsPlayed || 0;
  const nextUsed = nextEntry?.coverage?.usedMatches || nextEntry?.totals?.roundsPlayed || 0;
  const nextCaptured = nextEntry?.coverage?.capturedMatches || nextUsed;
  const suspiciousTrim = nextCaptured > nextUsed + Math.max(3, Math.round(nextCaptured * 0.10));
  return suspiciousTrim && prevUsed > nextUsed;
}

function buildMatchHistory(opts = {}) {
  const verbose = opts.verbose ?? true;
  const seasonState = ensureSeasonStateFromMatchCache(MATCH_CACHE_DIR);
  const seasonStartAt = seasonState.seasonStartAt || null;
  const currentSeasonId = seasonState.cacheSeasonId || seasonState.seasonId || null;
  const previousHistory = loadPreviousHistory(currentSeasonId);
  const apiRoundsByAccount = loadApiRoundsByAccount(currentSeasonId);

  if (!fs.existsSync(MEMBERS_FILE)) throw new Error('members.json not found');
  const members     = JSON.parse(fs.readFileSync(MEMBERS_FILE, 'utf8'));
  const memberIdSet = new Set(members.map(m => m.accountId));
  const memberById  = Object.fromEntries(members.map(m => [m.accountId, m.name]));

  if (!fs.existsSync(MATCH_CACHE_DIR)) throw new Error('match_cache/ not found');
  const files = fs.readdirSync(MATCH_CACHE_DIR).filter(f => f.endsWith('.json'));
  if (verbose) console.log(`[history] Processing ${files.length} cached matches…`);

  // { accountId → [{ matchId, date, placement, won, kills, assists, dbnos, hs, damage, survival, map, mode, teammates[] }] }
  const playerMatches = {};
  for (const id of memberIdSet) playerMatches[id] = [];
  let processed = 0;
  for (const file of files) {
    const matchId = file.replace('.json', '');
    try {
      const raw  = JSON.parse(fs.readFileSync(path.join(MATCH_CACHE_DIR, file), 'utf8'));
      const attr = raw.data?.attributes || {};
      const incl = raw.included || [];

      // Squad-mode counting filter — see lib/match-filters.js for the policy.
      // This is the core truth trunk: only applicable current-season official
      // squad matches are allowed through.
      const filterDecision = getMatchFilterDecision(attr);
      if (filterDecision.review && verbose) {
        console.warn(`[history] Review match shape ${matchId}: ${formatMatchDebug(filterDecision)}`);
      }
      if (!filterDecision.counts) { continue; }
      if (!isCurrentSeasonMatch(attr.createdAt, seasonStartAt)) { continue; }

      const matchDate = attr.createdAt;
      const map       = mapDisplay(attr.mapName);
      const mode      = modeDisplay(attr.gameMode);

      const rosters     = incl.filter(x => x.type === 'roster');
      const participants = incl.filter(x => x.type === 'participant');
      // Build a lookup: participantId → roster (for placement/win data)
      const partToRoster = {};
      for (const r of rosters) {
        for (const p of r.relationships?.participants?.data || []) {
          partToRoster[p.id] = r;
        }
      }

      // For each clan member in this match, record their stats
      for (const part of participants) {
        const stats     = part.attributes?.stats;
        const accountId = stats?.playerId;
        if (!accountId || !memberIdSet.has(accountId)) continue;

        const roster     = partToRoster[part.id];
        const placement  = roster?.attributes?.stats?.rank || null;
        const won        = roster?.attributes?.won === 'true';

        // Find squadmates (other clan members on the same roster)
        const teammates = [];
        for (const p2 of roster?.relationships?.participants?.data || []) {
          const p2obj = participants.find(x => x.id === p2.id);
          const p2id  = p2obj?.attributes?.stats?.playerId;
          if (p2id && p2id !== accountId && memberIdSet.has(p2id)) {
          teammates.push({ accountId: p2id, name: memberById[p2id] });
          }
        }

        playerMatches[accountId].push({
          matchId,
          date:        matchDate,
          placement:   placement,
          won:         won,
          kills:       stats.kills          || 0,
          assists:     stats.assists         || 0,
          dbnos:       stats.DBNOs           || 0,
          hs:          stats.headshotKills   || 0,
          damage:      Math.round(stats.damageDealt  || 0),
          survival:    Math.round(stats.timeSurvived  || 0),
          longestKill: +((stats.longestKill  || 0).toFixed(1)),
          map,
          mode,
          teammates,
        });
      }
      processed++;
    } catch (e) {
      // Skip corrupt/unreadable files silently
    }
  }

  // Sort each player's applicable current-season matches newest first. The
  // filtered match cache remains the source of truth, but we cap each player at
  // the official squad season rounds when the local cache somehow runs ahead.
  //
  // Sanity guard: if the API cap is extremely low relative to captured matches
  // (< 5% ratio), the API season stats are almost certainly stale or buggy for
  // that player (e.g. PUBG hasn't updated their round count yet). In that case
  // we ignore the cap and use the full captured set, which is ground-truth from
  // actual match data. Without this guard, a player with 80+ local matches but
  // an API count of 2 would be trimmed to their 2 highest-kill games, producing
  // a wildly inflated K/D on the leaderboard.
  const STALE_API_CAP_RATIO = 0.05; // treat API count as stale when < 5% of captured
  const result = {};
  // Season-wide unique games/wins must be computed from the FULL used match
  // sets, not the 30-match display slices (buildSeasonSummary over result
  // undercounted ~7x because result.matches is capped at MAX_MATCHES_PER_PLAYER).
  const _seasonMatchWon = new Map();
  for (const [accountId, matches] of Object.entries(playerMatches)) {
    const sorted = matches.sort((a, b) => new Date(b.date) - new Date(a.date));
    const capturedMatches = sorted.length;
    const apiRounds = apiRoundsByAccount.get(accountId) || 0;
    const rawTrimmedByApiCap = apiRounds > 0 && capturedMatches > apiRounds;
    const apiCapIsStale = rawTrimmedByApiCap &&
      capturedMatches >= 10 &&
      (apiRounds / capturedMatches) < STALE_API_CAP_RATIO;
    const trimmedByApiCap = rawTrimmedByApiCap && !apiCapIsStale;
    if (apiCapIsStale && verbose) {
      console.warn(
        `[history] Ignoring stale API cap for ${memberById[accountId]} — ` +
        `API says ${apiRounds} rounds but captured ${capturedMatches} (ratio ${(apiRounds/capturedMatches).toFixed(3)})`
      );
    }
    const used = trimmedByApiCap ? sorted.slice(0, apiRounds) : sorted;
    for (const m of used) {
      if (!m.matchId) continue;
      _seasonMatchWon.set(m.matchId, (_seasonMatchWon.get(m.matchId) || false) || !!m.won);
    }
    const usedMatches = used.length;
    const daysPlayed = new Set(
      used.map(m => m.date?.slice(0, 10)).filter(Boolean)
    ).size;
    const surplusMatches = Math.max(capturedMatches - usedMatches, 0);
    const missingMatches = apiRounds > 0 ? Math.max(apiRounds - usedMatches, 0) : 0;

    const nextEntry = {
      name:       memberById[accountId],
      matches:    used.slice(0, MAX_MATCHES_PER_PLAYER),
      totals:     computeTotals(used),
      daysPlayed,
      mapStats:   computeMapStats(used),
      coverage: {
        apiRounds,
        capturedMatches,
        usedMatches,
        complete: !apiRounds || missingMatches === 0,
        ratio: apiRounds > 0 ? +(usedMatches / apiRounds).toFixed(3) : (usedMatches > 0 ? 1 : 0),
        surplusMatches,
        trimmedByApiCap,
        source: 'match-cache',
      },
    };
    const previousEntry = previousHistory?.[accountId] || null;
    if (shouldPreservePreviousEntry(previousEntry, nextEntry)) {
      if (verbose) {
        const prevUsed = previousEntry?.coverage?.usedMatches || previousEntry?.totals?.roundsPlayed || 0;
        console.warn(
          `[history] Preserving previous totals for ${memberById[accountId]} — new build regressed from ${prevUsed} to ${usedMatches} matches`
        );
      }
      result[accountId] = previousEntry;
      continue;
    }
    result[accountId] = nextEntry;
  }

  const summary = {
    uniqueGames: _seasonMatchWon.size,
    uniqueWins:  [..._seasonMatchWon.values()].filter(Boolean).length,
  };

  // Write output
  const out = {
    builtAt: new Date().toISOString(),
    seasonId: currentSeasonId,
    seasonStartAt,
    playerCount: members.length,
    summary,
    result,
  };
  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));
  if (verbose) console.log(`[history] ✓ Written match_history_cache.json — ${processed} matches · ${members.length} players`);

  return result;
}

// ── Form analysis helpers ─────────────────────────────────────────────────────

// Compute form metrics for a player's recent matches
function computeForm(matches, windowSize = 5) {
  if (!matches?.length) return null;

  const recent = matches.slice(0, windowSize);
  const all    = matches;

  function avg(arr, fn) {
    if (!arr.length) return 0;
    return arr.reduce((s, m) => s + fn(m), 0) / arr.length;
  }

  const recentKills  = avg(recent, m => m.kills);
  const recentDamage = avg(recent, m => m.damage);
  const allKills     = avg(all, m => m.kills);
  const allDamage    = avg(all, m => m.damage);

  // Delta vs overall avg (positive = better recently)
  const killsDelta  = allKills  > 0 ? (recentKills  - allKills)  / allKills  : 0;
  const damageDelta = allDamage > 0 ? (recentDamage - allDamage) / allDamage : 0;
  const combined    = (killsDelta + damageDelta) / 2;

  // Trend label
  let trend;
  if (combined >= 0.20)       trend = 'hot';     // 20%+ above avg
  else if (combined >= 0.08)  trend = 'warm';
  else if (combined <= -0.20) trend = 'cold';    // 20%+ below avg
  else if (combined <= -0.08) trend = 'cool';
  else                        trend = 'steady';

  return {
    trend,
    delta:        +combined.toFixed(3),
    recentKills:  +recentKills.toFixed(2),
    recentDamage: +recentDamage.toFixed(0),
    allKills:     +allKills.toFixed(2),
    allDamage:    +allDamage.toFixed(0),
    window:       recent.length,
  };
}

// Compute map win rate breakdown: { mapName → { played, wins, kills, damage } }
function computeMapStats(matches) {
  const maps = {};
  for (const m of matches) {
    if (!maps[m.map]) maps[m.map] = { played: 0, wins: 0, kills: 0, damage: 0 };
    maps[m.map].played++;
    if (m.won)        maps[m.map].wins++;
    maps[m.map].kills  += m.kills;
    maps[m.map].damage += m.damage;
  }
  return Object.entries(maps)
    .map(([map, s]) => ({
      map,
      played:  s.played,
      wins:    s.wins,
      winRate: +(s.wins / s.played).toFixed(3),
      avgKills: +(s.kills / s.played).toFixed(2),
      avgDmg:   Math.round(s.damage / s.played),
    }))
    .sort((a, b) => b.played - a.played);
}

// Build a complete summary from match_history_cache.json
function buildHistorySummary(cache) {
  const summary = {};
  for (const [accountId, data] of Object.entries(cache.result || {})) {
    const matches = data.matches;
    // Use pre-computed daysPlayed (from full match set before the 30-match slice).
    // Fallback to counting from the display slice for backwards-compat with old cache files.
    const daysPlayed = data.daysPlayed ?? new Set(
      matches.map(m => m.date?.slice(0, 10)).filter(Boolean)
    ).size;
    summary[accountId] = {
      name:       data.name,
      totals:     data.totals   || null,
      daysPlayed,
      form:       computeForm(matches, 5),
      // Use pre-computed mapStats (from full match set). Fallback for old cache files.
      mapStats:   data.mapStats ?? computeMapStats(matches),
      recent:     matches.slice(0, 10), // last 10 for the UI
      coverage:   data.coverage || null,
    };
  }
  summary._summary = cache.summary || buildSeasonSummary(cache.result || {});
  return summary;
}

module.exports = { buildMatchHistory, buildHistorySummary, computeForm, computeMapStats };

if (require.main === module) {
  buildMatchHistory({ verbose: true });
}
