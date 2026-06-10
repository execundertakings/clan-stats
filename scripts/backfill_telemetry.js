#!/usr/bin/env node
'use strict';
// ── scripts/backfill_telemetry.js ─────────────────────────────────────────────
// Fetches telemetry for current-season counting matches that are cached in
// data/match_cache/ but have no file in data/telemetry_cache/. Telemetry
// coverage gaps (74% observed 2026-06-10) silently undercount the telemetry-
// derived branch (revives, heals, longest kill, landing spots) — this step
// converges coverage toward 100% at a bounded N fetches per daily run.
//
// Telemetry comes from the PUBG CDN (asset URL inside the cached match JSON),
// which is NOT subject to the 10 RPM API limit. Matches whose asset URL has
// expired 404 forever — after MAX_FAILURES attempts a matchId is skipped for
// good (state in data/telemetry_backfill_state.json).

const fs   = require('fs');
const path = require('path');
const { getMatchFilterDecision } = require('../lib/match-filters');
const { isCurrentSeasonMatch }   = require('../lib/season-state');
const { CACHE_DIR, getTelemetry } = require('../lib/telemetry');

const ROOT       = path.join(__dirname, '..');
const DATA       = path.join(ROOT, 'data');
const MATCH_DIR  = path.join(DATA, 'match_cache');
const STATE_FILE = path.join(DATA, 'telemetry_backfill_state.json');

const DEFAULT_LIMIT = 40;  // max fetches per run
const MAX_FAILURES  = 3;   // permanent skip after this many failed attempts

function readJsonSafe(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function telemetryExists(matchId) {
  return fs.existsSync(path.join(CACHE_DIR, `${matchId}.json.gz`)) ||
         fs.existsSync(path.join(CACHE_DIR, `${matchId}.json`));
}

async function backfillTelemetry(opts = {}) {
  const verbose = opts.verbose ?? true;
  const limit   = opts.limit ?? DEFAULT_LIMIT;

  const season = readJsonSafe(path.join(DATA, 'season.json'), {});
  const seasonStartAt = season.seasonStartAt || null;
  const state = readJsonSafe(STATE_FILE, { failures: {} });

  // Collect current-season counting matches missing telemetry
  const missing = [];
  let eligible = 0;
  for (const file of fs.readdirSync(MATCH_DIR)) {
    if (!file.endsWith('.json')) continue;
    let raw;
    try { raw = JSON.parse(fs.readFileSync(path.join(MATCH_DIR, file), 'utf8')); } catch { continue; }
    const attr = raw.data?.attributes || {};
    if (!getMatchFilterDecision(attr).counts) continue;
    if (!isCurrentSeasonMatch(attr.createdAt, seasonStartAt)) continue;
    eligible++;

    const matchId = raw.data?.id || file.replace('.json', '');
    if (telemetryExists(matchId)) continue;
    if ((state.failures[matchId] || 0) >= MAX_FAILURES) continue;

    const url = (raw.included || []).find(i => i.type === 'asset')?.attributes?.URL;
    if (!url) { state.failures[matchId] = MAX_FAILURES; continue; } // no asset → never fetchable
    missing.push({ matchId, url, createdAt: attr.createdAt });
  }

  // Newest first — recent matches are most likely to still have live CDN URLs
  // and matter most for current-season telemetry stats.
  missing.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const batch = missing.slice(0, limit);

  let fetched = 0, failed = 0;
  for (const m of batch) {
    try {
      await getTelemetry(m.matchId, m.url);
      delete state.failures[m.matchId];
      fetched++;
      if (verbose) console.log(`  [backfill] ✓ ${m.matchId}`);
    } catch (e) {
      // 403/404 = CDN URL expired — permanent, skip immediately instead of
      // burning two more runs' attempts on it.
      const permanent = /HTTP 40[34]\b/.test(e.message);
      state.failures[m.matchId] = permanent ? MAX_FAILURES : (state.failures[m.matchId] || 0) + 1;
      failed++;
      if (verbose) console.warn(`  [backfill] ✗ ${m.matchId} (${permanent ? 'expired — permanent skip' : `attempt ${state.failures[m.matchId]}/${MAX_FAILURES}`}): ${e.message}`);
    }
  }

  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch {}

  const covered = eligible - missing.length + fetched;
  return {
    eligible,
    missingBefore: missing.length,
    attempted: batch.length,
    fetched,
    failed,
    coverage: eligible ? +(covered / eligible).toFixed(3) : 1,
  };
}

module.exports = { backfillTelemetry };

if (require.main === module) {
  const limit = +(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] || DEFAULT_LIMIT);
  backfillTelemetry({ verbose: true, limit }).then(r => {
    console.log(`[backfill] ${r.fetched} fetched · ${r.failed} failed · ${r.missingBefore} were missing of ${r.eligible} eligible · coverage now ~${(r.coverage * 100).toFixed(1)}%`);
  }).catch(e => { console.error('[backfill] Fatal:', e.message); process.exit(1); });
}
