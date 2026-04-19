'use strict';
// ── routes/seasons.js — season list and current season ────────────────────────

const fs   = require('fs');
const path = require('path');
const { jsonRes, errRes } = require('../lib/http');
const { getSeasons, getCurrentSeason } = require('../lib/pubg');
const { DATA } = require('../lib/config');

const SEASON_FILE = path.join(DATA, 'season.json');

function saveSeasonCache(seasons) {
  try {
    const current = seasons.find(s => s.attributes?.isCurrentSeason);
    if (current) fs.writeFileSync(SEASON_FILE, JSON.stringify({ seasonId: current.id, savedAt: Date.now() }));
  } catch {}
}

function loadSeasonFallback() {
  try {
    const d = JSON.parse(fs.readFileSync(SEASON_FILE, 'utf8'));
    if (d.seasonId && Date.now() - d.savedAt < 14 * 24 * 60 * 60 * 1000) return d;
  } catch {}
  return null;
}

async function handleSeasons(req, res, url) {
  const { pathname } = url;

  // GET /api/seasons — all seasons
  if (req.method === 'GET' && pathname === '/api/seasons') {
    try {
      const data = await getSeasons();
      const seasons = data.data
        .filter(s => !s.id.includes('beta'))
        .sort((a, b) => b.id.localeCompare(a.id));
      saveSeasonCache(seasons); // persist current season to disk
      return jsonRes(res, { seasons });
    } catch (e) {
      // Rate limited — serve cached season info if available
      const saved = loadSeasonFallback();
      if (saved) {
        const fakeSeason = { id: saved.seasonId, attributes: { isCurrentSeason: true } };
        return jsonRes(res, { seasons: [fakeSeason], cached: true });
      }
      return errRes(res, e.message, 500);
    }
  }

  // GET /api/seasons/current — current season only
  if (req.method === 'GET' && pathname === '/api/seasons/current') {
    try {
      const season = await getCurrentSeason();
      return jsonRes(res, { season });
    } catch (e) {
      const saved = loadSeasonFallback();
      if (saved) return jsonRes(res, { season: { id: saved.seasonId, attributes: { isCurrentSeason: true } }, cached: true });
      return errRes(res, e.message, 500);
    }
  }

  return null;
}

module.exports = { handleSeasons };
