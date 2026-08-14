'use strict';
// ── scripts/build_weekly_digest.js ────────────────────────────────────────────
// Weekly clan newsletter — posts to Discord via webhook every Sunday.
// Newsletter format: narrative intro + match of the week + player highlights +
// one clan insight + map notes. All data from internal match_history_cache
// (official matches only) and weapon_cache.
//
// Requires: DISCORD_WEBHOOK_URL in .env

const fs    = require('fs');
const path  = require('path');
const { postWebhook } = require('../lib/discord');
const { loadClanConfig } = require('../lib/config');
const _WC = loadClanConfig().clan;

const ROOT         = path.join(__dirname, '..');
const HISTORY_FILE = path.join(ROOT, 'data', 'match_history_cache.json');
const WEAPON_FILE  = path.join(ROOT, 'data', 'weapon_cache.json');
const ENV_FILE     = path.join(ROOT, '.env');
const LOCK_FILE    = path.join(ROOT, 'data', 'weekly_digest_lock.json');

// ── Helpers ───────────────────────────────────────────────────────────────────
function loadEnv() {
  if (!fs.existsSync(ENV_FILE)) return {};
  return Object.fromEntries(
    fs.readFileSync(ENV_FILE, 'utf8').split('\n')
      .filter(l => l.includes('=') && !l.startsWith('#'))
      .map(l => { const i = l.indexOf('='); return [l.slice(0,i).trim(), l.slice(i+1).trim()]; })
  );
}

function num(n)  { return (n ?? 0).toLocaleString(); }
function pct(n)  { return (n * 100).toFixed(1) + '%'; }
function avg1(n) { return n.toFixed(1); }
function ordinal(n) {
  const s = ['th','st','nd','rd'];
  const v = n % 100;
  return n + (s[(v-20)%10] || s[v] || s[0]);
}

// ── Window ────────────────────────────────────────────────────────────────────
const WINDOW_DAYS = 7;
const cutoff = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000);

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  // Dedup guard — only post once per calendar week (ISO week number)
  const now = new Date();
  const jan1 = new Date(now.getFullYear(), 0, 1);
  const currentWeek = `${now.getFullYear()}-W${Math.ceil(((now - jan1) / 86400000 + jan1.getDay() + 1) / 7)}`;
  try {
    const lock = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
    if (lock.week === currentWeek) {
      console.log(`[Digest] Already posted for ${currentWeek} — skipping`);
      process.exit(0);
    }
  } catch {}

  const env = loadEnv();
  const webhookUrl = env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) {
    console.error('[Digest] ⚠ No DISCORD_WEBHOOK_URL in .env — skipping post');
    process.exit(0);
  }

  if (!fs.existsSync(HISTORY_FILE)) {
    console.error('[Digest] No match history cache — run build_match_history.js first');
    process.exit(1);
  }

  const histCache  = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
  const allPlayers = Object.values(histCache.result || {});

  // Filter each player to this week's official matches
  const weeklyPlayers = allPlayers.map(player => ({
    ...player,
    weekMatches: (player.matches || []).filter(m => m.date && new Date(m.date) >= cutoff),
  })).filter(p => p.weekMatches.length > 0);

  if (!weeklyPlayers.length) {
    console.log('[Digest] No matches in the past week — nothing to post');
    process.exit(0);
  }

  // ── Clan-wide totals (unique matches, not player-games) ────────────────────
  const seenMatches = new Set();
  let uniqueGames = 0, uniqueWins = 0;
  let totalKills = 0, totalDamage = 0;
  for (const p of weeklyPlayers) {
    // Kills/damage are per-player, so sum all player contributions
    totalKills  += p.weekMatches.reduce((s, m) => s + (m.kills  || 0), 0);
    totalDamage += p.weekMatches.reduce((s, m) => s + (m.damage || 0), 0);
    // Games/wins are per-match — deduplicate by matchId
    for (const m of p.weekMatches) {
      if (!m.matchId || seenMatches.has(m.matchId)) continue;
      seenMatches.add(m.matchId);
      uniqueGames++;
      if (m.won) uniqueWins++;
    }
  }
  const clanWinRate = uniqueGames > 0 ? uniqueWins / uniqueGames : 0;

  // ── Match of the week — best single game (kills × damage tiebreak) ────────
  let motw = null;
  for (const p of weeklyPlayers) {
    for (const m of p.weekMatches) {
      const score = (m.kills || 0) * 400 + (m.damage || 0);
      if (!motw || score > motw.score) {
        motw = { ...m, player: p.name, score };
      }
    }
  }

  // ── Dynamic Duo — pair with most shared games this week ───────────────────
  const pairGames = {};
  const seen = new Set();
  for (const p of weeklyPlayers) {
    for (const m of p.weekMatches) {
      const key = `${p.name}|${m.matchId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      for (const mate of (m.teammates || [])) {
        if (!mate.name) continue;
        const pk = [p.name, mate.name].sort().join(' & ');
        pairGames[pk] = (pairGames[pk] || 0) + 1;
      }
    }
  }
  const topPair = Object.entries(pairGames).sort((a, b) => b[1] - a[1])[0] || null;

  // ── Player form: biggest improvement vs career avg (min 3 games this week, 10 overall) ──
  const formRanking = weeklyPlayers
    .filter(p => p.weekMatches.length >= 3 && (p.matches || []).length >= 10)
    .map(p => {
      const allMatches = p.matches || [];
      const allAvgKills  = allMatches.reduce((s, m) => s + (m.kills  || 0), 0) / allMatches.length;
      const allAvgDamage = allMatches.reduce((s, m) => s + (m.damage || 0), 0) / allMatches.length;
      const wkAvgKills   = p.weekMatches.reduce((s, m) => s + (m.kills  || 0), 0) / p.weekMatches.length;
      const wkAvgDamage  = p.weekMatches.reduce((s, m) => s + (m.damage || 0), 0) / p.weekMatches.length;
      const killsDelta   = allAvgKills  > 0 ? (wkAvgKills  - allAvgKills)  / allAvgKills  : 0;
      const damageDelta  = allAvgDamage > 0 ? (wkAvgDamage - allAvgDamage) / allAvgDamage : 0;
      const delta        = (killsDelta + damageDelta) / 2;
      return {
        name: p.name, delta,
        wkAvgKills: wkAvgKills.toFixed(1), wkAvgDmg: Math.round(wkAvgDamage),
        allAvgKills: allAvgKills.toFixed(1), allAvgDmg: Math.round(allAvgDamage),
        games: p.weekMatches.length,
      };
    })
    .sort((a, b) => b.delta - a.delta);

  const hotPlayer  = formRanking.find(p => p.delta > 0.08)  || null;
  const coldPlayer = formRanking.slice().reverse().find(p => p.delta < -0.08) || null;

  // ── Map breakdown (unique matches, not player-games) ───────────────────────
  const mapStats = {};
  for (const p of weeklyPlayers) {
    for (const m of p.weekMatches) {
      if (!m.map || !m.matchId) continue;
      if (!mapStats[m.map]) mapStats[m.map] = { seen: new Set(), wins: 0 };
      if (mapStats[m.map].seen.has(m.matchId)) continue; // deduplicate
      mapStats[m.map].seen.add(m.matchId);
      if (m.won) mapStats[m.map].wins++;
    }
  }
  const mapList = Object.entries(mapStats)
    .map(([map, s]) => ({ map, played: s.seen.size, wins: s.wins, wr: s.wins / s.seen.size }))
    .sort((a, b) => b.played - a.played);
  const topMap     = mapList[0] || null;
  const worstMap   = mapList.find(m => m.played >= 5 && m.wr === 0) || null;

  // ── Blue zone offender ────────────────────────────────────────────────────
  let blueZone = null;
  if (fs.existsSync(WEAPON_FILE)) {
    const wc = JSON.parse(fs.readFileSync(WEAPON_FILE, 'utf8'));
    blueZone = Object.values(wc.players || {})
      .filter(p => (p.blueZoneMatches || 0) >= 5 && p.blueZoneDamage > 0)
      .map(p => ({ name: p.name, avg: +(p.blueZoneDamage / p.blueZoneMatches).toFixed(1), matches: p.blueZoneMatches }))
      .sort((a, b) => b.avg - a.avg)[0] || null;
  }

  // ── Clan insight — pick the most noteworthy observation ──────────────────
  // Priority: win streak note → bad map note → blue zone → generic
  let insight = null;
  if (worstMap) {
    insight = `We're **0-for-${worstMap.played}** on **${worstMap.map}** this week. Might be time to rotate off, or time to figure out what's going wrong there.`;
  } else if (topMap && topMap.wr < 0.03 && topMap.played >= 20) {
    insight = `**${topMap.map}** was our home this week (${topMap.played} games) but we only won ${topMap.wins}. Something to work on.`;
  } else if (blueZone) {
    insight = `**${blueZone.name}** is averaging **${blueZone.avg} blue zone damage per game** — playing zone chicken is not the move.`;
  } else {
    insight = `**${pct(clanWinRate)}** win rate this week across ~${uniqueGames} games. ${clanWinRate >= 0.05 ? 'Solid week.' : 'Rough stretch — keep grinding.'}`;
  }

  // ── Date range label ──────────────────────────────────────────────────────
  const fmt = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const dateRange = `${fmt(new Date(cutoff))} – ${fmt(new Date())}`;

  // ── Build embed description (narrative newsletter body) ───────────────────
  const memberWord = weeklyPlayers.length === 1
    ? (_WC.memberNoun || 'member')
    : (_WC.memberNounPlural || 'members');
  const intro = `**${weeklyPlayers.length} ${memberWord}** deployed this week across **${num(uniqueGames)} games**, racking up **${num(totalKills)} kills** and **${uniqueWins} wins** (${pct(clanWinRate)} win rate).`;

  let motwText = '';
  if (motw) {
    const outcome = motw.won
      ? `took the chicken dinner`
      : `went out ${ordinal(motw.placement || 99)}`;
    motwText = `**${motw.player}** — ${motw.kills} kills, ${num(motw.damage)} damage on **${motw.map}**, ${outcome}.`;
    if (motw.teammates?.length) {
      motwText += ` Ran with ${motw.teammates.map(t => t.name).join(' & ')}.`;
    }
  }

  let highlightsLines = [];
  if (hotPlayer) {
    highlightsLines.push(`📈 **${hotPlayer.name}** is running hot — ${hotPlayer.wkAvgKills} kills/game this week vs their usual ${hotPlayer.allAvgKills} (+${Math.round(hotPlayer.delta * 100)}%).`);
  }
  if (topPair && topPair[1] >= 3) {
    highlightsLines.push(`🤝 **${topPair[0]}** played together ${topPair[1]} times — the clan's most active duo this week.`);
  }
  if (coldPlayer) {
    highlightsLines.push(`📉 **${coldPlayer.name}** is in a bit of a dip (${Math.round(Math.abs(coldPlayer.delta) * 100)}% below their avg). It happens — bounce-back incoming.`);
  }

  const mapNotes = mapList.slice(0, 4)
    .map(m => `${m.map}: ${m.played} games, ${m.wins} wins`)
    .join(' · ');

  // ── Assemble embed ────────────────────────────────────────────────────────
  const description = intro;

  const fields = [
    motwText && {
      name:   '🏅 Match of the Week',
      value:  motwText,
      inline: false,
    },
    highlightsLines.length && {
      name:   '✨ Player Highlights',
      value:  highlightsLines.join('\n'),
      inline: false,
    },
    insight && {
      name:   '💡 Insight',
      value:  insight,
      inline: false,
    },
    mapNotes && {
      name:   '🗺 Maps This Week',
      value:  mapNotes,
      inline: false,
    },
  ].filter(Boolean);

  const embed = {
    author:    { name: `${_WC.emoji} ${_WC.shortName} Weekly Report` },
    color:     0x3B82F6,
    title:     `Week of ${dateRange}`,
    description,
    fields,
    footer:    { text: `Official matches only · Generated ${new Date().toLocaleString()}` },
    timestamp: new Date().toISOString(),
  };

  console.log('[Digest] Posting weekly digest to Discord…');
  await postWebhook(webhookUrl, { embeds: [embed] });
  console.log('[Digest] ✅ Posted successfully');
  // Write lock so we don't double-post this week
  try { fs.writeFileSync(LOCK_FILE, JSON.stringify({ week: currentWeek, postedAt: now.toISOString() })); } catch {}
}

if (require.main === module) {
  main().catch(e => { console.error('[Digest] Fatal:', e.message); process.exit(1); });
}
