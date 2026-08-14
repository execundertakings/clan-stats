'use strict';
// ── routes/matches.js — recent match history for clan members ─────────────────

const fs = require('fs');
const path = require('path');
const { jsonRes, errRes } = require('../lib/http');
const { getPlayer, getMatch, getPlayerFresh } = require('../lib/pubg');
const { isCountingSquadMatch } = require('../lib/match-filters');
const { requireAdmin } = require('../lib/admin-auth');
const { DATA } = require('../lib/config');

const MEMBERS_FILE = path.join(DATA, 'members.json');

function isClanMemberAccount(accountId) {
  try {
    const members = JSON.parse(fs.readFileSync(MEMBERS_FILE, 'utf8'));
    return members.some(m => m.accountId === accountId);
  } catch {
    return false;
  }
}

function parseLimit(value) {
  const n = parseInt(value || '5', 10);
  if (!Number.isFinite(n)) return 5;
  return Math.min(Math.max(n, 1), 10);
}

async function handleMatches(req, res, url) {
  const { pathname, searchParams } = url;

  // GET /api/matches/player?accountId=...&limit=5[&bust=1] — recent matches for one player
  // bust=1 bypasses the player disk cache so new matches show immediately
  if (req.method === 'GET' && pathname === '/api/matches/player') {
    const accountId = searchParams.get('accountId');
    const limit     = parseLimit(searchParams.get('limit'));
    const bust      = searchParams.get('bust') === '1';
    if (!accountId) return errRes(res, 'accountId required');
    if ((bust || !isClanMemberAccount(accountId)) && !requireAdmin(req, res)) return;

    try {
      const playerData = bust ? await getPlayerFresh(accountId) : await getPlayer(accountId);
      const matchRefs  = playerData.data.relationships.matches.data || [];
      const matches = [];
      for (let offset = 0; offset < matchRefs.length && matches.length < limit; offset += 10) {
        const chunk = matchRefs.slice(offset, offset + 10);
        const matchResults = await Promise.allSettled(
          chunk.map(ref => getMatch(ref.id))
        );

        for (const result of matchResults) {
          if (result.status !== 'fulfilled') continue;
          const m = result.value;
          const attrs = m.data.attributes;
          if (!isCountingSquadMatch(attrs)) continue;

          const participants = (m.included || []).filter(i => i.type === 'participant');
          const rosters = (m.included || []).filter(i => i.type === 'roster');
          const participant = participants.find(
            p => p.attributes.stats.playerId === accountId
          );
          const roster = participant
            ? rosters.find(r =>
                r.relationships.participants.data.some(p => p.id === participant.id)
              )
            : null;

          matches.push({
            matchId: m.data.id,
            mapName: attrs.mapName,
            gameMode: attrs.gameMode,
            createdAt: attrs.createdAt,
            duration: attrs.duration,
            playerStats: participant ? participant.attributes.stats : null,
            placement: roster ? roster.attributes.stats.rank : null,
            teamSize: roster ? roster.relationships.participants.data.length : null,
          });
          if (matches.length >= limit) break;
        }
      }

      return jsonRes(res, { matches, accountId });
    } catch (e) {
      return errRes(res, e.message, 500);
    }
  }

  // GET /api/matches/:matchId — full match details
  if (req.method === 'GET' && pathname.startsWith('/api/matches/') &&
      pathname.split('/').length === 4) {
    if (!requireAdmin(req, res)) return;
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
