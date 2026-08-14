#!/usr/bin/env node
'use strict';

// AI copy is produced by the Cowork scheduled task, but cache-shape enforcement
// stays deterministic. This keeps a slightly overlong tagline from failing the
// daily data pipeline or spamming operator alerts.

const fs = require('fs');
const path = require('path');

const CACHE_FILE = path.join(__dirname, '..', 'data', 'ai_insights_cache.json');
const MAX_TAGLINE_LENGTH = 90;

function shortenTagline(value, maxLength = MAX_TAGLINE_LENGTH) {
  const text = String(value).replace(/\s+/g, ' ').trim();
  if (text.length <= maxLength) return text;

  const room = maxLength - 1; // reserve one character for the ellipsis
  let cut = text.slice(0, room);
  const lastSpace = cut.lastIndexOf(' ');
  if (lastSpace >= Math.floor(room * 0.6)) cut = cut.slice(0, lastSpace);
  cut = cut.replace(/[\s,;:—-]+$/u, '');
  return `${cut}…`;
}

function normalizeAiInsights({ verbose = true } = {}) {
  if (!fs.existsSync(CACHE_FILE)) {
    if (verbose) console.log('[ai-normalize] No AI insight cache — nothing to normalize');
    return { found: false, changed: 0, ids: [] };
  }

  const cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  const cards = Array.isArray(cache.spotlights) ? cache.spotlights : [];
  const ids = [];

  for (const card of cards) {
    if (typeof card.tagline !== 'string') continue;
    const normalized = shortenTagline(card.tagline);
    if (normalized === card.tagline) continue;
    card.tagline = normalized;
    ids.push(card.id || '(no id)');
  }

  if (ids.length) {
    const tmp = `${CACHE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
    fs.renameSync(tmp, CACHE_FILE);
  }

  if (verbose) {
    console.log(ids.length
      ? `[ai-normalize] Shortened ${ids.length} tagline(s): ${ids.join(', ')}`
      : '[ai-normalize] All taglines already satisfy the 90-character limit');
  }
  return { found: true, changed: ids.length, ids };
}

if (require.main === module) {
  try {
    normalizeAiInsights({ verbose: true });
  } catch (error) {
    console.error(`[ai-normalize] ${error.message}`);
    process.exit(1);
  }
}

module.exports = { MAX_TAGLINE_LENGTH, shortenTagline, normalizeAiInsights };
