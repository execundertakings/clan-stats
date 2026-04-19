#!/usr/bin/env node
'use strict';
// ── daily_clan.js ─────────────────────────────────────────────────────────────
// Daily orchestrator for APES clan automated tasks.
// Run via Cowork scheduled task at 6am daily.
//
// Add new daily tasks below in the TASKS array — each task is an async function
// that returns a summary string on success or throws on failure.

const http = require('http');
const { computeTrends }    = require('./compute_trends');
const { computeAnalysis }  = require('./compute_analysis');
const { fetchWeaponStats }   = require('./fetch_weapon_stats');
const { buildMatchHistory }    = require('./build_match_history');
const { buildSquadStats }      = require('./build_squad_stats');
const { buildLandingHeatmap }  = require('./build_landing_heatmap');
const { checkMilestones }      = require('./check_milestones');
const { execFileSync }         = require('child_process');

const PORT = process.env.PUBG_PORT ? parseInt(process.env.PUBG_PORT) : 3002;
const PREWARM_TIMEOUT_MS = 7 * 60 * 1000; // 7 min — enough for a full 29-player prewarm
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
const TASKS = [

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
    name: 'Compute Trends',
    run: async () => {
      const result = computeTrends();
      const top = Object.entries(result.correlations)
        .filter(([, r]) => r !== null)
        .sort(([, a], [, b]) => Math.abs(b) - Math.abs(a))[0];
      const topLabel = top ? `${top[0]} r=${top[1].toFixed(2)}` : 'no correlations';
      return `${result.playerCount} players · strongest: ${topLabel}`;
    },
  },

  {
    name: 'Compute Analysis',
    run: async () => {
      const result = computeAnalysis();
      // Find strongest non-circular correlation
      const top = Object.entries(result.correlations)
        .filter(([, c]) => c.r !== null)
        .sort(([, a], [, b]) => Math.abs(b.r) - Math.abs(a.r))[0];
      const topLabel = top ? `${top[1].label} r=${top[1].r.toFixed(2)}` : 'no correlations';
      return `${result.playerCount} players · ${result.insights.length} insights · strongest: ${topLabel}`;
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
    name: 'Check Milestones',
    run: async () => {
      const result = await checkMilestones({ verbose: true });
      if (result.reason) return `0 posted (${result.reason})`;
      return `${result.posted || 0} milestone(s) posted · ${result.total || 0} found`;
    },
  },

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

async function main() {
  const started = Date.now();
  console.log(`\n${'═'.repeat(56)}`);
  console.log(`[APES Daily] ${new Date().toLocaleString()}  —  ${TASKS.length} task(s)`);
  console.log(`${'═'.repeat(56)}`);

  const results = [];
  for (const task of TASKS) {
    const t0 = Date.now();
    process.stdout.write(`\n[${task.name}] Running…\n`);
    try {
      const summary = await task.run();
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`[${task.name}] ✓ ${summary} (${elapsed}s)`);
      results.push({ task: task.name, ok: true, summary });
    } catch (e) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      console.error(`[${task.name}] ✗ ${e.message} (${elapsed}s)`);
      results.push({ task: task.name, ok: false, error: e.message });
    }
  }

  const totalSecs = ((Date.now() - started) / 1000).toFixed(1);
  const passed = results.filter(r => r.ok).length;
  console.log(`\n${'─'.repeat(56)}`);
  console.log(`[APES Daily] Done in ${totalSecs}s — ${passed}/${results.length} tasks OK`);
  console.log(`${'─'.repeat(56)}\n`);

  const anyFailed = results.some(r => !r.ok);
  process.exit(anyFailed ? 1 : 0);
}

main().catch(e => {
  console.error('[APES Daily] Fatal:', e.message);
  process.exit(1);
});
