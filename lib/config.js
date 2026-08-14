'use strict';
// ── lib/config.js — path roots, env loader, path traversal guard ─────────────
// Zero app-level imports. Only Node builtins.

const fs   = require('fs');
const path = require('path');

// ── Path roots ────────────────────────────────────────────────────────────────
const BASE = path.dirname(__dirname);
const DATA = path.join(BASE, 'data');
const DEFAULT_PORT = 3002;

// ── .env loader ───────────────────────────────────────────────────────────────
const ENV_TTL = 60000;
let _envCache   = null;
let _envCacheAt = 0;

function loadEnv() {
  if (_envCache && (Date.now() - _envCacheAt) < ENV_TTL) return _envCache;
  const envPath = path.join(BASE, '.env');
  if (!fs.existsSync(envPath)) return {};
  const env = {};
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const idx = trimmed.indexOf('=');
    if (idx < 0) return;
    const key = trimmed.slice(0, idx).trim();
    const val = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
    env[key] = val;
  });
  _envCache   = env;
  _envCacheAt = Date.now();
  return env;
}

function _parsePort(value) {
  if (value == null || String(value).trim() === '') return null;
  const n = parseInt(String(value).trim(), 10);
  return Number.isFinite(n) && n > 0 && n <= 65535 ? n : null;
}

// ── Path traversal guard ──────────────────────────────────────────────────────
function resolveInside(baseDir, ...parts) {
  const resolved = path.resolve(baseDir, ...parts);
  if (resolved === baseDir) return resolved;
  return resolved.startsWith(baseDir + path.sep) ? resolved : null;
}

// ── Clan config — single source of truth for clan-specific values ─────────────
// Non-secret, version-controlled. Lives in config/clan.config.json.
// See config/README.md for field docs. Secrets stay in .env, never here.
const CLAN_CONFIG_PATH = path.join(BASE, 'config', 'clan.config.json');

function _readClanConfigFile() {
  try {
    return JSON.parse(fs.readFileSync(CLAN_CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function _resolvePort() {
  const env = loadEnv();
  const fromEnv = _parsePort(process.env.PUBG_PORT || env.PUBG_PORT);
  if (fromEnv) return fromEnv;
  const fromConfig = _parsePort(_readClanConfigFile()?.site?.port);
  return fromConfig || DEFAULT_PORT;
}

const PORT = _resolvePort();

// Defaults so the app degrades gracefully if a field (or the whole file) is missing.
const CLAN_DEFAULTS = {
  clan: {
    name: 'Clan', shortName: 'Clan', tag: 'CLAN', emoji: '🎮',
    memberNoun: 'member', memberNounPlural: 'members', subtitle: '',
    restrictedLabel: '', bootTitle: 'Loading…', bootBody: '',
  },
  site: { publicUrl: '', port: PORT },
  discord: {
    guildId: '', membershipRole: 'Memo', adminUserIds: [],
    gracePeriodDays: 14, botUserAgent: 'ClanBot/1.0',
    reactionRoles: [],
    pinnedInfo: { channelName: '', channelId: '', messageId: '' },
  },
};

let _clanCache   = null;
let _clanCacheAt = 0;
const CLAN_TTL   = 60000;

function _deepMerge(base, over) {
  const clone = (value) => {
    if (Array.isArray(value)) return value.map(clone);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clone(v)]));
    }
    return value;
  };
  const out = Array.isArray(base) ? base.map(clone) : clone(base);
  for (const k of Object.keys(over || {})) {
    if (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k]) &&
        base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = _deepMerge(base[k], over[k]);
    } else if (over[k] !== undefined) {
      out[k] = clone(over[k]);
    }
  }
  return out;
}

function _firstNonEmpty(...values) {
  for (const v of values) {
    if (v != null && String(v).trim() !== '') return v;
  }
  return null;
}

// Validate required fields; returns array of human-readable problem strings.
function validateClanConfig(cfg) {
  const problems = [];
  const req = [
    ['clan.name', cfg.clan?.name],
    ['clan.shortName', cfg.clan?.shortName],
    ['clan.tag', cfg.clan?.tag],
    ['site.publicUrl', cfg.site?.publicUrl],
    ['discord.guildId', cfg.discord?.guildId],
    ['discord.membershipRole', cfg.discord?.membershipRole],
  ];
  for (const [name, val] of req) {
    if (!val || String(val).trim() === '') problems.push(`missing required field: ${name}`);
  }
  if (cfg.site?.publicUrl && /localhost|127\.0\.0\.1/.test(cfg.site.publicUrl)) {
    problems.push('site.publicUrl points at localhost — this leaks into public Discord posts');
  }
  if (!_parsePort(cfg.site?.port)) {
    problems.push('site.port must be a number between 1 and 65535');
  }
  if (cfg.discord && !Array.isArray(cfg.discord.adminUserIds)) {
    problems.push('discord.adminUserIds must be an array');
  }
  if (cfg.discord?.reactionRoles && !Array.isArray(cfg.discord.reactionRoles)) {
    problems.push('discord.reactionRoles must be an array');
  }
  return problems;
}

// Load + validate clan config, layering in optional non-secret env overrides.
function loadClanConfig() {
  if (_clanCache && (Date.now() - _clanCacheAt) < CLAN_TTL) return _clanCache;

  let fileCfg = {};
  try {
    fileCfg = JSON.parse(fs.readFileSync(CLAN_CONFIG_PATH, 'utf8'));
  } catch (e) {
    console.error(`[config] Could not read ${path.relative(BASE, CLAN_CONFIG_PATH)} (${e.message}) — falling back to defaults.`);
  }

  let cfg = _deepMerge(CLAN_DEFAULTS, fileCfg);

  // Optional env overrides (non-secret) — env wins if present.
  const env = loadEnv();
  cfg.site.port = PORT;
  const guildOverride = _firstNonEmpty(process.env.DISCORD_GUILD_ID, env.DISCORD_GUILD_ID);
  const roleOverride = _firstNonEmpty(process.env.DISCORD_CLAN_ROLE, env.DISCORD_CLAN_ROLE);
  const adminOverride = _firstNonEmpty(process.env.CLAN_ADMIN_DISCORD_IDS, env.CLAN_ADMIN_DISCORD_IDS);
  if (guildOverride) cfg.discord.guildId = guildOverride;
  if (roleOverride) cfg.discord.membershipRole = roleOverride;
  if (adminOverride) {
    cfg.discord.adminUserIds = String(adminOverride).split(',').map(s => s.trim()).filter(Boolean);
  }

  const problems = validateClanConfig(cfg);
  if (problems.length) {
    console.error('[config] clan.config.json problems:\n  - ' + problems.join('\n  - '));
  }

  _clanCache   = cfg;
  _clanCacheAt = Date.now();
  return cfg;
}

// Non-secret subset safe to inject into the browser (window.__CLAN_CONFIG__).
function frontendClanConfig() {
  const c = loadClanConfig();
  return {
    name:             c.clan.name,
    shortName:        c.clan.shortName,
    tag:              c.clan.tag,
    emoji:            c.clan.emoji,
    memberNoun:       c.clan.memberNoun,
    memberNounPlural: c.clan.memberNounPlural,
    subtitle:         c.clan.subtitle,
    restrictedLabel:  c.clan.restrictedLabel,
    bootTitle:        c.clan.bootTitle,
    bootBody:         c.clan.bootBody,
    publicUrl:        c.site.publicUrl,
  };
}

module.exports = {
  PORT, BASE, DATA, loadEnv, resolveInside,
  loadClanConfig, frontendClanConfig, validateClanConfig,
};
