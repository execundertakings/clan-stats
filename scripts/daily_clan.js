#!/usr/bin/env node
'use strict';
// ── daily_clan.js ─────────────────────────────────────────────────────────────
// Daily orchestrator for the clan clan automated tasks.
// Run via Cowork scheduled task at 6am daily.
//
// Add new daily tasks below in the TASKS array — each task is an async function
// that returns a summary string on success or throws on failure.

const http = require('http');
const fs   = require('fs');
const path = require('path');
const { fetchWeaponStats }   = require('./fetch_weapon_stats');
const { fetchRecentMatches } = require('./fetch_recent_matches');
const { backfillTelemetry }  = require('./backfill_telemetry');
const { verifyIntegrity }    = require('./verify_integrity');
const { buildMatchHistory }    = require('./build_match_history');
const { buildSquadStats }      = require('./build_squad_stats');
const { buildLandingHeatmap }  = require('./build_landing_heatmap');
const { buildTelemetryInsights } = require('./build_telemetry_insights');
const { checkMilestones }      = require('./check_milestones');
const { execFileSync }         = require('child_process');
const { PORT }                 = require('../lib/config');

// 12 min ceiling — the prewarm itself takes ~10 min for a 39-player roster,
// observed 9.87 min on 2026-05-11. The previous 7-min ceiling was hardcoded
// for a 29-player roster and now consistently throws a false-timeout error
// even though the prewarm completes and downstream caches refresh fine.
const PREWARM_TIMEOUT_MS = 12 * 60 * 1000;
const POLL_INTERVAL_MS   = 5000;

// ── HTTP helpers (no external deps) ──────────────────────────────────────────
function httpGet(path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch { reject(new Error(`Bad JSON from ${path}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Request timed out')); });
  });
}

function httpPost(path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': 2 } }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Request timed out')); });
    req.write('{}');
    req.end();
  });
}

// Poll /api/prewarm/status until done, running, or timeout.
async function waitForPrewarm() {
  const deadline = Date.now() + PREWARM_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const s = await httpGet('/api/prewarm/status');
    if (s.done) return s;
    if (!s.running) return s; // not started / idle
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`Prewarm timed out after ${PREWARM_TIMEOUT_MS / 60000} min`);
}

// ─────────────────────────────────────────────────────────────────────────────
// TASKS — add new daily clan automations here
// ─────────────────────────────────────────────────────────────────────────────
const MEMBERS_FILE    = path.join(__dirname, '..', 'data', 'members.json');
const GRACE_PERIOD_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

const TASKS = [

  {
    name: 'Purge Expired Departures',
    run: async () => {
      const raw     = fs.readFileSync(MEMBERS_FILE, 'utf8');
      const members = JSON.parse(raw);
      const now     = Date.now();
      const expired = members.filter(m => m.removedAt && (now - new Date(m.removedAt).getTime()) >= GRACE_PERIOD_MS);
      if (!expired.length) return 'no expired departures';

      const kept = members.filter(m => !m.removedAt || (now - new Date(m.removedAt).getTime()) < GRACE_PERIOD_MS);
      fs.writeFileSync(MEMBERS_FILE, JSON.stringify(kept, null, 2));
      return `hard-deleted ${expired.length} member(s): ${expired.map(m => m.name).join(', ')}`;
    },
  },

  {
    name: 'Refresh PUBG Stats',
    run: async () => {
      // Check server is reachable
      await httpGet('/api/health').catch(() => {
        throw new Error(`Server not reachable on port ${PORT} — is node server.js running?`);
      });

      // Trigger prewarm
      await httpPost('/api/prewarm');
      console.log(`  → Prewarm triggered, polling every ${POLL_INTERVAL_MS / 1000}s…`);

      const status = await waitForPrewarm();
      const elapsed = status.elapsed ? `${Math.round(status.elapsed)}s` : '?';
      if (status.errors > 0) {
        console.log(`  ⚠ Prewarm finished with ${status.errors} error(s)`);
      }
      return `completed in ${elapsed} · ${status.completed || 0} passes · ${status.errors || 0} errors`;
    },
  },

  {
    name: 'Hydrate Recent Matches',
    run: async () => {
      const result = await fetchRecentMatches({ verbose: true });
      return `${result.uniqueRefs} refs · ${result.fetched} fetched · ${result.errors} errors`;
    },
  },

  {
    name: 'Backfill Telemetry',
    run: async () => {
      const r = await backfillTelemetry({ verbose: false });
      return `${r.fetched} fetched · ${r.failed} failed · coverage ~${(r.coverage * 100).toFixed(1)}% (${r.eligible} eligible)`;
    },
  },

  {
    name: 'Fetch Weapon Stats',
    run: async () => {
      const summary = await fetchWeaponStats({ verbose: true });
      const playerCount = Object.values(summary).filter(p => p.weapons.length > 0).length;
      const totalKills  = Object.values(summary).reduce((s, p) => s + p.weapons.reduce((a, w) => a + w.kills, 0), 0);
      return `${playerCount} players · ${totalKills} kills mapped`;
    },
  },

  {
    name: 'Build Match History',
    run: async () => {
      const result = buildMatchHistory({ verbose: false });
      const playerCount = Object.keys(result).length;
      const totalMatches = Object.values(result).reduce((s, p) => s + p.matches.length, 0);
      return `${playerCount} players · ${totalMatches} match records`;
    },
  },

  {
    name: 'Build Squad Stats',
    run: async () => {
      const result = buildSquadStats({ verbose: false });
      return `${result.pairCount} qualifying pairs · ${result.trioCount} qualifying trios`;
    },
  },

  {
    name: 'Build Landing Heatmap',
    run: async () => {
      const result = await buildLandingHeatmap({ verbose: false });
      return `${result.playerCount} players · ${result.totalSpots} landing spots · ${result.processedMatches} matches`;
    },
  },

  {
    name: 'Build Telemetry Playbook',
    run: async () => {
      const result = buildTelemetryInsights({ verbose: true });
      const cards = result.cards?.length || 0;
      const matches = result.coverage?.telemetryMatches || 0;
      const total = result.coverage?.officialMatches || 0;
      return `${cards} cards · ${matches}/${total} matches with telemetry`;
    },
  },

  {
    name: 'Verify Data Integrity',
    run: async () => {
      const r = verifyIntegrity({ verbose: true });
      if (!r.ok) throw new Error(`${r.errors.length} integrity error(s): ${r.errors.slice(0, 3).join(' | ')}${r.errors.length > 3 ? ' …' : ''}`);
      return `clean — ${r.players} players · ${r.uniqueGames} season matches recomputed exactly · ${r.warnings.length} warning(s)`;
    },
  },

  {
    name: 'Check Milestones',
    run: async () => {
      const result = await checkMilestones({ verbose: true });
      if (result.reason) return `0 posted (${result.reason})`;
      return `${result.posted || 0} milestone(s) posted · ${result.total || 0} found`;
    },
  },

  // NOTE: AI spotlight synthesis still belongs to the surrounding Cowork
  // scheduled task, but it is intentionally not part of this Node pipeline.
  // Phase A here stays deterministic; the scheduled-task instruction performs
  // Phase B with summarize_for_ai.js after these cache builders finish.

  // ── Sunday-only: post weekly digest to Discord ───────────────────────────
  // Runs every Sunday after all data tasks are fresh.
  // Requires DISCORD_WEBHOOK_URL in .env.
  ...(new Date().getDay() === 0 ? [{
    name: 'Weekly Discord Digest',
    run: async () => {
      const scriptPath = require('path').join(__dirname, 'build_weekly_digest.js');
      try {
        const out = execFileSync(process.execPath, [scriptPath], {
          timeout: 30000,
          env: { ...process.env },
          cwd: require('path').join(__dirname, '..'),
        }).toString().trim();
        console.log(out);
        return out.includes('Posted successfully') ? 'Digest posted ✅' : out;
      } catch (e) {
        throw new Error(e.stderr?.toString().trim() || e.message);
      }
    },
  }] : []),

];
// ─────────────────────────────────────────────────────────────────────────────

// ── Pipeline status + failure alerting ────────────────────────────────────────
// data/pipeline_status.json is the authoritative "did the pipeline complete
// today" record — the 6AM Cowork task's freshness check reads it, so a dead
// pipeline can't hide behind notifier-refreshed caches (the 6/2–6/10 outage).
const STATUS_FILE = path.join(__dirname, '..', 'data', 'pipeline_status.json');

function writeStatusFile(payload) {
  try {
    const tmp = STATUS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
    fs.renameSync(tmp, STATUS_FILE);
  } catch (e) {
    console.warn('[3PI Daily] Could not write pipeline_status.json:', e.message);
  }
}

// Best-effort Discord alert when any step fails — never throws, never blocks exit.
async function alertFailures(results) {
  try {
    const { loadEnv } = require('../lib/config');
    const { postWebhook } = require('../lib/discord');
    const webhookUrl = loadEnv().DISCORD_WEBHOOK_URL;
    if (!webhookUrl) return;
    const failed = results.filter(r => !r.ok);
    if (!failed.length) return;
    await postWebhook(webhookUrl, {
      embeds: [{
        title: `⚠️ Daily pipeline: ${failed.length} step(s) failed`,
        description: failed.map(f => `**${f.task}** — ${String(f.error).slice(0, 180)}`).join('\n'),
        footer: { text: 'See ~/Library/Logs/clan-daily-pipeline.log on the host' },
        color: 0xf87171,
      }],
    });
    console.log(`[3PI Daily] Posted failure alert for ${failed.length} step(s)`);
  } catch (e) {
    console.warn('[3PI Daily] Could not post failure alert:', e.message);
  }
}

async function main() {
  const started = Date.now();
  console.log(`\n${'═'.repeat(56)}`);
  console.log(`[3PI Daily] ${new Date().toLocaleString()}  —  ${TASKS.length} task(s)`);
  console.log(`${'═'.repeat(56)}`);

  const results = [];
  for (const task of TASKS) {
    const t0 = Date.now();
    process.stdout.write(`\n[${task.name}] Running…\n`);
    try {
      const summary = await task.run();
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`[${task.name}] ✓ ${summary} (${elapsed}s)`);
      results.push({ task: task.name, ok: true, summary, secs: +elapsed });
    } catch (e) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      console.error(`[${task.name}] ✗ ${e.message} (${elapsed}s)`);
      results.push({ task: task.name, ok: false, error: e.message, secs: +elapsed });
    }
  }

  const totalSecs = ((Date.now() - started) / 1000).toFixed(1);
  const passed = results.filter(r => r.ok).length;
  console.log(`\n${'─'.repeat(56)}`);
  console.log(`[3PI Daily] Done in ${totalSecs}s — ${passed}/${results.length} tasks OK`);
  console.log(`${'─'.repeat(56)}\n`);

  const anyFailed = results.some(r => !r.ok);
  writeStatusFile({
    date:       new Date().toISOString().slice(0, 10),
    startedAt:  new Date(started).toISOString(),
    finishedAt: new Date().toISOString(),
    totalSecs:  +totalSecs,
    allOk:      !anyFailed,
    passed,
    total:      results.length,
    results,
  });
  if (anyFailed) await alertFailures(results);
  process.exit(anyFailed ? 1 : 0);
}

main().catch(e => {
  console.error('[3PI Daily] Fatal:', e.message);
  process.exit(1);
});
