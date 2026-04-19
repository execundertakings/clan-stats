#!/usr/bin/env node
'use strict';
// ── compute_analysis.js ───────────────────────────────────────────────────────
// Reads data/stats_cache.json and computes a non-circular player analysis:
//
//   • Correlations between truly independent variables (not damage vs kills,
//     not survival time, not DBNOs — all of which are circular with kills/wins)
//   • Per-player close-out rate: of top-10 finishes, how many become wins?
//   • Headshot % vs actual outcomes
//   • Assist leaders
//   • Winless players
//   • Player archetypes
//
// Aggregates across ALL game modes (squad-fpp + squad + solo, etc.) so players
// who split time between modes are fairly represented.
//
// Writes: data/analysis_cache.json
// Called by: scripts/daily_clan.js

const fs   = require('fs');
const path = require('path');

const DATA  = path.join(__dirname, '..', 'data');
const CACHE = path.join(DATA, 'stats_cache.json');
const OUT   = path.join(DATA, 'analysis_cache.json');

const MIN_GAMES = 5;

// ── Aggregate all game mode stats for a player ────────────────────────────────
function aggregateModes(seasonData) {
  const attrs = seasonData?.data?.attributes?.gameModeStats;
  if (!attrs) return null;

  const totals = {};
  for (const modeStats of Object.values(attrs)) {
    for (const [key, val] of Object.entries(modeStats)) {
      totals[key] = (totals[key] || 0) + (val || 0);
    }
  }
  return totals;
}

// ── Pearson r ─────────────────────────────────────────────────────────────────
function pearsonR(pairs) {
  const n = pairs.length;
  if (n < 3) return null;
  const xs = pairs.map(p => p[0]);
  const ys = pairs.map(p => p[1]);
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

function corrStrength(r) {
  const abs = Math.abs(r);
  if (abs >= 0.70) return 'strong';
  if (abs >= 0.40) return 'moderate';
  return 'weak';
}

// ── Main ──────────────────────────────────────────────────────────────────────
function computeAnalysis() {
  if (!fs.existsSync(CACHE)) {
    throw new Error('stats_cache.json not found — server must warm the cache first');
  }

  const { stats, seasonId, savedAt } = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
  const cacheAge = savedAt ? Math.round((Date.now() - savedAt) / 3600000) : '?';
  console.log(`[analysis] stats_cache.json is ${cacheAge}h old, season ${seasonId}`);

  // Build per-player metrics
  const players = [];
  for (const { member, season: sd } of stats) {
    const t = aggregateModes(sd);
    if (!t) continue;

    const games  = t.roundsPlayed || 0;
    if (games < MIN_GAMES) continue;

    const kills  = t.kills  || 0;
    const wins   = t.wins   || 0;
    const top10  = t.top10s || 0;
    const hs     = t.headshotKills || 0;
    const assists= t.assists || 0;
    const boosts = t.boosts  || 0;
    const heals  = t.heals   || 0;

    const losses    = Math.max(games - wins, 1);
    const kd        = kills / losses;
    const winRate   = wins  / games;
    const top10Rate = top10 / games;
    // close-out rate: of the top10 finishes, what fraction become wins?
    const closeOutRate = top10 > 0 ? wins / top10 : 0;
    // near-miss rate: top10 finishes that were NOT wins (as fraction of games)
    const nearMissRate = (top10 - wins) / games;
    const hsRate    = kills > 0 ? hs / kills : 0;
    const assistsPg = assists / games;
    const boostsPg  = boosts  / games;
    const healsPg   = heals   / games;

    players.push({
      name: member.name,
      games,
      kills,
      wins,
      top10,
      kd,
      winRate,
      top10Rate,
      closeOutRate,
      nearMissRate,
      hsRate,
      assistsPg,
      boostsPg,
      healsPg,
      longestKill: t.longestKill || 0,
    });
  }

  console.log(`[analysis] ${players.length} active players (${MIN_GAMES}+ games)`);
  if (players.length < 3) {
    throw new Error(`Only ${players.length} qualifying players — need at least 3`);
  }

  // ── Non-circular correlations ──────────────────────────────────────────────
  // Excluded as circular: survival time, DBNOs, damage dealt — all are the
  // same underlying action as kills/wins.
  const corrDefs = [
    {
      key:      'hsRateVsWinRate',
      label:    'HS% vs Win rate',
      question: 'Does aiming for headshots help you win?',
      xs: players.map(p => p.hsRate),
      ys: players.map(p => p.winRate),
    },
    {
      key:      'assistsVsWinRate',
      label:    'Assists/game vs Win rate',
      question: 'Does supporting teammates drive wins?',
      xs: players.map(p => p.assistsPg),
      ys: players.map(p => p.winRate),
    },
    {
      key:      'boostsVsWinRate',
      label:    'Boosts/game vs Win rate',
      question: 'Does using energy items drive wins?',
      xs: players.map(p => p.boostsPg),
      ys: players.map(p => p.winRate),
    },
    {
      key:      'top10RateVsWinRate',
      label:    'Top10 rate vs Win rate',
      question: 'Does reaching late game convert to wins?',
      xs: players.map(p => p.top10Rate),
      ys: players.map(p => p.winRate),
    },
    {
      key:      'closeOutRateVsWinRate',
      label:    'Close-out rate vs Win rate',
      question: 'When in top10, do they seal the deal?',
      xs: players.map(p => p.closeOutRate),
      ys: players.map(p => p.winRate),
    },
    {
      key:      'activityVsWinRate',
      label:    'Games played vs Win rate',
      question: 'Does playing more games improve win rate?',
      xs: players.map(p => p.games),
      ys: players.map(p => p.winRate),
    },
    {
      key:      'assistsVsKd',
      label:    'Assists/game vs K/D',
      question: 'Do team players also frag well?',
      xs: players.map(p => p.assistsPg),
      ys: players.map(p => p.kd),
    },
    {
      key:      'boostsVsKd',
      label:    'Boosts/game vs K/D',
      question: 'Do resource-aware players frag better?',
      xs: players.map(p => p.boostsPg),
      ys: players.map(p => p.kd),
    },
    {
      key:      'hsRateVsKd',
      label:    'HS% vs K/D',
      question: 'Do precision aimers have better K/D?',
      xs: players.map(p => p.hsRate),
      ys: players.map(p => p.kd),
    },
  ];

  const correlations = {};
  for (const def of corrDefs) {
    const pairs = def.xs.map((x, i) => [x, def.ys[i]]).filter(([x, y]) => isFinite(x) && isFinite(y));
    const r = pairs.length >= 3 ? pearsonR(pairs) : null;
    correlations[def.key] = {
      label:    def.label,
      question: def.question,
      r,
      direction: r === null ? null : (r > 0 ? 'positive' : 'negative'),
      strength:  r === null ? null : corrStrength(r),
      answer:    r === null ? 'unclear' : (Math.abs(r) >= 0.40 ? (r > 0 ? 'yes' : 'no') : 'unclear'),
    };
  }

  // ── Per-player detail ──────────────────────────────────────────────────────
  const playerProfiles = players.map(p => {
    // Archetypes
    const tags = [];
    if      (p.kd >= 1.5)  tags.push('Elite');
    else if (p.kd >= 1.0)  tags.push('Solid');
    else                   tags.push('Developing');

    if (p.winRate >= 0.10)  tags.push('Clutch');
    if (p.hsRate  >= 0.25)  tags.push('Precision');
    if (p.assistsPg >= 0.50) tags.push('Team Player');
    // Win-smart: wins more than their K/D would predict
    if (p.winRate >= 0.08 && p.kd < 1.0) tags.push('Win-Smart');
    if (p.closeOutRate >= 0.30) tags.push('Closer');

    return {
      name:          p.name,
      games:         p.games,
      wins:          p.wins,
      top10:         p.top10,
      kd:            +p.kd.toFixed(3),
      winRate:       +p.winRate.toFixed(4),
      top10Rate:     +p.top10Rate.toFixed(4),
      closeOutRate:  +p.closeOutRate.toFixed(4),
      nearMissRate:  +p.nearMissRate.toFixed(4),
      hsRate:        +p.hsRate.toFixed(4),
      assistsPg:     +p.assistsPg.toFixed(3),
      boostsPg:      +p.boostsPg.toFixed(3),
      longestKill:   p.longestKill,
      tags,
    };
  });

  // Sort by K/D descending for the profile list
  playerProfiles.sort((a, b) => b.kd - a.kd);

  // ── Clan-wide summary ──────────────────────────────────────────────────────
  const n = players.length;
  const clan = {
    activePlayerCount: n,
    totalGames:    players.reduce((s, p) => s + p.games, 0),
    totalWins:     players.reduce((s, p) => s + p.wins, 0),
    avgKd:         +(players.reduce((s, p) => s + p.kd, 0)       / n).toFixed(3),
    avgWinRate:    +(players.reduce((s, p) => s + p.winRate, 0)   / n).toFixed(4),
    avgTop10Rate:  +(players.reduce((s, p) => s + p.top10Rate, 0) / n).toFixed(4),
    avgCloseOut:   +(players.reduce((s, p) => s + p.closeOutRate, 0) / n).toFixed(4),
    avgHsRate:     +(players.reduce((s, p) => s + p.hsRate, 0)    / n).toFixed(4),
    avgAssistsPg:  +(players.reduce((s, p) => s + p.assistsPg, 0) / n).toFixed(3),
    topKd:         playerProfiles[0]?.name,
    topWinRate:    playerProfiles.slice().sort((a, b) => b.winRate - a.winRate)[0]?.name,
    topCloseOut:   playerProfiles.slice().sort((a, b) => b.closeOutRate - a.closeOutRate)[0]?.name,
    winlessPlayers: players.filter(p => p.wins === 0).map(p => p.name),
  };

  // ── Key insights (text bullets for the site) ───────────────────────────────
  const insights = [];

  // Close-out finding
  const closeOutCorr = correlations.closeOutRateVsWinRate;
  if (closeOutCorr.r !== null && Math.abs(closeOutCorr.r) >= 0.70) {
    insights.push({
      type: 'strong_correlation',
      key:  'closeOut',
      text: `Close-out rate is the strongest predictor of win rate (r=${closeOutCorr.r.toFixed(2)}). Reaching top 10 is not enough — converting those finishes into wins is what separates the leaderboard.`,
    });
  }

  // Assists finding
  const assistsCorr = correlations.assistsVsWinRate;
  if (assistsCorr.answer === 'yes') {
    insights.push({
      type: 'team_play',
      key:  'assists',
      text: `Team play drives wins (r=${assistsCorr.r.toFixed(2)}). The top assist players are also the top fraggers — supporting teammates is not a trade-off.`,
    });
  }

  // HS% negative finding
  const hsCorr = correlations.hsRateVsKd;
  if (hsCorr.r !== null && hsCorr.r < -0.30) {
    const topFraggers = playerProfiles.slice(0, 2);
    const avgHsTop2 = topFraggers.reduce((s, p) => s + p.hsRate, 0) / topFraggers.length;
    insights.push({
      type: 'counterintuitive',
      key:  'headshots',
      text: `High headshot % does not translate to better K/D (r=${hsCorr.r.toFixed(2)}). The top two fraggers average only ${(avgHsTop2 * 100).toFixed(0)}% headshots — body shot consistency and finishing speed matter more.`,
    });
  }

  // Winless players with decent K/D (close-out problem)
  const winlessDecent = players.filter(p => p.wins === 0 && p.kd >= 1.0);
  if (winlessDecent.length > 0) {
    insights.push({
      type: 'spotlight',
      key:  'winless_fraggers',
      text: `${winlessDecent.map(p => p.name).join(', ')} ${winlessDecent.length === 1 ? 'has' : 'have'} a K/D above 1.0 but zero wins — solid fighters who aren't closing out late game.`,
    });
  }

  // Boosts irrelevant
  const boostCorr = correlations.boostsVsWinRate;
  if (boostCorr.r !== null && Math.abs(boostCorr.r) < 0.15) {
    insights.push({
      type: 'myth_bust',
      key:  'boosts',
      text: `Boost usage has no measurable correlation with win rate (r=${boostCorr.r.toFixed(2)}). It reflects play style preference, not effectiveness.`,
    });
  }

  // Print summary
  console.log('\n[analysis] Correlation summary (non-circular only):');
  for (const [, c] of Object.entries(correlations)) {
    const dir = c.r !== null ? (c.r > 0 ? '↑+' : '↓−') : '??';
    const r   = c.r !== null ? c.r.toFixed(3) : 'null ';
    const str = c.strength ? c.strength.padEnd(8) : '?       ';
    console.log(`  ${c.label.padEnd(35)}  ${dir}  r=${r}  [${str}]  → ${c.answer}`);
  }
  console.log(`\n[analysis] ${insights.length} key insight(s) generated`);

  const result = {
    computedAt:   new Date().toISOString(),
    seasonId,
    playerCount:  n,
    correlations,
    players:      playerProfiles,
    clan,
    insights,
    note: 'Aggregates all game modes. Excludes circular metrics (survival time, DBNOs, damage dealt).',
  };

  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  console.log('[analysis] ✓ Written analysis_cache.json');

  return result;
}

module.exports = { computeAnalysis };

// Run directly
if (require.main === module) {
  try {
    const r = computeAnalysis();
    const top = Object.entries(r.correlations)
      .filter(([, c]) => c.r !== null)
      .sort(([, a], [, b]) => Math.abs(b.r) - Math.abs(a.r))[0];
    console.log(`\n[analysis] Done. Strongest: ${top[1].label} r=${top[1].r.toFixed(3)}`);
  } catch (e) {
    console.error('[analysis] Error:', e.message);
    process.exit(1);
  }
}
