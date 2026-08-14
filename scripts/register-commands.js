#!/usr/bin/env node
'use strict';
// ── scripts/register-commands.js — Register clan Discord slash commands ───────
// Run this once (or whenever you add/change commands):
//   node scripts/register-commands.js
//
// Required .env vars:
//   DISCORD_APP_ID     — from Discord Developer Portal → General Information
//   DISCORD_BOT_TOKEN  — from Discord Developer Portal → Bot → Token
//
// Registers to the configured guild (instant). To intentionally register global
// commands (~1 hour propagation), leave discord.guildId empty and pass --global.

const { loadEnv, loadClanConfig } = require('../lib/config');
const { discordApiRequest } = require('../lib/discord');

const env = loadEnv();
const APP_ID    = env.DISCORD_APP_ID;
const BOT_TOKEN = env.DISCORD_BOT_TOKEN;
// Guild ID comes from config/clan.config.json (single source). Guild-scoped
// registration is instant; leave guildId empty in config for global (~1h) registration.
const GUILD_ID  = loadClanConfig().discord.guildId;
const _RC = loadClanConfig().clan; // clan branding for command descriptions

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
    description: `List all current ${_RC.name} ${_RC.memberNounPlural}`,
  },
  {
    name:        'leaderboard',
    description: `Show the ${_RC.shortName} season leaderboard (K/D, kills, wins)`,
  },
  {
    name:        'help',
    description: `Show all available ${_RC.shortName} bot commands`,
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
  {
    name:        'register',
    description: `Register your PUBG account to get your stats tracked on the ${_RC.shortName} leaderboard`,
    options: [
      {
        type:         3,    // STRING
        name:         'pubg_name',
        description:  'Your exact PUBG username (case-sensitive)',
        required:     true,
      },
    ],
  },
  {
    name:        'glaze',
    description: "Show today's glaze — an over-the-top celebration of one clan member's best stats",
  },
  {
    name:        'roast',
    description: "Show today's roast — a ruthless, data-backed dragging of a clan member's worst stats",
  },
  {
    name:        'bugreport',
    description: 'Report something you noticed wrong on the stats page or in the Discord bot',
    options: [
      {
        type:        3,    // STRING
        name:        'text',
        description: 'What went wrong / what you noticed (10–2000 characters)',
        required:    true,
        min_length:  10,
        max_length:  2000,
      },
    ],
  },
  {
    name:        'bugreports',
    description: 'List the bug reports you have submitted and their current status',
  },
];

const ALLOW_GLOBAL = process.argv.includes('--global');

function registerCommands(commands, { allowGlobal = ALLOW_GLOBAL } = {}) {
  if (!GUILD_ID && !allowGlobal) {
    throw new Error('discord.guildId is empty. Refusing global registration unless --global is passed explicitly.');
  }

  // Guild-specific (instant) or global (1h propagation)
  const endpoint = GUILD_ID
    ? `/applications/${APP_ID}/guilds/${GUILD_ID}/commands`
    : `/applications/${APP_ID}/commands`;

  console.log(GUILD_ID
    ? `🚀 Registering to guild ${GUILD_ID} (instant)…`
    : '🌐 Registering globally (may take ~1h to propagate)…'
  );

  return discordApiRequest({
    token: BOT_TOKEN,
    endpoint,
    method: 'PUT',
    body: commands,
  }).then(result => {
    const registered = result.json || [];
    console.log(`✅  Registered ${registered.length} command(s):`);
    registered.forEach(c => console.log(`   /${c.name} — ${c.description}`));
    return registered;
  });
}

if (require.main === module) {
  registerCommands(COMMANDS)
    .then(() => {
      console.log('\nDone! Next step: make sure your Interactions Endpoint URL is set in the Discord');
      console.log('Developer Portal → your app → General Information → Interactions Endpoint URL');
      const tunnel = loadClanConfig().site.publicUrl || env.CLOUDFLARE_TUNNEL_URL || '<your-cloudflare-tunnel-url>';
      console.log(`\nSet it to: ${tunnel}/interactions`);
    })
    .catch(e => {
      console.error('❌  Registration failed:', e.message);
      process.exit(1);
    });
}

module.exports = {
  COMMANDS,
  registerCommands,
};
