'use strict';
// ── lib/discord-gateway.js — Discord Gateway (WebSocket) client ─────────────
// Connects to the Discord Gateway to receive real-time events:
//   - GUILD_MEMBER_ADD → seed role state for newly joined members
//   - GUILD_MEMBER_UPDATE → detect configured membership-role (e.g. @Memo) add/remove
//   - GUILD_MEMBER_REMOVE → detect member leaving the server
//   - MESSAGE_REACTION_ADD/REMOVE → optional configured reaction roles
//
// On role add:  DMs the user instructions to /register their PUBG name.
// On role remove / leave:  Removes them from members.json by discordId.
//
// Zero npm deps — uses Node 22 built-in WebSocket.
//
// Required env:
//   DISCORD_BOT_TOKEN   — Bot token
//   discord.guildId     — The clan server ID in config/clan.config.json
//   DISCORD_WEBHOOK_URL — (optional) posts removal notifications
//
// Required privileged intent: SERVER MEMBERS (enable in Developer Portal)

const fs   = require('fs');
const path = require('path');
const { postWebhook, discordApiRequest } = require('./discord');
const { loadClanConfig } = require('./config');

const GATEWAY_URL  = 'wss://gateway.discord.gg/?v=10&encoding=json';
// Intents: GUILDS (1) + GUILD_MEMBERS (2) + GUILD_MESSAGE_REACTIONS (1024)
const INTENTS = (1 << 0) | (1 << 1) | (1 << 10);

// ── State ────────────────────────────────────────────────────────────────────
let _ws              = null;
let _heartbeatTimer  = null;
let _lastSeq         = null;
let _sessionId       = null;
let _resumeUrl       = null;
let _botToken        = null;
let _guildId         = null;
let _roleName        = null;
let _roleId          = null;    // resolved on GUILD_CREATE
let _webhookUrl      = null;
let _membersFile     = null;
let _botUserId       = null;
let _reactionRoles   = [];
let _reconnectDelay  = 5000;
let _alive           = false;   // got heartbeat ACK?
let _pendingBackoffReset = false; // reset _reconnectDelay on next ACK (not on READY)
let _connectCount    = 0;       // rate limiter — connections in the current window
let _connectWindowAt = 0;       // start of the current rate-limit window
const _CONNECT_LIMIT = 10;      // max connections per window
const _CONNECT_WINDOW = 300000; // 5-minute window

// Track known role sets so we can detect adds/removes on GUILD_MEMBER_UPDATE.
// Discord only sends the *new* role list, not what changed — we diff against
// what we last saw. On startup we seed from REST so unrelated first updates
// after a restart do not look like new role additions.
const _memberRoles = new Map(); // discordUserId → Set<roleId>

// ── Public API ───────────────────────────────────────────────────────────────

function startGateway(opts) {
  _botToken    = opts.botToken;
  _guildId     = opts.guildId;
  _roleName    = (opts.roleName || 'Memo').toLowerCase();
  _webhookUrl  = opts.webhookUrl || null;
  _membersFile = opts.membersFile;
  _reactionRoles = _normalizeReactionRoles(loadClanConfig().discord.reactionRoles);

  if (!_botToken || !_guildId) {
    console.warn('[Gateway] Missing DISCORD_BOT_TOKEN or configured discord.guildId — Gateway disabled.');
    return;
  }

  console.log(`[Gateway] Connecting (watching for @${_roleName} role changes)…`);
  _connect();
}

function gatewayState(options = {}) {
  const state = {
    connected: _ws?.readyState === WebSocket.OPEN,
    roleName:  _roleName,
    tracked:   _memberRoles.size,
  };
  if (options.includePrivate) {
    state.roleId = _roleId;
    state.sessionId = _sessionId;
  }
  return state;
}

// ── WebSocket lifecycle ──────────────────────────────────────────────────────

function _connect(resumeUrl) {
  // Rate limiter — prevent runaway reconnect loops
  const now = Date.now();
  if (now - _connectWindowAt > _CONNECT_WINDOW) {
    _connectCount    = 0;
    _connectWindowAt = now;
  }
  _connectCount++;
  if (_connectCount > _CONNECT_LIMIT) {
    const cooldown = 120000; // 2 minutes
    console.warn(`[Gateway] Rate limited — ${_connectCount} connections in ${_CONNECT_WINDOW / 1000}s. Cooling down for ${cooldown / 1000}s.`);
    setTimeout(() => { _connectCount = 0; _connect(resumeUrl); }, cooldown);
    return;
  }

  const url = resumeUrl || GATEWAY_URL;
  _ws = new WebSocket(url);

  _ws.addEventListener('open', () => {
    // Do NOT reset _reconnectDelay here — the connection isn't authenticated yet.
    // Backoff is only reset after a successful READY event (see _handleEvent).
    console.log('[Gateway] WebSocket open.');
  });

  _ws.addEventListener('message', (event) => {
    let payload;
    try { payload = JSON.parse(event.data); } catch { return; }
    _handlePayload(payload);
  });

  // Per-connection guard: reconnect exactly once for this socket, whether the
  // trigger is a `close` event or a raw `error` with no following `close`.
  let _handled = false;

  function _reconnect(code) {
    if (_handled) return;   // close + error both fired — only reconnect once
    _handled = true;
    _stopHeartbeat();

    // Non-resumable close codes
    const fatal = [4004, 4010, 4011, 4012, 4013, 4014];
    if (code != null && fatal.includes(code)) {
      console.error(`[Gateway] Fatal close code ${code} — not reconnecting.`);
      if (code === 4014) {
        console.error('[Gateway] 4014 = Disallowed Intents. Enable "Server Members" privileged intent in the Discord Developer Portal.');
      }
      if (code === 4004) {
        console.error('[Gateway] 4004 = Authentication Failed. The bot token is invalid or was reset — update DISCORD_BOT_TOKEN in .env and restart the server.');
      }
      return;
    }

    // Discord is rate-limiting our connection attempts — back way off (5 min + jitter) and do NOT resume.
    // Jitter (0–60s) prevents thundering-herd if multiple restarts hit 4008 simultaneously.
    if (code === 4008) {
      const jitter = Math.floor(Math.random() * 60000);
      const pause  = 300000 + jitter; // 5 min + up to 60s jitter
      console.warn(`[Gateway] 4008 Rate Limited by Discord — backing off ${(pause/1000).toFixed(0)}s before reconnecting. This means we connected too frequently. Not resuming.`);
      _sessionId  = null;
      _resumeUrl  = null;
      _reconnectDelay = 60000; // start the next cycle with a 60s floor
      setTimeout(() => _connect(), pause);
      return;
    }

    // Reconnect with backoff
    console.log(`[Gateway] Reconnecting in ${_reconnectDelay / 1000}s…`);
    setTimeout(() => {
      if (_sessionId && _resumeUrl) {
        _connect(_resumeUrl);
      } else {
        _connect();
      }
    }, _reconnectDelay);
    _reconnectDelay = Math.min(_reconnectDelay * 2, 60000);
  }

  _ws.addEventListener('close', (event) => {
    console.warn(`[Gateway] Closed: ${event.code} ${event.reason || ''}`);
    _reconnect(event.code);
  });

  _ws.addEventListener('error', (err) => {
    console.error('[Gateway] WebSocket error:', err.message || err);
    // A raw `error` is not always followed by a `close` event — a non-101
    // handshake failure can leave the socket dead with no close, so the close
    // handler never fires and nothing reschedules (observed 2026-07-17: the
    // Gateway sat disconnected until a manual restart). Fall back to a reconnect
    // if `close` hasn't already handled it within 1s. `_handled` prevents a
    // double reconnect when `close` does follow.
    setTimeout(() => {
      if (!_handled && _ws?.readyState !== WebSocket.OPEN) {
        console.warn('[Gateway] error with no close event — forcing reconnect.');
        _reconnect(null);
      }
    }, 1000);
  });
}

function _send(data) {
  if (_ws?.readyState === WebSocket.OPEN) {
    _ws.send(JSON.stringify(data));
  }
}

// ── Heartbeat ────────────────────────────────────────────────────────────────

function _startHeartbeat(intervalMs) {
  _stopHeartbeat();
  // First heartbeat after jitter
  const jitter = Math.random() * intervalMs;
  setTimeout(() => {
    _sendHeartbeat();
    _heartbeatTimer = setInterval(_sendHeartbeat, intervalMs);
  }, jitter);
}

function _stopHeartbeat() {
  if (_heartbeatTimer) clearInterval(_heartbeatTimer);
  _heartbeatTimer = null;
}

function _sendHeartbeat() {
  _alive = false;
  _send({ op: 1, d: _lastSeq });
  // If we don't get ACK within 30s, consider connection dead.
  // 30s (was 15s) gives more headroom during heavy async work (prewarm ~437s run)
  // without leaving truly dead connections open longer than Discord's 45s threshold.
  // IMPORTANT: capture _ws at the time this beat was sent. The close handler
  // may reconnect and replace _ws before the 30s fires — we must only close
  // the socket that missed *this* ACK, not a brand-new connection.
  const wsAtBeat = _ws;
  setTimeout(() => {
    if (!_alive && _ws === wsAtBeat && _ws?.readyState === WebSocket.OPEN) {
      console.warn('[Gateway] Missed heartbeat ACK — zombied, closing.');
      _ws.close(4009, 'Zombie connection');
    }
  }, 30000);
}

// ── Payload dispatcher ───────────────────────────────────────────────────────

function _handlePayload(payload) {
  const { op, t, s, d } = payload;

  if (s) _lastSeq = s;

  switch (op) {
    case 10: // Hello
      _startHeartbeat(d.heartbeat_interval);
      if (_sessionId) {
        // Resume
        _send({ op: 6, d: { token: _botToken, session_id: _sessionId, seq: _lastSeq } });
      } else {
        // Identify
        _send({
          op: 2,
          d: {
            token:      _botToken,
            intents:    INTENTS,
            properties: { os: 'darwin', browser: '3pi-bot', device: '3pi-bot' },
          },
        });
      }
      break;

    case 11: // Heartbeat ACK
      _alive = true;
      // Connection is confirmed stable — now safe to reset backoff
      if (_pendingBackoffReset) {
        _pendingBackoffReset = false;
        _reconnectDelay = 5000;
        console.log('[Gateway] Heartbeat ACK confirmed — connection stable, backoff reset.');
      }
      break;

    case 7:  // Reconnect requested
      console.log('[Gateway] Server requested reconnect.');
      _ws.close(4000, 'Reconnect requested');
      break;

    case 9:  // Invalid session
      console.warn('[Gateway] Invalid session — will re-identify on reconnect.');
      _sessionId = null;
      _resumeUrl = null;
      // Close the socket cleanly — the close handler will reconnect with backoff
      if (_ws?.readyState === WebSocket.OPEN) {
        _ws.close(4000, 'Invalid session');
      }
      break;

    case 0:  // Dispatch
      _handleEvent(t, d);
      break;
  }
}

// ── Event handlers ───────────────────────────────────────────────────────────

function _handleEvent(event, data) {
  switch (event) {
    case 'READY':
      _sessionId = data.session_id;
      _resumeUrl = data.resume_gateway_url;
      _botUserId = data.user?.id || null;
      // Do NOT reset _reconnectDelay here — wait for the first heartbeat ACK to
      // confirm the connection is truly stable before resetting backoff.
      // Resetting on READY caused a fast reconnect loop: READY → zombie after 15s
      // → reconnect in 5s (reset) → repeat until Discord rate-limited the token.
      _pendingBackoffReset = true;
      console.log(`[Gateway] Ready — session ${_sessionId}`);
      break;

    case 'RESUMED':
      console.log('[Gateway] Resumed successfully.');
      break;

    case 'GUILD_CREATE':
      // Fires on connect — gives us the role list so we can resolve roleName → roleId
      if (data.id === _guildId) {
        _resolveRole(data.roles || []);
        _resolveReactionRoles(data.roles || []);
        // Seed known roles for members included in GUILD_CREATE, then backfill
        // the full guild below. GUILD_CREATE usually only includes a partial
        // member set, so relying on it alone causes false "role added" events
        // after restarts.
        for (const member of (data.members || [])) {
          if (member.user?.id) {
            _memberRoles.set(member.user.id, new Set(member.roles || []));
          }
        }
        console.log(`[Gateway] Guild ready — ${_memberRoles.size} online members cached, role @${_roleName} = ${_roleId || '(not found)'}`);
        _seedMemberRoles()
          .then(count => console.log(`[Gateway] Full member-role cache seeded — ${count} members tracked.`))
          .catch(err => console.error('[Gateway] Failed to seed full member-role cache:', err.message));
      }
      break;

    case 'GUILD_MEMBER_UPDATE':
      if (data.guild_id === _guildId) _onMemberUpdate(data);
      break;

    case 'GUILD_MEMBER_ADD':
      if (data.guild_id === _guildId) _onMemberAdd(data);
      break;

    case 'GUILD_MEMBER_REMOVE':
      if (data.guild_id === _guildId) _onMemberRemove(data);
      break;

    case 'MESSAGE_REACTION_ADD':
      _onMessageReaction(data, true);
      break;

    case 'MESSAGE_REACTION_REMOVE':
      _onMessageReaction(data, false);
      break;
  }
}

function _resolveRole(roles) {
  const match = roles.find(r => r.name.toLowerCase() === _roleName);
  if (match) {
    _roleId = match.id;
  } else {
    console.warn(`[Gateway] Role @${_roleName} not found in guild roles. Available: ${roles.map(r => r.name).join(', ')}`);
  }
}

function _normalizeReactionRoles(reactionRoles) {
  return (Array.isArray(reactionRoles) ? reactionRoles : [])
    .filter(rr => rr && rr.channelId && rr.messageId && rr.emoji && (rr.roleId || rr.roleName))
    .map(rr => ({
      channelId: String(rr.channelId),
      messageId: String(rr.messageId),
      emoji: String(rr.emoji),
      roleName: rr.roleName ? String(rr.roleName).toLowerCase() : '',
      roleId: rr.roleId ? String(rr.roleId) : null,
      removeOnUnreact: rr.removeOnUnreact !== false,
    }));
}

function _resolveReactionRoles(roles) {
  for (const rr of _reactionRoles) {
    if (rr.roleId) continue;
    const match = roles.find(r => r.name.toLowerCase() === rr.roleName);
    if (match) rr.roleId = match.id;
  }
  for (const rr of _reactionRoles) {
    if (!rr.roleId) {
      console.warn(`[Gateway] Reaction role target @${rr.roleName || '(unnamed)'} not found for message ${rr.messageId}`);
    }
  }
}

function _reactionEmojiMatches(configEmoji, eventEmoji) {
  if (!eventEmoji) return false;
  if (eventEmoji.id && configEmoji === eventEmoji.id) return true;
  return configEmoji === eventEmoji.name;
}

function _matchingReactionRole(data) {
  if (data.guild_id !== _guildId) return null;
  return _reactionRoles.find(rr =>
    rr.channelId === data.channel_id &&
    rr.messageId === data.message_id &&
    rr.roleId &&
    _reactionEmojiMatches(rr.emoji, data.emoji)
  ) || null;
}

function _onMessageReaction(data, added) {
  const rr = _matchingReactionRole(data);
  if (!rr || !data.user_id || data.user_id === _botUserId) return;
  if (!added && !rr.removeOnUnreact) return;

  const method = added ? 'PUT' : 'DELETE';
  const action = added ? 'added' : 'removed';
  _apiRequest(method, `/guilds/${_guildId}/members/${data.user_id}/roles/${rr.roleId}`)
    .then(() => console.log(`[Gateway] Reaction role ${action}: ${rr.roleName || rr.roleId} for ${data.user_id}`))
    .catch(err => console.error(`[Gateway] Failed to ${added ? 'add' : 'remove'} reaction role ${rr.roleName || rr.roleId} for ${data.user_id}:`, err.message));
}

async function _seedMemberRoles() {
  if (!_botToken || !_guildId) return _memberRoles.size;

  let after = '0';
  let count = 0;
  for (let page = 0; page < 50; page++) {
    const members = await _apiRequest('GET', `/guilds/${_guildId}/members?limit=1000&after=${after}`);
    if (!Array.isArray(members) || members.length === 0) break;

    for (const member of members) {
      if (!member.user?.id) continue;
      _memberRoles.set(member.user.id, new Set(member.roles || []));
      after = member.user.id;
      count++;
    }

    if (members.length < 1000) break;
  }
  return count;
}

// ── Role change detection ────────────────────────────────────────────────────

function _onMemberAdd(data) {
  const userId = data.user?.id;
  if (!userId) return;
  _memberRoles.set(userId, new Set(data.roles || []));
}

function _onMemberUpdate(data) {
  if (!_roleId) return;

  const userId   = data.user?.id;
  const username = data.user?.username || data.nick || 'unknown';
  if (!userId) return;

  const newRoles = new Set(data.roles || []);
  const oldRoles = _memberRoles.get(userId);

  // Update our tracking
  _memberRoles.set(userId, newRoles);

  if (!oldRoles) {
    console.log(`[Gateway] Initialized role cache for ${username} (${userId}) from first update — no @${_roleName} action taken.`);
    return;
  }

  const hadRole = oldRoles.has(_roleId);
  const hasRole = newRoles.has(_roleId);

  if (!hadRole && hasRole) {
    // Role ADDED — DM instructions
    const clan = loadClanConfig();
    console.log(`[Gateway] @${_roleName} role added to ${username} (${userId}) — sending DM.`);
    _dmUser(userId, [
      `Welcome to **${clan.clan.name}**, ${data.nick || username}! ${clan.clan.emoji}`,
      '',
      `To get your PUBG stats tracked on the ${clan.clan.memberNoun} performance dashboard, **type \`/register\`** in any channel — Discord will prompt you for your PUBG name. Make sure it matches your PUBG account exactly (case-sensitive).`,
      '',
      '⚠️ Type the slash command yourself rather than copy-pasting it — pasted text just sends as a plain message and won\'t trigger the bot.',
      '',
      `Once registered, your stats will appear on the leaderboard within a couple hours at **<${clan.site.publicUrl}>** — leaderboards, weapon breakdowns, squad chemistry, landing heatmaps, and more.`,
    ].join('\n'));
  }

  if (hadRole && !hasRole) {
    // Role REMOVED — remove from members.json
    console.log(`[Gateway] @${_roleName} role removed from ${username} (${userId}) — removing from tracker.`);
    _removeMemberByDiscordId(userId, username, 'role removed');
  }
}

function _onMemberRemove(data) {
  const userId   = data.user?.id;
  const username = data.user?.username || 'unknown';
  if (!userId) return;

  // Clean up tracking
  _memberRoles.delete(userId);

  // Remove from members.json if they had a discordId mapping
  console.log(`[Gateway] ${username} (${userId}) left the server — checking tracker.`);
  _removeMemberByDiscordId(userId, username, 'left server');
}

// ── Members file operations ──────────────────────────────────────────────────

function _loadMembers() {
  try { return JSON.parse(fs.readFileSync(_membersFile, 'utf8')); } catch { return []; }
}

function _saveMembers(members) {
  fs.writeFileSync(_membersFile, JSON.stringify(members, null, 2));
}

const GRACE_PERIOD_DAYS = loadClanConfig().discord.gracePeriodDays;

function _removeMemberByDiscordId(discordId, displayName, reason) {
  const members = _loadMembers();
  const idx = members.findIndex(m => m.discordId === discordId);
  if (idx === -1) {
    console.log(`[Gateway] ${displayName} not in members.json (no discordId match) — nothing to remove.`);
    return;
  }

  // Soft-delete: mark with removedAt instead of immediately splicing.
  // The daily pipeline will hard-delete after GRACE_PERIOD_DAYS.
  const member = members[idx];
  if (member.removedAt) {
    console.log(`[Gateway] ${member.name} already marked for removal (${member.removedAt}) — skipping.`);
    return;
  }
  member.removedAt = new Date().toISOString();
  member.removedReason = reason;
  _saveMembers(members);
  console.log(`[Gateway] Soft-removed ${member.name} (${reason}) — grace period: ${GRACE_PERIOD_DAYS} days before hard delete.`);

  // Notify via webhook
  if (_webhookUrl) {
    _postWebhook(`⏳ **${member.name}** departed (${reason}) — stats kept for ${GRACE_PERIOD_DAYS} days before removal from the ${loadClanConfig().clan.tag} tracker.`);
  }
}

// ── Discord REST helpers ─────────────────────────────────────────────────────

function _dmUser(userId, content) {
  // Step 1: Create DM channel, Step 2: Send message
  _apiRequest('POST', '/users/@me/channels', { recipient_id: userId })
    .then(channel => {
      if (!channel?.id) throw new Error('No DM channel returned');
      return _apiRequest('POST', `/channels/${channel.id}/messages`, { content });
    })
    .then(() => console.log(`[Gateway] DM sent to ${userId}`))
    .catch(err => console.error(`[Gateway] Failed to DM ${userId}:`, err.message));
}

function _postWebhook(content) {
  if (!_webhookUrl) return;
  postWebhook(_webhookUrl, { content })
    .catch(e => console.error('[Gateway] Webhook error:', e.message));
}

function _apiRequest(method, endpoint, body) {
  return discordApiRequest({
    token: _botToken,
    endpoint,
    method,
    body,
  }).then(result => result.json);
}

module.exports = { startGateway, gatewayState };
