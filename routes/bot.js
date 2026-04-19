'use strict';
// ── routes/bot.js — Discord HTTP Interactions endpoint ────────────────────────
// Handles POST /interactions
//
// Discord sends signed HTTP POST requests for every slash command.
// We verify the signature, read stats from disk cache (or live), respond.
//
// Slash commands handled:
//   /stats [player]   — season + lifetime stats for a clan member
//   /roster           — list all current clan members
//   /leaderboard      — top 5 by K/D, kills, wins this season

const fs   = require('fs');
const path = require('path');
const https = require('https');

const { DATA, loadEnv }                   = require('../lib/config');
const {
  verifySignature,
  extractStats,
  getStatsEntry,
  buildStatsEmbed,
  buildRosterEmbed,
  buildLeaderboardEmbed,
  buildHelpEmbed,
  buildAnalysisEmbed,
  pong,
  ephemeralMessage,
  embedResponse,
  deferredResponse,
} = require('../lib/discord-interactions');
const {
  getCurrentSeason,
  batchGetSeasonStats,
  batchGetLifetimeStats,
} = require('../lib/pubg');

const MEMBERS_FILE  = path.join(DATA, 'members.json');
const STATS_FILE    = path.join(DATA, 'stats_cache.json');
const SEASON_FILE   = path.join(DATA, 'season.json');
const ANALYSIS_FILE = path.join(DATA, 'analysis_cache.json');
const WEAPON_FILE   = path.join(DATA, 'weapon_cache.json');
const HISTORY_FILE  = path.join(DATA, 'match_history_cache.json');

// ── Helpers ───────────────────────────────────────────────────────────────────
function loadMembers() {
  try { return JSON.parse(fs.readFileSync(MEMBERS_FILE, 'utf8')); } catch { return []; }
}

function loadDiskCache() {
  try { return JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')); } catch { return null; }
}

// Load match history totals keyed by accountId (official-only, casual-filtered)
function loadHistoryTotals() {
  try {
    const cache = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    const totals = {};
    for (const [accountId, data] of Object.entries(cache.result || {})) {
      if (data.totals) totals[accountId] = data.totals;
    }
    return totals;
  } catch { return {}; }
}

function loadSavedSeasonId() {
  try {
    const d = JSON.parse(fs.readFileSync(SEASON_FILE, 'utf8'));
    if (d.seasonId && Date.now() - d.savedAt < 14 * 24 * 60 * 60 * 1000) return d.seasonId;
  } catch {}
  return null;
}

// Read raw request body as a string
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 10_000) req.destroy(new Error('Body too large')); });
    req.on('end',   ()    => resolve(body));
    req.on('error', reject);
  });
}

// Send a followup message to a deferred interaction (PATCH /webhooks/…/messages/@original)
function sendFollowup(appId, interactionToken, embed) {
  return new Promise((resolve, reject) => {
    const env  = loadEnv();
    const body = JSON.stringify({ embeds: [embed] });
    const req  = https.request({
      hostname: 'discord.com',
      path:     `/api/v10/webhooks/${appId}/${interactionToken}/messages/@original`,
      method:   'PATCH',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent':     'APES-ClanBot/1.0',
        'Authorization':  `Bot ${env.DISCORD_BOT_TOKEN}`,
      },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve();
        else reject(new Error(`Followup ${res.statusCode}: ${d.slice(0, 200)}`));
      });
    });
    req.on('error', reject);
    req.setTimeout(10_000, () => { req.destroy(); reject(new Error('Followup timeout')); });
    req.write(body);
    req.end();
  });
}

// Send autocomplete choices response
function jsonResponse(res, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

// ── Command handlers ──────────────────────────────────────────────────────────

// /stats [player]
// If player arg is omitted, shows aggregate clan summary (leaderboard-style).
// Uses disk cache first; if stale, defers and fetches live.
async function handleStats(interaction, res) {
  const env    = loadEnv();
  const appId  = env.DISCORD_APP_ID;
  const token  = interaction.token;

  const playerArg = interaction.data?.options?.find(o => o.name === 'player')?.value || null;
  const members   = loadMembers();

  if (members.length === 0) {
    return jsonResponse(res, ephemeralMessage('⚠️  No clan members found. Add some via the web interface first.'));
  }

  // Find specific member if arg given
  let targetMember = null;
  if (playerArg) {
    targetMember = members.find(m => m.name.toLowerCase() === playerArg.toLowerCase());
    if (!targetMember) {
      // Fuzzy: partial match
      targetMember = members.find(m => m.name.toLowerCase().includes(playerArg.toLowerCase()));
    }
    if (!targetMember) {
      const names = members.map(m => m.name).join(', ');
      return jsonResponse(res, ephemeralMessage(`❌  Player \`${playerArg}\` not found in the clan roster.\nMembers: ${names}`));
    }
  }

  // Check disk cache freshness (< 2 hours = serve immediately)
  const CACHE_MAX_AGE = 2 * 60 * 60 * 1000;
  const disk = loadDiskCache();
  const cacheOk = disk && (Date.now() - disk.savedAt) < CACHE_MAX_AGE;

  if (cacheOk) {
    // Fast path: serve from cache
    const historyTotals = loadHistoryTotals();
    if (targetMember) {
      const entry = disk.stats.find(s => s.member?.accountId === targetMember.accountId);
      const seasonEntry = entry ? getStatsEntry(targetMember.accountId, entry.season, historyTotals) : null;
      const embed = buildStatsEmbed(targetMember, seasonEntry, entry?.lifetime || null, disk.seasonId);
      return jsonResponse(res, embedResponse(embed));
    } else {
      // No player arg = leaderboard
      const embed = buildLeaderboardEmbed(disk.stats, disk.seasonId, historyTotals);
      return jsonResponse(res, embedResponse(embed));
    }
  }

  // Cache stale — defer and fetch live
  jsonResponse(res, deferredResponse());

  // Async followup
  setImmediate(async () => {
    try {
      let seasonId = loadSavedSeasonId();
      if (!seasonId) {
        try { seasonId = (await getCurrentSeason())?.id; } catch {}
      }

      const accountIds = targetMember ? [targetMember.accountId] : members.map(m => m.accountId);

      let seasonMap   = new Map();
      let lifetimeMap = new Map();
      try { seasonMap   = await batchGetSeasonStats(accountIds, seasonId); }   catch {}
      try { lifetimeMap = await batchGetLifetimeStats(accountIds); }           catch {}

      const historyTotals = loadHistoryTotals();
      let embed;
      if (targetMember) {
        const se = getStatsEntry(targetMember.accountId, seasonMap.get(targetMember.accountId) || null, historyTotals);
        embed = buildStatsEmbed(targetMember, se, lifetimeMap.get(targetMember.accountId) || null, seasonId);
      } else {
        const statsArr = members.map(m => ({
          member:  m,
          season:  seasonMap.get(m.accountId) || null,
          lifetime: lifetimeMap.get(m.accountId) || null,
        }));
        embed = buildLeaderboardEmbed(statsArr, seasonId, historyTotals);
      }

      await sendFollowup(appId, token, embed);
    } catch (e) {
      console.error('[APES Bot] Followup error:', e.message);
      try {
        await sendFollowup(appId, token, {
          title: 'Error',
          description: `⚠️  Could not fetch stats: ${e.message}`,
          color: 0xff0000,
        });
      } catch {}
    }
  });
}

// /roster
async function handleRoster(interaction, res) {
  const members = loadMembers();
  return jsonResponse(res, embedResponse(buildRosterEmbed(members)));
}

// /leaderboard
async function handleLeaderboard(interaction, res) {
  const env   = loadEnv();
  const appId = env.DISCORD_APP_ID;
  const token = interaction.token;

  const disk       = loadDiskCache();
  const CACHE_MAX_AGE = 2 * 60 * 60 * 1000;
  const cacheOk    = disk && (Date.now() - disk.savedAt) < CACHE_MAX_AGE;

  if (cacheOk) {
    return jsonResponse(res, embedResponse(buildLeaderboardEmbed(disk.stats, disk.seasonId, loadHistoryTotals())));
  }

  jsonResponse(res, deferredResponse());

  setImmediate(async () => {
    try {
      const members    = loadMembers();
      let seasonId     = loadSavedSeasonId();
      if (!seasonId) {
        try { seasonId = (await getCurrentSeason())?.id; } catch {}
      }
      const accountIds = members.map(m => m.accountId);
      let seasonMap    = new Map();
      try { seasonMap  = await batchGetSeasonStats(accountIds, seasonId); } catch {}

      const historyTotals = loadHistoryTotals();
      const statsArr = members.map(m => ({ member: m, season: seasonMap.get(m.accountId) || null }));
      await sendFollowup(appId, token, buildLeaderboardEmbed(statsArr, seasonId, historyTotals));
    } catch (e) {
      console.error('[APES Bot] Leaderboard followup error:', e.message);
      try { await sendFollowup(env.DISCORD_APP_ID, token, { title: 'Error', description: e.message, color: 0xff0000 }); } catch {}
    }
  });
}

// /anal <player>
function handleAnal(interaction, res) {
  const playerArg = interaction.data?.options?.find(o => o.name === 'player')?.value || null;
  if (!playerArg) {
    return jsonResponse(res, ephemeralMessage('❌  Please specify a player name.'));
  }

  const members = loadMembers();
  let target = members.find(m => m.name.toLowerCase() === playerArg.toLowerCase());
  if (!target) target = members.find(m => m.name.toLowerCase().includes(playerArg.toLowerCase()));
  if (!target) {
    const names = members.map(m => m.name).join(', ');
    return jsonResponse(res, ephemeralMessage(`❌  Player \`${playerArg}\` not found in the clan roster.\nMembers: ${names}`));
  }

  // Load analysis cache
  let analysis = null;
  try { analysis = JSON.parse(require('fs').readFileSync(ANALYSIS_FILE, 'utf8')); } catch {}

  if (!analysis) {
    return jsonResponse(res, ephemeralMessage('⚠️  Analysis not available yet — run the daily task first.'));
  }

  // Find player profile (array added by daily task)
  const players = analysis.players || [];
  const profile = players.find(p => p.name.toLowerCase() === target.name.toLowerCase());

  if (!profile) {
    return jsonResponse(res, ephemeralMessage(`⚠️  No analysis found for **${target.name}** — they may have fewer than 5 games this season.`));
  }

  // Load weapon cache if available (members already loaded above)
  const memberEntry = members.find(m => m.name.toLowerCase() === target.name.toLowerCase());

  let weaponSummary = null;
  try {
    const { buildSummary } = require('../scripts/fetch_weapon_stats');
    const weaponCache = JSON.parse(require('fs').readFileSync(WEAPON_FILE, 'utf8'));
    const summary = buildSummary(weaponCache, members);
    if (memberEntry) weaponSummary = summary[memberEntry.accountId] || null;
  } catch {}

  // Load match history for map affinity + knockdown conversion
  let historyEntry = null;
  try {
    const { buildHistorySummary } = require('../scripts/build_match_history');
    const historyCache = JSON.parse(require('fs').readFileSync(HISTORY_FILE, 'utf8'));
    const summary = buildHistorySummary(historyCache);
    if (memberEntry) historyEntry = summary[memberEntry.accountId] || null;
  } catch {}

  // Load lifetime data for season-vs-career comparison
  let lifetimeData = null;
  try {
    const disk = loadDiskCache();
    if (disk?.stats) {
      const entry = disk.stats.find(s => s.member?.accountId === memberEntry?.accountId);
      lifetimeData = entry?.lifetime || null;
    }
  } catch {}

  const seasonId = analysis.seasonId || null;
  return jsonResponse(res, embedResponse(buildAnalysisEmbed(target.name, profile, seasonId, weaponSummary, historyEntry, lifetimeData)));
}

// ── Autocomplete handler ──────────────────────────────────────────────────────
// Responds to Discord's autocomplete ping for the `player` option in /stats.
function handleAutocomplete(interaction, res) {
  const query   = interaction.data?.options?.find(o => o.name === 'player' && o.focused)?.value || '';
  const members = loadMembers();
  const matches = members
    .filter(m => m.name.toLowerCase().includes(query.toLowerCase()))
    .slice(0, 25)
    .map(m => ({ name: m.name, value: m.name }));
  return jsonResponse(res, { type: 8, data: { choices: matches } });
}

// ── Main handler ──────────────────────────────────────────────────────────────
async function handleBotInteraction(req, res, url) {
  if (req.method !== 'POST' || url.pathname !== '/interactions') return null;

  const env        = loadEnv();
  const publicKey  = env.DISCORD_PUBLIC_KEY;

  if (!publicKey) {
    console.error('[APES Bot] DISCORD_PUBLIC_KEY not set — rejecting interaction');
    res.writeHead(500); res.end('Bot not configured');
    return;
  }

  let rawBody;
  try {
    rawBody = await readBody(req);
  } catch (e) {
    res.writeHead(400); res.end('Bad request');
    return;
  }

  const timestamp = req.headers['x-signature-timestamp'] || '';
  const signature = req.headers['x-signature-ed25519']   || '';

  if (!verifySignature(publicKey, timestamp, rawBody, signature)) {
    console.warn('[APES Bot] Invalid signature — 401');
    res.writeHead(401); res.end('Invalid signature');
    return;
  }

  let interaction;
  try {
    interaction = JSON.parse(rawBody);
  } catch {
    res.writeHead(400); res.end('Invalid JSON');
    return;
  }

  // Type 1 = PING (Discord sends this to verify the endpoint URL)
  if (interaction.type === 1) {
    return jsonResponse(res, pong());
  }

  // Type 2 = APPLICATION_COMMAND (slash command)
  if (interaction.type === 2) {
    const cmd = interaction.data?.name;
    if (cmd === 'stats')       return handleStats(interaction, res);
    if (cmd === 'roster')      return handleRoster(interaction, res);
    if (cmd === 'leaderboard') return handleLeaderboard(interaction, res);
    if (cmd === 'help')        return jsonResponse(res, embedResponse(buildHelpEmbed()));
    if (cmd === 'anal')        return handleAnal(interaction, res);

    return jsonResponse(res, ephemeralMessage(`⚠️  Unknown command: \`/${cmd}\``));
  }

  // Type 4 = APPLICATION_COMMAND_AUTOCOMPLETE
  if (interaction.type === 4) {
    return handleAutocomplete(interaction, res);
  }

  // Unknown interaction type
  res.writeHead(400); res.end('Unknown interaction type');
}

module.exports = { handleBotInteraction };
