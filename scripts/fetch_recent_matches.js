#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { getPlayer, getPlayerFresh, getMatch, shouldPersistMatch } = require('../lib/pubg');
const { listMatchCacheFiles } = require('./cache_paths');

const DATA = path.join(__dirname, '..', 'data');
const MEMBERS_FILE = path.join(DATA, 'members.json');
const MATCH_DIR = path.join(DATA, 'match_cache');
// Matches we fetched once but intentionally never cache to disk (e.g.
// trainingroom — see lib/pubg.js NEVER_PERSIST_MATCH_TYPES). Without this
// list they'd look "missing" and be re-fetched on every run, wasting the
// 10 RPM API budget for as long as they sit in a player's recent-match list.
const SKIPPED_FILE = path.join(DATA, 'skipped_matches.json');

function loadMembers() {
  try {
    return JSON.parse(fs.readFileSync(MEMBERS_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function loadSkipped() {
  try {
    const parsed = JSON.parse(fs.readFileSync(SKIPPED_FILE, 'utf8'));
    return new Set(parsed.matchIds || []);
  } catch {
    return new Set();
  }
}

function saveSkipped(skipped) {
  try {
    fs.writeFileSync(SKIPPED_FILE, JSON.stringify({
      note: 'Match IDs fetched but never persisted to match_cache (non-counting types like trainingroom). Kept so they are not re-fetched every run.',
      updatedAt: new Date().toISOString(),
      matchIds: [...skipped].sort(),
    }, null, 2));
  } catch {}
}

async function fetchRecentMatches({ verbose = true } = {}) {
  const members = loadMembers();
  if (!members.length) throw new Error('No members found in members.json');

  const existing = new Set(
    listMatchCacheFiles()
      .map(file => file.replace(/\.json$/, ''))
  );

  const allRefs = new Set();
  let playersRead = 0;

  for (const member of members) {
    try {
      const player = await getPlayerFresh(member.accountId).catch(() => getPlayer(member.accountId));
      for (const ref of player?.data?.relationships?.matches?.data || []) {
        if (ref?.id) allRefs.add(ref.id);
      }
      playersRead++;
    } catch (e) {
      if (verbose) console.warn(`[matches] Could not read ${member.name}: ${e.message}`);
    }
  }

  const skipped = loadSkipped();
  const missing = [...allRefs].filter(matchId => !existing.has(matchId) && !skipped.has(matchId));

  if (verbose) {
    console.log(`[matches] ${playersRead}/${members.length} player objects scanned`);
    console.log(`[matches] ${allRefs.size} unique recent match refs · ${existing.size} cached · ${skipped.size} skip-listed · ${missing.length} missing`);
  }

  let fetched = 0;
  let errors = 0;
  let newlySkipped = 0;

  for (const matchId of missing) {
    try {
      const match = await getMatch(matchId);
      if (!shouldPersistMatch(match)) {
        // Non-counting type (trainingroom etc.) — getMatch didn't write it to
        // disk; remember the ID so we never spend an API call on it again.
        skipped.add(matchId);
        newlySkipped++;
        if (verbose) {
          console.log(`[matches] ⏭ ${matchId} skipped (matchType=${match?.data?.attributes?.matchType})`);
        }
        continue;
      }
      fetched++;
      if (verbose && fetched % 10 === 0) {
        console.log(`[matches] ${fetched}/${missing.length} fetched…`);
      }
    } catch (e) {
      errors++;
      if (verbose) console.warn(`[matches] ✗ ${matchId}: ${e.message}`);
    }
  }

  if (newlySkipped > 0) saveSkipped(skipped);

  if (verbose) {
    console.log(`[matches] ✓ Done — ${fetched} fetched · ${newlySkipped} skip-listed · ${errors} errors`);
  }

  return {
    members: members.length,
    playersRead,
    uniqueRefs: allRefs.size,
    alreadyCached: existing.size,
    skipListed: skipped.size,
    fetched,
    errors,
  };
}

module.exports = { fetchRecentMatches };

if (require.main === module) {
  fetchRecentMatches({ verbose: true }).catch(err => {
    console.error('[matches] Fatal:', err.message);
    process.exit(1);
  });
}
