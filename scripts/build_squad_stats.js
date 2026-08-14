#!/usr/bin/env node
// build_squad_stats.js — compute clan duo/trio win rates from full season match cache
// Reads immutable match_cache JSON files directly so chemistry stats cover the
// whole current season instead of the 30-match UI slice.
'use strict';

const fs = require('fs');
const path = require('path');
const { ensureSeasonStateFromMatchCache, isCurrentSeasonMatch } = require('../lib/season-state');
const { isCountingSquadMatch } = require('../lib/match-filters');
const { ensureMatchCacheDir, listMatchCacheFiles } = require('./cache_paths');

const BASE = path.join(__dirname, '..');
const MATCH_CACHE_DIR = path.join(BASE, 'data', 'match_cache');
const MEMBERS_FILE = path.join(BASE, 'data', 'members.json');
const OUT_FILE = path.join(BASE, 'data', 'squad_stats_cache.json');

const MIN_GAMES_PAIR = 4;
const MIN_GAMES_TRIO = 3;
const TOP_N = 10;

function addCombo(store, ids, memberById, won, memberStats) {
  const key = ids.join('|');
  if (!store[key]) {
    store[key] = {
      players: ids.map(id => memberById[id] || id),
      games: 0,
      wins: 0,
      kills: 0,
      damage: 0,
    };
  }
  store[key].games++;
  if (won) store[key].wins++;
  store[key].kills += ids.reduce((sum, id) => sum + (memberStats[id]?.kills || 0), 0);
  store[key].damage += ids.reduce((sum, id) => sum + (memberStats[id]?.damage || 0), 0);
}

function buildSquadStats(opts = {}) {
  const verbose = opts.verbose ?? true;

  if (!fs.existsSync(MEMBERS_FILE)) throw new Error('members.json not found');
  ensureMatchCacheDir();

  const members = JSON.parse(fs.readFileSync(MEMBERS_FILE, 'utf8'));
  const memberById = Object.fromEntries(members.map(m => [m.accountId, m.name]));
  const memberIdSet = new Set(members.map(m => m.accountId));
  const seasonState = ensureSeasonStateFromMatchCache(MATCH_CACHE_DIR);
  const seasonStartAt = seasonState.seasonStartAt || null;
  const files = listMatchCacheFiles();

  const pairs = {};
  const trios = {};
  let processedMatches = 0;

  for (const file of files) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(MATCH_CACHE_DIR, file), 'utf8'));
      const attrs = raw?.data?.attributes || {};
      if (!isCountingSquadMatch(attrs)) continue;
      if (!isCurrentSeasonMatch(attrs.createdAt, seasonStartAt)) continue;

      const participants = (raw.included || []).filter(x => x.type === 'participant');
      const rosters = (raw.included || []).filter(x => x.type === 'roster');
      const participantsById = new Map(participants.map(p => [p.id, p]));

      for (const roster of rosters) {
        const rosterParticipants = roster?.relationships?.participants?.data || [];
        const memberStats = {};
        const memberIds = [];

        for (const ref of rosterParticipants) {
          const part = participantsById.get(ref.id);
          const stats = part?.attributes?.stats;
          const accountId = stats?.playerId;
          if (!accountId || !memberIdSet.has(accountId)) continue;
          memberIds.push(accountId);
          memberStats[accountId] = {
            kills: stats.kills || 0,
            damage: Math.round(stats.damageDealt || 0),
          };
        }

        if (memberIds.length < 2) continue;
        memberIds.sort();
        const won = roster?.attributes?.won === 'true';

        for (let i = 0; i < memberIds.length; i++) {
          for (let j = i + 1; j < memberIds.length; j++) {
            addCombo(pairs, [memberIds[i], memberIds[j]], memberById, won, memberStats);
          }
        }

        for (let i = 0; i < memberIds.length; i++) {
          for (let j = i + 1; j < memberIds.length; j++) {
            for (let k = j + 1; k < memberIds.length; k++) {
              addCombo(trios, [memberIds[i], memberIds[j], memberIds[k]], memberById, won, memberStats);
            }
          }
        }
      }

      processedMatches++;
    } catch {}
  }

  function mapped(raw, minGames) {
    return Object.values(raw)
      .filter(c => c.games >= minGames)
      .map(c => ({
        players: c.players,
        games: c.games,
        wins: c.wins,
        winRate: +(c.wins / c.games).toFixed(3),
        avgKills: +(c.kills / c.games).toFixed(2),
        avgDamage: Math.round(c.damage / c.games),
        score: +(c.wins / (c.games + 4)).toFixed(4),
      }));
  }

  const pairList = mapped(pairs, MIN_GAMES_PAIR);
  const trioList = mapped(trios, MIN_GAMES_TRIO);

  const result = {
    builtAt: new Date().toISOString(),
    seasonId: seasonState.cacheSeasonId || seasonState.seasonId || null,
    seasonStartAt,
    processedMatches,
    topPairs: [...pairList].sort((a, b) => b.score - a.score).slice(0, TOP_N),
    topTrios: [...trioList].sort((a, b) => b.score - a.score).slice(0, TOP_N),
    mostPlayedPairs: [...pairList].sort((a, b) => b.games - a.games).slice(0, TOP_N),
    pairCount: pairList.length,
    trioCount: trioList.length,
  };

  fs.writeFileSync(OUT_FILE, JSON.stringify(result, null, 2));

  if (verbose) {
    console.log(`[squads] ✓ ${result.pairCount} qualifying pairs · ${result.trioCount} qualifying trios · ${processedMatches} season matches`);
    console.log('\nTop 5 pairs:');
    result.topPairs.slice(0, 5).forEach((c, i) => {
      console.log(`  ${i + 1}. ${c.players.join(' + ')} — ${c.games}g ${c.wins}W (${(c.winRate * 100).toFixed(0)}%) ${c.avgKills}K/g`);
    });
    if (result.topTrios.length) {
      console.log('\nTop 5 trios:');
      result.topTrios.slice(0, 5).forEach((c, i) => {
        console.log(`  ${i + 1}. ${c.players.join(' + ')} — ${c.games}g ${c.wins}W (${(c.winRate * 100).toFixed(0)}%) ${c.avgKills}K/g`);
      });
    }
  }

  return result;
}

module.exports = { buildSquadStats };

if (require.main === module) {
  buildSquadStats({ verbose: true });
}
