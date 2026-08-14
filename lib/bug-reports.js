'use strict';
// ── lib/bug-reports.js — Storage + safety helpers for /bugreport ──────────────
// User-submitted bug reports are UNTRUSTED text that ends up as input to the
// daily-clan scheduled task (an LLM with filesystem + shell access).
// Every helper here is conservative on purpose. Code-level guards back up the
// instructional guards in scheduled-tasks/daily-clan.skill.md.
//
// File on disk:  data/bug_reports.json
// Schema:
//   {
//     "version":  1,
//     "reports": [
//       {
//         "id":            "br_<unix>_<6hex>",
//         "submittedAt":   "<ISO>",
//         "discordId":     "<string>",
//         "submitterName": "<string>",     // Discord display name at submit time
//         "memberName":    "<string|null>",// matched clan roster name at submit time
//         "text":          "<sanitised>",
//         "textHash":      "<sha256:16>",  // for dedupe
//         "status":        "open" | "triaged_noop" | "applied" |
//                          "rejected_out_of_scope" | "rejected_not_member" |
//                          "rejected_prompt_injection" | "duplicate" | "needs_human",
//         "category":      "data_inaccuracy" | "ui_bug" | "missing_data" |
//                          "discord_bug" | "feature_request" | "complaint" |
//                          "prompt_injection_attempt" | "unclear" | "other" | null,
//         "validity":      "valid" | "invalid" | "uncertain" | null,
//         "triagedAt":     "<ISO>|null",
//         "triagedBy":     "<model name>|null",
//         "triageNotes":   "<string>|null",
//         "actionTaken":   "<allow-list key>|null",
//         "actionParam":   "<string>|null",
//         "actionAppliedAt":"<ISO>|null",
//         "actionResult":  "<string>|null"
//       }
//     ]
//   }

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

const { DATA } = require('./config');

const REPORTS_FILE = path.join(DATA, 'bug_reports.json');

// ── Limits ───────────────────────────────────────────────────────────────────
const MAX_TEXT_LEN          = 2000;                  // chars after sanitisation
const RATE_WINDOW_MS        = 24 * 60 * 60 * 1000;   // 24h
const MAX_REPORTS_PER_WINDOW = 10;
const DEDUPE_WINDOW_MS      = 24 * 60 * 60 * 1000;   // identical text → reject

// ── Prompt-injection sniff list ──────────────────────────────────────────────
// These are flagged at submit time (so the report gets stored AND tagged for
// the triage step to see, rather than silently dropped). Triage downgrades
// these to status=rejected_prompt_injection.
//
// We do NOT block them at submit time — that would tell an attacker which
// strings we're checking. We accept-and-tag. The author still gets a DM.
const PROMPT_INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?previous/i,
  /disregard\s+(all\s+)?previous/i,
  /system\s*[:>]\s/i,
  /<\|im_start\|>/i,
  /<\|im_end\|>/i,
  /\[INST\]/i,
  /\[\/INST\]/i,
  /<\s*\/?\s*system\s*>/i,
  /<\s*\/?\s*prompt\s*>/i,
  /<\s*\/?\s*instructions?\s*>/i,
  /you\s+are\s+(now\s+)?(an?\s+)?(unrestricted|jailbroken|dan\b|dev[- ]?mode)/i,
  /role\s*[:=]\s*(assistant|system|admin|root|developer)/i,
  /developer\s+mode/i,
  /act\s+as\s+(if\s+)?(you\s+are\s+)?(an?\s+)?(admin|root|developer|god|unrestricted)/i,
  /override\s+(your|the)\s+(rules|instructions|guidelines|policy)/i,
  /override\s+safety/i,
  /jailbreak/i,
  /from\s+now\s+on/i,
  /forget\s+(your|all)\s+(prior|previous|earlier)\s+(rules|instructions)/i,
  // attempts to invoke specific powerful actions by name
  /\brm\s+-rf\b/i,
  /\bcurl\s+.*\bapi\.anthropic\.com/i,
  /\bexec\s*\(/i,
  /\bbash\s*-c\b/i,
];

function hasPromptInjectionMarkers(text) {
  return PROMPT_INJECTION_PATTERNS.some(re => re.test(text));
}

// ── Text sanitisation ────────────────────────────────────────────────────────
// Goals: strip control chars and zero-width spaces, normalise whitespace,
// clamp length. Preserve newlines and printable Unicode.
function sanitiseText(input) {
  if (typeof input !== 'string') return '';
  let s = input;

  // Strip ASCII control chars except \t and \n
  s = s.replace(/[\x00-\x08\x0B-\x1F\x7F]/g, '');
  // Strip zero-width / format chars: ZWSP (U+200B) through RLO (U+202E),
  // WJ (U+2060), BOM (U+FEFF), soft hyphen (U+00AD)
  s = s.replace(/[​-‏‪-‮⁠﻿­]/g, '');
  // Collapse runs of >2 newlines
  s = s.replace(/\n{3,}/g, '\n\n');
  // Trim
  s = s.trim();
  // Clamp length
  if (s.length > MAX_TEXT_LEN) s = s.slice(0, MAX_TEXT_LEN);
  return s;
}

function hashText(text) {
  return crypto.createHash('sha256').update(text || '').digest('hex').slice(0, 16);
}

function newReportId() {
  return `br_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
}

// ── Storage ──────────────────────────────────────────────────────────────────
function loadStore() {
  try {
    const raw = JSON.parse(fs.readFileSync(REPORTS_FILE, 'utf8'));
    if (!raw || typeof raw !== 'object') return { version: 1, reports: [] };
    if (!Array.isArray(raw.reports)) return { version: 1, reports: [] };
    return raw;
  } catch {
    return { version: 1, reports: [] };
  }
}

function saveStore(store) {
  // Atomic write — protects against concurrent crashes mid-write
  const tmp = REPORTS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, REPORTS_FILE);
}

// ── Query helpers ────────────────────────────────────────────────────────────
function listForDiscordId(discordId) {
  if (!discordId) return [];
  const store = loadStore();
  return store.reports
    .filter(r => r.discordId === discordId)
    .sort((a, b) => (b.submittedAt || '').localeCompare(a.submittedAt || ''));
}

function listOpen() {
  const store = loadStore();
  return store.reports.filter(r => r.status === 'open');
}

function listAll() {
  return loadStore().reports.slice();
}

function findById(id) {
  if (!id) return null;
  return loadStore().reports.find(r => r.id === id) || null;
}

// Count reports submitted by this discordId within the rolling window
function recentCount(discordId, now = Date.now()) {
  if (!discordId) return 0;
  const cutoff = now - RATE_WINDOW_MS;
  return loadStore().reports.filter(r =>
    r.discordId === discordId &&
    new Date(r.submittedAt).getTime() >= cutoff
  ).length;
}

// Check whether identical text from same user landed within the dedupe window
function isDuplicateSubmission(discordId, textHash, now = Date.now()) {
  if (!discordId || !textHash) return false;
  const cutoff = now - DEDUPE_WINDOW_MS;
  return loadStore().reports.some(r =>
    r.discordId === discordId &&
    r.textHash === textHash &&
    new Date(r.submittedAt).getTime() >= cutoff
  );
}

// ── Submission ───────────────────────────────────────────────────────────────
// Pure function — performs the safety checks and returns either
//   { ok: true,  report: {...} }   on accepted submission (already persisted)
//   { ok: false, reason: '...' }   on rejection
//
// Caller (routes/bot.js) is responsible for: role gate, DM acknowledgment,
// ephemeral Discord response.
function submit({ discordId, submitterName, memberName, rawText }) {
  if (!discordId)  return { ok: false, reason: 'missing_discord_id' };
  if (!rawText)    return { ok: false, reason: 'empty' };

  const text = sanitiseText(rawText);
  if (!text)              return { ok: false, reason: 'empty_after_sanitise' };
  if (text.length < 10)   return { ok: false, reason: 'too_short' };

  // Rate limit
  if (recentCount(discordId) >= MAX_REPORTS_PER_WINDOW) {
    return { ok: false, reason: 'rate_limited' };
  }

  const textHash = hashText(text);

  // Dedupe — same user, same text, recent
  if (isDuplicateSubmission(discordId, textHash)) {
    return { ok: false, reason: 'duplicate' };
  }

  const promptInjection = hasPromptInjectionMarkers(text);

  const report = {
    id:               newReportId(),
    submittedAt:      new Date().toISOString(),
    discordId:        String(discordId),
    submitterName:    (submitterName || 'unknown').slice(0, 64),
    memberName:       memberName || null,
    text,
    textHash,
    status:           'open',
    category:         promptInjection ? 'prompt_injection_attempt' : null,
    validity:         null,
    triagedAt:        null,
    triagedBy:        null,
    triageNotes:      null,
    actionTaken:      null,
    actionParam:      null,
    actionAppliedAt:  null,
    actionResult:     null,
  };

  const store = loadStore();
  store.reports.push(report);
  saveStore(store);

  return { ok: true, report };
}

// ── Triage update (called by apply_bug_report_action.js) ─────────────────────
function updateReport(id, patch) {
  const store = loadStore();
  const idx = store.reports.findIndex(r => r.id === id);
  if (idx === -1) return null;
  const allowed = [
    'status', 'category', 'validity',
    'triagedAt', 'triagedBy', 'triageNotes',
    'actionTaken', 'actionParam', 'actionAppliedAt', 'actionResult',
  ];
  const next = { ...store.reports[idx] };
  for (const k of allowed) {
    if (Object.prototype.hasOwnProperty.call(patch, k)) next[k] = patch[k];
  }
  store.reports[idx] = next;
  saveStore(store);
  return next;
}

// ── Constants exported for callers + tests ───────────────────────────────────
const LIMITS = Object.freeze({
  MAX_TEXT_LEN,
  RATE_WINDOW_MS,
  MAX_REPORTS_PER_WINDOW,
});

const VALID_STATUSES = Object.freeze([
  'open',
  'triaged_noop',
  'applied',
  'rejected_out_of_scope',
  'rejected_not_member',
  'rejected_prompt_injection',
  'duplicate',
  'needs_human',
]);

const VALID_CATEGORIES = Object.freeze([
  'data_inaccuracy',
  'ui_bug',
  'missing_data',
  'discord_bug',
  'feature_request',
  'complaint',
  'prompt_injection_attempt',
  'unclear',
  'other',
]);

module.exports = {
  REPORTS_FILE,
  LIMITS,
  VALID_STATUSES,
  VALID_CATEGORIES,
  sanitiseText,
  hashText,
  hasPromptInjectionMarkers,
  newReportId,
  loadStore,
  saveStore,
  listForDiscordId,
  listOpen,
  listAll,
  findById,
  recentCount,
  isDuplicateSubmission,
  submit,
  updateReport,
};
