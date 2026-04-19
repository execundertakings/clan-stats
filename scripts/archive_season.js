'use strict';
// ── scripts/archive_season.js ─────────────────────────────────────────────────
// Archives the current stats_cache.json into data/seasons/ when the active
// season ID changes. Called by the prewarm before writing the new cache.
//
// Archive filename: data/seasons/<seasonId>.json
// The archive is identical to stats_cache.json — same shape, just frozen.
//
// Also exports buildSeasonIndex() which scans data/seasons/ and returns
// metadata for each archived season (used by /api/seasons).

const fs   = require('fs');
const path = require('path');

const DATA         = path.join(__dirname, '..', 'data');
const STATS_FILE   = path.join(DATA, 'stats_cache.json');
const SEASONS_DIR  = path.join(DATA, 'seasons');

// ── Ensure data/seasons/ exists ───────────────────────────────────────────────
function ensureSeasonsDir() {
  if (!fs.existsSync(SEASONS_DIR)) fs.mkdirSync(SEASONS_DIR, { recursive: true });
}

// ── Archive current stats_cache.json if seasonId has changed ─────────────────
// Returns { archived: bool, fromSeasonId, toSeasonId }
function archiveIfSeasonChanged(incomingSeasonId) {
  ensureSeasonsDir();
  if (!fs.existsSync(STATS_FILE)) return { archived: false, reason: 'no existing cache' };

  let existing;
  try {
    existing = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
  } catch {
    return { archived: false, reason: 'could not parse existing cache' };
  }

  const existingSeasonId = existing?.seasonId;
  if (!existingSeasonId) return { archived: false, reason: 'existing cache has no seasonId' };
  if (existingSeasonId === incomingSeasonId) return { archived: false, reason: 'same season' };

  // Different season — archive the existing file
  const archivePath = path.join(SEASONS_DIR, `${existingSeasonId}.json`);
  if (!fs.existsSync(archivePath)) {
    fs.writeFileSync(archivePath, JSON.stringify(existing, null, 2));
    console.log(`[APES] 📦 Season archived: ${existingSeasonId} → data/seasons/${existingSeasonId}.json`);
  } else {
    console.log(`[APES] 📦 Season archive already exists: ${existingSeasonId}`);
  }

  return { archived: true, fromSeasonId: existingSeasonId, toSeasonId: incomingSeasonId };
}

// ── Build index of all archived seasons ──────────────────────────────────────
// Returns array sorted newest-first: [{ seasonId, savedAt, playerCount, totalGames }]
function buildSeasonIndex() {
  ensureSeasonsDir();
  const files = fs.readdirSync(SEASONS_DIR).filter(f => f.endsWith('.json'));
  const { extractStats } = require('../lib/discord-interactions');

  return files.map(f => {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(SEASONS_DIR, f), 'utf8'));
      const totalGames = (data.stats || []).reduce((sum, p) => {
        const s = extractStats(p.season);
        return sum + (s?.s?.roundsPlayed || 0);
      }, 0);
      const activePlayers = (data.stats || []).filter(p => {
        const s = extractStats(p.season);
        return (s?.s?.roundsPlayed || 0) > 0;
      }).length;
      return {
        seasonId:      data.seasonId,
        savedAt:       data.savedAt,
        playerCount:   data.stats?.length || 0,
        activePlayers,
        totalGames,
        label:         seasonLabel(data.seasonId),
      };
    } catch {
      return null;
    }
  }).filter(Boolean).sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
}

// ── Load a specific archived season's stats ───────────────────────────────────
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
