#!/usr/bin/env node
// build_squad_stats.js — compute APES duo/trio win rates from match history
// Reads match_history_cache.json (already built), no network calls.
// Produces: data/squad_stats_cache.json
'use strict';

const fs   = require('fs');
const path = require('path');

const BASE         = path.join(__dirname, '..');
const HISTORY_FILE = path.join(BASE, 'data', 'match_history_cache.json');
const MEMBERS_FILE = path.join(BASE, 'data', 'members.json');
const OUT_FILE     = path.join(BASE, 'data', 'squad_stats_cache.json');

const MIN_GAMES_PAIR  = 4;   // minimum games together to surface a pair
const MIN_GAMES_TRIO  = 3;   // minimum games together to surface a trio
const TOP_N           = 10;  // how many top combos to keep

function buildSquadStats(opts = {}) {
  const verbose = opts.verbose ?? true;

  if (!fs.existsSync(HISTORY_FILE)) throw new Error('match_history_cache.json not found — run build_match_history.js first');

  const cache   = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
  const members = fs.existsSync(MEMBERS_FILE) ? JSON.parse(fs.readFileSync(MEMBERS_FILE, 'utf8')) : [];
  const memberById = Object.fromEntries(members.map(m => [m.accountId, m.name]));

  // pairs[key] and trios[key] accumulate { games, wins, kills, damage, players[] }
  const pairs = {};
  const trios = {};
  // Track seen matchIds per combo to avoid double-counting (each match appears
  // in both players' history, so we deduplicate by matchId).
  const pairSeen = {};
  const trioSeen = {};

  for (const [accountId, data] of Object.entries(cache.result || {})) {
    for (const match of data.matches) {
      const teammates = match.teammates || [];
      if (teammates.length === 0) continue;

      // All APES members in this squad (including this player)
      const squad = [{ accountId, name: data.name }, ...teammates];

      // ── Pairs ───────────────────────────────────────────────────────────────
      for (let i = 0; i < squad.length; i++) {
        for (let j = i + 1; j < squad.length; j++) {
          const ids  = [squad[i].accountId, squad[j].accountId].sort();
          const key  = ids.join('|');
          const seen = pairSeen[key] || (pairSeen[key] = new Set());
          if (seen.has(match.matchId)) continue;
          seen.add(match.matchId);
          if (!pairs[key]) pairs[key] = { players: [memberById[ids[0]] || ids[0], memberById[ids[1]] || ids[1]], games: 0, wins: 0, kills: 0, damage: 0 };
          pairs[key].games++;
          if (match.won) pairs[key].wins++;
          pairs[key].kills  += match.kills;
          pairs[key].damage += match.damage;
        }
      }

      // ── Trios ───────────────────────────────────────────────────────────────
      for (let i = 0; i < squad.length; i++) {
        for (let j = i + 1; j < squad.length; j++) {
          for (let k = j + 1; k < squad.length; k++) {
            const ids  = [squad[i].accountId, squad[j].accountId, squad[k].accountId].sort();
            const key  = ids.join('|');
            const seen = trioSeen[key] || (trioSeen[key] = new Set());
            if (seen.has(match.matchId)) continue;
            seen.add(match.matchId);
            if (!trios[key]) trios[key] = { players: ids.map(id => memberById[id] || id), games: 0, wins: 0, kills: 0, damage: 0 };
            trios[key].games++;
            if (match.won) trios[key].wins++;
            trios[key].kills  += match.kills;
            trios[key].damage += match.damage;
          }
        }
      }
    }
  }

  // ── Filter, score, sort ────────────────────────────────────────────────────
  function mapped(raw, minGames) {
    return Object.values(raw)
      .filter(c => c.games >= minGames)
      .map(c => ({
        players:   c.players,
        games:     c.games,
        wins:      c.wins,
        winRate:   +(c.wins / c.games).toFixed(3),
        avgKills:  +(c.kills / c.games).toFixed(2),
        avgDamage: Math.round(c.damage / c.games),
        // Bayesian-ish score: win rate weighted by sample — rewards consistency at volume
        score:     +(c.wins / (c.games + 4)).toFixed(4),
      }));
  }

  const pairList = mapped(pairs, MIN_GAMES_PAIR);
  const trioList = mapped(trios, MIN_GAMES_TRIO);

  const result = {
    builtAt:         new Date().toISOString(),
    topPairs:        [...pairList].sort((a, b) => b.score - a.score).slice(0, TOP_N),
    topTrios:        [...trioList].sort((a, b) => b.score - a.score).slice(0, TOP_N),
    mostPlayedPairs: [...pairList].sort((a, b) => b.games - a.games).slice(0, TOP_N),
    pairCount:       pairList.length,
    trioCount:       trioList.length,
  };

  fs.writeFileSync(OUT_FILE, JSON.stringify(result, null, 2));

  if (verbose) {
    console.log(`[squads] ✓ ${result.pairCount} qualifying pairs · ${result.trioCount} qualifying trios`);
    console.log('\nTop 5 pairs:');
    result.topPairs.slice(0, 5).forEach((c, i) => {
      console.log(`  ${i+1}. ${c.players.join(' + ')} — ${c.games}g ${c.wins}W (${(c.winRate*100).toFixed(0)}%) ${c.avgKills}K/g`);
    });
    if (result.topTrios.length) {
      console.log('\nTop 5 trios:');
      result.topTrios.slice(0, 5).forEach((c, i) => {
        console.log(`  ${i+1}. ${c.players.join(' + ')} — ${c.games}g ${c.wins}W (${(c.winRate*100).toFixed(0)}%) ${c.avgKills}K/g`);
      });
    }
  }

  return result;
}

module.exports = { buildSquadStats };

if (require.main === module) {
  buildSquadStats({ verbose: true });
}
