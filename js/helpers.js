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
