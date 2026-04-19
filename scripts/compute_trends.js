#!/usr/bin/env node
'use strict';
// ── compute_trends.js ────────────────────────────────────────────────────────
// Reads data/stats_cache.json, computes Pearson correlations across 6 insight
// pairs, writes data/trends_cache.json, and appends a dated row to
// data/trends_history.json (capped at 90 entries / ~3 months).
//
// Usage: node scripts/compute_trends.js
// Called by: scripts/daily_clan.js

const fs   = require('fs');
const path = require('path');

const DATA  = path.join(__dirname, '..', 'data');
const CACHE = path.join(DATA, 'stats_cache.json');
const OUT   = path.join(DATA, 'trends_cache.json');
const HIST  = path.join(DATA, 'trends_history.json');

// ── Mirrors extractStats() from the frontend ─────────────────────────────────
function extractStats(seasonData) {
  if (!seasonData) return null;
  const attrs = seasonData.data?.attributes?.gameModeStats;
  if (!attrs) return null;
  const fpp = attrs['squad-fpp'];
  const tpp = attrs['squad'];
  if (fpp?.roundsPlayed > 0) return fpp;
  if (tpp?.roundsPlayed > 0) return tpp;
  return fpp || tpp || null;
}

// ── Pearson r ─────────────────────────────────────────────────────────────────
function pearsonR(pairs) {
  const n = pairs.length;
  if (n < 3) return null;
  const xs = pairs.map(p => p[0]), ys = pairs.map(p => p[1]);
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    num += dx * dy; dx2 += dx * dx; dy2 += dy * dy;
  }
  const denom = Math.sqrt(dx2 * dy2);
  return denom === 0 ? 0 : num / denom;
}

// ── Main ──────────────────────────────────────────────────────────────────────
function computeTrends() {
  if (!fs.existsSync(CACHE)) {
    throw new Error('stats_cache.json not found — server must warm the cache first');
  }

  const { stats, seasonId, savedAt } = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
  const cacheAge = savedAt ? Math.round((Date.now() - savedAt) / 3600000) : '?';
  console.log(`[trends] stats_cache.json is ${cacheAge}h old, season ${seasonId}`);

  const MIN_GAMES = 5;
  const players = stats.map(({ member, season: sd }) => {
    const s = extractStats(sd);
    if (!s || (s.roundsPlayed || 0) < MIN_GAMES) return null;
    return { name: member.name, s };
  }).filter(Boolean);

  console.log(`[trends] ${players.length} active players (${MIN_GAMES}+ games)`);
  if (players.length < 3) {
    throw new Error(`Only ${players.length} qualifying players — need at least 3`);
  }

  function getPairs(xFn, yFn) {
    const pairs = [], names = [];
    players.forEach(p => {
      const x = xFn(p.s), y = yFn(p.s);
      if (x != null && y != null && isFinite(x) && isFinite(y)) {
        pairs.push([x, y]);
        names.push(p.name);
      }
    });
    return { pairs, names };
  }

  const datasets = {
    hsVsKd:      getPairs(s => s.kills > 3 ? (s.headshotKills||0)/s.kills : null, s => s.kills/Math.max(s.losses||1,1)),
    dmgVsKd:     getPairs(s => (s.damageDealt||0)/s.roundsPlayed,                 s => s.kills/Math.max(s.losses||1,1)),
    survVsWin:   getPairs(s => (s.timeSurvived||0)/s.roundsPlayed/60,             s => (s.wins||0)/s.roundsPlayed*100),
    teamVsWin:   getPairs(s => ((s.assists||0)+(s.revives||0))/s.roundsPlayed,    s => (s.wins||0)/s.roundsPlayed*100),
    knockVsKd:   getPairs(s => (s.dBNOs||0)/s.roundsPlayed,                       s => s.kills/Math.max(s.losses||1,1)),
    boostVsSurv: getPairs(s => (s.boosts||0)/s.roundsPlayed,                      s => (s.timeSurvived||0)/s.roundsPlayed/60),
  };

  const correlations = {};
  for (const [key, { pairs }] of Object.entries(datasets)) {
    correlations[key] = pairs.length >= 3 ? pearsonR(pairs) : null;
  }

  // Clan-wide summary stats
  const withKills = players.filter(p => p.s.kills > 3);
  const clan = {
    playerCount: players.length,
    avgKD:       players.reduce((s, p) => s + p.s.kills/Math.max(p.s.losses||1,1), 0) / players.length,
    avgHsRate:   withKills.length ? withKills.reduce((s, p) => s + (p.s.headshotKills||0)/p.s.kills, 0) / withKills.length : 0,
    avgDmgPerGame: players.reduce((s, p) => s + (p.s.damageDealt||0)/p.s.roundsPlayed, 0) / players.length,
    avgWinRate:  players.reduce((s, p) => s + (p.s.wins||0)/p.s.roundsPlayed, 0) / players.length,
    totalKills:  players.reduce((s, p) => s + (p.s.kills||0), 0),
    totalWins:   players.reduce((s, p) => s + (p.s.wins||0), 0),
    totalMatches:players.reduce((s, p) => s + (p.s.roundsPlayed||0), 0),
  };

  const result = {
    computedAt:  new Date().toISOString(),
    seasonId,
    playerCount: players.length,
    playerNames: players.map(p => p.name),
    correlations,
    datasets,
    clan,
  };

  // Write current cache
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  console.log('[trends] ✓ Written trends_cache.json');

  // Append to history (cap at 90 entries)
  let history = [];
  if (fs.existsSync(HIST)) {
    try { history = JSON.parse(fs.readFileSync(HIST, 'utf8')); } catch {}
  }
  const today = new Date().toISOString().slice(0, 10);
  // Replace today's entry if it exists (idempotent daily runs)
  history = history.filter(e => e.date !== today);
  history.push({ date: today, correlations, clan });
  history = history.slice(-90);
  fs.writeFileSync(HIST, JSON.stringify(history, null, 2));
  console.log(`[trends] ✓ History updated — ${history.length} days on record`);

  // Print summary
  const labels = {
    hsVsKd:      'HS% vs K/D   ',
    dmgVsKd:     'Dmg vs K/D   ',
    survVsWin:   'Surv vs Win% ',
    teamVsWin:   'Team vs Win% ',
    knockVsKd:   'DBNOs vs K/D ',
    boostVsSurv: 'Boosts vs Surv',
  };
  console.log('\n[trends] Correlation summary:');
  for (const [key, r] of Object.entries(correlations)) {
    const abs = r === null ? 0 : Math.abs(r);
    const strength = abs >= 0.65 ? 'STRONG  ' : abs >= 0.35 ? 'moderate' : 'weak    ';
    const dir = r !== null ? (r > 0 ? '↑+' : '↓−') : '??';
    console.log(`  ${labels[key]}  ${dir}  r=${r !== null ? r.toFixed(3) : 'null '}  [${strength}]`);
  }

  return result;
}

module.exports = { computeTrends };

// Run directly
if (require.main === module) {
  try {
    computeTrends();
    console.log('\n[trends] Done.');
  } catch (e) {
    console.error('[trends] Error:', e.message);
    process.exit(1);
  }
}
