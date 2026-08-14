'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const MATCH_CACHE_DIR = path.join(DATA_DIR, 'match_cache');
const TELEMETRY_CACHE_DIR = path.join(DATA_DIR, 'telemetry_cache');

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function labelFor(dir) {
  return path.relative(ROOT, dir) || path.basename(dir);
}

function ensureDir(dir, label = labelFor(dir)) {
  // Retry up to 3 times (6s total) for transient symlink inaccessibility.
  // APFS snapshots (Time Machine) can briefly make symlink targets unreachable.
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const lst = fs.lstatSync(dir);
      if (lst.isSymbolicLink() && !fs.existsSync(dir)) {
        if (attempt < 3) {
          // Brief wait — give the volume time to stabilize.
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);
          continue;
        }
        throw new Error(`${label} storage is unavailable; reconnect the external storage volume or restore the cache target.`);
      }
      if (fs.existsSync(dir) && !fs.statSync(dir).isDirectory()) {
        throw new Error(`${label} exists but is not a directory.`);
      }
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
}

function ensureDataDirectories() {
  ensureDir(DATA_DIR, 'data/');
  ensureDir(MATCH_CACHE_DIR, 'data/match_cache');
  ensureDir(TELEMETRY_CACHE_DIR, 'data/telemetry_cache');
}

function ensureMatchCacheDir() {
  ensureDir(DATA_DIR, 'data/');
  return ensureDir(MATCH_CACHE_DIR, 'data/match_cache');
}

function listMatchCacheFiles({ jsonOnly = true } = {}) {
  const dir = ensureMatchCacheDir();
  const files = fs.readdirSync(dir);
  return jsonOnly ? files.filter(file => file.endsWith('.json')) : files;
}

function sanitizeForDiscord(value) {
  let text = String(value ?? '');
  const replacements = [
    [ROOT, '<project>'],
    [DATA_DIR, '<data>'],
    [os.homedir(), '~'],
  ].filter(([from]) => from);

  for (const [link, label] of [
    [MATCH_CACHE_DIR, '<data>/match_cache'],
    [TELEMETRY_CACHE_DIR, '<data>/telemetry_cache'],
  ]) {
    try {
      if (fs.lstatSync(link).isSymbolicLink()) {
        const target = fs.readlinkSync(link);
        if (target) replacements.push([target, label]);
      }
    } catch {}
  }

  replacements.sort((a, b) => b[0].length - a[0].length);
  for (const [from, to] of replacements) {
    text = text.replace(new RegExp(escapeRegExp(from), 'g'), to);
  }

  return text
    .replace(/'\/(?:Users|Volumes|private|var|tmp)\/[^']*'/g, "'[local path]'")
    .replace(/"\/(?:Users|Volumes|private|var|tmp)\/[^"]*"/g, '"[local path]"')
    .replace(/\/(?:Users|Volumes|private|var|tmp)\/[^\s)\]}]+/g, '[local path]');
}

module.exports = {
  ROOT,
  DATA_DIR,
  MATCH_CACHE_DIR,
  TELEMETRY_CACHE_DIR,
  ensureDataDirectories,
  ensureMatchCacheDir,
  listMatchCacheFiles,
  sanitizeForDiscord,
};
