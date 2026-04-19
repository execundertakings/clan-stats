'use strict';
// ── scripts/check_milestones.js ───────────────────────────────────────────────
// Checks for new player milestones each time it runs and posts to Discord.
// Safe to run daily — uses milestones_cache.json to never double-post.
//
// Milestones tracked:
//   🎯  Season kill thresholds  — 50, 100, 250, 500, 750, 1000
//   🍗  Season win thresholds   — 5, 10, 25, 50
//   ⚔️  Season K/D thresholds  — 1.0, 1.5, 2.0, 2.5, 3.0
//   🏅  New personal best game  — roundMostKills improves
//   🔥  Hot streak              — 3+ wins in last 7 games (30-day cooldown)
//
// Requires: DISCORD_WEBHOOK_URL in .env

const fs    = require('fs');
const path  = require('path');
const https = require('https');

const ROOT           = path.join(__dirname, '..');
const STATS_FILE     = path.join(ROOT, 'data', 'stats_cache.json');
const HISTORY_FILE   = path.join(ROOT, 'data', 'match_history_cache.json');
const MILESTONE_FILE = path.join(ROOT, 'data', 'milestones_cache.json');
const ENV_FILE       = path.join(ROOT, '.env');

// ── Milestone thresholds ──────────────────────────────────────────────────────
const KILL_THRESHOLDS = [50, 100, 250, 500, 750, 1000];
const WIN_THRESHOLDS  = [5, 10, 25, 50];
const KD_THRESHOLDS   = [1.0, 1.5, 2.0, 2.5, 3.0];
const STREAK_WINDOW   = 7;    // games to look back for streak
const STREAK_WINS     = 3;    // wins needed in window
const STREAK_COOLDOWN = 30 * 24 * 60 * 60 * 1000; // 30 days in ms

// ── Helpers ───────────────────────────────────────────────────────────────────
function loadEnv() {
  if (!fs.existsSync(ENV_FILE)) return {};
  return Object.fromEntries(
    fs.readFileSync(ENV_FILE, 'utf8').split('\n')
      .filter(l => l.includes('=') && !l.startsWith('#'))
      .map(l => { const i = l.indexOf('='); return [l.slice(0,i).trim(), l.slice(i+1).trim()]; })
  );
}

function extractStats(seasonData) {
  const gms = seasonData?.data?.attributes?.gameModeStats;
  if (!gms) return null;
  if (gms['squad-fpp']?.roundsPlayed > 0) return gms['squad-fpp'];
  if (gms['squad']?.roundsPlayed     > 0) return gms['squad'];
  return null;
}

function loadCache() {
  try { return JSON.parse(fs.readFileSync(MILESTONE_FILE, 'utf8')); } catch { return {}; }
}

function saveCache(cache) {
  fs.writeFileSync(MILESTONE_FILE, JSON.stringify(cache, null, 2));
}

function postWebhook(webhookUrl, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const url  = new URL(webhookUrl);
    const req  = https.request({
      hostname: url.hostname,
      path:     url.pathname + url.search,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

// ── Build history summary (latest N games per player) ─────────────────────────
function buildHistoryMap(historyCache) {
  // historyCache is the raw match_history_cache — result keyed by accountId
  const out = {};
  for (const [accountId, data] of Object.entries(historyCache.result || {})) {
    out[accountId] = { name: data.name, matches: data.matches || [] };
  }
  return out;
}

// ── Core milestone checker ────────────────────────────────────────────────────
async function checkMilestones({ verbose = false } = {}) {
  const env        = loadEnv();
  const webhookUrl = env.DISCORD_WEBHOOK_URL;

  if (!fs.existsSync(STATS_FILE)) {
    if (verbose) console.log('[Milestones] No stats cache — skipping');
    return { posted: 0, skipped: 'no stats cache' };
  }

  const statsCache   = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
  const seasonId     = statsCache.seasonId || 'unknown';
  const allStats     = statsCache.stats || [];

  // Load history for streak detection
  let historyMap = {};
  if (fs.existsSync(HISTORY_FILE)) {
    try {
      const hc = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
      historyMap = buildHistoryMap(hc);
    } catch {}
  }

  const cache = loadCache();
  // Per-season namespace so everything resets cleanly on season rollover
  if (!cache[seasonId]) cache[seasonId] = {};
  const sc = cache[seasonId]; // season-scoped milestone state

  const milestones = []; // { name, title, description, color }

  for (const entry of allStats) {
    const member = entry.member;
    if (!member?.accountId) continue;
    const s = extractStats(entry.season);
    if (!s || !s.roundsPlayed) continue;

    const accountId = member.accountId;
    const name      = member.name;
    if (!sc[accountId]) sc[accountId] = {};
    const p = sc[accountId]; // per-player state

    const kills        = s.kills        || 0;
    const wins         = s.wins         || 0;
    const deaths       = s.losses       || 1;
    const kdVal        = kills / deaths;
    const bestGame     = s.roundMostKills || 0;

    // ── Kill thresholds ────────────────────────────────────────────────────
    for (const threshold of KILL_THRESHOLDS) {
      const key = `kills_${threshold}`;
      if (kills >= threshold && !p[key]) {
        p[key] = true;
        milestones.push({
          name, color: 0xf87171,
          title: `🎯 ${name} — ${threshold} Season Kills`,
          description: `Just crossed **${threshold} kills** this season! (${kills} total, ${kdVal.toFixed(2)} K/D)`,
        });
        if (verbose) console.log(`  [Milestones] 🎯 ${name}: ${threshold} kills`);
        break; // post the highest crossed threshold per run, not all at once
      }
    }

    // ── Win thresholds ─────────────────────────────────────────────────────
    for (const threshold of WIN_THRESHOLDS) {
      const key = `wins_${threshold}`;
      if (wins >= threshold && !p[key]) {
        p[key] = true;
        milestones.push({
          name, color: 0x34d399,
          title: `🍗 ${name} — ${threshold} Chicken Dinners`,
          description: `Just hit **${threshold} wins** this season! (${wins} total in ${s.roundsPlayed} games, ${(wins/s.roundsPlayed*100).toFixed(1)}% win rate)`,
        });
        if (verbose) console.log(`  [Milestones] 🍗 ${name}: ${threshold} wins`);
        break;
      }
    }

    // ── K/D thresholds ─────────────────────────────────────────────────────
    // Only track once the player has at least 10 games (avoid fluky early spikes)
    if (s.roundsPlayed >= 10) {
      for (const threshold of KD_THRESHOLDS) {
        const key = `kd_${threshold.toFixed(1)}`;
        if (kdVal >= threshold && !p[key]) {
          p[key] = true;
          milestones.push({
            name, color: 0x818cf8,
            title: `⚔️ ${name} — K/D ${threshold.toFixed(1)}+`,
            description: `Season K/D just broke **${threshold.toFixed(1)}** — sitting at **${kdVal.toFixed(2)}** across ${s.roundsPlayed} games`,
          });
          if (verbose) console.log(`  [Milestones] ⚔️ ${name}: K/D ${threshold.toFixed(1)}`);
          break;
        }
      }
    }

    // ── Personal best game ─────────────────────────────────────────────────
    const prevBest = p.bestGame || 0;
    if (bestGame > prevBest && bestGame >= 5) { // only post if ≥5 kills (notable)
      const improved = prevBest > 0;
      p.bestGame = bestGame;
      milestones.push({
        name, color: 0xfbbf24,
        title: `🏅 ${name} — New Personal Best`,
        description: improved
          ? `New season best of **${bestGame} kills** in a single game — up from ${prevBest}!`
          : `Season-best **${bestGame} kills** in a single game this season`,
      });
      if (verbose) console.log(`  [Milestones] 🏅 ${name}: best game ${bestGame} kills (was ${prevBest})`);
    }

    // ── Hot streak — 3+ wins in last 7 games ───────────────────────────────
    const history  = historyMap[accountId]?.matches || [];
    const recent7  = history.slice(-STREAK_WINDOW);
    const recentWins = recent7.filter(m => m.won).length;

    if (recent7.length >= STREAK_WINDOW && recentWins >= STREAK_WINS) {
      const lastStreakAt = p.lastStreakAt || 0;
      if (Date.now() - lastStreakAt > STREAK_COOLDOWN) {
        p.lastStreakAt = Date.now();
        milestones.push({
          name, color: 0xfb923c,
          title: `🔥 ${name} — Hot Streak`,
          description: `**${recentWins} wins in their last ${STREAK_WINDOW} games** — they're on fire right now`,
        });
        if (verbose) console.log(`  [Milestones] 🔥 ${name}: hot streak ${recentWins}/${STREAK_WINDOW}`);
      }
    }
  }

  // Save updated cache regardless of whether we post
  saveCache(cache);

  if (!milestones.length) {
    if (verbose) console.log('[Milestones] No new milestones this run');
    return { posted: 0 };
  }

  if (!webhookUrl) {
    if (verbose) console.log(`[Milestones] ${milestones.length} milestone(s) found but no DISCORD_WEBHOOK_URL — skipping post`);
    return { posted: 0, milestones: milestones.length, reason: 'no webhook' };
  }

  // ── Post each milestone as its own embed ─────────────────────────────────
  let posted = 0, errors = 0;
  for (const m of milestones) {
    const embed = {
      author:    { name: '[APES] Milestone Unlocked' },
      title:     m.title,
      description: m.description,
      color:     m.color,
      footer:    { text: `Season ${seasonId.split('.').pop() || '?'} · Clan stats at localhost:3002` },
      timestamp: new Date().toISOString(),
    };
    try {
      const result = await postWebhook(webhookUrl, { embeds: [embed] });
      if (result.status >= 200 && result.status < 300) {
        posted++;
        if (verbose) console.log(`  [Milestones] ✅ Posted: ${m.title}`);
      } else {
        errors++;
        if (verbose) console.warn(`  [Milestones] ⚠ Webhook ${result.status} for "${m.title}": ${result.body.slice(0,100)}`);
      }
      // Brief pause between webhook calls to avoid rate limiting
      await new Promise(r => setTimeout(r, 400));
    } catch (e) {
      errors++;
      if (verbose) console.warn(`  [Milestones] ⚠ Error posting "${m.title}": ${e.message}`);
    }
  }

  if (verbose) console.log(`[Milestones] Done: ${posted} posted, ${errors} errors`);
  return { posted, errors, total: milestones.length };
}

// ── Baseline seeder — run once after deploying on an existing season ──────────
// Marks all current stats as "already seen" without posting anything.
// Use: node check_milestones.js --init
async function seedBaseline({ verbose = false } = {}) {
  if (!fs.existsSync(STATS_FILE)) {
    console.log('[Milestones --init] No stats cache found — nothing to seed');
    return;
  }

  const statsCache = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
  const seasonId   = statsCache.seasonId || 'unknown';
  const allStats   = statsCache.stats || [];

  let historyMap = {};
  if (fs.existsSync(HISTORY_FILE)) {
    try {
      const hc = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
      historyMap = buildHistoryMap(hc);
    } catch {}
  }

  const cache = loadCache();
  if (!cache[seasonId]) cache[seasonId] = {};
  const sc = cache[seasonId];

  let seeded = 0;
  for (const entry of allStats) {
    const member = entry.member;
    if (!member?.accountId) continue;
    const s = extractStats(entry.season);
    if (!s || !s.roundsPlayed) continue;

    const accountId = member.accountId;
    if (!sc[accountId]) sc[accountId] = {};
    const p = sc[accountId];

    const kills    = s.kills    || 0;
    const wins     = s.wins     || 0;
    const deaths   = s.losses   || 1;
    const kdVal    = kills / deaths;
    const bestGame = s.roundMostKills || 0;

    // Mark all currently-crossed thresholds as seen (no posting)
    for (const t of KILL_THRESHOLDS) if (kills >= t) p[`kills_${t}`] = true;
    for (const t of WIN_THRESHOLDS)  if (wins  >= t) p[`wins_${t}`]  = true;
    if (s.roundsPlayed >= 10) {
      for (const t of KD_THRESHOLDS) if (kdVal >= t) p[`kd_${t.toFixed(1)}`] = true;
    }
    // Seed best game at current value (only post if it improves)
    p.bestGame = Math.max(p.bestGame || 0, bestGame);

    seeded++;
    if (verbose) console.log(`  [init] Seeded ${member.name}: ${kills}K / ${wins}W / ${kdVal.toFixed(2)}KD / bestGame=${bestGame}`);
  }

  saveCache(cache);
  console.log(`[Milestones --init] Baseline seeded for ${seeded} players (season ${seasonId.split('.').pop() || '?'}) — no posts made`);
}

// ── CLI ───────────────────────────────────────────────────────────────────────
if (require.main === module) {
  const init = process.argv.includes('--init');
  if (init) {
    seedBaseline({ verbose: true })
      .catch(e => { console.error('[Milestones] Fatal:', e.message); process.exit(1); });
  } else {
    checkMilestones({ verbose: true })
      .then(r => console.log(`\n[Milestones] Summary: ${r.posted} posted, ${r.total || 0} found`))
      .catch(e => { console.error('[Milestones] Fatal:', e.message); process.exit(1); });
  }
}

module.exports = { checkMilestones, seedBaseline };
