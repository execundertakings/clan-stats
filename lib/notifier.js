'use strict';
// ── lib/notifier.js — Discord achievement notifier ────────────────────────────
// Polls each clan member's recent matches every POLL_INTERVAL ms.
//
// Achievements tracked:
//   🍗 Chicken dinner    (1st place)       — combined squad embed
//   😤 Near miss         (2nd place)       — combined squad embed
//   🔥 Nuke game         (10+ kills)       — individual
//   ⚔️  Kill milestone    (5–9 kills)       — individual
//   🎯 Long range kill   (≥ 300m)          — individual
//   🏥 Clutch medic      (3+ revives)      — individual
//   🔫 Surgical          (≥4 kills, ≥60% HS rate) — individual
//   😬 Team kill         (teamKills > 0)   — individual
//   💀 Suicide           (deathType byself)— individual
//   📊 New record        (kills / range / damage PB) — individual
//
// Config (.env):
//   DISCORD_WEBHOOK_URL      — real channel webhook
//   DISCORD_TEST_WEBHOOK_URL — test channel webhook; used instead when set
//
// Resilience:
//   • getPlayerFresh every scan — never misses new matches via stale cache
//   • official-squad allowlist (lib/match-filters.js) + age filter — no false alerts, no restart floods
//   • detectAchievements only after filters — records.json stays clean
//   • Orphan pruning — removed members cleaned up each scan
//   • Bootstrap + flood guards — no spam on first run or list drift
//   • Squad rollups — dinner and near-miss each post one combined embed

const fs   = require('fs');
const path = require('path');
const { DATA, loadEnv, loadClanConfig } = require('./config');
const NTAG = `[${loadClanConfig().clan.tag}]`;
const { getPlayerFresh, getMatch }   = require('./pubg');
const { postWebhook }                = require('./discord');

// ── File paths ────────────────────────────────────────────────────────────────
const MEMBERS_FILE  = path.join(DATA, 'members.json');
const NOTIFIED_FILE = path.join(DATA, 'notified.json');
const RECORDS_FILE  = path.join(DATA, 'records.json');

// ── Tuning constants ──────────────────────────────────────────────────────────
const POLL_INTERVAL           = 5 * 60 * 1000;
const MEMBER_DELAY            = 2 * 1000;
const MAX_NOTIFIED_PER_PLAYER = 250;
const LONG_RANGE_THRESHOLD    = 300;   // metres
const KILL_MILESTONE_MIN      = 5;
const KILL_NUKE_MIN           = 10;
const DAMAGE_RECORD_MIN       = 500;
const MAX_NEW_MATCHES_PER_SCAN = 15;
const MAX_POSTS_PER_SCAN      = 8;
const MATCH_MAX_AGE_MS        = 2 * 60 * 60 * 1000;  // 2 hours

// New achievement thresholds
const REVIVE_THRESHOLD  = 3;    // revives in one match → clutch medic
const HS_KILLS_MIN      = 4;    // min kills to qualify for surgical
const HS_RATE_THRESHOLD = 0.60; // headshot rate to trigger surgical (60%)

// Allowlist via lib/match-filters.js. A blocklist here failed twice:
// 'training' never matched PUBG's actual 'trainingroom' (phantom Camp Jackal
// "solo dinner" posted 2026-06-11), and 'arcade'/'tutorialatoz'/unknown new
// types were never listed at all (TDM games polluted records.json PBs).
//
// Policy (Greg, 2026-06-12):
//   • official squad   → announce + count toward records.json PBs
//   • official solo/duo → announce only; never mutates records.json
//   • everything else (custom, event, arcade/TDM, trainingroom, airoyale,
//     tutorial, unknown future types) → skip entirely
const { getMatchFilterDecision } = require('./match-filters');

// ── Disk I/O ──────────────────────────────────────────────────────────────────
function loadJson(file, def) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return def; }
}
function saveJson(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch (e) {
    console.error('[Notifier] Could not save', file, e.message);
  }
}

// Record a matchId we actually POSTED (individual or squad). Read by
// scripts/recover_missed_announcements.js to tell announced games apart from
// ones that were only marked seen (flood guard / no-webhook = swallowed).
const POSTED_CAP = 3000;
function markPosted(notified, matchId) {
  if (!matchId) return;
  if (!Array.isArray(notified._posted)) notified._posted = [];
  if (!notified._posted.includes(matchId)) notified._posted.push(matchId);
  if (notified._posted.length > POSTED_CAP) notified._posted = notified._posted.slice(-POSTED_CAP);
}

// ── PUBG data helpers ─────────────────────────────────────────────────────────
function getMatchIds(playerData) {
  return (playerData?.data?.relationships?.matches?.data || []).map(m => m.id);
}
function findParticipant(matchData, accountId) {
  return (matchData?.included || []).find(item =>
    item.type === 'participant' &&
    item.attributes?.stats?.playerId === accountId
  );
}

const MAP_NAMES = {
  Baltic_Main:    'Erangel',
  Desert_Main:    'Miramar',
  Savage_Main:    'Sanhok',
  DihorOtok_Main: 'Vikendi',
  Summerland_Main:'Karakin',
  Tiger_Main:     'Taego',
  Kiki_Main:      'Deston',
  Neon_Main:      'Rondo',
  Range_Main:     'Camp Jackal',
};
const MODE_NAMES = {
  'squad-fpp': 'Squad FPP', 'squad': 'Squad TPP',
  'duo-fpp':   'Duo FPP',   'duo':   'Duo TPP',
  'solo-fpp':  'Solo FPP',  'solo':  'Solo TPP',
};

function describeModeMap(matchData) {
  const attrs  = matchData?.data?.attributes || {};
  const mode   = MODE_NAMES[attrs.gameMode] || attrs.gameMode || 'Squad';
  const mapRaw = attrs.mapName || '';
  return `${mode} · ${MAP_NAMES[mapRaw] || mapRaw.replace('_Main', '') || 'Unknown'}`;
}

function fmtTime(seconds) {
  const m = Math.floor((seconds || 0) / 60);
  const s = Math.floor((seconds || 0) % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ── Achievement detection ─────────────────────────────────────────────────────
// Mutates records in-place. Only call AFTER match-type + age filters.
function detectAchievements(stats, records, accountId) {
  const {
    kills         = 0,
    headshotKills = 0,
    teamKills     = 0,
    longestKill   = 0,
    damageDealt   = 0,
    deathType     = '',
    winPlace      = 99,
    revives       = 0,
  } = stats;

  const achievements = [];

  // ── Personal records ────────────────────────────────────────────────────────
  const rec = records[accountId] || { kills: 0, longestKill: 0, damage: 0 };
  const newRecs = [];

  if (kills >= KILL_MILESTONE_MIN && kills > rec.kills) {
    newRecs.push({ stat: 'kills', old: rec.kills, new: kills });
    rec.kills = kills;
  }
  if (longestKill >= LONG_RANGE_THRESHOLD && longestKill > rec.longestKill) {
    newRecs.push({ stat: 'longestKill', old: +rec.longestKill.toFixed(1), new: +longestKill.toFixed(1) });
    rec.longestKill = longestKill;
  }
  if (damageDealt >= DAMAGE_RECORD_MIN && damageDealt > rec.damage) {
    newRecs.push({ stat: 'damage', old: Math.round(rec.damage), new: Math.round(damageDealt) });
    rec.damage = damageDealt;
  }
  records[accountId] = rec;

  // ── Squad placement (rolled up by scan()) ───────────────────────────────────
  if (winPlace === 1) achievements.push({ type: 'dinner' });
  if (winPlace === 2) achievements.push({ type: 'nearmiss' });

  // ── Individual kill-based ───────────────────────────────────────────────────
  if (kills >= KILL_NUKE_MIN)           achievements.push({ type: 'nuke',      kills });
  else if (kills >= KILL_MILESTONE_MIN) achievements.push({ type: 'milestone', kills });

  // ── Surgical: ≥ 4 kills, ≥ 60% headshot rate ───────────────────────────────
  if (kills >= HS_KILLS_MIN && headshotKills >= kills * HS_RATE_THRESHOLD) {
    achievements.push({ type: 'surgical', kills, hs: headshotKills });
  }

  // ── Snipe ───────────────────────────────────────────────────────────────────
  if (longestKill >= LONG_RANGE_THRESHOLD) achievements.push({ type: 'snipe', dist: longestKill });

  // ── Clutch medic ────────────────────────────────────────────────────────────
  if (revives >= REVIVE_THRESHOLD) achievements.push({ type: 'medic', revives });

  // ── Misc ────────────────────────────────────────────────────────────────────
  if (teamKills > 0)      achievements.push({ type: 'teamkill', count: teamKills });
  if (deathType === 'byself') achievements.push({ type: 'suicide' });
  if (newRecs.length > 0) achievements.push({ type: 'record', records: newRecs });

  return achievements;
}

// ── Embed builders ────────────────────────────────────────────────────────────
const COLORS = {
  dinner:    0xFFD700, // gold
  nearmiss:  0xFF6B35, // orange-red
  nuke:      0xFF2222, // red
  milestone: 0xFF8C00, // orange
  surgical:  0xC471ED, // purple
  snipe:     0x4169E1, // royal blue
  medic:     0x00CED1, // teal
  teamkill:  0x9B59B6, // purple
  suicide:   0x95A5A6, // grey
  record:    0x2ECC71, // green
};

const ACHIEVEMENT_TITLES = {
  dinner:    ()  => '🍗  CHICKEN DINNER!',
  nearmiss:  ()  => '😤  SO CLOSE',
  nuke:      (a) => `🔥  ${a.kills}-KILL GAME`,
  milestone: (a) => `⚔️   ${a.kills} KILLS`,
  surgical:  (a) => `🔫  ${Math.round((a.hs / a.kills) * 100)}% HEADSHOTS  (${a.kills} kills)`,
  snipe:     (a) => `🎯  ${Math.round(a.dist)}m SNIPE`,
  medic:     (a) => `🏥  ${a.revives}-REVIVE MEDIC`,
  teamkill:  (a) => `😬  FRIENDLY FIRE${a.count > 1 ? ` (×${a.count})` : ''}`,
  suicide:   ()  => '💀  SELF-ELIMINATION',
  record:    ()  => '📊  NEW RECORD',
};

// Individual embed — non-squad, non-dinner achievements
function buildEmbed(playerName, achievements, stats, modeMap) {
  const {
    kills = 0, headshotKills = 0, damageDealt = 0, longestKill = 0,
    winPlace = 99, timeSurvived = 0, assists = 0, revives = 0,
  } = stats;

  const primaryType = (achievements.find(a => a.type === 'nuke') ||
                       achievements.find(a => a.type === 'surgical') ||
                       achievements[0])?.type || 'milestone';

  const title = achievements
    .filter(a => a.type !== 'record') // records shown in body
    .map(a => ACHIEVEMENT_TITLES[a.type]?.(a) || '')
    .filter(Boolean).join('  ·  ');

  const statsLine = [
    `**#${winPlace}** finish`,
    `**${kills}** kills${headshotKills > 0 ? ` (${headshotKills} HS)` : ''}`,
    assists > 0  ? `${assists} assists`  : null,
    revives > 0  ? `${revives} revives`  : null,
    `**${Math.round(damageDealt)}** dmg`,
    longestKill >= 50 ? `**${Math.round(longestKill)}m** longest` : null,
    `${fmtTime(timeSurvived)} survived`,
  ].filter(Boolean).join('  ·  ');

  const recAchiev = achievements.find(a => a.type === 'record');
  const recLines  = (recAchiev?.records || []).map(r => {
    const label  = { kills: 'Kill record', longestKill: 'Longest kill', damage: 'Damage record' }[r.stat] || r.stat;
    const suffix = r.stat === 'longestKill' ? 'm' : '';
    return `> 📊 **${label}**: ${r.new}${suffix}${r.old === 0 ? ' *(first!)*' : ` *(was ${r.old}${suffix})*`}`;
  });

  return {
    title,
    description: [statsLine, ...recLines].join('\n'),
    color: COLORS[primaryType],
    author:    { name: `${NTAG} ${playerName}` },
    footer:    { text: modeMap },
    timestamp: new Date().toISOString(),
  };
}

// Squad embed — dinner or near-miss, all clan members in one post.
// participants sorted by kills desc before call.
function buildSquadEmbed(participants, modeMap, type) {
  const lines = participants.map(({ member, stats, achievements }) => {
    const {
      kills = 0, headshotKills = 0, damageDealt = 0,
      longestKill = 0, timeSurvived = 0, assists = 0, revives = 0, teamKills = 0,
    } = stats;

    const statParts = [
      kills === 1 ? '**1 kill**' : `**${kills} kills**`,
      headshotKills > 0 ? `(${headshotKills} HS)` : null,
      assists > 0       ? `${assists} ast`         : null,
      revives > 0       ? `${revives} rev`         : null,
      `${Math.round(damageDealt)} dmg`,
      longestKill >= 50 ? `${Math.round(longestKill)}m` : null,
      fmtTime(timeSurvived),
    ].filter(Boolean).join(' · ');

    // In-line badges for notable sub-achievements
    const badges = [];
    if (kills >= KILL_NUKE_MIN)           badges.push(`🔥 ${kills} kills`);
    else if (kills >= KILL_MILESTONE_MIN) badges.push(`⚔️ ${kills} kills`);
    if (teamKills > 0)                       badges.push('😬 TK');
    if (longestKill >= LONG_RANGE_THRESHOLD) badges.push(`🎯 ${Math.round(longestKill)}m`);
    if (revives >= REVIVE_THRESHOLD)         badges.push(`🏥 ${revives} rev`);
    if (kills >= HS_KILLS_MIN && headshotKills >= kills * HS_RATE_THRESHOLD)
      badges.push(`🔫 ${Math.round((headshotKills / kills) * 100)}% HS`);

    const recAchiev = achievements?.find(a => a.type === 'record');
    if (recAchiev?.records?.length) {
      badges.push(...recAchiev.records.map(r => ({
        kills: '📊 kill PR', longestKill: '📊 range PR', damage: '📊 dmg PR',
      }[r.stat] || '📊 PR')));
    }

    const badgeStr = badges.length ? `  —  ${badges.join('  ')}` : '';
    return `**${member.name}**  ·  ${statParts}${badgeStr}`;
  });

  const count      = participants.length;
  const totalKills = participants.reduce((s, p) => s + (p.stats.kills || 0), 0);
  const placement  = type === 'dinner' ? '#1' : '#2';
  // `count` is how many CLAN members were in this match, NOT the squad size.
  // Derive the actual game mode from modeMap ("Squad TPP · Erangel" → "Squad TPP")
  // so a squad win carried with non-clan randoms (count===1) isn't mislabelled
  // "Solo". Only label Solo when the real game mode is solo.
  const modeLabel  = (modeMap || '').split('·')[0].trim();
  const isSoloMode = /\bsolo\b/i.test(modeLabel);
  const subtitle   = count > 1
    ? `${placement}  ·  ${count} ${loadClanConfig().clan.memberNounPlural}  ·  ${totalKills} kills`
    : isSoloMode
      ? `${placement}  ·  Solo  ·  ${totalKills} kills`
      : `${placement}  ·  ${totalKills} kills`;

  return {
    title:       type === 'dinner' ? '🍗  CHICKEN DINNER!' : '😤  SO CLOSE',
    description: lines.join('\n'),
    color:       COLORS[type],
    author:      { name: `${NTAG}  ·  ${subtitle}` },
    footer:      { text: modeMap },
    timestamp:   new Date().toISOString(),
  };
}

// ── onNewMatches callback (set by startNotifier) ──────────────────────────────
let _onNewMatches = null;

// ── Notifier state ────────────────────────────────────────────────────────────
const notifierState = {
  running: false, lastScan: null, lastPost: null,
  postsTotal: 0, errors: 0, log: [],
};

function logEvent(msg) {
  notifierState.log.unshift(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
  if (notifierState.log.length > 60) notifierState.log.pop();
  console.log('[3PI Notifier]', msg);
}

// ── Per-member scan ───────────────────────────────────────────────────────────
// dinnerQueue / nearMissQueue: Map<matchId, { matchData, modeMap, participants[] }>
// Squad-placement matches are queued here; scan() posts them combined after the loop.
async function scanMember(member, notified, records, webhookUrl, postsThisScan, dinnerQueue, nearMissQueue) {
  let playerData;
  try {
    playerData = await getPlayerFresh(member.accountId);
  } catch (e) {
    logEvent(`⚠ Could not fetch ${member.name}: ${e.message}`);
    notifierState.errors++;
    return { posts: postsThisScan, newMatches: 0 };
  }

  const matchIds = getMatchIds(playerData);

  // Bootstrap — only when this member has NEVER been scanned before.
  // An empty array is a valid "bootstrapped, but PUBG returned no recent
  // matches" state. Treating it as never-seen re-bootstrapped those members on
  // every scan, which meant their first match after a period of inactivity was
  // silently marked seen instead of announced.
  if (!Array.isArray(notified[member.accountId])) {
    notified[member.accountId] = matchIds.slice();
    logEvent(`📋 Bootstrap ${member.name}: ${matchIds.length} match(es) seen`);
    saveJson(NOTIFIED_FILE, notified);
    return { posts: postsThisScan, newMatches: 0 };
  }

  const seen   = new Set(notified[member.accountId]);
  const newIds = matchIds.filter(id => !seen.has(id));
  if (newIds.length === 0) return { posts: postsThisScan, newMatches: 0 };

  // Flood guard
  if (newIds.length > MAX_NEW_MATCHES_PER_SCAN) {
    notified[member.accountId] = matchIds.slice();
    logEvent(`🛡 Flood guard: ${member.name} had ${newIds.length} unseen — re-synced`);
    saveJson(NOTIFIED_FILE, notified);
    return { posts: postsThisScan, newMatches: 0 };
  }

  logEvent(`🔎 ${member.name}: ${newIds.length} new match(es)`);

  for (const matchId of newIds) {
    let matchData;
    try {
      matchData = await getMatch(matchId);
    } catch (e) {
      logEvent(`⚠ Match ${matchId} fetch failed: ${e.message}`);
      notifierState.errors++;
      seen.add(matchId);
      continue;
    }

    const attrs = matchData?.data?.attributes || {};

    // Filter — same single source of truth as the stats pipeline.
    // 'non-squad-mode' is only returned for OFFICIAL matches, so official
    // solo/duo pass through as announce-only; all other non-counting types
    // (custom, event, arcade/TDM, trainingroom, airoyale, tutorial, unknown)
    // are skipped before detectAchievements so records.json stays clean.
    const filterDecision = getMatchFilterDecision(attrs);
    const isCountingSquad    = filterDecision.counts;
    const isOfficialNonSquad = !isCountingSquad && filterDecision.reason === 'non-squad-mode';
    if (!isCountingSquad && !isOfficialNonSquad) {
      logEvent(`⏭ Skip [${attrs.matchType || '?'}/${attrs.gameMode || '?'}] (${filterDecision.reason}) — ${member.name}`);
      seen.add(matchId);
      continue;
    }

    // Age filter
    if (attrs.createdAt && Date.now() - new Date(attrs.createdAt).getTime() > MATCH_MAX_AGE_MS) {
      seen.add(matchId);
      continue;
    }

    const participant = findParticipant(matchData, member.accountId);
    if (!participant) { seen.add(matchId); continue; }

    const stats = participant.attributes?.stats || {};
    let achievements;
    if (isCountingSquad) {
      achievements = detectAchievements(stats, records, member.accountId);
    } else {
      // Official solo/duo: announce achievements, but PBs in records.json are
      // squad-only — run detection against a throwaway object and drop any
      // 'record' achievement it produces (it would be a false "first!").
      achievements = detectAchievements(stats, {}, member.accountId)
        .filter(a => a.type !== 'record');
    }

    const hasDinner   = achievements.some(a => a.type === 'dinner');
    const hasNearMiss = achievements.some(a => a.type === 'nearmiss');

    if (hasDinner || hasNearMiss) {
      // ── Guard: skip if this match was already posted as a squad embed ────────
      const postedSquad = new Set(notified._posted || []);
      if (postedSquad.has(matchId)) {
        logEvent(`⏭ Squad embed already posted for ${matchId} — skipping duplicate`);
        seen.add(matchId);
        continue;
      }

      // ── Queue for combined squad post ────────────────────────────────────────
      const queue = hasDinner ? dinnerQueue : nearMissQueue;
      if (!queue.has(matchId)) {
        queue.set(matchId, { matchData, modeMap: describeModeMap(matchData), participants: [] });
      }
      queue.get(matchId).participants.push({ member, stats, achievements });

    } else if (achievements.length > 0) {
      // ── Individual post ───────────────────────────────────────────────────────
      if (!webhookUrl) {
        logEvent(`📝 (dry) ${member.name} — ${achievements.map(a => a.type).join(', ')}`);
      } else if (postsThisScan >= MAX_POSTS_PER_SCAN) {
        logEvent(`🛑 Post cap reached — skipping ${member.name}`);
      } else {
        const embed = buildEmbed(member.name, achievements, stats, describeModeMap(matchData));
        try {
          await postWebhook(webhookUrl, { embeds: [embed] });
          notifierState.lastPost = new Date().toISOString();
          notifierState.postsTotal++;
          postsThisScan++;
          markPosted(notified, matchId);
          logEvent(`✅ ${member.name} — ${embed.title} (${postsThisScan}/${MAX_POSTS_PER_SCAN})`);
        } catch (e) {
          logEvent(`⚠ Discord post failed: ${e.message}`);
          notifierState.errors++;
        }
      }
    }

    seen.add(matchId);
  }

  notified[member.accountId] = [...seen].slice(-MAX_NOTIFIED_PER_PLAYER);
  saveJson(NOTIFIED_FILE, notified);
  return { posts: postsThisScan, newMatches: newIds.length };
}

// ── Post a squad queue (dinner or near-miss) ──────────────────────────────────
async function postSquadQueue(queue, type, members, webhookUrl, postsThisScan, notified) {
  for (const [matchId, { matchData, modeMap, participants }] of queue) {
    // Pull in any clan members who already had this match in their seen list
    const alreadyIn = new Set(participants.map(p => p.member.accountId));
    const targetPlace = type === 'dinner' ? 1 : 2;
    for (const member of members) {
      if (alreadyIn.has(member.accountId)) continue;
      const extra = findParticipant(matchData, member.accountId);
      if (!extra) continue;
      if ((extra.attributes?.stats?.winPlace || 99) !== targetPlace) continue;
      participants.push({ member, stats: extra.attributes?.stats || {}, achievements: [] });
    }

    participants.sort(
      (a, b) => (b.stats.kills || 0) - (a.stats.kills || 0) ||
                (b.stats.damageDealt || 0) - (a.stats.damageDealt || 0)
    );

    const names = participants.map(p => p.member.name).join(', ');

    if (!webhookUrl) {
      logEvent(`📝 (dry) ${type === 'dinner' ? 'Dinner' : 'Near-miss'}: ${names}`);
      continue;
    }
    if (postsThisScan >= MAX_POSTS_PER_SCAN) {
      logEvent(`🛑 Post cap — skipping ${type} embed (${names})`);
      continue;
    }

    try {
      await postWebhook(webhookUrl, { embeds: [buildSquadEmbed(participants, modeMap, type)] });
      notifierState.lastPost = new Date().toISOString();
      notifierState.postsTotal++;
      postsThisScan++;
      logEvent(`✅ ${type === 'dinner' ? 'Dinner' : 'Near-miss'}: ${names} (${postsThisScan}/${MAX_POSTS_PER_SCAN})`);
      // Mark this matchId as posted so late-arriving squad members don't trigger a
      // second post (and so the recovery script knows it was announced).
      if (notified) {
        markPosted(notified, matchId);
        saveJson(NOTIFIED_FILE, notified);
      }
    } catch (e) {
      logEvent(`⚠ ${type} post failed: ${e.message}`);
      notifierState.errors++;
    }
  }
  return postsThisScan;
}

// ── Full scan ─────────────────────────────────────────────────────────────────
let _scanRunning = false;

async function scan() {
  if (_scanRunning) { logEvent('⏭ Scan already running — skipping'); return; }
  _scanRunning = true;
  notifierState.running = true;

  const env        = loadEnv();
  const webhookUrl = env.DISCORD_TEST_WEBHOOK_URL || env.DISCORD_WEBHOOK_URL || null;
  if (!webhookUrl) logEvent('ℹ No webhook — scanning to keep seen-list current');

  const members = loadJson(MEMBERS_FILE, []);
  if (!members.length) {
    _scanRunning = false; notifierState.running = false; return;
  }

  const notified = loadJson(NOTIFIED_FILE, {});
  const records  = loadJson(RECORDS_FILE,  {});

  // Prune orphaned entries for removed members
  const activeIds = new Set(members.map(m => m.accountId));
  let pruned = 0;
  for (const id of Object.keys(notified)) { if (id.startsWith('_')) continue; if (!activeIds.has(id)) { delete notified[id]; pruned++; } }
  for (const id of Object.keys(records))  { if (!activeIds.has(id)) { delete records[id];  pruned++; } }
  if (pruned > 0) {
    logEvent(`🧹 Pruned ${pruned} orphaned entries`);
    saveJson(NOTIFIED_FILE, notified);
    saveJson(RECORDS_FILE,  records);
  }

  logEvent(`🔍 Scanning ${members.length} member(s)…`);

  const dinnerQueue   = new Map();
  const nearMissQueue = new Map();
  let postsThisScan   = 0;
  let totalNewMatches = 0;

  for (const member of members) {
    const scanResult = await scanMember(
      member, notified, records, webhookUrl, postsThisScan, dinnerQueue, nearMissQueue
    ).catch(e => { logEvent(`⚠ Error scanning ${member.name}: ${e.message}`); return { posts: postsThisScan, newMatches: 0 }; });
    postsThisScan    = scanResult.posts;
    totalNewMatches += scanResult.newMatches;
    await new Promise(r => setTimeout(r, MEMBER_DELAY));
  }

  // Notify server if new matches found so it can trigger a prewarm
  if (totalNewMatches > 0 && _onNewMatches) _onNewMatches(totalNewMatches);

  // Post squad embeds after all members processed
  postsThisScan = await postSquadQueue(dinnerQueue,   'dinner',   members, webhookUrl, postsThisScan, notified);
  postsThisScan = await postSquadQueue(nearMissQueue, 'nearmiss', members, webhookUrl, postsThisScan, notified);

  saveJson(NOTIFIED_FILE, notified);
  saveJson(RECORDS_FILE,  records);

  notifierState.lastScan = new Date().toISOString();
  notifierState.running  = false;
  _scanRunning = false;

  // Posting-health snapshot — read by the daily freshness check so a long
  // posting outage (webhook missing, flood-guard swallows) can't hide behind a
  // still-fresh match_history cache.
  saveJson(path.join(DATA, 'notifier_health.json'), {
    lastScanAt:        notifierState.lastScan,
    lastPostAt:        notifierState.lastPost,
    webhookConfigured: !!webhookUrl,
    postsTotal:        notifierState.postsTotal,
    errors:            notifierState.errors,
  });

  logEvent(`✓ Scan complete — ${postsThisScan} post(s)`);
}

// ── Start / stop ──────────────────────────────────────────────────────────────
let _timer = null;

function startNotifier({ onNewMatches } = {}) {
  _onNewMatches = onNewMatches || null;

  const env        = loadEnv();
  const webhookUrl = env.DISCORD_TEST_WEBHOOK_URL || env.DISCORD_WEBHOOK_URL || null;
  if (!webhookUrl) console.log('[3PI Notifier] ⚠ No webhook URL — will not post until configured');
  else if (env.DISCORD_TEST_WEBHOOK_URL) console.log('[3PI Notifier] 🧪 TEST mode');
  else console.log('[3PI Notifier] 🚀 LIVE — polling every 5 min');

  setTimeout(() => scan().catch(e => logEvent(`Scan error: ${e.message}`)), 60 * 1000);
  _timer = setInterval(() => scan().catch(e => logEvent(`Scan error: ${e.message}`)), POLL_INTERVAL);
}

function stopNotifier() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = { startNotifier, stopNotifier, notifierState, scan };
