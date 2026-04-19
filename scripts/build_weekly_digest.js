'use strict';
// ── scripts/build_weekly_digest.js ────────────────────────────────────────────
// Builds and posts a weekly PUBG clan stats digest to Discord via webhook.
// Run every Sunday morning via launchd/cron.
//
// What it reports (last 7 days of match_history_cache):
//   🏆 Top Killer       — most kills in the window
//   ⚔️  Best K/D        — highest K/D among players with ≥3 games this week
//   💥 Damage Dealer    — highest avg damage per game (≥3 games)
//   🤝 Dynamic Duo      — pair with most games together this week
//   🗺 Map of the Week  — map with most APES games
//   🔵 Zone Offender    — player who took the most blue zone damage (from weapon_cache)
//   📈 Hot Streak       — player with the biggest form improvement vs their overall avg
//   🏅 Best Game        — highest single-game kill count
//
// Requires: DISCORD_WEBHOOK_URL in .env

const fs   = require('fs');
const path = require('path');
const https = require('https');

const ROOT         = path.join(__dirname, '..');
const HISTORY_FILE = path.join(ROOT, 'data', 'match_history_cache.json');
const WEAPON_FILE  = path.join(ROOT, 'data', 'weapon_cache.json');
const ENV_FILE     = path.join(ROOT, '.env');

// ── Helpers ───────────────────────────────────────────────────────────────────
function loadEnv() {
  if (!fs.existsSync(ENV_FILE)) return {};
  return Object.fromEntries(
    fs.readFileSync(ENV_FILE, 'utf8').split('\n')
      .filter(l => l.includes('=') && !l.startsWith('#'))
      .map(l => { const i = l.indexOf('='); return [l.slice(0,i).trim(), l.slice(i+1).trim()]; })
  );
}

function postWebhook(webhookUrl, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const url  = new URL(webhookUrl);
    const req  = https.request({
      hostname: url.hostname, path: url.pathname + url.search,
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function num(n) { return n?.toLocaleString() ?? '0'; }
function kd(kills, deaths) { return deaths > 0 ? (kills / deaths).toFixed(2) : kills.toFixed(2); }

// ── Window: last N days ───────────────────────────────────────────────────────
const WINDOW_DAYS = 7;
const cutoff = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000);

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
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

  const histCache = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
  const allPlayers = Object.values(histCache.result || {});

  // Filter each player's matches to the past WINDOW_DAYS
  const weeklyPlayers = allPlayers.map(player => {
    const recent = (player.matches || []).filter(m => m.date && new Date(m.date) >= cutoff);
    return { ...player, weekMatches: recent };
  }).filter(p => p.weekMatches.length > 0);

  if (!weeklyPlayers.length) {
    console.log('[Digest] No matches in the past week — nothing to post');
    process.exit(0);
  }

  const totalGames = weeklyPlayers.reduce((s, p) => s + p.weekMatches.length, 0);
  const totalKills = weeklyPlayers.reduce((s, p) => s + p.weekMatches.reduce((ss, m) => ss + (m.kills||0), 0), 0);
  const totalWins  = weeklyPlayers.reduce((s, p) => s + p.weekMatches.filter(m => m.won).length, 0);
  // Each game has squad of ~4, so unique games ≈ totalGames / avg squad size
  const uniqueGames = Math.round(totalGames / 3.5);

  // ── Top Killer ────────────────────────────────────────────────────────────
  const killTotals = weeklyPlayers.map(p => ({
    name:   p.name,
    kills:  p.weekMatches.reduce((s, m) => s + (m.kills||0), 0),
    games:  p.weekMatches.length,
  })).sort((a, b) => b.kills - a.kills);
  const topKiller = killTotals[0];

  // ── Best K/D (min 3 games) ────────────────────────────────────────────────
  const kdRanking = weeklyPlayers
    .filter(p => p.weekMatches.length >= 3)
    .map(p => {
      const kills  = p.weekMatches.reduce((s, m) => s + (m.kills||0), 0);
      const deaths = p.weekMatches.filter(m => !m.won).length || 1;
      return { name: p.name, kills, deaths, kdVal: kills / deaths, games: p.weekMatches.length };
    }).sort((a, b) => b.kdVal - a.kdVal);
  const bestKD = kdRanking[0];

  // ── Best Avg Damage (min 3 games) ─────────────────────────────────────────
  const dmgRanking = weeklyPlayers
    .filter(p => p.weekMatches.length >= 3)
    .map(p => {
      const totalDmg = p.weekMatches.reduce((s, m) => s + (m.damage||0), 0);
      return { name: p.name, avgDmg: totalDmg / p.weekMatches.length, games: p.weekMatches.length };
    }).sort((a, b) => b.avgDmg - a.avgDmg);
  const bestDamage = dmgRanking[0];

  // ── Best Single Game (most kills) ─────────────────────────────────────────
  let bestGame = null;
  for (const p of weeklyPlayers) {
    for (const m of p.weekMatches) {
      if (!bestGame || m.kills > bestGame.kills) bestGame = { name: p.name, kills: m.kills, map: m.map, placement: m.placement };
    }
  }

  // ── Map of the Week ───────────────────────────────────────────────────────
  const mapCounts = {};
  for (const p of weeklyPlayers) {
    for (const m of p.weekMatches) {
      if (m.map) mapCounts[m.map] = (mapCounts[m.map] || 0) + 1;
    }
  }
  const mapOfWeek = Object.entries(mapCounts).sort((a, b) => b[1] - a[1])[0];

  // ── Dynamic Duo (pair with most games) ───────────────────────────────────
  const pairGames = {};
  const seenPairs = new Set();
  for (const p of weeklyPlayers) {
    for (const m of p.weekMatches) {
      const key = `${p.name}|${m.matchId}`;
      if (seenPairs.has(key)) continue;
      seenPairs.add(key);
      const teammates = (m.teammates || []).map(t => t.name).filter(Boolean);
      for (const mate of teammates) {
        const pairKey = [p.name, mate].sort().join(' + ');
        pairGames[pairKey] = (pairGames[pairKey] || 0) + 1;
      }
    }
  }
  const topPair = Object.entries(pairGames).sort((a, b) => b[1] - a[1])[0];

  // ── Blue Zone Offender (from weapon_cache) ────────────────────────────────
  let blueZoneOffender = null;
  if (fs.existsSync(WEAPON_FILE)) {
    const wc = JSON.parse(fs.readFileSync(WEAPON_FILE, 'utf8'));
    const ranked = Object.values(wc.players || {})
      .filter(p => (p.blueZoneMatches||0) >= 5 && p.blueZoneDamage > 0)
      .map(p => ({ name: p.name, avg: +(p.blueZoneDamage / p.blueZoneMatches).toFixed(1), matches: p.blueZoneMatches }))
      .sort((a, b) => b.avg - a.avg);
    blueZoneOffender = ranked[0] || null;
  }

  // ── Hot Streak (biggest positive form delta vs overall) ───────────────────
  const formRanking = weeklyPlayers
    .filter(p => p.weekMatches.length >= 3 && p.matches?.length >= 10)
    .map(p => {
      // Overall avg kills+damage per game
      const allMatches = p.matches || [];
      const overallAvg = allMatches.reduce((s, m) => s + (m.kills||0) * 300 + (m.damage||0), 0) / allMatches.length;
      const weekAvg    = p.weekMatches.reduce((s, m) => s + (m.kills||0) * 300 + (m.damage||0), 0) / p.weekMatches.length;
      const delta      = overallAvg > 0 ? (weekAvg - overallAvg) / overallAvg : 0;
      return { name: p.name, delta, weekGames: p.weekMatches.length };
    }).sort((a, b) => b.delta - a.delta);
  const hotStreak = formRanking[0];

  // ── Build Discord embed ───────────────────────────────────────────────────
  const dateRange = (() => {
    const now   = new Date();
    const start = new Date(cutoff);
    const fmt   = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    return `${fmt(start)} – ${fmt(now)}`;
  })();

  const fields = [
    {
      name:   '📊 Week at a Glance',
      value:  `**${uniqueGames}** matches played · **${num(totalKills)}** kills · **${totalWins}** wins · ${(totalWins / Math.max(uniqueGames, 1) * 100).toFixed(1)}% win rate`,
      inline: false,
    },
    topKiller && {
      name:   '🏆 Top Killer',
      value:  `**${topKiller.name}** — ${num(topKiller.kills)} kills in ${topKiller.games} games (${(topKiller.kills / topKiller.games).toFixed(1)}/g)`,
      inline: true,
    },
    bestKD && {
      name:   '⚔️ Best K/D',
      value:  `**${bestKD.name}** — ${kd(bestKD.kills, bestKD.deaths)} K/D over ${bestKD.games} games`,
      inline: true,
    },
    bestDamage && {
      name:   '💥 Damage Dealer',
      value:  `**${bestDamage.name}** — ${Math.round(bestDamage.avgDmg)} avg dmg over ${bestDamage.games} games`,
      inline: true,
    },
    bestGame && bestGame.kills >= 5 && {
      name:   '🏅 Best Game',
      value:  `**${bestGame.name}** — ${bestGame.kills} kills on ${bestGame.map} (place #${bestGame.placement})`,
      inline: true,
    },
    mapOfWeek && {
      name:   '🗺 Most Played Map',
      value:  `**${mapOfWeek[0]}** — ${mapOfWeek[1]} squad appearances`,
      inline: true,
    },
    topPair && topPair[1] >= 2 && {
      name:   '🤝 Dynamic Duo',
      value:  `**${topPair[0]}** — ${topPair[1]} games together`,
      inline: true,
    },
    blueZoneOffender && {
      name:   '🔵 Zone Offender',
      value:  `**${blueZoneOffender.name}** — ${blueZoneOffender.avg} avg zone dmg/game 😬`,
      inline: true,
    },
    hotStreak && hotStreak.delta > 0.08 && {
      name:   '📈 Hot This Week',
      value:  `**${hotStreak.name}** — +${Math.round(hotStreak.delta * 100)}% vs their overall avg (${hotStreak.weekGames} games)`,
      inline: true,
    },
  ].filter(Boolean);

  const embed = {
    author:      { name: '[APES] Weekly Clan Digest' },
    color:       0x3B82F6,
    title:       `Week of ${dateRange}`,
    fields,
    footer:      { text: `Generated ${new Date().toLocaleString()}` },
    timestamp:   new Date().toISOString(),
  };

  console.log('[Digest] Posting weekly digest to Discord…');
  const result = await postWebhook(webhookUrl, { embeds: [embed] });
  if (result.status >= 200 && result.status < 300) {
    console.log('[Digest] ✅ Posted successfully');
  } else {
    console.error(`[Digest] ⚠ Webhook returned ${result.status}: ${result.body}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch(e => { console.error('[Digest] Fatal:', e.message); process.exit(1); });
}
