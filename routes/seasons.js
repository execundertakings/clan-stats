'use strict';
// ── routes/seasons.js — season list and current season ────────────────────────

const { jsonRes, errRes } = require('../lib/http');
const { getSeasons, getCurrentSeason } = require('../lib/pubg');

async function handleSeasons(req, res, url) {
  const { pathname } = url;

  // GET /api/seasons — all seasons
  if (req.method === 'GET' && pathname === '/api/seasons') {
    try {
      const data = await getSeasons();
      // Sort: most recent first, filter to named seasons only
      const seasons = data.data
        .filter(s => !s.id.includes('beta'))
        .sort((a, b) => b.id.localeCompare(a.id));
      return jsonRes(res, { seasons });
    } catch (e) {
      return errRes(res, e.message, 500);
    }
  }

  // GET /api/seasons/current — current season only
  if (req.method === 'GET' && pathname === '/api/seasons/current') {
    try {
      const season = await getCurrentSeason();
      return jsonRes(res, { season });
    } catch (e) {
      return errRes(res, e.message, 500);
    }
  }

  return null;
}

module.exports = { handleSeasons };
