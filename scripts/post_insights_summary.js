#!/usr/bin/env node
'use strict';
// ── scripts/post_insights_summary.js ──────────────────────────────────────────
// Posts a short summary of today's AI insight cards to Discord, plus an
// optional "Yesterday's highlight" line when a single-game performance from
// the previous 24 hours clears a high bar.
//
// Reads:
//   data/ai_insights_cache.json   — the 5 cards just written by Phase B
//   data/match_history_cache.json — for scanning yesterday's matches
//
// Posts to DISCORD_WEBHOOK_URL.
//
// Highlight bar (a match qualifies if ANY of these are true):
//   • ≥ 8 kills in a single game (rare; PB-tier)
//   • ≥ 700 damage in a single game
//   • Chicken dinner with ≥ 5 kills
//   • Chicken dinner with ≥ 500 damage
//
// If multiple matches qualify, pick the highest score (kills * 100 + damage).
// If nothing qualifies, the highlight line is omitted entirely.

const fs   = require('fs');
const path = require('path');
const { postWebhook } = require('../lib/discord');
const { loadClanConfig } = require('../lib/config');

const ROOT          = path.join(__dirname, '..');
const ENV_FILE      = path.join(ROOT, '.env');
const CACHE_FILE    = path.join(ROOT, 'data', 'ai_insights_cache.json');
const HISTORY_FILE  = path.join(ROOT, 'data', 'match_history_cache.json');
const MEMBERS_FILE  = path.join(ROOT, 'data', 'members.json');
const SITE_URL      = loadClanConfig().site.publicUrl;

// Time window for the "Yesterday's highlight" scan.
const HIGHLIGHT_WINDOW_HOURS = 24;

// Absolute thresholds for what counts as notable — see comment above.
const BAR = {
  killsAny:      8,
  damageAny:     700,
  killsOnChicken: 5,
  damageOnChicken: 500,
};

function loadEnv() {
  if (!fs.existsSync(ENV_FILE)) return {};
  return Object.fromEntries(
    fs.readFileSync(ENV_FILE, 'utf8').split('\n')
      .filter(l => l.includes('=') && !l.startsWith('#'))
      .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
  );
}

function ordinal(n) {
  if (n == null) return '?';
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// Format one card as two lines: "{icon} **{title}**\n{tagline}".
// For glaze_* and roast_* cards we override the title with the short
// "Glaze: PlayerName" / "Roast: PlayerName" form, since the in-page card
// titles tend to be longer and theatrical and the Discord post wants
// scannable hooks instead.
function formatCardBlock(card) {
  const icon = card.icon ? card.icon + ' ' : '';
  let titleText = card.title;
  const primary = card.players && card.players[0];
  if (primary && card.id) {
    if (card.id.startsWith('glaze_')) titleText = `Glaze: ${primary}`;
    else if (card.id.startsWith('roast_')) titleText = `Roast: ${primary}`;
  }
  const head = `${icon}**${titleText}**`;
  if (card.tagline) return `${head}\n${card.tagline}`;
  return head;
}

// Scan match_history_cache for any single game in the last
// HIGHLIGHT_WINDOW_HOURS that clears the bar. Return the single best
// candidate, or null if nothing qualifies.
//
// Filter to clan members only — the match cache also contains entries for
// non-roster teammates observed in matches, which would otherwise get
// picked up and credited as clan achievements.
function pickHighlight(historyCache, rosterNames) {
  const cutoff = Date.now() - HIGHLIGHT_WINDOW_HOURS * 3600 * 1000;
  const candidates = [];
  const players = historyCache.result || {};
  const roster = new Set(rosterNames || []);

  for (const player of Object.values(players)) {
    const name = player.name;
    if (!name) continue;
    if (roster.size && !roster.has(name)) continue;
    for (const m of player.matches || []) {
      const t = Date.parse(m.date);
      if (!Number.isFinite(t) || t < cutoff || t > Date.now()) continue;

      const kills  = m.kills  || 0;
      const damage = m.damage || 0;
      const won    = !!m.won;

      const notable =
        kills  >= BAR.killsAny ||
        damage >= BAR.damageAny ||
        (won && kills  >= BAR.killsOnChicken) ||
        (won && damage >= BAR.damageOnChicken);

      if (notable) {
        candidates.push({
          name, kills, damage, won,
          placement: m.placement,
          map:       m.map,
          date:      m.date,
          score:     kills * 100 + damage,
        });
      }
    }
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0];
}

function formatHighlightLine(h) {
  if (!h) return null;
  const placement = h.won
    ? `Chicken Dinner on ${h.map}`
    : `${ordinal(h.placement)} on ${h.map}`;
  return `🎯 **Yesterday's highlight:** **${h.name}** dropped ${h.kills} kill${h.kills === 1 ? '' : 's'} and ${h.damage} damage — ${placement}.`;
}

function todayLabelFromComputedAt(iso) {
  // The card cache stamp is the canonical "today" for the post — use the
  // date portion only, in the user's local timezone (matches how Discord
  // users read it).
  try {
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
  } catch { return null; }
}

function buildMessage({ cache, highlight }) {
  const dateLabel = todayLabelFromComputedAt(cache.computedAt) || new Date().toISOString().slice(0, 10);

  const lines = [];
  lines.push(`**📊 AI Insights — ${dateLabel}**`);
  lines.push('');

  for (const card of cache.spotlights || []) {
    lines.push(formatCardBlock(card));
    lines.push('');
  }

  const hl = formatHighlightLine(highlight);
  if (hl) {
    lines.push(hl);
    lines.push('');
  }

  lines.push(`Check out stats, trends and analysis at <${SITE_URL}>`);

  return lines.join('\n');
}

async function postInsightsSummary({ verbose = false, dryRun = false } = {}) {
  const env = loadEnv();
  const webhookUrl = env.DISCORD_WEBHOOK_URL;

  if (!fs.existsSync(CACHE_FILE)) {
    return { posted: false, reason: 'no ai_insights_cache.json' };
  }
  const cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  if (!cache.spotlights || !cache.spotlights.length) {
    return { posted: false, reason: 'empty spotlights array' };
  }

  let highlight = null;
  if (fs.existsSync(HISTORY_FILE)) {
    try {
      const history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
      let roster = [];
      try {
        const members = JSON.parse(fs.readFileSync(MEMBERS_FILE, 'utf8'));
        roster = (Array.isArray(members) ? members : []).map(m => m.name).filter(Boolean);
      } catch { /* fall through with empty roster — pickHighlight treats empty as "no filter" */ }
      highlight = pickHighlight(history, roster);
    } catch (e) {
      if (verbose) console.log(`[InsightsSummary] history scan failed: ${e.message}`);
    }
  }

  const content = buildMessage({ cache, highlight });

  if (dryRun || !webhookUrl) {
    if (verbose || dryRun) {
      console.log('───── message preview ─────');
      console.log(content);
      console.log('────────────────────────────');
    }
    if (!webhookUrl) return { posted: false, reason: 'no DISCORD_WEBHOOK_URL' };
    return { posted: false, reason: 'dry-run', highlight, content };
  }

  await postWebhook(webhookUrl, {
    content,
    // Suppress unfurl preview — the site URL is enough on its own.
    flags: 4, // SUPPRESS_EMBEDS
  });

  return {
    posted: true,
    cardCount: cache.spotlights.length,
    highlight: highlight ? `${highlight.name} ${highlight.kills}k/${highlight.damage}d on ${highlight.map}` : null,
  };
}

// CLI entry point
if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  postInsightsSummary({ verbose: true, dryRun })
    .then(r => {
      if (r.posted) {
        console.log(`[InsightsSummary] ✓ Posted ${r.cardCount} cards${r.highlight ? ` · highlight: ${r.highlight}` : ' · no highlight cleared the bar'}`);
      } else {
        console.log(`[InsightsSummary] not posted (${r.reason})`);
      }
    })
    .catch(e => {
      console.error(`[InsightsSummary] ✗ ${e.message}`);
      process.exit(1);
    });
}

module.exports = { postInsightsSummary, pickHighlight, buildMessage };
