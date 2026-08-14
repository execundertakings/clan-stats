'use strict';
// ── lib/match-filters.js ─────────────────────────────────────────────────────
// Single source of truth for which PUBG match-types and game-modes count
// toward clan season stats. Used by build_match_history, build_squad_stats,
// and build_landing_heatmap so a filter change in one place can't drift away
// from the others.
//
// matchTypes intentionally EXCLUDED:
//   airoyale      — casual / AI back-fill matches, not allowed in clan stats
//   custom        — private games, not ranked
//   event         — special event modes (IBR, etc.) — gameMode also doesn't include 'squad'
//   arcade        — TDM and other arcade variants — gameMode also doesn't include 'squad'
//   trainingroom  — training mode
//   tutorialatoz  — tutorial
//
// gameMode filter:
//   We require .includes('squad') so 'squad', 'squad-fpp', and 'normal-squad'
//   variants all qualify. 'normal-squad' only ever appears with 'custom' so
//   it gets dropped by the matchType filter anyway, but keeping the substring
//   match here is robust to future PUBG mode names.
//
// ── Do NOT filter "zero-impact" participant entries ──────────────────────────
// (Investigated 2026-06-12 after a report that SENPAISLAUGHTER's 0-kill /
// 0-damage squad win in match 9beaadae-7712 was an API stat-recording bug.)
// A proposed filter — skip entries where damageDealt===0 && kills===0 &&
// DBNOs===0 && deathType==='byplayer' — must NOT be added, for three reasons:
//   1. Telemetry ground truth: the cached telemetry for 9beaadae-7712 shows
//      SENPAISLAUGHTER dealt zero damage to any other player in his 18 min.
//      The API record is CORRECT — a legitimate zero-contribution game, not
//      a recording failure. winPlace:1 is real (his squad won after he died).
//   2. Blast radius: 1,761 of 9,061 member participant entries (19.4%) match
//      that signature. They are normal passive/early-death/support games
//      (PUBG's damageDealt also excludes damage to already-knocked enemies,
//      so "0 damage" often coexists with real telemetry damage). Filtering
//      them would massively inflate per-match averages.
//   3. API reconciliation: PUBG's official season stats (apiRounds cap in
//      build_match_history.js, audit_data.js comparisons) count these rounds
//      and wins. Local exclusion would permanently diverge from API truth.

const MATCH_FILTER_POLICY_VERSION = 'official-squad-v2';
const COUNTING_MATCH_TYPES = new Set(['official']);
const KNOWN_MATCH_TYPES = new Set([
  ...COUNTING_MATCH_TYPES,
  'airoyale',
  'custom',
  'event',
  'arcade',
  'trainingroom',
  'tutorialatoz',
]);
const EXCLUDED_MODE_PATTERNS = [
  /\brumble\b/i,
  /\bpayday\b/i,
];

function isCountingMatchType(matchType) {
  return COUNTING_MATCH_TYPES.has(matchType);
}

function isSquadMode(gameMode) {
  return typeof gameMode === 'string' && gameMode.includes('squad');
}

function flattenTagStrings(value, out = []) {
  if (value == null) return out;
  if (typeof value === 'string') {
    out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) flattenTagStrings(item, out);
    return out;
  }
  if (typeof value === 'object') {
    for (const [key, val] of Object.entries(value)) {
      out.push(key);
      flattenTagStrings(val, out);
    }
  }
  return out;
}

function summarizeTags(tags) {
  return flattenTagStrings(tags)
    .map(s => String(s).trim())
    .filter(Boolean)
    .join(' | ');
}

function hasExcludedModeSignal(text) {
  return typeof text === 'string' && EXCLUDED_MODE_PATTERNS.some(p => p.test(text));
}

function getMatchFilterDecision(attrs = {}) {
  const matchType = typeof attrs.matchType === 'string' ? attrs.matchType : '';
  const gameMode  = typeof attrs.gameMode === 'string' ? attrs.gameMode : '';
  const tagText   = summarizeTags(attrs.tags);
  const tagReview = !!tagText;
  const unknownMatchType = !!matchType && !KNOWN_MATCH_TYPES.has(matchType);
  const excludedSignal = hasExcludedModeSignal(gameMode) || hasExcludedModeSignal(tagText);

  if (excludedSignal) {
    return {
      counts: false,
      reason: 'excluded-special-mode',
      review: true,
      reviewReason: 'mode/tag matched an excluded special-mode keyword',
      matchType,
      gameMode,
      tagText,
    };
  }

  if (!isCountingMatchType(matchType)) {
    return {
      counts: false,
      reason: 'non-counting-match-type',
      review: tagReview || unknownMatchType,
      reviewReason: tagReview
        ? 'match carried non-empty tags'
        : unknownMatchType
          ? 'matchType is not in the known PUBG set'
          : '',
      matchType,
      gameMode,
      tagText,
    };
  }

  if (!isSquadMode(gameMode)) {
    return {
      counts: false,
      reason: 'non-squad-mode',
      review: tagReview,
      reviewReason: tagReview ? 'non-squad match carried non-empty tags' : '',
      matchType,
      gameMode,
      tagText,
    };
  }

  return {
    counts: true,
    reason: 'counting-squad-match',
    review: tagReview || unknownMatchType,
    reviewReason: tagReview
      ? 'counting match carried non-empty tags'
      : unknownMatchType
        ? 'counting matchType is not in the known PUBG set'
        : '',
    matchType,
    gameMode,
    tagText,
  };
}

function formatMatchDebug(attrsOrDecision = {}) {
  const info = Object.prototype.hasOwnProperty.call(attrsOrDecision, 'counts')
    ? attrsOrDecision
    : getMatchFilterDecision(attrsOrDecision);
  const parts = [
    `matchType=${info.matchType || '∅'}`,
    `gameMode=${info.gameMode || '∅'}`,
  ];
  if (info.tagText) parts.push(`tags=${info.tagText}`);
  if (info.reviewReason) parts.push(`review=${info.reviewReason}`);
  return parts.join(' · ');
}

// Convenience: full check that a match should count for the clan squad stats.
// Pass either the parsed match attributes or the two raw fields directly.
function isCountingSquadMatch(matchTypeOrAttrs, gameMode) {
  if (typeof matchTypeOrAttrs === 'object' && matchTypeOrAttrs !== null) {
    return getMatchFilterDecision(matchTypeOrAttrs).counts;
  }
  return getMatchFilterDecision({ matchType: matchTypeOrAttrs, gameMode }).counts;
}

module.exports = {
  MATCH_FILTER_POLICY_VERSION,
  COUNTING_MATCH_TYPES,
  isCountingMatchType,
  isSquadMode,
  isCountingSquadMatch,
  getMatchFilterDecision,
  formatMatchDebug,
  summarizeTags,
};
