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
const { prewarm, prewarmStats } = require('../lib/prewarm');
const { DATA } = require('../lib/config');
const { requireAdmin } = require('../lib/admin-auth');

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

// Update a single player's season entry in stats_cache.json without touching
// other players. Called whenever fresh season stats are fetched individually
// (e.g. after a player-level refresh) so reloads always get the fresh data.
function patchPlayerStatsDisk(accountId, seasonId, freshSeason, freshLifetime) {
  try {
    if (!fs.existsSync(STATS_FILE)) return; // no cache to patch — prewarm will write it
    const cache = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
    if (!Array.isArray(cache.stats)) return;
    const idx = cache.stats.findIndex(s => s.member?.accountId === accountId);
    if (idx === -1) return; // player not in cache — prewarm will include them later
    if (freshSeason  !== undefined) cache.stats[idx].season   = freshSeason;
    if (freshLifetime !== undefined) cache.stats[idx].lifetime = freshLifetime;
    cache.stats[idx].seasonId = seasonId || cache.stats[idx].seasonId;
    cache.savedAt = Date.now(); // bump so staleness timer resets
    const TMP = STATS_FILE + '.tmp';
    fs.writeFileSync(TMP, JSON.stringify(cache, null, 2));
    fs.renameSync(TMP, STATS_FILE);
    console.log(`[3PI] 💾 stats_cache.json patched for ${accountId}`);
  } catch (e) {
    console.warn(`[3PI] Could not patch stats_cache.json for ${accountId}:`, e.message);
  }
}

async function handlePlayers(req, res, url) {
  const { pathname, searchParams } = url;

  // GET /api/members — list clan members
  if (req.method === 'GET' && pathname === '/api/members') {
    return jsonRes(res, { members: loadMembers() });
  }

  // POST /api/members — add a member by name
  if (req.method === 'POST' && pathname === '/api/members') {
    if (!requireAdmin(req, res)) return;
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
    if (!requireAdmin(req, res)) return;
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
    if (!requireAdmin(req, res)) return;
    const names = searchParams.get('names');
    if (!names) return errRes(res, 'names param required');
    try {
      const data = await getPlayersByName(names.split(',').map(n => n.trim()));
      return jsonRes(res, data);
    } catch (e) {
      return errRes(res, e.message, 500);
    }
  }

  // GET /api/players/season?accountId=...&seasonId=...&bust=1 — season stats
  // bust=1 bypasses in-memory cache and patches stats_cache.json on disk so
  // a browser reload still gets the fresh season data.
  if (req.method === 'GET' && pathname === '/api/players/season') {
    const accountId = searchParams.get('accountId');
    const seasonId  = searchParams.get('seasonId');
    const bust      = searchParams.get('bust') === '1';
    if (!accountId || !seasonId) return errRes(res, 'accountId and seasonId required');
    if (!requireAdmin(req, res)) return;
    try {
      const data = await getPlayerSeasonStats(accountId, seasonId, bust);
      // Write-through to disk cache so browser reloads always get fresh data.
      // Only patch when bust=1 (explicit refresh) to avoid thrashing the file on normal reads.
      if (bust) {
        patchPlayerStatsDisk(accountId, seasonId, data, undefined);
      }
      return jsonRes(res, data);
    } catch (e) {
      return errRes(res, e.message, 500);
    }
  }

  // GET /api/players/ranked?accountId=...&seasonId=... — ranked season stats
  if (req.method === 'GET' && pathname === '/api/players/ranked') {
    if (!requireAdmin(req, res)) return;
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

  // GET /api/players/lifetime?accountId=...&bust=1 — lifetime stats
  // bust=1 bypasses in-memory cache and patches stats_cache.json on disk.
  if (req.method === 'GET' && pathname === '/api/players/lifetime') {
    const accountId = searchParams.get('accountId');
    const bust      = searchParams.get('bust') === '1';
    if (!accountId) return errRes(res, 'accountId required');
    if (!requireAdmin(req, res)) return;
    try {
      const data = await getPlayerLifetime(accountId, bust);
      if (bust) {
        // No seasonId needed for lifetime patch — pass undefined to leave season untouched
        const sid = loadSavedSeasonId();
        patchPlayerStatsDisk(accountId, sid, undefined, data);
      }
      return jsonRes(res, data);
    } catch (e) {
      return errRes(res, e.message, 500);
    }
  }

  // GET /api/clan/stats — batch-fetch season + lifetime stats for all members
  //
  // Loading strategy: ALWAYS serves the disk cache immediately if it has real
  // data, regardless of age. The daily 6am scheduled task refreshes the cache —
  // serving slightly old data is dramatically better than blocking the page
  // load for 1-3 minutes on a synchronous live PUBG API fetch (13+ rate-limited
  // calls). When the cache is stale (>2h) or missing, we kick off prewarm in
  // the background; the next page load will pick up the fresh data, and the
  // existing /api/prewarm/status poll on the frontend surfaces progress.
  if (req.method === 'GET' && pathname === '/api/clan/stats') {
    const members = loadMembers();
    if (!members.length) return jsonRes(res, { stats: [] });

    function hasRealGameStats(seasonObj) {
      const gms = seasonObj?.data?.attributes?.gameModeStats;
      return (gms?.squad?.roundsPlayed > 0) || (gms?.['squad-fpp']?.roundsPlayed > 0);
    }

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

    function triggerBackgroundRefresh(reason) {
      if (prewarm.running) return;
      console.log(`[3PI] ⏳ ${reason} — kicking off background prewarm`);
      // setImmediate so the response goes out before prewarm starts queuing API calls
      setImmediate(() => {
        prewarmStats().catch(e => console.warn('[3PI] Background prewarm failed:', e.message));
      });
    }

    const CACHE_STALE_AFTER = 2 * 60 * 60 * 1000; // 2h — refresh in background after this
    const diskCache = loadValidDiskCache();

    // Cache exists with real data — always serve immediately, never block.
    if (diskCache) {
      const ageMs  = Date.now() - diskCache.savedAt;
      const ageMin = Math.round(ageMs / 60000);
      const stale  = ageMs > CACHE_STALE_AFTER;
      if (stale) {
        triggerBackgroundRefresh(`Disk cache ${ageMin}m old (>2h)`);
      } else {
        console.log(`[3PI] ⚡ Disk cache fresh (${ageMin}m old) — serving without API call (${diskCache.stats.length}/${members.length} members)`);
      }
      return jsonRes(res, {
        stats:         diskCache.stats,
        seasonId:      diskCache.seasonId,
        fromDiskCache: true,
        ageMin,
        stale,
        refreshing:    prewarm.running,
      });
    }

    // No disk cache — first load after server start, or just busted by member add/remove.
    // Don't block on a synchronous fetch (would take 1-3 minutes through the rate limiter).
    // Trigger prewarm and return empty + refreshing flag; frontend already polls /api/prewarm/status.
    triggerBackgroundRefresh('No disk cache present');
    return jsonRes(res, {
      stats:      [],
      seasonId:   null,
      refreshing: true,
      message:    'Cache empty — refreshing in background, watch /api/prewarm/status',
    });
  }

  // POST /api/clan/discover — seed with one player name, store clan metadata
  // Body: { playerName: "SomeClanMember" }
  // Note: PUBG API only exposes clan metadata (name, tag, level, count) — not
  // the full member roster. Use /api/members/bulk to import members by name.
  if (req.method === 'POST' && pathname === '/api/clan/discover') {
    if (!requireAdmin(req, res)) return;
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
    if (!requireAdmin(req, res)) return;
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
