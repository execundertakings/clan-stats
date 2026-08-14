'use strict';

const fs = require('fs');
const path = require('path');
const { DATA } = require('./config');
const { isCountingSquadMatch } = require('./match-filters');
const { getSeasonBoundary } = require('./season-boundaries');

const SEASON_FILE = path.join(DATA, 'season.json');

function loadSeasonState() {
  try {
    return JSON.parse(fs.readFileSync(SEASON_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveSeasonState(nextState) {
  const merged = { ...loadSeasonState(), ...nextState };
  fs.writeFileSync(SEASON_FILE, JSON.stringify(merged, null, 2));
  return merged;
}

function loadSavedSeasonId() {
  const state = loadSeasonState();
  if (state.seasonId && Date.now() - (state.savedAt || 0) < 14 * 24 * 60 * 60 * 1000) {
    return state.seasonId;
  }
  return null;
}

function isCurrentSeasonMatch(createdAt, seasonStartAt) {
  if (!seasonStartAt) return true;
  const matchTs = new Date(createdAt || '').getTime();
  const startTs = new Date(seasonStartAt).getTime();
  if (!Number.isFinite(matchTs) || !Number.isFinite(startTs)) return false;
  return matchTs >= startTs;
}

// Most-recent Wednesday 08:30 UTC — PUBG PC patch/season maintenance window.
// Used as the season-start approximation until a verified entry is added to
// lib/season-boundaries.js. Mirrors lib/prewarm.js (kept in sync).
function provisionalSeasonStart(now = new Date()) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 8, 30, 0));
  while (d.getUTCDay() !== 3) d.setUTCDate(d.getUTCDate() - 1);
  if (d.getTime() > now.getTime()) d.setUTCDate(d.getUTCDate() - 7);
  return d.toISOString();
}

function resolveSeasonBoundary(seasonId, fallbackStartAt = null) {
  const explicit = getSeasonBoundary(seasonId);
  if (explicit?.startAt) {
    return {
      seasonStartAt: explicit.startAt,
      seasonStartSource: explicit.source,
    };
  }
  // No verified entry yet (e.g. a fresh rollover before the boundary is added).
  // Approximate with the most-recent Wednesday 08:30 UTC patch boundary — never
  // null (= no season filter, includes everything) and never match-cache-earliest
  // (= prior-season bleed-in). Keeps prewarm, builds, and rollover all consistent.
  // fallbackStartAt is kept for signature compatibility but no longer drives a
  // match-cache-earliest result.
  void fallbackStartAt;
  return {
    seasonStartAt: provisionalSeasonStart(),
    seasonStartSource: 'provisional-wednesday',
  };
}

function findEarliestOfficialSquadMatch(matchDir) {
  let earliest = null;
  for (const file of fs.readdirSync(matchDir)) {
    if (!file.endsWith('.json')) continue;
    try {
      const match = JSON.parse(fs.readFileSync(path.join(matchDir, file), 'utf8'));
      const attrs = match?.data?.attributes || {};
      if (!isCountingSquadMatch(attrs)) continue;
      if (!attrs.createdAt) continue;
      if (!earliest || attrs.createdAt < earliest) earliest = attrs.createdAt;
    } catch {}
  }
  return earliest;
}

function ensureSeasonStateFromMatchCache(matchDir) {
  const state = loadSeasonState();
  const seasonId = state.cacheSeasonId || state.seasonId || null;
  const explicit = resolveSeasonBoundary(seasonId, null);
  if (explicit.seasonStartAt) {
    if (state.seasonStartAt === explicit.seasonStartAt && state.seasonStartSource === explicit.seasonStartSource) {
      return state;
    }
    return saveSeasonState(explicit);
  }

  if (!matchDir || !fs.existsSync(matchDir)) return state;

  if (state.seasonStartAt) return state;

  const earliest = findEarliestOfficialSquadMatch(matchDir);
  if (!earliest) return state;
  return saveSeasonState(resolveSeasonBoundary(seasonId, earliest));
}

module.exports = {
  loadSeasonState,
  saveSeasonState,
  loadSavedSeasonId,
  isCurrentSeasonMatch,
  resolveSeasonBoundary,
  provisionalSeasonStart,
  ensureSeasonStateFromMatchCache,
};
