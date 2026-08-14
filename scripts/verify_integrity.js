#!/usr/bin/env node
'use strict';
// ── scripts/verify_integrity.js ───────────────────────────────────────────────
// Deterministic verification step for the daily pipeline. Two checks:
//
//  1. EXACT recompute: independently re-aggregates every player's season totals
//     from the raw data/match_cache files (same filters: official + squad +
//     season window) and diffs them field-by-field against
//     match_history_cache.json. Any drift = the builder or its inputs broke.
//
//  2. AI cache validation: schema-validates data/ai_insights_cache.json and
//     data/analysis_cache.json (card count, required fields, tone enums,
//     player names against the roster, unique ids).
//
// Exits 0 when clean, 1 on any failure — daily_clan.js runs this as the
// "Verify Data Integrity" step so regressions surface as a failed step (and
// therefore a Discord alert) the same morning they ship, not days later.
// (Origin: the 2026-06-10 audit caught a builder typo that had been silently
// failing for 9 days, plus a clan-summary undercount.)

const fs   = require('fs');
const path = require('path');
const { getMatchFilterDecision } = require('../lib/match-filters');
const { isCurrentSeasonMatch }   = require('../lib/season-state');
const { ensureMatchCacheDir, listMatchCacheFiles } = require('./cache_paths');

const ROOT      = path.join(__dirname, '..');
const DATA      = path.join(ROOT, 'data');
const MATCH_DIR = path.join(DATA, 'match_cache');

function readJsonSafe(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

// ── Check 1: exact recompute of match_history_cache totals ───────────────────
// builtAtMs: only consider match files already on disk when the builder ran —
// the server's notifier fetches new matches continuously, so a match landing
// between Build Match History and this step would otherwise read as a phantom
// +1 drift (observed on the first live run, 2026-06-10: Negromantia +1).
function recomputeFromMatchCache(members, seasonStartAt, builtAtMs) {
  const idSet = new Set(members.map(m => m.accountId));
  const perPlayer = {};
  for (const id of idSet) perPlayer[id] = [];

  ensureMatchCacheDir();
  for (const file of listMatchCacheFiles()) {
    const full = path.join(MATCH_DIR, file);
    if (builtAtMs) {
      try { if (fs.statSync(full).mtimeMs > builtAtMs) continue; } catch { continue; }
    }
    let raw;
    try { raw = JSON.parse(fs.readFileSync(full, 'utf8')); } catch { continue; }
    const attr = raw.data?.attributes || {};
    if (!getMatchFilterDecision(attr).counts) continue;
    if (!isCurrentSeasonMatch(attr.createdAt, seasonStartAt)) continue;

    const incl = raw.included || [];
    const rosters = incl.filter(x => x.type === 'roster');
    const partToRoster = {};
    for (const r of rosters) {
      for (const p of r.relationships?.participants?.data || []) partToRoster[p.id] = r;
    }
    for (const part of incl.filter(x => x.type === 'participant')) {
      const st = part.attributes?.stats;
      const id = st?.playerId;
      if (!id || !idSet.has(id)) continue;
      const roster = partToRoster[part.id];
      perPlayer[id].push({
        matchId:   raw.data?.id || path.basename(file, '.json'),
        date:      attr.createdAt,
        placement: roster?.attributes?.stats?.rank || null,
        won:       roster?.attributes?.won === 'true',
        kills:     st.kills || 0,
        assists:   st.assists || 0,
        dbnos:     st.DBNOs || 0,
        hs:        st.headshotKills || 0,
        damage:    Math.round(st.damageDealt || 0),
        survival:  Math.round(st.timeSurvived || 0),
      });
    }
  }
  return perPlayer;
}

function totalsOf(matches) {
  if (!matches.length) return null;
  const t = { roundsPlayed: matches.length, kills: 0, wins: 0, top10s: 0, damageDealt: 0,
              headshotKills: 0, assists: 0, dBNOs: 0, timeSurvived: 0, roundMostKills: 0, maxRoundDamage: 0 };
  for (const m of matches) {
    t.kills += m.kills; t.damageDealt += m.damage; t.headshotKills += m.hs;
    t.assists += m.assists; t.dBNOs += m.dbnos; t.timeSurvived += m.survival;
    if (m.won) t.wins++;
    if (m.placement && m.placement <= 10) t.top10s++;
    if (m.kills > t.roundMostKills) t.roundMostKills = m.kills;
    if (m.damage > t.maxRoundDamage) t.maxRoundDamage = m.damage;
  }
  t.losses = t.roundsPlayed - t.wins;
  return t;
}

function checkMatchHistory(errors, warnings) {
  const members = readJsonSafe(path.join(DATA, 'members.json'), []);
  const cache   = readJsonSafe(path.join(DATA, 'match_history_cache.json'));
  const season  = readJsonSafe(path.join(DATA, 'season.json'), {});
  if (!cache?.result) { errors.push('match_history_cache.json missing or unparseable'); return; }
  if (!members.length) { errors.push('members.json missing or empty'); return; }

  const seasonStartAt = cache.seasonStartAt || season.seasonStartAt || null;
  const builtAtMs = cache.builtAt ? new Date(cache.builtAt).getTime() : 0;
  const perPlayer = recomputeFromMatchCache(members, seasonStartAt, builtAtMs);

  const FIELDS = ['roundsPlayed', 'kills', 'wins', 'losses', 'top10s', 'damageDealt',
                  'headshotKills', 'assists', 'dBNOs', 'timeSurvived', 'roundMostKills', 'maxRoundDamage'];
  const matchWon = new Map();

  for (const m of members) {
    const entry = cache.result[m.accountId];
    const sorted = (perPlayer[m.accountId] || []).sort((a, b) => new Date(b.date) - new Date(a.date));

    // Reproduce the builder's API-cap trim from the recorded coverage so a
    // legitimately trimmed player doesn't read as drift.
    const used = entry?.coverage?.trimmedByApiCap
      ? sorted.slice(0, entry.coverage.apiRounds)
      : sorted;
    for (const mm of used) {
      matchWon.set(mm.matchId, (matchWon.get(mm.matchId) || false) || mm.won);
    }
    const expected = totalsOf(used);
    const actual = entry?.totals || null;

    if (!expected && !actual) continue;
    if (!expected || !actual) {
      errors.push(`${m.name}: totals ${actual ? 'present in cache but no raw matches found' : 'missing from cache but raw matches exist'}`);
      continue;
    }
    for (const f of FIELDS) {
      if ((expected[f] || 0) !== (actual[f] || 0)) {
        errors.push(`${m.name}.${f}: cache=${actual[f]} recomputed=${expected[f]}`);
      }
    }
    const expDays = new Set(used.map(mm => mm.date?.slice(0, 10)).filter(Boolean)).size;
    if (expDays !== (entry.daysPlayed || 0)) {
      errors.push(`${m.name}.daysPlayed: cache=${entry.daysPlayed} recomputed=${expDays}`);
    }
  }

  // Clan-wide summary must come from full match sets, not display slices.
  const expGames = matchWon.size;
  const expWins  = [...matchWon.values()].filter(Boolean).length;
  if ((cache.summary?.uniqueGames || 0) !== expGames) {
    errors.push(`summary.uniqueGames: cache=${cache.summary?.uniqueGames} recomputed=${expGames}`);
  }
  if ((cache.summary?.uniqueWins || 0) !== expWins) {
    errors.push(`summary.uniqueWins: cache=${cache.summary?.uniqueWins} recomputed=${expWins}`);
  }
  return { players: members.length, uniqueGames: expGames };
}

// ── Check 2: AI cache schema validation ──────────────────────────────────────
const TONES = new Set(['good', 'warn', 'bad', 'neutral']);

function checkAiCaches(errors, warnings) {
  const members = readJsonSafe(path.join(DATA, 'members.json'), []);
  const names = new Set(members.map(m => m.name));

  const ai = readJsonSafe(path.join(DATA, 'ai_insights_cache.json'));
  if (!ai) {
    warnings.push('ai_insights_cache.json missing (ok on first run / early season)');
  } else {
    const cards = ai.spotlights || [];
    if (cards.length !== 5) errors.push(`ai_insights: expected 5 cards, found ${cards.length}`);
    const ids = new Set();
    for (const c of cards) {
      const tag = c.id || '(no id)';
      for (const f of ['id', 'title', 'icon', 'type', 'finding', 'tip', 'tagline']) {
        if (typeof c[f] !== 'string' || !c[f].length) errors.push(`ai_insights ${tag}: missing/empty ${f}`);
      }
      if (c.type !== 'spotlight') errors.push(`ai_insights ${tag}: type must be "spotlight"`);
      if ((c.title || '').length > 40) errors.push(`ai_insights ${tag}: title >40 chars`);
      if ((c.tagline || '').length > 90) errors.push(`ai_insights ${tag}: tagline >90 chars`);
      if (ids.has(c.id)) errors.push(`ai_insights: duplicate id ${c.id}`);
      ids.add(c.id);
      if (!Array.isArray(c.players) || !c.players.length) errors.push(`ai_insights ${tag}: players must be a non-empty array`);
      for (const p of c.players || []) {
        if (!names.has(p)) errors.push(`ai_insights ${tag}: unknown player "${p}"`);
      }
      for (const b of c.bars || []) {
        if (!TONES.has(b.tone)) errors.push(`ai_insights ${tag}: invalid bar tone "${b.tone}"`);
        if (typeof b.val === 'number' && typeof b.max === 'number' && b.val > b.max) {
          errors.push(`ai_insights ${tag}: bar val ${b.val} > max ${b.max}`);
        }
      }
      if (/\bAPES\b|\bAP3S\b/i.test(`${c.title} ${c.finding} ${c.tip} ${c.tagline}`)) {
        errors.push(`ai_insights ${tag}: contains banned old clan name`);
      }
    }
    const glaze = cards.filter(c => c.id?.startsWith('glaze_')).length;
    const roast = cards.filter(c => c.id?.startsWith('roast_')).length;
    if (cards.length === 5 && (glaze !== 1 || roast !== 1)) {
      errors.push(`ai_insights: expected exactly 1 glaze_ and 1 roast_ card (found ${glaze}/${roast})`);
    }
  }

  const an = readJsonSafe(path.join(DATA, 'analysis_cache.json'));
  if (!an) {
    warnings.push('analysis_cache.json missing (ok on first run / early season)');
  } else {
    if (!Array.isArray(an.players)) errors.push('analysis_cache: players must be an array');
    for (const p of an.players || []) {
      if (!names.has(p.name)) errors.push(`analysis_cache: unknown player "${p.name}"`);
      if (typeof p.summary !== 'string' || !p.summary.length) errors.push(`analysis_cache ${p.name}: missing summary`);
      if (typeof p.tip !== 'string' || !p.tip.length) errors.push(`analysis_cache ${p.name}: missing tip`);
      for (const f of ['games', 'kd', 'winRate', 'top10Rate', 'hsRate', 'assistsPg', 'avgDmg']) {
        if (typeof p[f] !== 'number') errors.push(`analysis_cache ${p.name}: ${f} must be a number`);
      }
    }
  }

  // History file must be pure JSON (corruption breaks anti-repetition).
  const histRaw = (() => { try { return fs.readFileSync(path.join(DATA, 'ai_insights_history.json'), 'utf8'); } catch { return null; } })();
  if (histRaw !== null) {
    try { JSON.parse(histRaw); } catch { errors.push('ai_insights_history.json is not valid JSON'); }
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────
function verifyIntegrity(opts = {}) {
  const verbose = opts.verbose ?? true;
  const errors = [];
  const warnings = [];

  const hist = checkMatchHistory(errors, warnings) || {};
  checkAiCaches(errors, warnings);

  if (verbose) {
    for (const w of warnings) console.log(`[verify] ⚠ ${w}`);
    for (const e of errors)   console.error(`[verify] ✗ ${e}`);
  }
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    players: hist.players || 0,
    uniqueGames: hist.uniqueGames || 0,
  };
}

module.exports = { verifyIntegrity };

if (require.main === module) {
  const result = verifyIntegrity({ verbose: true });
  console.log(result.ok
    ? `[verify] ✓ clean — ${result.players} players, ${result.uniqueGames} season matches, ${result.warnings.length} warning(s)`
    : `[verify] ✗ ${result.errors.length} error(s), ${result.warnings.length} warning(s)`);
  process.exit(result.ok ? 0 : 1);
}
