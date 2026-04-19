#!/usr/bin/env node
'use strict';
// ── scripts/register-commands.js — Register APES Discord slash commands ───────
// Run this once (or whenever you add/change commands):
//   node scripts/register-commands.js
//
// Required .env vars:
//   DISCORD_APP_ID     — from Discord Developer Portal → General Information
//   DISCORD_BOT_TOKEN  — from Discord Developer Portal → Bot → Token
//
// Registers GLOBALLY (takes ~1 hour to propagate) or to a single guild (instant).
// To register to a specific guild only, set DISCORD_GUILD_ID in .env.

const https  = require('https');
const path   = require('path');
const { loadEnv } = require('../lib/config');

const env = loadEnv();
const APP_ID    = env.DISCORD_APP_ID;
const BOT_TOKEN = env.DISCORD_BOT_TOKEN;
const GUILD_ID  = env.DISCORD_GUILD_ID; // optional: set for instant guild-scoped registration

if (!APP_ID || !BOT_TOKEN) {
  console.error('❌  DISCORD_APP_ID and DISCORD_BOT_TOKEN must be set in .env');
  process.exit(1);
}

const COMMANDS = [
  {
    name:        'stats',
    description: 'Show PUBG stats for a clan member (or the whole leaderboard if no player given)',
    options: [
      {
        type:         3,    // STRING
        name:         'player',
        description:  'Clan member username (leave blank for full leaderboard)',
        required:     false,
        autocomplete: true,
      },
    ],
  },
  {
    name:        'roster',
    description: 'List all current APES clan members',
  },
  {
    name:        'leaderboard',
    description: 'Show the APES season leaderboard (K/D, kills, wins)',
  },
  {
    name:        'help',
    description: 'Show all available APES bot commands',
  },
  {
    name:        'anal',
    description: 'Show AI analysis and improvement tip for a clan member',
    options: [
      {
        type:         3,    // STRING
        name:         'player',
        description:  'Clan member username',
        required:     true,
        autocomplete: true,
      },
    ],
  },
];

function registerCommands(commands) {
  const body    = JSON.stringify(commands);
  // Guild-specific (instant) or global (1h propagation)
  const apiPath = GUILD_ID
    ? `/api/v10/applications/${APP_ID}/guilds/${GUILD_ID}/commands`
    : `/api/v10/applications/${APP_ID}/commands`;

  console.log(GUILD_ID
    ? `🚀 Registering to guild ${GUILD_ID} (instant)…`
    : '🌐 Registering globally (may take ~1h to propagate)…'
  );

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'discord.com',
      path:     apiPath,
      method:   'PUT',   // PUT replaces all commands atomically
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Authorization':  `Bot ${BOT_TOKEN}`,
        'User-Agent':     'APES-ClanBot/1.0',
      },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          const registered = JSON.parse(d);
          console.log(`✅  Registered ${registered.length} command(s):`);
          registered.forEach(c => console.log(`   /${c.name} — ${c.description}`));
          resolve(registered);
        } else {
          reject(new Error(`Discord API ${res.statusCode}: ${d.slice(0, 500)}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(15_000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(body);
    req.end();
  });
}

registerCommands(COMMANDS)
  .then(() => {
    console.log('\nDone! Next step: make sure your Interactions Endpoint URL is set in the Discord');
    console.log('Developer Portal → your app → General Information → Interactions Endpoint URL');
    const tunnel = env.CLOUDFLARE_TUNNEL_URL || '<your-cloudflare-tunnel-url>';
    console.log(`\nSet it to: ${tunnel}/interactions`);
  })
  .catch(e => {
    console.error('❌  Registration failed:', e.message);
    process.exit(1);
  });
