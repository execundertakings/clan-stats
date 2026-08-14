'use strict';
// ── scripts/archive_season.js ─────────────────────────────────────────────────
// Archives per-player totals from match_history_cache.json into data/seasons/
// when the active season ID changes. Called by the prewarm before writing a
// new cache — ensures the outgoing season is preserved with official-only data.
//
// Archive filename: data/seasons/<seasonId>.json
// Shape: { seasonId, savedAt, builtAt, playerCount, players: { accountId → { name, totals, daysPlayed } } }
//
// Also exports buildSeasonIndex() (used by /api/seasons) and
// loadArchivedSeason() (used by /api/seasons/:id).

const fs   = require('fs');
const path = require('path');
const { loadSeasonState } = require('../lib/season-state');

const DATA         = path.join(__dirname, '..', 'data');
const HISTORY_FILE = path.join(DATA, 'match_history_cache.json');
const SEASONS_DIR  = path.join(DATA, 'seasons');

// ── Helpers ───────────────────────────────────────────────────────────────────

function ensureSeasonsDir() {
  if (!fs.existsSync(SEASONS_DIR)) fs.mkdirSync(SEASONS_DIR, { recursive: true });
}

// Read the season ID that the current caches belong to.
function loadCurrentSeasonId() {
  const state = loadSeasonState();
  return state.cacheSeasonId || null;
}

// ── Archive current match_history_cache.json if the season has rolled ─────────
// Returns { archived: bool, fromSeasonId?, toSeasonId?, reason? }
function archiveIfSeasonChanged(incomingSeasonId) {
  ensureSeasonsDir();

  const existingSeasonId = loadCurrentSeasonId();
  if (!existingSeasonId) return { archived: false, reason: 'no current season on record' };
  if (existingSeasonId === incomingSeasonId) return { archived: false, reason: 'same season' };

  if (!fs.existsSync(HISTORY_FILE)) return { archived: false, reason: 'no match_history_cache to archive' };

  let history;
  try {
    history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
  } catch {
    return { archived: false, reason: 'could not parse match_history_cache' };
  }

  const archivePath = path.join(SEASONS_DIR, `${existingSeasonId}.json`);
  if (!fs.existsSync(archivePath)) {
    // Build a clean snapshot: per-player totals only — no raw API fields, no casual games
    const snapshot = {
      seasonId:    existingSeasonId,
      savedAt:     new Date().toISOString(),
      builtAt:     history.builtAt,
      playerCount: history.playerCount,
      players:     {},
    };

    for (const [accountId, data] of Object.entries(history.result || {})) {
      snapshot.players[accountId] = {
        name:       data.name,
        totals:     data.totals || null,
        daysPlayed: data.daysPlayed || 0,
      };
    }

    fs.writeFileSync(archivePath, JSON.stringify(snapshot, null, 2));
    console.log(`[3PI] 📦 Season archived: ${existingSeasonId} → data/seasons/${existingSeasonId}.json`);
  } else {
    console.log(`[3PI] 📦 Season archive already exists: ${existingSeasonId}`);
  }

  return { archived: true, fromSeasonId: existingSeasonId, toSeasonId: incomingSeasonId };
}

// ── Build index of all archived seasons ──────────────────────────────────────
// Returns array sorted newest-first: [{ seasonId, savedAt, playerCount, activePlayers, totalGames, label }]
function buildSeasonIndex() {
  ensureSeasonsDir();
  const files = fs.readdirSync(SEASONS_DIR).filter(f => f.endsWith('.json'));

  return files.map(f => {
    try {
      const snap    = JSON.parse(fs.readFileSync(path.join(SEASONS_DIR, f), 'utf8'));
      const players = Object.values(snap.players || {});
      const totalGames    = players.reduce((s, p) => s + (p.totals?.roundsPlayed || 0), 0);
      const activePlayers = players.filter(p => (p.totals?.roundsPlayed || 0) > 0).length;
      return {
        seasonId:      snap.seasonId,
        savedAt:       snap.savedAt,
        playerCount:   snap.playerCount || players.length,
        activePlayers,
        totalGames,
        label:         seasonLabel(snap.seasonId),
      };
    } catch {
      return null;
    }
  }).filter(Boolean).sort((a, b) => (b.savedAt > a.savedAt ? 1 : -1));
}

// ── Load a specific archived season's snapshot ────────────────────────────────
function loadArchivedSeason(seasonId) {
  const archivePath = path.join(SEASONS_DIR, `${seasonId}.json`);
  if (!fs.existsSync(archivePath)) return null;
  return JSON.parse(fs.readFileSync(archivePath, 'utf8'));
}

// ── Human-readable season label ───────────────────────────────────────────────
// "division.bro.official.pc-2025-01" → "Season 01 (2025)"
function seasonLabel(seasonId) {
  if (!seasonId) return seasonId;
  const m = seasonId.match(/pc-(\d{4})-(\d+)$/);
  if (!m) return seasonId;
  return `Season ${m[2]} (${m[1]})`;
}

module.exports = { archiveIfSeasonChanged, buildSeasonIndex, loadArchivedSeason, seasonLabel };
