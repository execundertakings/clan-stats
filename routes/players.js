'use strict';
// ── routes/players.js — player lookup, season stats, lifetime stats ───────────

const fs   = require('fs');
const path = require('path');
const { jsonRes, errRes } = require('../lib/http');
const {
  getPlayersByName,
  getPlayer,
  getPlayerSeasonStats,
  getPlayerRankedStats,
  getPlayerLifetime,
  batchGetSeasonStats,
  batchGetLifetimeStats,
  getCurrentSeason,
  discoverClanFromPlayer,
  bulkResolvePlayers,
} = require('../lib/pubg');
const { DATA } = require('../lib/config');

const MEMBERS_FILE  = path.join(DATA, 'members.json');
const SEASON_FILE   = path.join(DATA, 'season.json');
const STATS_FILE    = path.join(DATA, 'stats_cache.json');

// Load disk-persisted season ID as fallback when API is rate-limited
function loadSavedSeasonId() {
  try {
    const d = JSON.parse(fs.readFileSync(SEASON_FILE, 'utf8'));
    if (d.seasonId && Date.now() - d.savedAt < 14 * 24 * 60 * 60 * 1000) return d.seasonId;
  } catch {}
  return null;
}

function loadMembers() {
  try {
    return JSON.parse(fs.readFileSync(MEMBERS_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function saveMembers(members) {
  fs.writeFileSync(MEMBERS_FILE, JSON.stringify(members, null, 2), 'utf8');
}

// Invalidate the stats disk cache whenever membership changes so the
// leaderboard picks up the new/removed member on the next page load.
function bustStatsCache() {
  try { fs.unlinkSync(STATS_FILE); } catch {}
}

async function handlePlayers(req, res, url) {
  const { pathname, searchParams } = url;

  // GET /api/members — list clan members
  if (req.method === 'GET' && pathname === '/api/members') {
    return jsonRes(res, { members: loadMembers() });
  }

  // POST /api/members — add a member by name
  if (req.method === 'POST' && pathname === '/api/members') {
    const { parseBody } = require('../lib/http');
    const body = await parseBody(req);
    const name = (body.name || '').trim();
    if (!name) return errRes(res, 'name required');
    const members = loadMembers();
    if (members.find(m => m.name.toLowerCase() === name.toLowerCase())) {
      return errRes(res, 'Member already exists');
    }
    // Look up the player to get their account ID
    let playerData;
    try {
      playerData = await getPlayersByName(name);
    } catch (e) {
      return errRes(res, `Could not find player "${name}": ${e.message}`);
    }
    const player = playerData.data[0];
    if (!player) return errRes(res, `Player "${name}" not found`);
    const member = {
      name: player.attributes.name,
      accountId: player.id,
      addedAt: new Date().toISOString(),
    };
    members.push(member);
    saveMembers(members);
    bustStatsCache();
    return jsonRes(res, { ok: true, member });
  }

  // DELETE /api/members/:name — remove a member
  if (req.method === 'DELETE' && pathname.startsWith('/api/members/')) {
    const name = decodeURIComponent(pathname.slice('/api/members/'.length));
    let members = loadMembers();
    const before = members.length;
    members = members.filter(m => m.name.toLowerCase() !== name.toLowerCase());
    if (members.length === before) return errRes(res, 'Member not found', 404);
    saveMembers(members);
    bustStatsCache();
    return jsonRes(res, { ok: true });
  }

  // GET /api/players/lookup?names=foo,bar — look up players by name
  if (req.method === 'GET' && pathname === '/api/players/lookup') {
    const names = searchParams.get('names');
    if (!names) return errRes(res, 'names param required');
    try {
      const data = await getPlayersByName(names.split(',').map(n => n.trim()));
      return jsonRes(res, data);
    } catch (e) {
      return errRes(res, e.message, 500);
    }
  }

  // GET /api/players/season?accountId=...&seasonId=... — season stats
  if (req.method === 'GET' && pathname === '/api/players/season') {
    const accountId = searchParams.get('accountId');
    const seasonId  = searchParams.get('seasonId');
    if (!accountId || !seasonId) return errRes(res, 'accountId and seasonId required');
    try {
      const data = await getPlayerSeasonStats(accountId, seasonId);
      return jsonRes(res, data);
    } catch (e) {
      return errRes(res, e.message, 500);
    }
  }

  // GET /api/players/ranked?accountId=...&seasonId=... — ranked season stats
  if (req.method === 'GET' && pathname === '/api/players/ranked') {
    const accountId = searchParams.get('accountId');
    const seasonId  = searchParams.get('seasonId');
    if (!accountId || !seasonId) return errRes(res, 'accountId and seasonId required');
    try {
      const data = await getPlayerRankedStats(accountId, seasonId);
      return jsonRes(res, data);
    } catch (e) {
      return errRes(res, e.message, 500);
    }
  }

  // GET /api/players/lifetime?accountId=... — lifetime stats
  if (req.method === 'GET' && pathname === '/api/players/lifetime') {
    const accountId = searchParams.get('accountId');
    if (!accountId) return errRes(res, 'accountId required');
    try {
      const data = await getPlayerLifetime(accountId);
      return jsonRes(res, data);
    } catch (e) {
      return errRes(res, e.message, 500);
    }
  }

  // GET /api/clan/stats — batch-fetch season + lifetime stats for all members
  // Serves disk cache if fresh (< 2h), otherwise fetches live. Never blocks on rate limit.
  if (req.method === 'GET' && pathname === '/api/clan/stats') {
    const members = loadMembers();
    if (!members.length) return jsonRes(res, { stats: [] });

    // Helper: check if a season object has real data (not all-null from failed batch)
    function hasRealGameStats(seasonObj) {
      const gms = seasonObj?.data?.attributes?.gameModeStats;
      return (gms?.squad?.roundsPlayed > 0) || (gms?.['squad-fpp']?.roundsPlayed > 0);
    }

    // Helper: load and validate disk cache, filtering to current members only
    const memberIds = new Set(members.map(m => m.accountId));
    function loadValidDiskCache() {
      try {
        const cached = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
        if (cached?.stats?.length && cached.stats.some(s => hasRealGameStats(s.season))) {
          // Filter to only current members (removed members shouldn't appear)
          cached.stats = cached.stats.filter(s => memberIds.has(s.member?.accountId));
          return cached;
        }
      } catch {}
      return null;
    }

    // Serve disk cache immediately if fresh enough (< 2 hours old)
    // This avoids hammering the API on every page load and keeps things snappy.
    const CACHE_MAX_AGE = 2 * 60 * 60 * 1000; // 2 hours
    const diskCache = loadValidDiskCache();
    if (diskCache && (Date.now() - diskCache.savedAt) < CACHE_MAX_AGE) {
      const ageMin = Math.round((Date.now() - diskCache.savedAt) / 60000);
      console.log(`[APES] ⚡ Disk cache fresh (${ageMin}m old) — serving without API call (${diskCache.stats.length}/${members.length} members)`);
      return jsonRes(res, { stats: diskCache.stats, seasonId: diskCache.seasonId, fromDiskCache: true });
    }

    // Cache is stale or missing — try live fetch
    const seasonId = searchParams.get('seasonId');
    let targetSeason = seasonId;
    if (!targetSeason) {
      try {
        const current = await getCurrentSeason();
        targetSeason = current ? current.id : null;
        if (targetSeason) {
          try { fs.writeFileSync(SEASON_FILE, JSON.stringify({ seasonId: targetSeason, savedAt: Date.now() })); } catch {}
        }
      } catch (e) {
        targetSeason = loadSavedSeasonId();
        if (!targetSeason) {
          // Fall back to stale disk cache rather than failing completely
          if (diskCache) {
            console.log(`[APES] ⚡ Season API failed, serving stale disk cache`);
            return jsonRes(res, { stats: diskCache.stats, seasonId: diskCache.seasonId, fromDiskCache: true });
          }
          return errRes(res, `Could not determine current season: ${e.message}`, 500);
        }
      }
    }
    if (!targetSeason) return errRes(res, 'No current season found', 500);

    const accountIds = members.map(m => m.accountId);

    let seasonMap   = new Map();
    let lifetimeMap = new Map();
    try { seasonMap   = await batchGetSeasonStats(accountIds, targetSeason); } catch (e) {
      console.warn('[APES] batchGetSeasonStats failed:', e.message);
    }
    try { lifetimeMap = await batchGetLifetimeStats(accountIds); } catch (e) {
      console.warn('[APES] batchGetLifetimeStats failed:', e.message);
    }

    // If live fetch got no real data, fall back to disk cache (any age)
    const gotAnyStats = [...seasonMap.values()].some(hasRealGameStats);
    if (!gotAnyStats) {
      if (diskCache) {
        console.log(`[APES] ⚡ Live fetch returned no stats — serving disk cache`);
        return jsonRes(res, { stats: diskCache.stats, seasonId: diskCache.seasonId, fromDiskCache: true });
      }
    }

    const stats = members.map(m => ({
      member:        m,
      seasonId:      targetSeason,
      season:        seasonMap.get(m.accountId)   || null,
      lifetime:      lifetimeMap.get(m.accountId) || null,
      seasonError:   seasonMap.get(m.accountId)   ? null : 'No season data',
      lifetimeError: lifetimeMap.get(m.accountId) ? null : 'No lifetime data',
    }));

    // Persist to disk if we got real data
    if (gotAnyStats) {
      try {
        fs.writeFileSync(STATS_FILE, JSON.stringify({ stats, seasonId: targetSeason, savedAt: Date.now() }, null, 2));
        console.log(`[APES] 💾 Stats written to disk cache`);
      } catch {}
    }

    return jsonRes(res, { stats, seasonId: targetSeason });
  }

  // POST /api/clan/discover — seed with one player name, store clan metadata
  // Body: { playerName: "SomeAPESMember" }
  // Note: PUBG API only exposes clan metadata (name, tag, level, count) — not
  // the full member roster. Use /api/members/bulk to import members by name.
  if (req.method === 'POST' && pathname === '/api/clan/discover') {
    const { parseBody } = require('../lib/http');
    const body = await parseBody(req);
    const playerName = (body.playerName || '').trim();
    if (!playerName) return errRes(res, 'playerName required');

    let discovered;
    try {
      discovered = await discoverClanFromPlayer(playerName);
    } catch (e) {
      return errRes(res, e.message, 400);
    }

    const { clanId, clanName, clanTag, clanLevel, clanMemberCount, seedMember } = discovered;

    // Add seed player to members if not already there
    const existing = loadMembers();
    const existingIds = new Set(existing.map(m => m.accountId));
    if (!existingIds.has(seedMember.accountId)) {
      existing.push(seedMember);
      saveMembers(existing);
    }

    // Persist clan metadata
    const CLAN_FILE = require('path').join(require('../lib/config').DATA, 'clan.json');
    require('fs').writeFileSync(CLAN_FILE, JSON.stringify(
      { clanId, clanName, clanTag, clanLevel, clanMemberCount, syncedAt: new Date().toISOString() },
      null, 2
    ));

    return jsonRes(res, { ok: true, clanId, clanName, clanTag, clanLevel, clanMemberCount, seedMember });
  }

  // POST /api/members/bulk — resolve multiple usernames at once
  // Body: { names: ["name1", "name2", ...] } or { names: "name1\nname2\nname3" }
  if (req.method === 'POST' && pathname === '/api/members/bulk') {
    const { parseBody } = require('../lib/http');
    const body = await parseBody(req);
    let names = body.names;
    if (typeof names === 'string') {
      names = names.split(/[\n,]+/).map(n => n.trim()).filter(Boolean);
    }
    if (!Array.isArray(names) || !names.length) return errRes(res, 'names required');
    if (names.length > 100) return errRes(res, 'Max 100 names per bulk import');

    let bulkResult;
    try {
      bulkResult = await bulkResolvePlayers(names);
    } catch (e) {
      return errRes(res, e.message, 500);
    }

    const existing    = loadMembers();
    const existingIds = new Set(existing.map(m => m.accountId));
    let added = 0;
    for (const m of bulkResult.resolved) {
      if (!existingIds.has(m.accountId)) {
        existing.push(m);
        added++;
      }
    }
    saveMembers(existing);
    if (added > 0) bustStatsCache();

    return jsonRes(res, {
      ok:       true,
      added,
      skipped:  bulkResult.resolved.length - added,
      notFound: bulkResult.notFound,
      members:  existing,
    });
  }

  // GET /api/clan/info — return stored clan metadata
  if (req.method === 'GET' && pathname === '/api/clan/info') {
    const CLAN_FILE = require('path').join(require('../lib/config').DATA, 'clan.json');
    try {
      const info = JSON.parse(require('fs').readFileSync(CLAN_FILE, 'utf8'));
      return jsonRes(res, info);
    } catch {
      return jsonRes(res, {});
    }
  }

  return null; // not handled
}

module.exports = { handlePlayers };
