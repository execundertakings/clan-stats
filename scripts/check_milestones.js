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
const { postWebhook } = require('../lib/discord');
const { loadClanConfig } = require('../lib/config');
const MTAG = `[${loadClanConfig().clan.tag}]`;

const ROOT           = path.join(__dirname, '..');
const HISTORY_FILE   = path.join(ROOT, 'data', 'match_history_cache.json');
const SEASON_FILE    = path.join(ROOT, 'data', 'season.json');
const MILESTONE_FILE = path.join(ROOT, 'data', 'milestones_cache.json');
// Append-only event log of fired milestones (timestamped). Separate from the
// dedupe state in milestones_cache.json — used by summarize_for_ai.js to
// surface "recently posted" milestones to the AI synthesis step.
const MILESTONE_EVENTS_FILE = path.join(ROOT, 'data', 'milestone_events.json');
const MILESTONE_EVENT_RETENTION_DAYS = 90;
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

// Load the current season ID from season.json (saved by the prewarm process)
function loadSeasonId() {
  try {
    const d = JSON.parse(fs.readFileSync(SEASON_FILE, 'utf8'));
    return d.seasonId || 'unknown';
  } catch { return 'unknown'; }
}

function loadCache() {
  try { return JSON.parse(fs.readFileSync(MILESTONE_FILE, 'utf8')); } catch { return {}; }
}

function saveCache(cache) {
  fs.writeFileSync(MILESTONE_FILE, JSON.stringify(cache, null, 2));
}

// ── Core milestone checker ────────────────────────────────────────────────────
async function checkMilestones({ verbose = false } = {}) {
  const env        = loadEnv();
  const webhookUrl = env.DISCORD_WEBHOOK_URL;

  if (!fs.existsSync(HISTORY_FILE)) {
    if (verbose) console.log('[Milestones] No match history cache — skipping');
    return { posted: 0, skipped: 'no history cache' };
  }

  const historyCache = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
  const seasonId     = loadSeasonId();
  const allPlayers   = Object.entries(historyCache.result || {});

  const cache = loadCache();
  // Per-season namespace so everything resets cleanly on season rollover
  if (!cache[seasonId]) cache[seasonId] = {};
  const sc = cache[seasonId]; // season-scoped milestone state

  const milestones = []; // { name, title, description, color }

  for (const [accountId, data] of allPlayers) {
    const name = data.name;
    if (!name) continue;
    const s = data.totals; // official-only match totals
    if (!s || !s.roundsPlayed) continue;

    const matches      = data.matches || [];
    const kills        = s.kills    || 0;
    const wins         = s.wins     || 0;
    const deaths       = s.losses   || 1;
    const kdVal        = kills / deaths;
    // Compute best-game directly from the match list — the canonical record.
    // Avoids depending on totals.roundMostKills, which can lag the match list
    // if totals get aggregated from a stale snapshot.
    const bestGame     = matches.reduce((max, m) => Math.max(max, m.kills || 0), 0);

    // Cold-start seeding: if this is the first time we've seen this player,
    // seed every milestone marker from current state WITHOUT firing alerts.
    // Otherwise the first run after a player joins (or after a cache reset)
    // posts a flood of misleading "X just hit Y" milestones for things that
    // happened arbitrarily long ago.
    if (!sc[accountId]) {
      sc[accountId] = {};
      const seed = sc[accountId];
      for (const t of KILL_THRESHOLDS) if (kills >= t) seed[`kills_${t}`] = true;
      for (const t of WIN_THRESHOLDS)  if (wins  >= t) seed[`wins_${t}`]  = true;
      if (s.roundsPlayed >= 10) {
        for (const t of KD_THRESHOLDS) if (kdVal >= t) seed[`kd_${t.toFixed(1)}`] = true;
      }
      seed.bestGame = bestGame;
      if (verbose) console.log(`  [Milestones] 🌱 Cold-start seeded ${name}: ${kills}K / ${wins}W / ${kdVal.toFixed(2)}KD / bestGame=${bestGame}`);
      continue; // skip the rest of the loop — alerts only fire on subsequent runs
    }
    const p = sc[accountId]; // per-player state

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
          description: `Just hit **${threshold} wins** this season! (${wins} total in ${s.roundsPlayed} official games, ${(wins/s.roundsPlayed*100).toFixed(1)}% win rate)`,
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
    const history  = data.matches || [];
    const recent7  = history.slice(0, STREAK_WINDOW); // matches sorted newest-first
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

  // Append fired milestones to the timestamped event log (so summarize_for_ai
  // can surface "recent milestones" to the AI synthesis step). The dedupe
  // state lives in milestones_cache.json — this is purely an event audit.
  if (milestones.length) {
    let events = [];
    try { events = JSON.parse(fs.readFileSync(MILESTONE_EVENTS_FILE, 'utf8')); } catch {}
    if (!Array.isArray(events)) events = [];
    const at = new Date().toISOString();
    for (const m of milestones) {
      events.push({ at, name: m.name, title: m.title, description: m.description });
    }
    const cutoff = Date.now() - MILESTONE_EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    events = events.filter(e => {
      const t = Date.parse(e.at || 0);
      return Number.isFinite(t) && t >= cutoff;
    });
    try { fs.writeFileSync(MILESTONE_EVENTS_FILE, JSON.stringify(events, null, 2)); }
    catch (e) { if (verbose) console.warn('[Milestones] event-log write failed:', e.message); }
  }

  if (!milestones.length) {
    if (verbose) console.log('[Milestones] No new milestones this run');
    return { posted: 0 };
  }

  if (!webhookUrl) {
    if (verbose) console.log(`[Milestones] ${milestones.length} milestone(s) found but no DISCORD_WEBHOOK_URL — skipping post`);
    return { posted: 0, milestones: milestones.length, reason: 'no webhook' };
  }

  // ── Post each milestone as its own embed ─────────────────────────────────
  // Footer links the public site (config-driven) — never localhost in Discord posts.
  let siteUrl = 'https://3pi.executiveundertakings.com';
  try { siteUrl = require('../lib/config').loadClanConfig().site.publicUrl || siteUrl; } catch {}
  let posted = 0, errors = 0;
  for (const m of milestones) {
    const embed = {
      author:    { name: `${MTAG} Milestone Unlocked` },
      title:     m.title,
      description: m.description,
      color:     m.color,
      footer:    { text: `Season ${seasonId.split('.').pop?.() || seasonId} · Clan stats at ${siteUrl.replace(/^https?:\/\//, '')}` },
      timestamp: new Date().toISOString(),
    };
    try {
      await postWebhook(webhookUrl, { embeds: [embed] });
      posted++;
      if (verbose) console.log(`  [Milestones] ✅ Posted: ${m.title}`);
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
  if (!fs.existsSync(HISTORY_FILE)) {
    console.log('[Milestones --init] No match history cache found — nothing to seed');
    return;
  }

  const historyCache = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
  const seasonId     = loadSeasonId();
  const allPlayers   = Object.entries(historyCache.result || {});

  const cache = loadCache();
  if (!cache[seasonId]) cache[seasonId] = {};
  const sc = cache[seasonId];

  let seeded = 0;
  for (const [accountId, data] of allPlayers) {
    const name = data.name;
    if (!name) continue;
    const s = data.totals;
    if (!s || !s.roundsPlayed) continue;

    if (!sc[accountId]) sc[accountId] = {};
    const p = sc[accountId];

    const matches  = data.matches || [];
    const kills    = s.kills    || 0;
    const wins     = s.wins     || 0;
    const deaths   = s.losses   || 1;
    const kdVal    = kills / deaths;
    const bestGame = matches.reduce((max, m) => Math.max(max, m.kills || 0), 0);

    // Mark all currently-crossed thresholds as seen (no posting)
    for (const t of KILL_THRESHOLDS) if (kills >= t) p[`kills_${t}`] = true;
    for (const t of WIN_THRESHOLDS)  if (wins  >= t) p[`wins_${t}`]  = true;
    if (s.roundsPlayed >= 10) {
      for (const t of KD_THRESHOLDS) if (kdVal >= t) p[`kd_${t.toFixed(1)}`] = true;
    }
    // Seed best game at current value (only post if it improves)
    p.bestGame = Math.max(p.bestGame || 0, bestGame);

    seeded++;
    if (verbose) console.log(`  [init] Seeded ${name}: ${kills}K / ${wins}W / ${kdVal.toFixed(2)}KD / bestGame=${bestGame}`);
  }

  saveCache(cache);
  console.log(`[Milestones --init] Baseline seeded for ${seeded} players (season ${seasonId.split('.').pop?.() || seasonId}) — no posts made`);
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
