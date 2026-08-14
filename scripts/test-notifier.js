#!/usr/bin/env node
'use strict';
// ── scripts/test-notifier.js — dry-run notifier diagnostic ───────────────────
// Simulates one full scan without posting to Discord or modifying notified.json.
// Prints:
//   • What each member's scan would do and why
//   • Before/after seen-list sizes
//   • Which members would trigger flood guard, bootstrap, or posts
//   • Root-cause diagnosis for seen-list drift
//
// Usage: node scripts/test-notifier.js [--fix]
//   --fix   actually write corrected notified.json to disk (flood-guard resets)

const fs   = require('fs');
const path = require('path');

// Resolve project root: prefer cwd (so `node scripts/test-notifier.js` works
// when run from the project root), fall back to __dirname/.. (for running the
// worktree copy directly from the project folder).
function findProjectRoot() {
  for (const candidate of [process.cwd(), path.resolve(__dirname, '..')]) {
    if (fs.existsSync(path.join(candidate, 'data', 'members.json'))) return candidate;
  }
  // Last resort: use __dirname parent
  return path.resolve(__dirname, '..');
}
const PROJECT_ROOT = findProjectRoot();
const DATA         = path.join(PROJECT_ROOT, 'data');

const MEMBERS_FILE  = path.join(DATA, 'members.json');
const NOTIFIED_FILE = path.join(DATA, 'notified.json');
const RECORDS_FILE  = path.join(DATA, 'records.json');
const PLAYER_CACHE  = path.join(DATA, 'player_cache');

const MAX_NOTIFIED_PER_PLAYER = 250; // must match notifier.js
const MAX_NEW_MATCHES_PER_SCAN = 15;
const LONG_RANGE_THRESHOLD    = 300;
const KILL_MILESTONE_MIN      = 5;
const KILL_NUKE_MIN           = 10;
const DAMAGE_RECORD_MIN       = 500;

const FIX_MODE = process.argv.includes('--fix');

// ── Helpers ───────────────────────────────────────────────────────────────────
function loadJson(file, def) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return def; }
}

function getMatchIds(playerData) {
  return (playerData?.data?.relationships?.matches?.data || []).map(m => m.id);
}

function loadPlayerCache(accountId) {
  try {
    const raw = fs.readFileSync(path.join(PLAYER_CACHE, `${accountId}.json`), 'utf8');
    const { data, savedAt } = JSON.parse(raw);
    const ageMin = Math.round((Date.now() - savedAt) / 60000);
    return { data, ageMin };
  } catch {
    return null;
  }
}

// ── Achievement detection (mirrors notifier.js) ───────────────────────────────
function detectAchievements(stats, records, accountId) {
  const {
    kills = 0, headshotKills = 0, teamKills = 0,
    longestKill = 0, damageDealt = 0, deathType = '', winPlace = 99,
  } = stats;

  const achievements = [];
  const rec = records[accountId] || { kills: 0, longestKill: 0, damage: 0 };
  const newRecs = [];

  if (kills >= KILL_MILESTONE_MIN && kills > rec.kills)
    newRecs.push({ stat: 'kills', old: rec.kills, new: kills });
  if (longestKill >= LONG_RANGE_THRESHOLD && longestKill > rec.longestKill)
    newRecs.push({ stat: 'longestKill', old: +rec.longestKill.toFixed(1), new: +longestKill.toFixed(1) });
  if (damageDealt >= DAMAGE_RECORD_MIN && damageDealt > rec.damage)
    newRecs.push({ stat: 'damage', old: Math.round(rec.damage), new: Math.round(damageDealt) });

  if (winPlace === 1)                      achievements.push({ type: 'dinner' });
  if (kills >= KILL_NUKE_MIN)              achievements.push({ type: 'nuke', kills });
  else if (kills >= KILL_MILESTONE_MIN)    achievements.push({ type: 'milestone', kills });
  if (longestKill >= LONG_RANGE_THRESHOLD) achievements.push({ type: 'snipe', dist: longestKill });
  if (teamKills > 0)                       achievements.push({ type: 'teamkill', count: teamKills });
  if (deathType === 'byself')              achievements.push({ type: 'suicide' });
  if (newRecs.length > 0)                  achievements.push({ type: 'record', records: newRecs });

  return achievements;
}

function fmtAchievement(a) {
  if (a.type === 'dinner')    return '🍗 Chicken dinner';
  if (a.type === 'nuke')      return `🔥 ${a.kills}-kill game`;
  if (a.type === 'milestone') return `⚔️  ${a.kills} kills`;
  if (a.type === 'snipe')     return `🎯 ${Math.round(a.dist)}m snipe`;
  if (a.type === 'teamkill')  return `😬 Teamkill×${a.count}`;
  if (a.type === 'suicide')   return '💀 Suicide';
  if (a.type === 'record')    return `📊 Record(${a.records.map(r=>r.stat).join(',')})`;
  return a.type;
}

// ── Match cache helper ─────────────────────────────────────────────────────────
function loadMatchCache(matchId) {
  try {
    const raw = fs.readFileSync(path.join(DATA, 'match_cache', `${matchId}.json`), 'utf8');
    return JSON.parse(raw);
  } catch { return null; }
}

function findParticipant(matchData, accountId) {
  return (matchData?.included || []).find(item =>
    item.type === 'participant' &&
    item.attributes?.stats?.playerId === accountId
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('══════════════════════════════════════════════════════════');
  console.log('  3PI Notifier Dry-Run Diagnostic');
  console.log(`  Mode: ${FIX_MODE ? '⚠️  --fix (will update notified.json)' : 'read-only'}`);
  console.log('══════════════════════════════════════════════════════════\n');

  const members  = loadJson(MEMBERS_FILE, []);
  const notified = loadJson(NOTIFIED_FILE, {});
  const records  = loadJson(RECORDS_FILE, {});

  if (!members.length) {
    console.error('No members found in', MEMBERS_FILE);
    process.exit(1);
  }

  console.log(`Members: ${members.length}    Players in notified.json: ${Object.keys(notified).length}\n`);

  // Simulate the records object (mutated per achievement detection)
  const simRecords = JSON.parse(JSON.stringify(records));

  const summary = {
    bootstrap: [],
    floodGuard: [],
    newMatches: [],
    noChange: [],
    noCacheSkipped: [],
  };

  for (const member of members) {
    const { name, accountId } = member;
    const cached = loadPlayerCache(accountId);

    if (!cached) {
      console.log(`[${name}] ⚠ No player cache — would need live API call (skipping in dry-run)`);
      summary.noCacheSkipped.push(name);
      console.log();
      continue;
    }

    const matchIds  = getMatchIds(cached.data);
    const seenBefore = notified[accountId] ? notified[accountId].length : 0;

    // ── Bootstrap ────────────────────────────────────────────────────────────
    if (!notified[accountId] || notified[accountId].length === 0) {
      console.log(`[${name}] 📋 BOOTSTRAP — ${matchIds.length} matches would be marked as seen`);
      console.log(`         Cache age: ${cached.ageMin}m  |  Before: 0  →  After: ${matchIds.length}`);
      summary.bootstrap.push(name);
      if (FIX_MODE) {
        notified[accountId] = matchIds.slice();
      }
      console.log();
      continue;
    }

    const seen   = new Set(notified[accountId]);
    const newIds = matchIds.filter(id => !seen.has(id));
    const afterSize = Math.min(seen.size + newIds.length, MAX_NOTIFIED_PER_PLAYER);

    // ── Flood guard ───────────────────────────────────────────────────────────
    if (newIds.length > MAX_NEW_MATCHES_PER_SCAN) {
      console.log(`[${name}] 🛡 FLOOD GUARD — ${newIds.length} unseen matches (>${MAX_NEW_MATCHES_PER_SCAN} threshold)`);
      console.log(`         Cache age: ${cached.ageMin}m  |  Before: ${seenBefore}  →  After: ${matchIds.length} (full re-bootstrap)`);
      console.log(`         API returns: ${matchIds.length} total  |  In seen list: ${matchIds.filter(id => seen.has(id)).length}`);
      console.log(`         ⚠️  BUG: old notifier didn't save here → same flood guard fires every scan!`);
      if (FIX_MODE) {
        console.log(`         ✅ --fix: writing corrected seen list to disk`);
        notified[accountId] = matchIds.slice();
      }
      summary.floodGuard.push({ name, newCount: newIds.length, apiCount: matchIds.length, seenCount: seenBefore });
      console.log();
      continue;
    }

    if (newIds.length === 0) {
      console.log(`[${name}] ✓ No new matches  (${seenBefore} seen, ${matchIds.length} from API)`);
      summary.noChange.push(name);
      console.log();
      continue;
    }

    // ── New matches ───────────────────────────────────────────────────────────
    console.log(`[${name}] 🔎 ${newIds.length} new match(es)  |  Before: ${seenBefore}  →  After: ~${afterSize}`);
    console.log(`         Cache age: ${cached.ageMin}m  |  API total: ${matchIds.length}`);

    const wouldPost = [];
    for (const matchId of newIds) {
      const matchData = loadMatchCache(matchId);
      if (!matchData) {
        console.log(`         [${matchId.slice(0,8)}] ⚠ Not in match cache — would fetch from API`);
        continue;
      }
      const participant = findParticipant(matchData, accountId);
      if (!participant) {
        console.log(`         [${matchId.slice(0,8)}] ⚠ Participant not found in match`);
        continue;
      }
      const stats        = participant.attributes?.stats || {};
      const achievements = detectAchievements(stats, simRecords, accountId);
      const place        = stats.winPlace || '?';
      const kills        = stats.kills || 0;
      const dmg          = Math.round(stats.damageDealt || 0);

      if (achievements.length > 0) {
        const achStr = achievements.map(fmtAchievement).join(' · ');
        console.log(`         [${matchId.slice(0,8)}] 📢 WOULD POST: ${achStr}  (#${place}, ${kills}k, ${dmg}dmg)`);
        wouldPost.push({ matchId, achievements, stats });
      } else {
        console.log(`         [${matchId.slice(0,8)}] — No achievement  (#${place}, ${kills}k, ${dmg}dmg)`);
      }
    }

    if (wouldPost.length > 0) {
      summary.newMatches.push({ name, posts: wouldPost.length });
    } else {
      summary.noChange.push(name);
    }
    console.log();
  }

  if (FIX_MODE) {
    fs.writeFileSync(NOTIFIED_FILE, JSON.stringify(notified, null, 2));
    console.log(`\n✅ notified.json updated on disk (--fix mode)\n`);
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log('══════════════════════════════════════════════════════════');
  console.log('  SUMMARY');
  console.log('══════════════════════════════════════════════════════════');
  if (summary.floodGuard.length) {
    console.log(`\n🛡 FLOOD GUARD (seen-list drift — core bug):`);
    for (const p of summary.floodGuard) {
      console.log(`   ${p.name}: ${p.newCount} unseen / ${p.apiCount} API total / ${p.seenCount} stored`);
    }
    console.log(`\n   ROOT CAUSE: MAX_NOTIFIED_PER_PLAYER (was 100) < API return size (${summary.floodGuard.map(p=>p.apiCount).join('/')})`);
    console.log(`   The old flood guard fixed memory but forgot to saveJson → same flood every scan.`);
    console.log(`   FIX: MAX_NOTIFIED_PER_PLAYER raised to 250; flood guard now saves immediately.`);
  }
  if (summary.bootstrap.length) {
    console.log(`\n📋 Bootstrap (new members): ${summary.bootstrap.join(', ')}`);
  }
  if (summary.newMatches.length) {
    console.log(`\n📢 Members with genuinely new matches to post:`);
    for (const p of summary.newMatches) console.log(`   ${p.name}: ${p.posts} post(s)`);
  }
  if (summary.noChange.length) {
    console.log(`\n✓ No change: ${summary.noChange.join(', ')}`);
  }
  if (summary.noCacheSkipped.length) {
    console.log(`\n⚠ Skipped (no disk cache): ${summary.noCacheSkipped.join(', ')}`);
  }

  if (!FIX_MODE && (summary.floodGuard.length || summary.bootstrap.length)) {
    console.log(`\n  Re-run with --fix to write corrected notified.json.`);
    console.log(`  Or just restart the server — the new notifier.js fixes this automatically.`);
  }
  console.log();
}

main().catch(e => { console.error(e); process.exit(1); });
