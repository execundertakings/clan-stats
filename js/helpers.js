// ── React hooks — destructured once, available to all modules in global scope ─
const { useState, useEffect, useRef, useCallback, useMemo } = React;

// ── Clan branding — single source of truth ────────────────────────────────────
// Injected by the server from config/clan.config.json as window.__CLAN_CONFIG__.
// All components read branding from CLAN; never hardcode the clan name/tag/wording.
const CLAN = (typeof window !== 'undefined' && window.__CLAN_CONFIG__) || {
  name: 'Clan', shortName: 'Clan', tag: 'CLAN', emoji: '🎮',
  memberNoun: 'member', memberNounPlural: 'members', subtitle: '',
  restrictedLabel: '', bootTitle: '', bootBody: '', publicUrl: '',
};

// ── API helpers ───────────────────────────────────────────────────────────────
let _adminPassword = '';

function adminHeaders() {
  return _adminPassword ? { 'X-Admin-Password': _adminPassword } : {};
}

const api = {
  setAdminPassword(password) {
    _adminPassword = password || '';
  },
  async get(path, opts = {}) {
    const r = await fetch(path, { headers: opts.admin ? adminHeaders() : {} });
    if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || `HTTP ${r.status}`); }
    return r.json();
  },
  async post(path, body, opts = {}) {
    const r = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(opts.skipAdmin ? {} : adminHeaders()) },
      body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    return data;
  },
  async del(path) {
    const r = await fetch(path, { method:'DELETE', headers: adminHeaders() });
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
// Aggregates both TPP and FPP variants of the mode so players who split time
// across squad and squad-fpp get a complete count — not just one mode.
// Peak-value fields (longestKill, roundMostKills, etc.) are max'd; everything
// else is summed. Falls back to aggregating all modes if no squad games exist.
const PEAK_FIELDS = new Set(['longestKill', 'maxKillStreaks', 'roundMostKills', 'mostSurvivalTime', 'maxRoundDamage']);
function extractStats(seasonData, mode = 'squad') {
  if (!seasonData) return null;
  const attrs = seasonData.data?.attributes?.gameModeStats;
  if (!attrs) return null;
  const fppRaw = attrs[`${mode}-fpp`];
  const tppRaw = attrs[mode];
  const fpp = fppRaw && typeof fppRaw === 'object' ? fppRaw : {};
  const tpp = tppRaw && typeof tppRaw === 'object' ? tppRaw : {};
  const fppRounds = fpp.roundsPlayed || 0;
  const tppRounds = tpp.roundsPlayed || 0;

  // Neither squad mode has rounds — player may play duo or solo exclusively.
  // Aggregate all available modes so we never show zeros for active players.
  if (fppRounds === 0 && tppRounds === 0) {
    const totals = {};
    for (const modeStats of Object.values(attrs)) {
      if (!modeStats || typeof modeStats !== 'object') continue;
      for (const [key, val] of Object.entries(modeStats)) {
        if (typeof val === 'number') totals[key] = (totals[key] || 0) + val;
      }
    }
    if (totals.roundsPlayed > 0) return totals;
    return null;
  }

  // Only one mode has rounds — return it directly (no summing needed).
  if (fppRounds === 0) return tpp;
  if (tppRounds === 0) return fpp;

  // Both modes have rounds — aggregate them.
  const combined = {};
  const keys = new Set([...Object.keys(fpp), ...Object.keys(tpp)]);
  for (const key of keys) {
    const fv = typeof fpp[key] === 'number' ? fpp[key] : 0;
    const tv = typeof tpp[key] === 'number' ? tpp[key] : 0;
    combined[key] = PEAK_FIELDS.has(key) ? Math.max(fv, tv) : fv + tv;
  }
  return combined;
}

function extractLifetimeStats(lifetimeData, mode = 'squad') {
  if (!lifetimeData) return null;
  const attrs = lifetimeData.data?.attributes?.gameModeStats;
  if (!attrs) return null;
  const fppRaw = attrs[`${mode}-fpp`];
  const tppRaw = attrs[mode];
  const fpp = fppRaw && typeof fppRaw === 'object' ? fppRaw : {};
  const tpp = tppRaw && typeof tppRaw === 'object' ? tppRaw : {};
  const fppRounds = fpp.roundsPlayed || 0;
  const tppRounds = tpp.roundsPlayed || 0;
  if (fppRounds === 0 && tppRounds === 0) return null;
  if (fppRounds === 0) return tpp;
  if (tppRounds === 0) return fpp;
  // Aggregate both lifetime squad modes
  const combined = {};
  const keys = new Set([...Object.keys(fpp), ...Object.keys(tpp)]);
  for (const key of keys) {
    const fv = typeof fpp[key] === 'number' ? fpp[key] : 0;
    const tv = typeof tpp[key] === 'number' ? tpp[key] : 0;
    combined[key] = PEAK_FIELDS.has(key) ? Math.max(fv, tv) : fv + tv;
  }
  return combined;
}

// Convert match-history cache totals into the same shape extractStats() returns.
// Core combat stats come from our local official-only match cache.
// Fields we don't track (revives, distance, etc.) stay at 0 until the
// telemetry-derived caches fill them from applicable matches too.
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
    // Fields sourced elsewhere (weapon_cache / history daysPlayed) — not in match totals
    revives: 0, maxKillStreaks: 0, walkDistance: 0, rideDistance: 0,
    swimDistance: 0, suicides: 0, boosts: 0, heals: 0,
    vehicleDestroys: 0, roadKills: 0, longestKill: 0, days: 0,
  };
}

function historyCoverageSummary(coverage) {
  if (!coverage) return null;
  const apiRounds = coverage.apiRounds || 0;
  const usedMatches = coverage.usedMatches || 0;
  const capturedMatches = coverage.capturedMatches || usedMatches;
  const missingGap = Math.max(apiRounds - usedMatches, 0);
  const surplusGap = Math.max(capturedMatches - usedMatches, 0);
  const allowedMissing = Math.max(2, Math.round(apiRounds * 0.03));
  return {
    apiRounds,
    usedMatches,
    capturedMatches,
    missingGap,
    surplusGap,
    // Trusted = telemetry window is consistent with the stats window.
    // The only case where they diverge is surplusGap > 0: the match-history
    // trimmed to fewer games than the weapon cache processed, so telemetry
    // covers a LARGER set than the stats. In that case, withhold telemetry.
    //
    // missingGap (local cache has fewer than API total) is NOT a trust problem:
    // both stats AND telemetry are derived from the same captured subset, so
    // they remain consistent with each other — just an incomplete sample.
    trusted: !apiRounds || surplusGap === 0,
  };
}

function historyCoverageLabel(coverage) {
  const summary = historyCoverageSummary(coverage);
  if (!summary?.apiRounds) return null;
  if (summary.surplusGap > 0) return `${summary.usedMatches}/${summary.apiRounds} counted · ${summary.surplusGap} older trimmed`;
  return `${summary.usedMatches}/${summary.apiRounds} captured`;
}

// The filtered match-history cache is the only source of truth for current-
// season totals. We never fall back to broader PUBG season aggregates here,
// because those can include non-applicable match types.
function getStats(accountId, seasonData, historyData) {
  const historyEntry = historyData?.[accountId] || null;
  const cached = extractCacheStats(historyEntry?.totals);
  return cached || null;
}

// ── Shared scoring formula ────────────────────────────────────────────────────
// Single definition used by the app.js trunk. Each component is normalised
// against a clan-elite benchmark; players who hit every benchmark land at ~100+.
// Components (max-at-benchmark in parens):
//   Combat   38 — K/D (22 @ 2.0) + avgDmg (11 @ 220) + HS% (5 @ 0.30)
//   Survival 14 — top10Rate (14 @ 0.55)
//   Outcomes 31 — winRate (21 @ 0.12) + closeOutRate (10 @ 0.22)
//   Support  26 — assistsPg (20 @ 0.70) + revivesPg (6 @ 0.45)
//   Volume    6 — games (6 capped at 250)
// Keep in sync with the OVR tooltip in leaderboard.js.
function computeScore({ kdVal, avgDmg, hsRate, top10Rate, winRate, closeOutRate, assistsPg, revivesPg, games }) {
  const combat   = (kdVal     / 2.0)  * 22
                 + (avgDmg    / 220)  * 11
                 + (hsRate    / 0.30) * 5;
  const survival = (top10Rate / 0.55) * 14;
  const outcomes = (winRate      / 0.12) * 21
                 + (closeOutRate / 0.22) * 10;
  const support  = (assistsPg / 0.70) * 20
                 + (revivesPg / 0.45) * 6;
  const volume   = Math.min((games || 0) / 250, 1) * 6;
  return Math.round(combat + survival + outcomes + support + volume);
}

// ── Client-side analysis (runs on resolvedStats) ──
// All fields come from resolvedStats trunk (official-only data — no raw API reads).
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
  // All derived metrics are pre-computed in the resolvedStats trunk by App.
  // We destructure them directly — no re-derivation here.
  const players = (resolvedStats || []).map(({ member, s,
      games, kills, wins, top10,
      kdVal, winRate, top10Rate, closeOutRate, nearMissRate,
      hsRate, assistsPg, boostsPg, healsPg, dmgPerKill, longestKill }) => {
    if (!s || games < MIN_GAMES) return null;
    return {
      name: member.name,
      games, kills, wins, top10,
      kd:         kdVal,
      winRate,    top10Rate,    closeOutRate, nearMissRate,
      hsRate,     assistsPg,   boostsPg,     healsPg,
      dmgPerKill: dmgPerKill || 0,
      longestKill: longestKill || 0,
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

  // Pre-compute clan averages so playerProfiles can generate contextual summaries/tips
  const _pn = players.length;
  const _avgKd        = players.reduce((s,p)=>s+p.kd,0) / _pn;
  const _avgWinRate   = players.reduce((s,p)=>s+p.winRate,0) / _pn;
  const _avgTop10Rate = players.reduce((s,p)=>s+p.top10Rate,0) / _pn;
  const _avgCloseOut  = players.reduce((s,p)=>s+p.closeOutRate,0) / _pn;
  const _avgHsRate    = players.reduce((s,p)=>s+p.hsRate,0) / _pn;
  const _avgAssistsPg = players.reduce((s,p)=>s+p.assistsPg,0) / _pn;

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

    // ── Per-player summary ──────────────────────────────────────────────────
    let summary;
    if (p.kd >= 1.5) {
      summary = `${p.name} is one of the clan's elite fraggers — a ${p.kd.toFixed(2)} K/D across ${p.games} games puts them firmly at the top of the roster.`;
    } else if (p.kd >= 1.0) {
      summary = `${p.name} holds a solid ${p.kd.toFixed(2)} K/D across ${p.games} games, staying above the clan average of ${_avgKd.toFixed(2)}.`;
    } else {
      summary = `${p.name} is still developing their game — a ${p.kd.toFixed(2)} K/D across ${p.games} games with room to grow.`;
    }
    if (p.winRate >= _avgWinRate * 1.4) {
      summary += ` Their ${(p.winRate*100).toFixed(1)}% win rate is well above clan average — they know how to close.`;
    } else if (p.winRate >= _avgWinRate * 0.7) {
      summary += ` A ${(p.winRate*100).toFixed(1)}% win rate tracks close to the clan average.`;
    } else if (p.wins === 0) {
      summary += ` They haven't grabbed a chicken dinner yet this season.`;
    } else {
      summary += ` A ${(p.winRate*100).toFixed(1)}% win rate suggests the final circle is a work in progress.`;
    }
    if (p.hsRate >= 0.30) {
      summary += ` High headshot rate (${(p.hsRate*100).toFixed(0)}%) marks them as one of the clan's sharpest aimers.`;
    } else if (p.assistsPg >= _avgAssistsPg * 1.4) {
      summary += ` ${p.assistsPg.toFixed(1)} assists/game makes them one of the most selfless team players on the roster.`;
    } else if (p.closeOutRate >= _avgCloseOut * 1.4 && p.top10 >= 3) {
      summary += ` Their close-out rate (${(p.closeOutRate*100).toFixed(0)}%) is elite — they convert final-circle presence into wins.`;
    }

    // ── Per-player actionable tip ───────────────────────────────────────────
    // Score each potential weakness by how far below clan average the player is
    const gaps = [];
    if (p.top10 >= 3 && p.closeOutRate < _avgCloseOut * 0.80)
      gaps.push({ key:'closeout', delta: (_avgCloseOut - p.closeOutRate) / Math.max(_avgCloseOut, 0.01) });
    if (p.kd < _avgKd * 0.70)
      gaps.push({ key:'kd', delta: (_avgKd - p.kd) / Math.max(_avgKd, 0.01) });
    if (p.games >= 8 && p.assistsPg < _avgAssistsPg * 0.50)
      gaps.push({ key:'assists', delta: (_avgAssistsPg - p.assistsPg) / Math.max(_avgAssistsPg, 0.01) });
    if (p.hsRate < _avgHsRate * 0.55 && p.kills >= 20)
      gaps.push({ key:'headshots', delta: (_avgHsRate - p.hsRate) / Math.max(_avgHsRate, 0.01) });
    if (p.top10Rate < _avgTop10Rate * 0.65 && p.games >= 8)
      gaps.push({ key:'survival', delta: (_avgTop10Rate - p.top10Rate) / Math.max(_avgTop10Rate, 0.01) });
    gaps.sort((a, b) => b.delta - a.delta);

    let tip;
    const worst = gaps[0]?.key;
    if (worst === 'closeout') {
      tip = `You reach the final circle but aren't converting — ${(p.closeOutRate*100).toFixed(0)}% close-out vs clan avg ${(_avgCloseOut*100).toFixed(0)}%. In the last ring, push actively when you have the count advantage rather than playing passive and letting the zone shrink your options.`;
    } else if (worst === 'kd') {
      tip = `Your K/D (${p.kd.toFixed(2)}) has room to climb. Prioritise fight selection over raw aggression — take engagements where you have cover or height, and disengage when you're exposed. Fewer bad trades quickly moves the needle.`;
    } else if (worst === 'assists') {
      tip = `Your assists/game (${p.assistsPg.toFixed(1)}) sit below the clan average (${_avgAssistsPg.toFixed(1)}). Communicate enemy positions and call out your knocks — letting teammates secure kills you've softened builds chemistry and boosts squad win rate.`;
    } else if (worst === 'headshots') {
      tip = `A ${(p.hsRate*100).toFixed(0)}% headshot rate leaves damage on the table. Practice high-chest aim as your default — it converts cleanly to headshots at most ranges without sacrificing consistency.`;
    } else if (worst === 'survival') {
      tip = `Your top-10 rate (${(p.top10Rate*100).toFixed(0)}%) suggests early exits are costing you. Look for loot routes that keep you inside zone by mid-game — dying to the blue is a free loss.`;
    } else if (p.kd >= _avgKd * 1.1 && p.winRate < _avgWinRate * 0.85) {
      tip = `Your K/D is strong but win rate lags. You're winning fights but not games. Zone in earlier in the final rings and stop taking late-fight detours — your position should do the work in the endgame.`;
    } else if (p.winRate >= _avgWinRate * 1.1 && p.kd < _avgKd * 0.9) {
      tip = `You win games despite a below-average K/D — your game sense is real. To level up, focus on converting your position into clean eliminations rather than waiting for perfect shots.`;
    } else {
      tip = `Your stats are well-rounded. The next gains come from consistency — review what you did differently in your winning sessions and make those habits automatic.`;
    }

    return { name:p.name, games:p.games, wins:p.wins, top10:p.top10,
      kd:+p.kd.toFixed(3), winRate:+p.winRate.toFixed(4), top10Rate:+p.top10Rate.toFixed(4),
      closeOutRate:+p.closeOutRate.toFixed(4), nearMissRate:+p.nearMissRate.toFixed(4),
      hsRate:+p.hsRate.toFixed(4), assistsPg:+p.assistsPg.toFixed(3),
      boostsPg:+p.boostsPg.toFixed(3), longestKill:p.longestKill, tags, summary, tip };
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

  // ── Generate the 6 insight cards expected by trends.js ───────────────────────
  // Each entry needs: id, type, icon, title, finding, tip, players[]
  // cardData() in trends.js handles visualization data independently from resolvedStats.
  const insights = [];

  // 1. efficiency_killer — damage per kill (lower = cleaner finisher)
  const effPlayers = players.filter(p => p.dmgPerKill > 0 && p.games >= 8).sort((a, b) => a.dmgPerKill - b.dmgPerKill);
  if (effPlayers.length >= 2) {
    const best = effPlayers[0];
    const worst = effPlayers[effPlayers.length - 1];
    insights.push({
      id: 'efficiency_killer', type: 'insight', icon: '⚡', title: 'Efficiency Killers',
      finding: `${best.name} closes fights with only ${Math.round(best.dmgPerKill)} damage per kill — the cleanest finisher on the roster. ${worst.name} needs ${Math.round(worst.dmgPerKill)} damage to secure the same result, a sign of fights that drag on.`,
      tip: `Damage per kill reveals who finishes efficiently vs. who wastes bullets on downed enemies. Lower is better — it means decisive, fast closes.`,
      players: effPlayers.slice(0, 3).map(p => p.name),
    });
  }

  // 2. headshot_trap — HS% leaders vs their win rate
  const hsPlayers = players.filter(p => p.hsRate > 0 && p.games >= 8).sort((a, b) => b.hsRate - a.hsRate);
  if (hsPlayers.length >= 3) {
    const top3hs = hsPlayers.slice(0, 3);
    const avgWinTop3 = top3hs.reduce((s, p) => s + p.winRate, 0) / top3hs.length;
    const avgWinAll  = players.reduce((s, p) => s + p.winRate, 0) / players.length;
    const hsKdCorr   = correlations.hsRateVsKd?.r;
    const corrNote   = hsKdCorr !== null ? ` HS% vs K/D correlation across the clan: r=${hsKdCorr.toFixed(2)} (${Math.abs(hsKdCorr) < 0.25 ? 'no link' : hsKdCorr < 0 ? 'negative' : 'positive'}).` : '';
    insights.push({
      id: 'headshot_trap', type: 'counterintuitive', icon: '🎯', title: 'The Headshot Trap',
      finding: `The top 3 headshot artists (${top3hs.map(p => p.name).join(', ')}) average a ${(avgWinTop3 * 100).toFixed(1)}% win rate vs. the clan average of ${(avgWinAll * 100).toFixed(1)}%.${corrNote} Chasing headshots doesn't reliably translate to more wins.`,
      tip: `Body shot consistency and clean follow-up speed matter more than precision aiming. Fast finishes beat flashy headshots.`,
      players: top3hs.map(p => p.name),
    });
  }

  // 3. dark_horse_winners — biggest positive gap between win rank and K/D rank
  const pool10 = players.filter(p => p.games >= 10);
  if (pool10.length >= 4) {
    const byKd  = [...pool10].sort((a, b) => b.kd - a.kd);
    const byWin = [...pool10].sort((a, b) => b.winRate - a.winRate);
    let best = { flip: -Infinity, name: '', kdR: 1, winR: 1 };
    byKd.forEach((p, ki) => {
      const wi = byWin.findIndex(x => x.name === p.name);
      if ((ki - wi) > best.flip) best = { flip: ki - wi, name: p.name, kdR: ki + 1, winR: wi + 1 };
    });
    if (best.flip > 0) {
      insights.push({
        id: 'dark_horse_winners', type: 'insight', icon: '🌑', title: 'Dark Horse Winners',
        finding: `${best.name} ranks #${best.kdR} for K/D but #${best.winR} for win rate — ${best.kdR - best.winR} spots higher in the standings when it counts. Smart positioning and late-game reads are worth more than raw frag output.`,
        tip: `Win rate and K/D don't always agree. Players who over-perform their K/D in wins understand end-game circle dynamics better than their kill count suggests.`,
        players: byWin.slice(0, 2).map(p => p.name),
      });
    } else {
      const topWinner = byWin[0];
      insights.push({
        id: 'dark_horse_winners', type: 'insight', icon: '🌑', title: 'Dark Horse Winners',
        finding: `${topWinner.name} leads the clan in win rate at ${(topWinner.winRate * 100).toFixed(1)}% — converting late-game pressure into chicken dinners more consistently than anyone else.`,
        tip: `Win rate is the hardest stat to inflate. Consistent winners understand circle mechanics, resource management, and when to fight vs. hold.`,
        players: byWin.slice(0, 2).map(p => p.name),
      });
    }
  }

  // 4. closeout_crisis — top-10 to win conversion rate
  const validClose = players.filter(p => p.top10 > 0 && p.games >= 8).sort((a, b) => a.closeOutRate - b.closeOutRate);
  if (validClose.length >= 2) {
    const avg = validClose.reduce((s, p) => s + p.closeOutRate, 0) / validClose.length;
    const struggling = validClose.filter(p => p.closeOutRate < avg * 0.7 && p.top10 >= 3);
    const topCloser  = validClose[validClose.length - 1];
    insights.push({
      id: 'closeout_crisis', type: avg < 0.20 ? 'warning' : 'insight',
      icon: avg < 0.20 ? '⚠️' : '🏆', title: 'Close-out Crisis',
      finding: `The clan converts ${(avg * 100).toFixed(0)}% of top-10 finishes into wins. ${topCloser.name} leads at ${(topCloser.closeOutRate * 100).toFixed(0)}%.${struggling.length > 0 ? ` ${struggling.slice(0, 2).map(p => p.name).join(' and ')} reach the final circle but rarely close it out.` : ''}`,
      tip: `Making top 10 is the floor, not the goal. Late-game calls — when to push, when to hold position — are what separate a top-5 finish from a chicken dinner.`,
      players: struggling.slice(0, 3).map(p => p.name),
    });
  }

  // 5. vicsgmg_anomaly — Vicsgmg-specific, or biggest K/D vs win-rate gap player
  const vic = players.find(p => p.name === 'Vicsgmg');
  if (vic) {
    const peers = [...players]
      .filter(p => p.name !== 'Vicsgmg' && p.games >= 8 && Math.abs(p.kd - vic.kd) < 0.4)
      .sort((a, b) => Math.abs(a.kd - vic.kd) - Math.abs(b.kd - vic.kd)).slice(0, 3);
    const avgPeerWin = peers.length > 0 ? peers.reduce((s, p) => s + p.winRate, 0) / peers.length : null;
    insights.push({
      id: 'vicsgmg_anomaly', type: 'insight', icon: '🔍', title: 'The Anomaly',
      finding: `Vicsgmg carries a ${vic.kd.toFixed(2)} K/D across ${vic.games} games with ${vic.wins} win${vic.wins !== 1 ? 's' : ''} (${(vic.winRate * 100).toFixed(1)}% win rate).${avgPeerWin !== null ? ` Comparable K/D peers average ${(avgPeerWin * 100).toFixed(1)}% wins — a gap that points to late-game decision-making.` : ''}`,
      tip: `K/D peers with higher win rates are closing fights Vicsgmg isn't. The frags are there — the circle reads need work.`,
      players: ['Vicsgmg', ...peers.slice(0, 2).map(p => p.name)],
    });
  } else {
    // Fallback: player with most top-10s but fewest wins (highest near-miss rate)
    const anomalyPool = players.filter(p => p.games >= 10 && p.top10 >= 3).sort((a, b) => b.nearMissRate - a.nearMissRate);
    const anomaly = anomalyPool[0];
    if (anomaly) {
      insights.push({
        id: 'vicsgmg_anomaly', type: 'insight', icon: '🔍', title: 'The Anomaly',
        finding: `${anomaly.name} reaches the final circle more often than they win from it — a ${(anomaly.nearMissRate * 100).toFixed(0)}% near-miss rate across ${anomaly.games} games. The late-game positioning is there; the close-out isn't.`,
        tip: `Consistent top-5 finishes with few wins signal a tactical hesitation in the endgame. Aggressive positioning in the final circle often matters more than waiting for the right moment.`,
        players: [anomaly.name],
      });
    }
  }

  // 6. boosts_vs_wins — boost usage leaders and correlation with winning
  const boostPlayers = players.filter(p => p.boostsPg > 0 && p.games >= 8).sort((a, b) => b.boostsPg - a.boostsPg);
  const boostCorr    = correlations.boostsVsWinRate?.r;
  if (boostPlayers.length >= 3) {
    const top = boostPlayers[0];
    const corrText = boostCorr !== null
      ? Math.abs(boostCorr) < 0.20
        ? 'no meaningful correlation between boost usage and wins'
        : boostCorr > 0
          ? `a positive link between boost usage and wins (r=${boostCorr.toFixed(2)})`
          : `no reliable link between boost usage and wins (r=${boostCorr.toFixed(2)})`
      : 'unclear correlation between boost usage and wins';
    insights.push({
      id: 'boosts_vs_wins', type: 'insight', icon: '⚗️', title: 'Boost Economy',
      finding: `${top.name} leads the clan at ${top.boostsPg.toFixed(1)} boosts per game. Clan data shows ${corrText} — suggesting it's a play-style preference more than a performance driver.`,
      tip: `Boosts matter most in the final circle when a speed advantage can close a gap or win a race. Hoarding mid-game doesn't drive wins; saving them for endgame pressure does.`,
      players: boostPlayers.slice(0, 3).map(p => p.name),
    });
  }

  // 7. squad_carry — assists per game: who's enabling the squad vs. hunting solo
  const assistPool = players.filter(p => p.games >= 8 && p.assistsPg > 0).sort((a, b) => b.assistsPg - a.assistsPg);
  if (assistPool.length >= 3) {
    const top    = assistPool[0];
    const bottom = assistPool[assistPool.length - 1];
    const assistCorr = correlations.assistsVsWinRate?.r;
    const corrNote = assistCorr !== null && Math.abs(assistCorr) >= 0.25
      ? ` Clan data shows a ${assistCorr > 0 ? 'positive' : 'negative'} link between assist rate and wins (r=${assistCorr.toFixed(2)}).`
      : '';
    const gap = top.assistsPg / Math.max(bottom.assistsPg, 0.01);
    insights.push({
      id: 'squad_carry', type: 'insight', icon: '🤝', title: 'Squad Multiplier',
      finding: `${top.name} leads the clan with ${top.assistsPg.toFixed(1)} assists/game — ${gap.toFixed(1)}× more than ${bottom.name} at the bottom (${bottom.assistsPg.toFixed(1)}/g).${corrNote} High-assist players put the squad in positions to close — their value shows up in the win column.`,
      tip: `When you knock an enemy, call it immediately and let a teammate secure the kill. Shared kills build squad discipline — teams that assist and communicate win more than five solo hunters sharing a lobby.`,
      players: assistPool.slice(0, 3).map(p => p.name),
    });
  }

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

// ── Current map service context (NA PC, official 41.2 report) ────────────────
const MAP_SERVICE_41_2_NA = [
  { label: 'Week 1', start: '2026-05-13T00:00:00Z', end: '2026-05-20T00:00:00Z', maps: ['Erangel', 'Taego', 'Miramar', 'Vikendi', 'Sanhok'] },
  { label: 'Week 2', start: '2026-05-20T00:00:00Z', end: '2026-05-27T00:00:00Z', maps: ['Erangel', 'Taego', 'Rondo', 'Miramar', 'Karakin'] },
  { label: 'Week 3', start: '2026-05-27T00:00:00Z', end: '2026-06-03T00:00:00Z', maps: ['Erangel', 'Taego', 'Vikendi', 'Rondo', 'Deston'] },
  { label: 'Week 4', start: '2026-06-03T00:00:00Z', end: '2026-06-10T00:00:00Z', maps: ['Erangel', 'Taego', 'Miramar', 'Vikendi', 'Paramo'] },
  { label: 'Week 5', start: '2026-06-10T00:00:00Z', end: '2026-06-18T00:00:00Z', maps: ['Erangel', 'Taego', 'Rondo', 'Miramar', 'Sanhok'] },
];

function getCurrentMapServiceInfo(now = new Date()) {
  const nowTs = new Date(now).getTime();
  if (!Number.isFinite(nowTs)) return null;
  const active = MAP_SERVICE_41_2_NA.find(w => {
    const startTs = new Date(w.start).getTime();
    const endTs   = new Date(w.end).getTime();
    return nowTs >= startTs && nowTs < endTs;
  });
  if (!active) return null;
  return {
    update: '41.2',
    region: 'NA PC',
    mapSelectSince: '2026-05-13',
    weekLabel: active.label,
    windowStart: active.start,
    windowEnd: active.end,
    maps: active.maps,
  };
}

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
