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

const fs    = require('fs');
const path  = require('path');

const { DATA, loadEnv, loadClanConfig }   = require('../lib/config');
const CLAN = loadClanConfig();
const CTAG = `[${CLAN.clan.tag}]`;       // bracketed embed prefix, e.g. "[3PI]"
const CSHORT = CLAN.clan.shortName;      // inline short name, e.g. "3PI"
const { bulkResolvePlayers, clearCache }  = require('../lib/pubg');
const { postWebhook, discordApiRequest } = require('../lib/discord');
const bugReports = require('../lib/bug-reports');
const {
  verifySignature,
  extractStats,
  getStatsEntry,
  buildStatsEmbed,
  buildRosterEmbed,
  buildLeaderboardEmbed,
  buildHelpEmbed,
  buildAnalysisEmbed,
  buildBugReportsEmbed,
  pong,
  ephemeralMessage,
  embedResponse,
  deferredResponse,
  signEmbed,
} = require('../lib/discord-interactions');
const MEMBERS_FILE   = path.join(DATA, 'members.json');
const SEASON_FILE    = path.join(DATA, 'season.json');
const ANALYSIS_FILE  = path.join(DATA, 'analysis_cache.json');
const WEAPON_FILE    = path.join(DATA, 'weapon_cache.json');
const HISTORY_FILE   = path.join(DATA, 'match_history_cache.json');
const STATS_FILE     = path.join(DATA, 'stats_cache.json');
const AI_INSIGHTS_FILE = path.join(DATA, 'ai_insights_cache.json');

// ── Helpers ───────────────────────────────────────────────────────────────────
function loadMembers() {
  try { return JSON.parse(fs.readFileSync(MEMBERS_FILE, 'utf8')); } catch { return []; }
}

function saveMembers(members) {
  fs.writeFileSync(MEMBERS_FILE, JSON.stringify(members, null, 2));
}

function bustStatsCache() {
  const STATS_CACHE = path.join(DATA, 'stats_cache.json');
  try { if (fs.existsSync(STATS_CACHE)) fs.unlinkSync(STATS_CACHE); } catch {}
}

// Load match history entries keyed by accountId (official-only, casual-filtered)
function loadHistoryEntries() {
  try {
    const cache = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    return cache.result || {};
  } catch { return {}; }
}

function loadSeasonStatsById() {
  try {
    const cache = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
    return new Map((cache.stats || []).map(entry => [entry.member?.accountId, entry.season || null]));
  } catch {
    return new Map();
  }
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

// Send autocomplete choices response
function jsonResponse(res, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

// Send a followup message to a deferred interaction via Discord REST API.
// Used when we need to do async work (like PUBG API calls) after deferring.
function sendFollowup(appId, interactionToken, payload) {
  if (payload && Array.isArray(payload.embeds)) payload.embeds = payload.embeds.map(signEmbed);
  postWebhook(`https://discord.com/api/v10/webhooks/${appId}/${interactionToken}`, payload)
    .catch(e => console.error('[3PI Bot] Followup error:', e.message));
}

// DM a Discord user via the bot token (two-step: create channel, send message).
// Fails silently if the user has DMs disabled — never block the calling flow on this.
async function dmUser(botToken, userId, payload) {
  if (!botToken || !userId) return;
  try {
    const channel = await discordApiRequest({
      token:    botToken,
      endpoint: '/users/@me/channels',
      method:   'POST',
      body:     { recipient_id: String(userId) },
    });
    const channelId = channel?.json?.id;
    if (!channelId) throw new Error('No DM channel returned');
    await discordApiRequest({
      token:    botToken,
      endpoint: `/channels/${channelId}/messages`,
      method:   'POST',
      body:     payload,
    });
  } catch (e) {
    console.warn(`[3PI Bot] DM to ${userId} failed: ${e.message}`);
  }
}

// ── Command handlers ──────────────────────────────────────────────────────────

// /stats [player]
// If player arg is omitted, shows aggregate clan summary (leaderboard-style).
// Serves from local caches only: official-only match history when trustworthy,
// otherwise the latest disk-cached PUBG season payload.
async function handleStats(interaction, res) {
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
      targetMember = members.find(m => m.name.toLowerCase().includes(playerArg.toLowerCase()));
    }
    if (!targetMember) {
      const names = members.map(m => m.name).join(', ');
      return jsonResponse(res, ephemeralMessage(`❌  Player \`${playerArg}\` not found in the clan roster.\nMembers: ${names}`));
    }
  }

  const historyEntries = loadHistoryEntries();
  const seasonById     = loadSeasonStatsById();
  const seasonId       = loadSavedSeasonId() || 'current';

  if (targetMember) {
    const seasonEntry = getStatsEntry(targetMember.accountId, seasonById.get(targetMember.accountId) || null, historyEntries);
    const embed = buildStatsEmbed(targetMember, seasonEntry, null, seasonId);
    return jsonResponse(res, embedResponse(embed));
  } else {
    // No player arg = leaderboard across all members
    const statsArr = members.map(m => ({ member: m, season: seasonById.get(m.accountId) || null, lifetime: null }));
    const embed = buildLeaderboardEmbed(statsArr, seasonId, historyEntries);
    return jsonResponse(res, embedResponse(embed));
  }
}

// /roster
async function handleRoster(interaction, res) {
  const members = loadMembers();
  return jsonResponse(res, embedResponse(buildRosterEmbed(members)));
}

// /leaderboard
// Serves from local caches only: official-only match history when trustworthy,
// otherwise the latest disk-cached PUBG season payload.
async function handleLeaderboard(interaction, res) {
  const members        = loadMembers();
  const historyEntries = loadHistoryEntries();
  const seasonById     = loadSeasonStatsById();
  const seasonId       = loadSavedSeasonId() || 'current';
  const statsArr       = members.map(m => ({ member: m, season: seasonById.get(m.accountId) || null, lifetime: null }));
  return jsonResponse(res, embedResponse(buildLeaderboardEmbed(statsArr, seasonId, historyEntries)));
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

  const seasonId = analysis.seasonId || loadSavedSeasonId() || null;
  // lifetimeData removed — career comparison uses official-only match_history totals via historyEntry
  return jsonResponse(res, embedResponse(buildAnalysisEmbed(target.name, profile, seasonId, weaponSummary, historyEntry, null)));
}

// /glaze — show today's glaze card from ai_insights_cache.json
function handleGlaze(interaction, res) {
  let cache = null;
  try { cache = JSON.parse(fs.readFileSync(AI_INSIGHTS_FILE, 'utf8')); } catch {}

  if (!cache) {
    return jsonResponse(res, ephemeralMessage('⚠️  No AI insights cache found — the daily task may not have run yet.'));
  }

  const card = (cache.spotlights || []).find(s => s.id && s.id.startsWith('glaze_'));
  if (!card) {
    return jsonResponse(res, ephemeralMessage('⚠️  No glaze card found in today\'s insights.'));
  }

  const players = (card.players || []).join(', ');
  // Replace literal \n in finding with actual newlines for Discord
  const finding = (card.finding || '').replace(/\\n/g, '\n');

  const embed = {
    author:      { name: `${card.icon || '🔥'}  Today's Glaze` },
    title:       card.title,
    description: finding,
    color:       0xFFD700, // gold
    fields:      card.tip ? [{ name: '💡 Tip', value: card.tip, inline: false }] : [],
    footer:      { text: `Player: ${players} · ${CSHORT} Stats` },
    timestamp:   cache.computedAt,
  };

  return jsonResponse(res, embedResponse(embed));
}

// /roast — show today's roast card from ai_insights_cache.json
function handleRoast(interaction, res) {
  let cache = null;
  try { cache = JSON.parse(fs.readFileSync(AI_INSIGHTS_FILE, 'utf8')); } catch {}

  if (!cache) {
    return jsonResponse(res, ephemeralMessage('⚠️  No AI insights cache found — the daily task may not have run yet.'));
  }

  const card = (cache.spotlights || []).find(s => s.id && s.id.startsWith('roast_'));
  if (!card) {
    return jsonResponse(res, ephemeralMessage('⚠️  No roast card found in today\'s insights.'));
  }

  const players = (card.players || []).join(', ');
  const finding = (card.finding || '').replace(/\\n/g, '\n');

  const embed = {
    author:      { name: `${card.icon || '💀'}  Today's Roast` },
    title:       card.title,
    description: finding,
    color:       0xE74C3C, // red
    fields:      card.tip ? [{ name: '💡 Tip', value: card.tip, inline: false }] : [],
    footer:      { text: `Player: ${players} · ${CSHORT} Stats` },
    timestamp:   cache.computedAt,
  };

  return jsonResponse(res, embedResponse(embed));
}

// /register <pubg_name>
// Resolves a PUBG username, adds to members.json with the caller's discordId.
// Uses deferred response because the PUBG API call can exceed Discord's 3s limit.
async function handleRegister(interaction, res) {
  const pubgName = interaction.data?.options?.find(o => o.name === 'pubg_name')?.value || null;
  if (!pubgName) {
    return jsonResponse(res, ephemeralMessage('❌  Please provide your PUBG username: `/register pubg_name:YourName`'));
  }

  const discordId   = interaction.member?.user?.id || interaction.user?.id;
  const discordName = interaction.member?.user?.username || interaction.user?.username || 'unknown';

  // Quick checks that don't need the API — respond immediately if possible
  const existing = loadMembers();
  const alreadyLinked = existing.find(m => m.discordId === discordId);
  if (alreadyLinked) {
    return jsonResponse(res, ephemeralMessage(
      `You're already registered as **${alreadyLinked.name}**. If you changed your PUBG name, ask an admin to update it.`
    ));
  }

  const alreadyInRoster = existing.find(m => m.name.toLowerCase() === pubgName.toLowerCase());
  if (alreadyInRoster) {
    if (!alreadyInRoster.discordId) {
      alreadyInRoster.discordId = discordId;
      saveMembers(existing);
      return jsonResponse(res, embedResponse({
        author: { name: `${CTAG} Registration` },
        color:  0x2ECC71,
        description: `**${alreadyInRoster.name}** was already on the roster — linked to your Discord account. Your stats are being tracked!`,
      }));
    }
    return jsonResponse(res, ephemeralMessage(
      `**${alreadyInRoster.name}** is already registered to another Discord account.`
    ));
  }

  // Needs PUBG API call — defer the response, then follow up async
  const env   = loadEnv();
  const appId = env.DISCORD_APP_ID;
  const token = interaction.token;

  jsonResponse(res, deferredResponse());

  // Do the slow work in the background
  _registerAsync(pubgName, discordId, discordName, existing, appId, token).catch(e => {
    console.error('[3PI Bot] Register async error:', e.message);
    sendFollowup(appId, token, { content: `❌  Registration failed: ${e.message}` });
  });
}

// Background worker for /register — runs after deferred response is sent
async function _registerAsync(pubgName, discordId, discordName, existing, appId, token) {
  let result;
  try {
    result = await bulkResolvePlayers([pubgName]);
  } catch (e) {
    return sendFollowup(appId, token, { content: `❌  PUBG API error: ${e.message}` });
  }

  if (!result.resolved.length) {
    return sendFollowup(appId, token, {
      content: `❌  PUBG player **${pubgName}** not found. Make sure the name is exact (case-sensitive).`,
    });
  }

  const player = result.resolved[0];

  // Re-read members in case someone else registered in the meantime
  const members = loadMembers();

  // Check for accountId collision
  const byAccount = members.find(m => m.accountId === player.accountId);
  if (byAccount) {
    if (!byAccount.discordId) {
      byAccount.discordId = discordId;
      byAccount.name = player.name;
      saveMembers(members);
      return sendFollowup(appId, token, {
        embeds: [{
          author: { name: `${CTAG} Registration` },
          color:  0x2ECC71,
          description: `**${player.name}** was already on the roster — linked to your Discord. Stats are being tracked!`,
        }],
      });
    }
    return sendFollowup(appId, token, {
      content: 'This PUBG account is already registered to another Discord user.',
    });
  }

  // Add new member
  members.push({
    name:      player.name,
    accountId: player.accountId,
    clanId:    player.clanId || null,
    discordId: discordId,
    addedAt:   new Date().toISOString(),
    source:    'discord',
  });
  saveMembers(members);
  bustStatsCache();

  sendFollowup(appId, token, {
    embeds: [{
      author:      { name: `${CTAG} Registration` },
      color:       0x2ECC71,
      description: `**${player.name}** has been added to the ${CSHORT} tracker! 🎮\n\nYour stats will appear on the leaderboard after the next data refresh (up to 2 hours).`,
      footer:      { text: `Registered by ${discordName}` },
      timestamp:   new Date().toISOString(),
    }],
  });
}

// /bugreport <text>
// Records a bug report. The daily scheduled task triages reports — this
// command does NOT do anything beyond storing the report and DMing the
// submitter an acknowledgment. Reports are user feedback, not authoritative
// truth; the security scope governing how the task may act on them lives in
// scheduled-tasks/daily-clan.skill.md (Phase D) and is enforced in
// scripts/apply_bug_report_action.js.
async function handleBugReport(interaction, res) {
  // Ack within Discord's 3s window even when the box is under load, then do
  // everything else as an ephemeral followup. Responding inline timed out
  // under load (bug report br_1780775766606_e2c6c2).
  const appId = loadEnv().DISCORD_APP_ID;
  const token = interaction.token;
  jsonResponse(res, deferredResponse(true));
  const reply = msg => sendFollowup(appId, token, { content: msg, flags: 64 });

  try {
  const textArg = interaction.data?.options?.find(o => o.name === 'text')?.value || '';

  // Gate: require the configured clan membership role (e.g. @Memo).
  // NOTE: /register is NOT gated — only this command is.
  const { gatewayState } = require('../lib/discord-gateway');
  const gw = gatewayState({ includePrivate: true });
  const memberRoles = interaction.member?.roles || [];
  if (gw.roleId && !memberRoles.includes(gw.roleId)) {
    return reply(`❌  You need the **@${gw.roleName || 'Memo'}** role to submit a bug report. Ask an admin to add you first.`);
  }

  const discordId   = interaction.member?.user?.id || interaction.user?.id;
  const submitterName = interaction.member?.user?.username || interaction.user?.username || 'unknown';

  // Cross-reference the roster — informational only; we still accept reports
  // from users who have the role but aren't /register'd yet.
  const members   = loadMembers();
  const matched   = members.find(m => m.discordId === discordId);
  const memberName = matched?.name || null;

  const result = bugReports.submit({
    discordId,
    submitterName,
    memberName,
    rawText: textArg,
  });

  if (!result.ok) {
    const reasonMsg = {
      missing_discord_id:    '❌  Could not identify your Discord user.',
      empty:                 '❌  Bug report is empty. Describe what you noticed.',
      empty_after_sanitise:  '❌  Bug report only contained whitespace or control characters.',
      too_short:             '❌  Bug report is too short — give us at least a sentence to work with.',
      rate_limited:          `⏱  You’ve submitted ${bugReports.LIMITS.MAX_REPORTS_PER_WINDOW} reports in the last 24h — try again later.`,
      duplicate:             '🪞  You already submitted an identical report in the last 24h.',
    }[result.reason] || `❌  Bug report rejected: ${result.reason}`;
    return reply(reasonMsg);
  }

  const report = result.report;

  // DM the submitter an acknowledgment (fire and forget — DM may fail if they
  // disabled them, which is fine).
  const env = loadEnv();
  const botToken = env.DISCORD_BOT_TOKEN;
  const ackLines = [
    'Thanks for the bug report! 🐞',
    '',
    `**Report ID:** \`${report.id}\``,
    `**Submitted:** ${report.submittedAt}`,
    '',
    '> ' + report.text.split('\n').join('\n> '),
    '',
    `The daily ${CSHORT} task (06:00 local) will look it over and decide whether anything needs fixing. Reports are treated as helpful feedback, not authoritative truth — we cross-check against the actual data before changing anything. You’ll only hear back if a human gets involved.`,
    '',
    'You can check the status of your reports anytime with `/bugreports`.',
  ];
  dmUser(botToken, discordId, { content: ackLines.join('\n') });

  // Also DM each admin so new reports surface immediately instead of waiting
  // for the daily triage at 06:00. Configured via clan.config.json, with an
  // optional CLAN_ADMIN_DISCORD_IDS override. Fire-and-forget — must never block the user.
  const adminIds = loadClanConfig().discord.adminUserIds || [];
  if (adminIds.length) {
    const preview = report.text.length > 600
      ? report.text.slice(0, 600) + '…'
      : report.text;
    const injectionTag = report.category === 'prompt_injection_attempt'
      ? '\n⚠️  Flagged on submission as a possible prompt-injection attempt.'
      : '';
    const rosterTag = memberName
      ? `\n**Roster match:** ${memberName}`
      : '\n**Roster match:** _none_ (submitter has the membership role but no /register link)';
    const adminLines = [
      `🐞 **New ${CSHORT} bug report**`,
      `**ID:** \`${report.id}\``,
      `**From:** ${submitterName} (<@${discordId}>)${rosterTag}${injectionTag}`,
      `**At:** ${report.submittedAt}`,
      '',
      '> ' + preview.split('\n').join('\n> '),
    ];
    for (const adminId of adminIds) {
      if (adminId === discordId) continue; // don't double-DM if admin self-reports
      dmUser(botToken, adminId, { content: adminLines.join('\n') });
    }
  }

  // Ephemeral reply visible only to the submitter
  return reply(`✅  Bug report received — ID \`${report.id}\`. Check your DMs for confirmation. The daily task will triage it at 06:00 local.`);
  } catch (e) {
    console.error('[3PI Bot] bugreport error:', e.message);
    reply('❌  Something went wrong recording your report — try again later.');
  }
}

// /bugreports
// Lists the caller's own submitted reports and their current triage status.
async function handleBugReports(interaction, res) {
  const discordId = interaction.member?.user?.id || interaction.user?.id;
  const submitterName = interaction.member?.user?.username || interaction.user?.username || 'you';
  const reports = bugReports.listForDiscordId(discordId);
  return jsonResponse(res, embedResponse(buildBugReportsEmbed(submitterName, reports), true));
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
  if (req.method !== 'POST' || !['/interactions', '/api/bot/interactions'].includes(url.pathname)) return null;

  const env        = loadEnv();
  const publicKey  = env.DISCORD_PUBLIC_KEY;

  if (!publicKey) {
    console.error('[3PI Bot] DISCORD_PUBLIC_KEY not set — rejecting interaction');
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
    console.warn('[3PI Bot] Invalid signature — 401');
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
    if (cmd === 'register')    return handleRegister(interaction, res);
    if (cmd === 'help')        return jsonResponse(res, embedResponse(buildHelpEmbed()));
    if (cmd === 'anal')        return handleAnal(interaction, res);
    if (cmd === 'glaze')       return handleGlaze(interaction, res);
    if (cmd === 'roast')       return handleRoast(interaction, res);
    if (cmd === 'bugreport')   return handleBugReport(interaction, res);
    if (cmd === 'bugreports')  return handleBugReports(interaction, res);

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
