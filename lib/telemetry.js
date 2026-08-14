'use strict';
// ── lib/telemetry.js — shared telemetry fetch/cache for match asset URLs ──────
// Persists decompressed telemetry JSON per match so multiple jobs can reuse one
// download, and uses a lightweight lock file to avoid duplicate concurrent fetches.

const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');
const { DATA } = require('./config');

const CACHE_DIR = path.join(DATA, 'telemetry_cache');
const LOCK_WAIT_MS = 30000;
const LOCK_POLL_MS = 250;
const RETRY_DELAY_MS = 2000;
const DEFAULT_TIMEOUT_MS = 30000;
// A lock file older than this is assumed to be orphaned (the owning process
// died without releasing). 5× the longest legitimate hold (DEFAULT_TIMEOUT_MS
// + retries × RETRY_DELAY_MS ≈ 35s, plus comfortable margin).
const STALE_LOCK_AGE_MS = 5 * 60 * 1000; // 5 minutes

try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch {}

// Sweep abandoned lock files at module load. Without this, a daily_clan.js
// run that gets killed mid-heatmap leaves *.lock files behind, and the next
// run loops forever in waitForExistingDownload because the lock owner is
// dead but the file is still on disk. Bounded by file mtime age.
function cleanStaleLocks() {
  let removed = 0;
  try {
    const now = Date.now();
    for (const name of fs.readdirSync(CACHE_DIR)) {
      if (!name.endsWith('.lock')) continue;
      const full = path.join(CACHE_DIR, name);
      try {
        const stat = fs.statSync(full);
        if (now - stat.mtimeMs > STALE_LOCK_AGE_MS) {
          fs.unlinkSync(full);
          removed++;
        }
      } catch {}
    }
  } catch {}
  return removed;
}
cleanStaleLocks();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function cachePath(matchId) {
  return path.join(CACHE_DIR, `${matchId}.json.gz`);
}

function lockPath(matchId) {
  return path.join(CACHE_DIR, `${matchId}.lock`);
}

function readCachedTelemetry(matchId) {
  const gz = cachePath(matchId);
  if (fs.existsSync(gz)) {
    return JSON.parse(zlib.gunzipSync(fs.readFileSync(gz)).toString('utf8'));
  }
  // Fallback: legacy uncompressed file (present during/before migration)
  const plain = path.join(CACHE_DIR, `${matchId}.json`);
  if (fs.existsSync(plain)) return JSON.parse(fs.readFileSync(plain, 'utf8'));
  return null;
}

function writeCachedTelemetry(matchId, events) {
  const file = cachePath(matchId);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, zlib.gzipSync(JSON.stringify(events)));
  fs.renameSync(tmp, file);
}

function acquireLock(matchId) {
  const file = lockPath(matchId);
  try {
    const fd = fs.openSync(file, 'wx');
    fs.writeFileSync(fd, String(process.pid));
    return {
      release() {
        try { fs.closeSync(fd); } catch {}
        try { fs.unlinkSync(file); } catch {}
      },
    };
  } catch (e) {
    if (e.code === 'EEXIST') return null;
    throw e;
  }
}

async function waitForExistingDownload(matchId) {
  const file = cachePath(matchId);
  const lockFile = lockPath(matchId);
  const startedAt = Date.now();
  while (Date.now() - startedAt < LOCK_WAIT_MS) {
    if (readCachedTelemetry(matchId) !== null) return readCachedTelemetry(matchId);
    if (!fs.existsSync(lockFile)) break;
    // Lock present — but if its mtime is older than STALE_LOCK_AGE_MS the
    // owning process is gone. Remove it so the caller can take a fresh lock.
    try {
      const stat = fs.statSync(lockFile);
      if (Date.now() - stat.mtimeMs > STALE_LOCK_AGE_MS) {
        try { fs.unlinkSync(lockFile); } catch {}
        break;
      }
    } catch {}
    await sleep(LOCK_POLL_MS);
  }
  return null;
}

function fetchTelemetryJson(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'Accept-Encoding': 'gzip, deflate' } }, res => {
      if (res.statusCode >= 400) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }

      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const encoding = res.headers['content-encoding'];
        const inflate = encoding === 'gzip' ? zlib.gunzip
          : encoding === 'deflate' ? zlib.inflate
          : null;

        const finish = raw => {
          const text = raw.toString('utf8');
          if (text.trimStart().startsWith('<')) {
            return reject(new Error(`CDN returned XML (telemetry expired?) for ${url}`));
          }
          try { resolve(JSON.parse(text)); }
          catch (e) { reject(new Error(`JSON parse failed for ${url}: ${e.message}`)); }
        };

        if (!inflate) return finish(buf);
        inflate(buf, (err, raw) => finish(err ? buf : raw));
      });
    });

    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error(`Timeout fetching ${url}`));
    });
  });
}

async function getTelemetry(matchId, url, opts = {}) {
  const retries = opts.retries ?? 2;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // Bound contention recursion: at most a few self-calls when the lock keeps
  // being held by another worker. Without this, a stuck lock used to spin
  // here forever (and produced the heatmap hang seen on 2026-05-09).
  const lockAttempts = opts._lockAttempts ?? 0;
  if (lockAttempts >= 3) {
    throw new Error(`Lock contention on ${matchId} after ${lockAttempts} attempts`);
  }

  const cached = readCachedTelemetry(matchId);
  if (cached) return cached;

  const existing = await waitForExistingDownload(matchId);
  if (existing) return existing;

  const lock = acquireLock(matchId);
  if (!lock) {
    const raced = await waitForExistingDownload(matchId);
    if (raced) return raced;
    return getTelemetry(matchId, url, { ...opts, _lockAttempts: lockAttempts + 1 });
  }

  try {
    let lastErr = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const events = await fetchTelemetryJson(url, timeoutMs);
        writeCachedTelemetry(matchId, events);
        return events;
      } catch (e) {
        lastErr = e;
        if (attempt < retries) await sleep(RETRY_DELAY_MS);
      }
    }
    throw lastErr || new Error(`Telemetry fetch failed for ${matchId}`);
  } finally {
    lock.release();
  }
}

module.exports = { CACHE_DIR, getTelemetry, readCachedTelemetry, cleanStaleLocks };
