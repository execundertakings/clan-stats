'use strict';
// ── lib/config.js — path roots, env loader, path traversal guard ─────────────
// Zero app-level imports. Only Node builtins.

const fs   = require('fs');
const path = require('path');

// ── Path roots ────────────────────────────────────────────────────────────────
const BASE = path.dirname(__dirname);
const DATA = path.join(BASE, 'data');
const PORT = process.env.PUBG_PORT ? parseInt(process.env.PUBG_PORT) : 3002;

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

// ── Path traversal guard ──────────────────────────────────────────────────────
function resolveInside(baseDir, ...parts) {
  const resolved = path.resolve(baseDir, ...parts);
  if (resolved === baseDir) return resolved;
  return resolved.startsWith(baseDir + path.sep) ? resolved : null;
}

module.exports = { PORT, BASE, DATA, loadEnv, resolveInside };
