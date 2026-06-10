#!/usr/bin/env node
'use strict';
// ── scripts/summarize_for_ai.js ───────────────────────────────────────────────
// Deterministic data-prep step for the ai-spotlights Cowork scheduled task.
//
// Reads the freshly-built local caches and prints a compact JSON summary to
// stdout. The scheduled task pipes the output to a tmp file, Claude reads it
// and synthesises 3 spotlight cards, then writes data/ai_insights_cache.json.
//
// THIS SCRIPT NEVER CALLS AN LLM. All synthesis happens in the scheduled task —
// see CLAUDE.md → "AI / LLM features — scheduled tasks only, NEVER direct API calls".
//
// Usage:
//   node scripts/summarize_for_ai.js > /tmp/clan_ai_input.json

const fs   = require('fs');
const path = require('path');
const { DATA, loadClanConfig }    = require('../lib/config');

const HISTORY_FILE    = path.join(DATA, 'match_history_cache.json');
const SQUAD_FILE      = path.join(DATA, 'squad_stats_cache.json');
const RECORDS_FILE    = path.join(DATA, 'records.json');
const MILESTONES_FILE = path.join(DATA, 'milestones_cache.json'); // dedupe state, not events
const MILESTONE_EVENTS_FILE = path.join(DATA, 'milestone_events.json'); // timestamped event log
const ROLLING_FILE    = path.join(DATA, 'ai_insights_history.json');
const STATS_CACHE_FILE = path.join(DATA, 'stats_cache.json');

const MIN_GAMES               = 5;
const ROLLING_LOOKBACK_DAYS   = 30;
const RECENT_MATCH_COUNT      = 5;
const RECENT_MILESTONE_DAYS   = 14;

function readJsonSafe(file, fallback = null) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    // Strip any leading non-JSON content (e.g. debug log lines) before parsing
    const match = raw.match(/[\[\{]/);
    const cleaned = match ? raw.slice(match.index) : raw;
    return JSON.parse(cleaned);
  } catch { return fallback; }
}

function summarizeMapStats(mapStats) {
  if (!Array.isArray(mapStats) || !mapStats.length) return '';
  return mapStats
    .filter(s => s?.map && s.played > 0)
    .sort((a, b) => b.played - a.played)
    .slice(0, 3)
    .map(s => `${s.map}:${s.played}g ${Math.round(((s.wins || 0) / s.played) * 100)}%w`)
    .join(' · ');
}

// Build accountId → best (lifetime/season, squad/squad-fpp) longestKill from
// stats_cache.json. records.json only stores longestKill once a player crosses
// the 300m milestone threshold, so any player without a qualifying snipe shows
// 0 there. The PUBG season/lifetime API exposes the actual personal best —
// we read it from stats_cache and use it as a fallback so pbLongest reflects
// reality (cf. pbKills/pbDamage which already fall back to API totals).
function buildLongestKillMap() {
  const cache = readJsonSafe(STATS_CACHE_FILE);
  const stats = cache?.stats;
  const map = {};
  if (!stats || typeof stats !== 'object') return map;
  for (const entry of Object.values(stats)) {
    const id = entry?.member?.accountId;
    if (!id) continue;
    const lt = entry?.lifetime?.data?.attributes?.gameModeStats || {};
    const sn = entry?.season?.data?.attributes?.gameModeStats   || {};
    const candidates = [
      lt.squad?.longestKill,
      lt['squad-fpp']?.longestKill,
      sn.squad?.longestKill,
      sn['squad-fpp']?.longestKill,
    ].filter(v => Number.isFinite(v) && v > 0);
    map[id] = candidates.length ? Math.max(...candidates) : 0;
  }
  return map;
}

function buildPlayerSnapshots(history, records, longestMap = {}) {
  const out = [];
  for (const [accountId, data] of Object.entries(history.result || {})) {
    const t = data.totals;
    if (!t || !t.roundsPlayed || t.roundsPlayed < MIN_GAMES) continue;
    const games = t.roundsPlayed;
    const losses = (t.losses ?? (games - (t.wins || 0))) || 0;
    const kd    = losses > 0 ? (t.kills || 0) / losses : (t.kills || 0);
    // Recent match list always comes from the cache — the API has no per-match data.
    const recent = (data.matches || []).slice(0, RECENT_MATCH_COUNT).map(m => ({
      date:      m.date?.slice(0, 10),
      placement: m.placement,
      won:       !!m.won,
      kills:     m.kills,
      damage:    Math.round(m.damage || 0),
      survival:  Math.round((m.survival || 0) / 60), // minutes
      map:       m.map,
    }));
    const rec = records?.[accountId] || {};
    const longestFromApi = longestMap[accountId] || 0;
    out.push({
      name:        data.name,
      games,
      kills:       t.kills      || 0,
      wins:        t.wins       || 0,
      top10s:      t.top10s     || 0,
      kd:          +kd.toFixed(2),
      winRate:     +((t.wins || 0) / games).toFixed(3),
      top10Rate:   +((t.top10s || 0) / games).toFixed(3),
      closeOutRate: (t.top10s || 0) > 0 ? +((t.wins || 0) / t.top10s).toFixed(3) : 0,
      hsRate:      (t.kills || 0) > 0 ? +((t.headshotKills || 0) / t.kills).toFixed(3) : 0,
      avgDmg:      Math.round((t.damageDealt || 0) / games),
      dmgPerKill:  (t.kills || 0) > 0 ? Math.round((t.damageDealt || 0) / t.kills) : 0,
      assistsPg:   +((t.assists || 0) / games).toFixed(2),
      pbKills:     rec.kills      || t.roundMostKills  || 0,
      pbDamage:    Math.round(rec.damage      || t.maxRoundDamage || 0),
      pbLongest:   Math.round(Math.max(rec.longestKill || 0, longestFromApi)),
      mostMaps:    summarizeMapStats(data.mapStats),
      dataSource:  'match-cache',
      recent,
    });
  }
  return out.sort((a, b) => b.games - a.games);
}

function buildClanSummary(players, history) {
  if (!players.length) return null;
  const n = players.length;
  const totals = history?.summary || {};
  const uniqueGames = totals.uniqueGames || 0;
  const uniqueWins = totals.uniqueWins || 0;

  return {
    activePlayers: n,
    totalGames:    uniqueGames,
    totalKills:    players.reduce((s, p) => s + p.kills, 0),
    totalWins:     uniqueWins,
    avgKd:         +(players.reduce((s, p) => s + p.kd, 0) / n).toFixed(2),
    avgWinRate:    +(players.reduce((s, p) => s + p.winRate, 0) / n).toFixed(3),
    avgTop10Rate:  +(players.reduce((s, p) => s + p.top10Rate, 0) / n).toFixed(3),
    avgHsRate:     +(players.reduce((s, p) => s + p.hsRate, 0) / n).toFixed(3),
    avgDmgPerKill: Math.round(players.reduce((s, p) => s + p.dmgPerKill, 0) / n),
  };
}

function buildRecentThemes() {
  const raw    = readJsonSafe(ROLLING_FILE, []);
  const log    = Array.isArray(raw) ? raw : (raw.entries || []);
  const cutoff = Date.now() - ROLLING_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  const themes = [];
  for (const entry of log) {
    const computedAt = new Date(entry.computedAt || '').getTime();
    if (!Number.isFinite(computedAt) || computedAt < cutoff) continue;
    for (const s of (entry.spotlights || [])) {
      themes.push({ id: s.id, title: s.title, players: s.players, computedAt: entry.computedAt });
    }
  }
  return themes;
}

// Annotate squad pair/trio entries with a sample-size confidence flag so card
// copy can't lean on a tiny-N pair without qualifying. Threshold tuned to the
// build_squad_stats.js gates (MIN_GAMES_PAIR=4, MIN_GAMES_TRIO=3) — anything
// near those is "low" confidence; comfortable samples are "ok".
function annotateSampleSize(entries, kind) {
  return (entries || []).map(e => {
    const games = e?.games || 0;
    let confidence = 'ok';
    if (kind === 'pair') {
      if (games < 10) confidence = 'low';
      else if (games < 20) confidence = 'medium';
    } else if (kind === 'trio') {
      if (games < 8) confidence = 'low';
      else if (games < 15) confidence = 'medium';
    }
    return { ...e, sampleSize: games, confidence };
  });
}

// Read fired-milestone events from the timestamped append-only log written by
// check_milestones.js. (milestones_cache.json is per-account dedupe state with
// no timestamps — it can't answer "what fired in the last N days".)
function buildRecentMilestones() {
  const events = readJsonSafe(MILESTONE_EVENTS_FILE, []);
  const list   = Array.isArray(events) ? events : [];
  const cutoff = Date.now() - RECENT_MILESTONE_DAYS * 24 * 60 * 60 * 1000;
  const out = [];
  for (const e of list) {
    const ts = Date.parse(e?.at || 0);
    if (!Number.isFinite(ts) || ts < cutoff) continue;
    out.push({ player: e.name, title: e.title, description: e.description, at: e.at });
  }
  return out.slice(-15); // most recent 15
}

function main() {
  const history     = readJsonSafe(HISTORY_FILE, { result: {} });
  const records     = readJsonSafe(RECORDS_FILE, {});
  const squad       = readJsonSafe(SQUAD_FILE, { topPairs: [], topTrios: [] });
  const longestMap  = buildLongestKillMap();

  const players = buildPlayerSnapshots(history, records, longestMap);
  if (players.length < 3) {
    process.stderr.write(`✗ Only ${players.length} players with ≥${MIN_GAMES} games — too few for spotlights\n`);
    process.exit(1);
  }

  const summary = {
    builtAt:          new Date().toISOString(),
    notes: {
      scoping:
        "All player counts (games, kills, wins, top10s, damage, headshots, assists) are CURRENT-SEASON ONLY, " +
        "from match_history_cache: per-match aggregates filtered down to applicable official squad matches. " +
        "Each player snapshot has a `dataSource` field set to 'match-cache'. Frame these in card copy as " +
        "'this season' — never as 'career' or 'lifetime'.",
      personalBests:
        "pbKills / pbDamage / pbLongest are personal bests that may span seasons. " +
        "pbKills and pbDamage prefer records.json (lifetime PB, gated at >=5 kills / >=500 damage / >=300m longest), " +
        "falling back to current-season max from match_history totals (roundMostKills / maxRoundDamage). " +
        "pbLongest prefers max(records.json longestKill, PUBG-API lifetime/season longestKill). " +
        "Frame these as 'personal best' — they're the player's all-time peak, not a this-season claim.",
      sampleSize:
        "topPairs / topTrios entries each include `sampleSize` (game count) and `confidence` ('low'|'medium'|'ok'). " +
        "Any pair with <10 games or trio with <8 games is 'low' — if a card cites it, mention game count explicitly " +
        "and avoid making it the sole headline of a spotlight.",
      milestones:
        "recentMilestones lists actual milestones fired to Discord in the last 14 days from milestone_events.json. " +
        "Empty list means nothing fired recently, not that the data is missing.",
      naming:
        "Refer to the clan ONLY by `clanIdentity.name` / `clanIdentity.shortName` below ('3PI' / 'Third Party Incorporated'). " +
        "NEVER write 'APES' or 'AP3S' in any card copy — that is an OLD clan the group left, not the current one.",
    },
    clanIdentity: (() => {
      const c = loadClanConfig().clan;
      return { name: c.name, shortName: c.shortName, tag: c.tag };
    })(),
    knownPlayerNames: players.map(p => p.name),
    clan:             buildClanSummary(players, history),
    players,
    topPairs:         annotateSampleSize((squad.topPairs || squad.pairs || []).slice(0, 5), 'pair'),
    topTrios:         annotateSampleSize((squad.topTrios || squad.trios || []).slice(0, 5), 'trio'),
    recentMilestones: buildRecentMilestones(),
    recentThemes:     buildRecentThemes(),
  };

  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
}

if (require.main === module) main();

module.exports = {
  buildPlayerSnapshots, buildClanSummary, buildRecentThemes, buildRecentMilestones,
  buildLongestKillMap,
};
