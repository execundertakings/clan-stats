'use strict';

// Explicit season boundaries keyed by PUBG season id.
// Match payloads do not expose a seasonId, only createdAt + seasonState, so we
// anchor current-season filtering to the verified live-server rollover time.
//
// Source for Season 41:
// PUBG Patch Notes 41.1 list PC maintenance as 2026-04-08 00:00-08:30 UTC and
// state that the leaderboard resets after maintenance for Season 41.
const SEASON_BOUNDARIES = {
  'division.bro.official.pc-2018-41': {
    startAt: '2026-04-08T08:30:00Z',
    source: 'official-patch-notes-41.1',
  },
};

function getSeasonBoundary(seasonId) {
  if (!seasonId) return null;
  const boundary = SEASON_BOUNDARIES[seasonId];
  return boundary ? { ...boundary } : null;
}

module.exports = {
  SEASON_BOUNDARIES,
  getSeasonBoundary,
};
