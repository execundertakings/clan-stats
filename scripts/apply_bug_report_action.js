#!/usr/bin/env node
'use strict';
// ── scripts/apply_bug_report_action.js — Safety enforcer for bug-report triage
//
// This script is invoked by the daily-clan scheduled task (Phase D)
// to apply ONE allow-listed action in response to a bug report. The action
// list lives in CODE here, not in instructions — so even if the LLM is
// talked into "running" a different action by report text, the script
// refuses.
//
// Usage:
//   node scripts/apply_bug_report_action.js \
//     --report-id <br_…> --action <key> [--param <string>] [--notes "<short>"] \
//     [--triaged-by <model name>] [--dry-run]
//
// Exit codes:
//   0  applied successfully (or dry-run validation passed)
//   2  rejected by allow-list or operational caps
//   3  bad input (missing args, malformed param, etc.)
//   1  unexpected error during execution
//
// The script writes the result back to data/bug_reports.json via lib/bug-reports.

const fs        = require('fs');
const path      = require('path');
const { spawnSync } = require('child_process');

const { BASE, DATA } = require('../lib/config');
const bugReports     = require('../lib/bug-reports');

// ── Allow-list ────────────────────────────────────────────────────────────────
// Each action either takes no parameter, or a strictly-validated parameter.
// We DO NOT allow shell pass-through — actions are dispatched to known scripts
// or in-process logic, never assembled into shell strings.

const ACTIONS = {
  rebuild_weapon_cache: {
    needsParam: false,
    cooldownMs: 12 * 60 * 60 * 1000,
    run: () => runScript('scripts/fetch_weapon_stats.js'),
    description: 'Re-run scripts/fetch_weapon_stats.js (re-derives weapon cache from telemetry).',
  },
  rebuild_match_history: {
    needsParam: false,
    cooldownMs: 12 * 60 * 60 * 1000,
    run: () => runScript('scripts/build_match_history.js'),
    description: 'Re-run scripts/build_match_history.js (re-aggregates from immutable match cache).',
  },
  rebuild_squad_stats: {
    needsParam: false,
    cooldownMs: 12 * 60 * 60 * 1000,
    run: () => runScript('scripts/build_squad_stats.js'),
    description: 'Re-run scripts/build_squad_stats.js.',
  },
  rebuild_landing_heatmap: {
    needsParam: false,
    cooldownMs: 12 * 60 * 60 * 1000,
    run: () => runScript('scripts/build_landing_heatmap.js'),
    description: 'Re-run scripts/build_landing_heatmap.js.',
  },
  clear_player_stats_cache_entry: {
    needsParam: true,
    validateParam: (p) => /^[A-Za-z0-9._-]{8,64}$/.test(p),
    cooldownMs: 1 * 60 * 60 * 1000, // narrower scope = shorter cooldown
    run: (param) => clearPlayerStatsCacheEntry(param),
    description: 'Remove one accountId from data/stats_cache.json so the next fetch is fresh from the PUBG API.',
  },
  refetch_match: {
    needsParam: true,
    validateParam: (p) => /^[A-Za-z0-9._-]{16,80}$/.test(p),
    cooldownMs: 1 * 60 * 60 * 1000,
    run: (param) => refetchMatch(param),
    description: 'Delete one file from data/match_cache/ so it gets re-fetched on the next history build.',
  },
};

// ── Operational caps (enforced even if the LLM tries to batch) ───────────────
const MAX_ACTIONS_PER_DAY = 3;

// ── Args ─────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === '--report-id')   { out.reportId   = next; i++; continue; }
    if (a === '--action')      { out.action     = next; i++; continue; }
    if (a === '--param')       { out.param      = next; i++; continue; }
    if (a === '--notes')       { out.notes      = next; i++; continue; }
    if (a === '--triaged-by')  { out.triagedBy  = next; i++; continue; }
    if (a === '--dry-run')     { out.dryRun     = true;       continue; }
    if (a === '--help' || a === '-h') { out.help = true; continue; }
  }
  return out;
}

function printHelp() {
  console.log('Usage: node scripts/apply_bug_report_action.js --report-id <id> --action <key> [--param <p>] [--notes "<short>"] [--triaged-by <model>] [--dry-run]');
  console.log('');
  console.log('Allow-listed actions:');
  for (const [k, v] of Object.entries(ACTIONS)) {
    console.log(`  ${k.padEnd(34)}  ${v.description}`);
  }
}

// ── Action implementations ───────────────────────────────────────────────────
function runScript(relPath) {
  const abs = path.join(BASE, relPath);
  if (!fs.existsSync(abs)) {
    return { ok: false, msg: `script ${relPath} not found` };
  }
  // No shell, no env merging from outside — Node invokes Node directly.
  const r = spawnSync(process.execPath, [abs], {
    cwd:       BASE,
    timeout:   10 * 60 * 1000, // 10 min hard cap
    encoding:  'utf8',
    stdio:     ['ignore', 'pipe', 'pipe'],
  });
  if (r.error)  return { ok: false, msg: `spawn error: ${r.error.message}` };
  if (r.status !== 0) {
    return { ok: false, msg: `exit ${r.status}: ${(r.stderr || '').slice(-300)}` };
  }
  const tail = (r.stdout || '').trim().split('\n').slice(-3).join(' | ');
  return { ok: true, msg: `ok — ${tail}` };
}

function clearPlayerStatsCacheEntry(accountId) {
  const file = path.join(DATA, 'stats_cache.json');
  if (!fs.existsSync(file)) return { ok: false, msg: 'stats_cache.json missing' };
  let cache;
  try { cache = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return { ok: false, msg: `parse error: ${e.message}` }; }

  const before = (cache.stats || []).length;
  cache.stats = (cache.stats || []).filter(e => e?.member?.accountId !== accountId);
  const after = cache.stats.length;

  if (before === after) {
    return { ok: false, msg: `accountId not in cache (no-op)` };
  }
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
  fs.renameSync(tmp, file);
  return { ok: true, msg: `removed accountId from stats_cache.json (${before} → ${after})` };
}

function refetchMatch(matchId) {
  const dir = path.join(DATA, 'match_cache');
  if (!fs.existsSync(dir)) return { ok: false, msg: 'match_cache/ missing' };

  // Defence in depth — extra path-traversal check on top of regex validation.
  const target = path.join(dir, `${matchId}.json`);
  const rel    = path.relative(dir, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return { ok: false, msg: `path traversal blocked` };
  }
  if (!fs.existsSync(target)) return { ok: false, msg: `match file not in cache (no-op)` };
  fs.unlinkSync(target);
  return { ok: true, msg: `deleted ${path.basename(target)} — will refetch on next history build` };
}

// ── Operational-cap checks ───────────────────────────────────────────────────
function countActionsAppliedToday() {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  return bugReports.listAll().filter(r =>
    r.status === 'applied' &&
    r.actionAppliedAt &&
    new Date(r.actionAppliedAt).getTime() >= cutoff
  ).length;
}

function lastAppliedAtFor(actionKey) {
  let latest = 0;
  for (const r of bugReports.listAll()) {
    if (r.actionTaken !== actionKey || !r.actionAppliedAt) continue;
    const ts = new Date(r.actionAppliedAt).getTime();
    if (ts > latest) latest = ts;
  }
  return latest;
}

// ── Main ─────────────────────────────────────────────────────────────────────
function main() {
  const args = parseArgs(process.argv);
  if (args.help) { printHelp(); process.exit(0); }

  if (!args.reportId)  { console.error('Missing --report-id');  process.exit(3); }
  if (!args.action)    { console.error('Missing --action');     process.exit(3); }

  const spec = ACTIONS[args.action];
  if (!spec) {
    console.error(`Refused: action "${args.action}" is not on the allow-list.`);
    console.error('Allowed:', Object.keys(ACTIONS).join(', '));
    process.exit(2);
  }

  const report = bugReports.findById(args.reportId);
  if (!report) {
    console.error(`Refused: report ${args.reportId} not found.`);
    process.exit(3);
  }

  // Idempotency — don't double-apply
  if (report.status === 'applied') {
    console.error(`Refused: report ${args.reportId} already has status=applied.`);
    process.exit(2);
  }

  // Param validation
  let param = null;
  if (spec.needsParam) {
    if (!args.param) {
      console.error(`Refused: action "${args.action}" requires --param.`);
      process.exit(3);
    }
    if (!spec.validateParam(args.param)) {
      console.error(`Refused: --param "${args.param}" did not pass validation for action "${args.action}".`);
      process.exit(2);
    }
    param = args.param;
  }

  // Daily cap
  const todayCount = countActionsAppliedToday();
  if (todayCount >= MAX_ACTIONS_PER_DAY) {
    console.error(`Refused: daily cap of ${MAX_ACTIONS_PER_DAY} actions reached (${todayCount} applied in last 24h).`);
    process.exit(2);
  }

  // Per-action cooldown
  const lastTs = lastAppliedAtFor(args.action);
  if (lastTs && (Date.now() - lastTs) < spec.cooldownMs) {
    const mins = Math.round((spec.cooldownMs - (Date.now() - lastTs)) / 60000);
    console.error(`Refused: cooldown on "${args.action}" — wait ~${mins} more minute(s).`);
    process.exit(2);
  }

  if (args.dryRun) {
    console.log(JSON.stringify({
      ok:     true,
      dryRun: true,
      action: args.action,
      param,
      report: args.reportId,
      message: 'All preflight checks passed; no action executed.',
    }, null, 2));
    process.exit(0);
  }

  // Run the action
  let result;
  try { result = spec.run(param); }
  catch (e)  { result = { ok: false, msg: `unhandled: ${e.message}` }; }

  // Persist the outcome on the report
  const patch = {
    triagedAt:        new Date().toISOString(),
    triagedBy:        args.triagedBy || 'apply_bug_report_action.js',
    triageNotes:      (args.notes || '').slice(0, 500) || null,
    actionTaken:      args.action,
    actionParam:      param,
    actionAppliedAt:  new Date().toISOString(),
    actionResult:     (result.msg || '').slice(0, 500),
    status:           result.ok ? 'applied' : 'needs_human',
    category:         report.category || 'data_inaccuracy',
    validity:         result.ok ? 'valid' : 'uncertain',
  };
  bugReports.updateReport(args.reportId, patch);

  console.log(JSON.stringify({
    ok:     result.ok,
    action: args.action,
    param,
    report: args.reportId,
    message: result.msg,
  }, null, 2));

  process.exit(result.ok ? 0 : 1);
}

if (require.main === module) {
  main();
}

module.exports = { ACTIONS, MAX_ACTIONS_PER_DAY };
