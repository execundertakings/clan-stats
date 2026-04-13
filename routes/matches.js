'use strict';
// ── routes/matches.js — recent match history for clan members ─────────────────

const { jsonRes, errRes } = require('../lib/http');
const { getPlayer, getMatch } = require('../lib/pubg');

async function handleMatches(req, res, url) {
  const { pathname, searchParams } = url;

  // GET /api/matches/player?accountId=...&limit=5 — recent matches for one player
  if (req.method === 'GET' && pathname === '/api/matches/player') {
    const accountId = searchParams.get('accountId');
    const limit     = Math.min(parseInt(searchParams.get('limit') || '5', 10), 10);
    if (!accountId) return errRes(res, 'accountId required');

    try {
      const playerData = await getPlayer(accountId);
      const matchRefs  = (playerData.data.relationships.matches.data || []).slice(0, limit);

      // Fetch each match in parallel
      const matchResults = await Promise.allSettled(
        matchRefs.map(ref => getMatch(ref.id))
      );

      const matches = matchResults
        .filter(r => r.status === 'fulfilled')
        .map(r => {
          const m = r.value;
          const attrs = m.data.attributes;

          // Find this player's participant entry
          const participants = (m.included || []).filter(i => i.type === 'participant');
          const rosters      = (m.included || []).filter(i => i.type === 'roster');
          const participant  = participants.find(
            p => p.attributes.stats.playerId === accountId
          );
          const roster = participant
            ? rosters.find(r =>
                r.relationships.participants.data.some(p => p.id === participant.id)
              )
            : null;

          return {
            matchId:    m.data.id,
            mapName:    attrs.mapName,
            gameMode:   attrs.gameMode,
            createdAt:  attrs.createdAt,
            duration:   attrs.duration,
            playerStats: participant ? participant.attributes.stats : null,
            placement:   roster ? roster.attributes.stats.rank : null,
            teamSize:    roster ? roster.relationships.participants.data.length : null,
          };
        });

      return jsonRes(res, { matches, accountId });
    } catch (e) {
      return errRes(res, e.message, 500);
    }
  }

  // GET /api/matches/:matchId — full match details
  if (req.method === 'GET' && pathname.startsWith('/api/matches/') &&
      pathname.split('/').length === 4) {
    const matchId = pathname.split('/')[3];
    if (!matchId) return errRes(res, 'matchId required');
    try {
      const data = await getMatch(matchId);
      return jsonRes(res, data);
    } catch (e) {
      return errRes(res, e.message, 500);
    }
  }

  return null;
}

module.exports = { handleMatches };
