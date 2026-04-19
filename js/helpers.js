// ── React hooks — destructured once, available to all modules in global scope ─
const { useState, useEffect, useRef, useCallback, useMemo } = React;

// ── API helpers ───────────────────────────────────────────────────────────────
const api = {
  async get(path) {
    const r = await fetch(path);
    if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || `HTTP ${r.status}`); }
    return r.json();
  },
  async post(path, body) {
    const r = await fetch(path, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    return data;
  },
  async del(path) {
    const r = await fetch(path, { method:'DELETE' });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    return data;
  },
};

// ── Stat helpers ──────────────────────────────────────────────────────────────
function kd(kills, deaths) {
  if (!deaths) return kills.toFixed(2);
  return (kills / deaths).toFixed(2);
}
function pct(n, total) {
  if (!total) return '0%';
  return (n / total * 100).toFixed(1) + '%';
}
function round(n, d = 1) { return typeof n === 'number' ? n.toFixed(d) : '—'; }
function num(n) { return typeof n === 'number' ? n.toLocaleString() : '—'; }

// Extract normalised stats from season data for a given mode.
// Checks roundsPlayed > 0 before trusting a mode — the batch endpoint returns
// zero-filled objects for modes the player has never played, which would fool
// a plain || fallback and show all zeros instead of their real TPP/FPP stats.
function extractStats(seasonData, mode = 'squad') {
  if (!seasonData) return null;
  const attrs = seasonData.data?.attributes?.gameModeStats;
  if (!attrs) return null;
  const fpp = attrs[`${mode}-fpp`];
  const tpp = attrs[mode];
  if (fpp?.roundsPlayed > 0) return fpp;
  if (tpp?.roundsPlayed > 0) return tpp;
  return fpp || tpp || null;
}

function extractLifetimeStats(lifetimeData, mode = 'squad') {
  if (!lifetimeData) return null;
  const attrs = lifetimeData.data?.attributes?.gameModeStats;
  if (!attrs) return null;
  const fpp = attrs[`${mode}-fpp`];
  const tpp = attrs[mode];
  if (fpp?.roundsPlayed > 0) return fpp;
  if (tpp?.roundsPlayed > 0) return tpp;
  return fpp || tpp || null;
}

// Convert match-history cache totals into the same shape extractStats() returns.
// Core combat stats come from our local official-only match cache.
// Fields we don't track (revives, distance, etc.) are left as 0 — caller falls back to API for those.
function extractCacheStats(totals) {
  if (!totals || !totals.roundsPlayed) return null;
  return {
    roundsPlayed:     totals.roundsPlayed,
    kills:            totals.kills            || 0,
    losses:           totals.losses           || 0,
    wins:             totals.wins             || 0,
    damageDealt:      totals.damageDealt      || 0,
    headshotKills:    totals.headshotKills    || 0,
    assists:          totals.assists          || 0,
    dBNOs:            totals.dBNOs            || 0,
    top10s:           totals.top10s           || 0,
    timeSurvived:     totals.timeSurvived     || 0,
    roundMostKills:   totals.roundMostKills   || 0,
    maxRoundDamage:   totals.maxRoundDamage   || 0,
    mostSurvivalTime: totals.mostSurvivalTime || 0,
    // API-only fields — not tracked in match cache
    revives: 0, maxKillStreaks: 0, walkDistance: 0, rideDistance: 0,
    swimDistance: 0, suicides: 0, boosts: 0, heals: 0,
    vehicleDestroys: 0, roadKills: 0, longestKill: 0, days: 0,
  };
}

// Prefer official-only cache stats for core combat fields; return null if neither available.
// Pass apiStats as fallback for display in non-core leaderboard columns.
function getStats(accountId, seasonData, historyData) {
  const cached = historyData?.[accountId]?.totals;
  if (cached && cached.roundsPlayed > 0) return extractCacheStats(cached);
  return extractStats(seasonData);
}

// ── Client-side analysis (mirrors compute_analysis.js, runs on resolvedStats) ──
// Using resolvedStats ensures the same cache-preferred data the rest of the UI
// uses (r.s for core combat stats, r.sApi for API-only fields like boosts/heals).
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
function corrStrength(r) {
  const a = Math.abs(r);
  return a >= 0.70 ? 'strong' : a >= 0.40 ? 'moderate' : 'weak';
}

function computeAnalysisFromStats(resolvedStats) {
  const MIN_GAMES = 5;
  const players = (resolvedStats || []).map(({ member, s, sApi }) => {
    if (!s || (s.roundsPlayed || 0) < MIN_GAMES) return null;
    const games  = s.roundsPlayed;
    const kills  = s.kills      || 0;
    const wins   = s.wins       || 0;
    const top10  = s.top10s     || 0;
    const hs     = s.headshotKills || 0;
    const assists= s.assists    || 0;
    // boosts/heals/longestKill are API-only (zeroed in match cache) — use sApi
    const boosts = sApi?.boosts      || 0;
    const heals  = sApi?.heals       || 0;
    const longestKill = sApi?.longestKill || 0;
    const losses      = Math.max(games - wins, 1);
    return {
      name:          member.name,
      games,  kills,  wins,  top10,
      kd:            kills / losses,
      winRate:       wins  / games,
      top10Rate:     top10 / games,
      closeOutRate:  top10 > 0 ? wins / top10 : 0,
      nearMissRate:  (top10 - wins) / games,
      hsRate:        kills > 0 ? hs / kills : 0,
      assistsPg:     assists / games,
      boostsPg:      boosts  / games,
      healsPg:       heals   / games,
      longestKill,
    };
  }).filter(Boolean);

  if (players.length < 3) return null;

  const corrDefs = [
    { key:'hsRateVsWinRate',      label:'HS% vs Win rate',           question:'Does aiming for headshots help you win?',           xs:players.map(p=>p.hsRate),      ys:players.map(p=>p.winRate) },
    { key:'assistsVsWinRate',     label:'Assists/game vs Win rate',   question:'Does supporting teammates drive wins?',             xs:players.map(p=>p.assistsPg),   ys:players.map(p=>p.winRate) },
    { key:'boostsVsWinRate',      label:'Boosts/game vs Win rate',    question:'Does using energy items drive wins?',               xs:players.map(p=>p.boostsPg),    ys:players.map(p=>p.winRate) },
    { key:'top10RateVsWinRate',   label:'Top10 rate vs Win rate',     question:'Does reaching late game convert to wins?',          xs:players.map(p=>p.top10Rate),   ys:players.map(p=>p.winRate) },
    { key:'closeOutRateVsWinRate',label:'Close-out rate vs Win rate', question:'When in top10, do they seal the deal?',            xs:players.map(p=>p.closeOutRate),ys:players.map(p=>p.winRate) },
    { key:'activityVsWinRate',    label:'Games played vs Win rate',   question:'Does playing more games improve win rate?',         xs:players.map(p=>p.games),       ys:players.map(p=>p.winRate) },
    { key:'assistsVsKd',          label:'Assists/game vs K/D',        question:'Do team players also frag well?',                  xs:players.map(p=>p.assistsPg),   ys:players.map(p=>p.kd) },
    { key:'boostsVsKd',           label:'Boosts/game vs K/D',         question:'Do resource-aware players frag better?',           xs:players.map(p=>p.boostsPg),    ys:players.map(p=>p.kd) },
    { key:'hsRateVsKd',           label:'HS% vs K/D',                 question:'Do precision aimers have better K/D?',             xs:players.map(p=>p.hsRate),      ys:players.map(p=>p.kd) },
  ];

  const correlations = {};
  for (const def of corrDefs) {
    const pairs = def.xs.map((x, i) => [x, def.ys[i]]).filter(([x, y]) => isFinite(x) && isFinite(y));
    const r = pairs.length >= 3 ? pearsonR(pairs) : null;
    correlations[def.key] = {
      label: def.label, question: def.question, r,
      direction: r === null ? null : (r > 0 ? 'positive' : 'negative'),
      strength:  r === null ? null : corrStrength(r),
      answer:    r === null ? 'unclear' : (Math.abs(r) >= 0.40 ? (r > 0 ? 'yes' : 'no') : 'unclear'),
    };
  }

  const playerProfiles = players.map(p => {
    const tags = [];
    if      (p.kd >= 1.5)        tags.push('Elite');
    else if (p.kd >= 1.0)        tags.push('Solid');
    else                         tags.push('Developing');
    if (p.winRate  >= 0.10)      tags.push('Clutch');
    if (p.hsRate   >= 0.25)      tags.push('Precision');
    if (p.assistsPg >= 0.50)     tags.push('Team Player');
    if (p.winRate  >= 0.08 && p.kd < 1.0) tags.push('Win-Smart');
    if (p.closeOutRate >= 0.30)  tags.push('Closer');
    return { name:p.name, games:p.games, wins:p.wins, top10:p.top10,
      kd:+p.kd.toFixed(3), winRate:+p.winRate.toFixed(4), top10Rate:+p.top10Rate.toFixed(4),
      closeOutRate:+p.closeOutRate.toFixed(4), nearMissRate:+p.nearMissRate.toFixed(4),
      hsRate:+p.hsRate.toFixed(4), assistsPg:+p.assistsPg.toFixed(3),
      boostsPg:+p.boostsPg.toFixed(3), longestKill:p.longestKill, tags };
  }).sort((a, b) => b.kd - a.kd);

  const n = players.length;
  const clan = {
    activePlayerCount: n,
    totalGames:   players.reduce((s,p)=>s+p.games,0),
    totalWins:    players.reduce((s,p)=>s+p.wins,0),
    avgKd:        +(players.reduce((s,p)=>s+p.kd,0)/n).toFixed(3),
    avgWinRate:   +(players.reduce((s,p)=>s+p.winRate,0)/n).toFixed(4),
    avgTop10Rate: +(players.reduce((s,p)=>s+p.top10Rate,0)/n).toFixed(4),
    avgCloseOut:  +(players.reduce((s,p)=>s+p.closeOutRate,0)/n).toFixed(4),
    avgHsRate:    +(players.reduce((s,p)=>s+p.hsRate,0)/n).toFixed(4),
    avgAssistsPg: +(players.reduce((s,p)=>s+p.assistsPg,0)/n).toFixed(3),
    topKd:        playerProfiles[0]?.name,
    topWinRate:   [...playerProfiles].sort((a,b)=>b.winRate-a.winRate)[0]?.name,
    topCloseOut:  [...playerProfiles].sort((a,b)=>b.closeOutRate-a.closeOutRate)[0]?.name,
    winlessPlayers: players.filter(p=>p.wins===0).map(p=>p.name),
  };

  const insights = [];
  const closeOutCorr = correlations.closeOutRateVsWinRate;
  if (closeOutCorr.r !== null && Math.abs(closeOutCorr.r) >= 0.70)
    insights.push({ type:'strong_correlation', id:'closeOut', key:'closeOut',
      text:`Close-out rate is the strongest predictor of win rate (r=${closeOutCorr.r.toFixed(2)}). Reaching top 10 is not enough — converting those finishes into wins is what separates the leaderboard.` });

  const assistsCorr = correlations.assistsVsWinRate;
  if (assistsCorr.answer === 'yes')
    insights.push({ type:'team_play', id:'assists', key:'assists',
      text:`Team play drives wins (r=${assistsCorr.r.toFixed(2)}). The top assist players are also the top fraggers — supporting teammates is not a trade-off.` });

  const hsCorr = correlations.hsRateVsKd;
  if (hsCorr.r !== null && hsCorr.r < -0.30) {
    const top2 = playerProfiles.slice(0,2);
    const avgHsTop2 = top2.reduce((s,p)=>s+p.hsRate,0)/top2.length;
    insights.push({ type:'counterintuitive', id:'headshots', key:'headshots',
      text:`High headshot % does not translate to better K/D (r=${hsCorr.r.toFixed(2)}). The top two fraggers average only ${(avgHsTop2*100).toFixed(0)}% headshots — body shot consistency and finishing speed matter more.` });
  }

  const winlessDecent = players.filter(p=>p.wins===0 && p.kd>=1.0);
  if (winlessDecent.length > 0)
    insights.push({ type:'spotlight', id:'winless_fraggers', key:'winless_fraggers',
      text:`${winlessDecent.map(p=>p.name).join(', ')} ${winlessDecent.length===1?'has':'have'} a K/D above 1.0 but zero wins — solid fighters who aren't closing out late game.` });

  const boostCorr = correlations.boostsVsWinRate;
  if (boostCorr.r !== null && Math.abs(boostCorr.r) < 0.15)
    insights.push({ type:'myth_bust', id:'boosts', key:'boosts',
      text:`Boost usage has no measurable correlation with win rate (r=${boostCorr.r.toFixed(2)}). It reflects play style preference, not effectiveness.` });

  return { computedAt: new Date().toISOString(), playerCount: n, correlations, players: playerProfiles, clan, insights };
}

// ── Season label ─────────────────────────────────────────────────────────────
function formatSeason(id) {
  if (!id) return '—';
  const clean = id.replace('division.bro.official.', '');
  // "pc-2018-41" → "Season 41"
  const m = clean.match(/pc-\d+-(\d+)/);
  if (m) return `Season ${m[1]}`;
  return clean;
}

// ── MAP name display ──────────────────────────────────────────────────────────
const MAP_NAMES = {
  Baltic_Main:     'Erangel',
  Chimera_Main:    'Paramo',
  Desert_Main:     'Miramar',
  DihorOtok_Main:  'Vikendi',
  Erangel_Main:    'Erangel',
  Heaven_Main:     'Haven',
  Kiki_Main:       'Deston',
  Range_Main:      'Camp Jackal',
  Savage_Main:     'Sanhok',
  Summerland_Main: 'Karakin',
  Tiger_Main:      'Taego',
};
const mapName = m => MAP_NAMES[m] || m;

// ── Icons ─────────────────────────────────────────────────────────────────────
const Icon = {
  skull:    () => <svg viewBox="0 0 24 24" fill="currentColor" className="app-icon"><path d="M12 2C8.13 2 5 5.13 5 9c0 2.38 1.19 4.47 3 5.74V17c0 .55.45 1 1 1h6c.55 0 1-.45 1-1v-2.26c1.81-1.27 3-3.36 3-5.74 0-3.87-3.13-7-7-7zm1 13h-2v-2h2v2zm0-4h-2V9h2v2z"/></svg>,
  trophy:   () => <svg viewBox="0 0 24 24" fill="currentColor" className="app-icon"><path d="M19 5h-2V3H7v2H5c-1.1 0-2 .9-2 2v1c0 2.55 1.92 4.63 4.39 4.94.63 1.5 1.98 2.63 3.61 2.96V19H7v2h10v-2h-4v-3.1c1.63-.33 2.98-1.46 3.61-2.96C19.08 12.63 21 10.55 21 8V7c0-1.1-.9-2-2-2zM5 8V7h2v3.82C5.84 10.4 5 9.3 5 8zm14 0c0 1.3-.84 2.4-2 2.82V7h2v1z"/></svg>,
  target:   () => <svg viewBox="0 0 24 24" fill="currentColor" className="app-icon"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93V18h2v1.93c-3.94-.49-7-3.85-7-7.93s3.06-7.44 7-7.93V6h2V4.07c3.94.49 7 3.85 7 7.93s-3.06 7.44-7 7.93zM12 8c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4-1.79-4-4-4z"/></svg>,
  star:     () => <svg viewBox="0 0 24 24" fill="currentColor" className="app-icon"><path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg>,
  users:    () => <svg viewBox="0 0 24 24" fill="currentColor" className="app-icon"><path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>,
  chart:    () => <svg viewBox="0 0 24 24" fill="currentColor" className="app-icon"><path d="M5 9.2h3V19H5V9.2zM10.6 5h2.8v14h-2.8V5zM16.2 13h2.8v6h-2.8v-6z"/></svg>,
  clock:    () => <svg viewBox="0 0 24 24" fill="currentColor" className="app-icon"><path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zm.01 18c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67V7z"/></svg>,
  settings: () => <svg viewBox="0 0 24 24" fill="currentColor" className="app-icon"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>,
  plus:     () => <svg viewBox="0 0 24 24" fill="currentColor" className="app-icon"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>,
  trash:    () => <svg viewBox="0 0 24 24" fill="currentColor" className="app-icon app-icon-sm"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>,
  refresh:  () => <svg viewBox="0 0 24 24" fill="currentColor" className="app-icon"><path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>,
  home:     () => <svg viewBox="0 0 24 24" fill="currentColor" className="app-icon"><path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/></svg>,
  key:      () => <svg viewBox="0 0 24 24" fill="currentColor" className="app-icon"><path d="M12.65 10C11.83 7.67 9.61 6 7 6c-3.31 0-6 2.69-6 6s2.69 6 6 6c2.61 0 4.83-1.67 5.65-4H17v4h4v-4h2v-4H12.65zM7 14c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2z"/></svg>,
  gamepad:  () => <svg viewBox="0 0 24 24" fill="currentColor" className="app-icon"><path d="M15 7.5V2H9v5.5l3 3 3-3zM7.5 9H2v6h5.5l3-3-3-3zm1 6.5V21h6v-5.5l-3-3-3 3zm7.5-6.5l-3 3 3 3H21V9h-5.5z"/></svg>,
  trend:    () => <svg viewBox="0 0 24 24" fill="currentColor" className="app-icon"><path d="M3.5 18.49l6-6.01 4 4L22 6.92l-1.41-1.41-7.09 7.97-4-4L2 16.99z"/></svg>,
};
