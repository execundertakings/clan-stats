'use strict';
// ── lib/discord.js — Discord REST/webhook client with rate-limit handling ─────
// Serializes requests per webhook/token bucket, honors retry windows, and
// backs off on global or per-bucket 429 responses. Also enforces a conservative
// local rolling-window cap so a bug cannot burst hundreds of requests at once.

const https = require('https');
const { loadEnv, loadClanConfig } = require('./config');

const API_BASE = 'https://discord.com/api/v10';
const FALLBACK_USER_AGENT = 'ClanBot/1.0';
const RATE_LIMIT_SAFETY_MS = 100;
const MAX_429_RETRIES = 4;
const DEFAULT_SOFT_LIMIT = 250;
const DEFAULT_SOFT_WINDOW_MS = 5 * 60 * 1000;

const _bucketTails = new Map();
const _bucketWaitUntil = new Map();
const _requestTimes = [];
let _globalWaitUntil = 0;
let _budgetTail = Promise.resolve();
let _lastBudgetLogAt = 0;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function budgetConfig() {
  const env = loadEnv();
  const limit = parseInt(env.DISCORD_REQUEST_SOFT_LIMIT || '', 10);
  const windowMs = parseInt(env.DISCORD_REQUEST_SOFT_WINDOW_MS || '', 10);
  return {
    limit: Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_SOFT_LIMIT,
    windowMs: Number.isFinite(windowMs) && windowMs > 0 ? windowMs : DEFAULT_SOFT_WINDOW_MS,
  };
}

function parseJson(text) {
  try { return JSON.parse(text); }
  catch { return null; }
}

function waitForBucket(bucketKey) {
  const now = Date.now();
  const waitUntil = Math.max(_globalWaitUntil, _bucketWaitUntil.get(bucketKey) || 0);
  return waitUntil > now ? sleep(waitUntil - now) : Promise.resolve();
}

function queueByBucket(bucketKey, task) {
  const tail = _bucketTails.get(bucketKey) || Promise.resolve();
  const next = tail.catch(() => {}).then(task);
  _bucketTails.set(bucketKey, next.catch(() => {}));
  return next;
}

function computeRetryAfterMs(headers, parsedBody) {
  const headerSeconds = Number(headers['x-ratelimit-reset-after']);
  if (Number.isFinite(headerSeconds) && headerSeconds > 0) {
    return Math.ceil(headerSeconds * 1000) + RATE_LIMIT_SAFETY_MS;
  }

  const bodySeconds = Number(parsedBody?.retry_after);
  if (Number.isFinite(bodySeconds) && bodySeconds > 0) {
    return Math.ceil(bodySeconds * 1000) + RATE_LIMIT_SAFETY_MS;
  }

  return 1000;
}

function noteBucketWindow(bucketKey, headers) {
  if (headers['x-ratelimit-remaining'] !== '0') return;
  const resetAfter = Number(headers['x-ratelimit-reset-after']);
  if (!Number.isFinite(resetAfter) || resetAfter <= 0) return;
  _bucketWaitUntil.set(bucketKey, Date.now() + Math.ceil(resetAfter * 1000) + RATE_LIMIT_SAFETY_MS);
}

function reserveBudgetSlot() {
  const task = _budgetTail.catch(() => {}).then(async () => {
    const { limit, windowMs } = budgetConfig();
    while (true) {
      const now = Date.now();
      while (_requestTimes.length && now - _requestTimes[0] >= windowMs) _requestTimes.shift();
      if (_requestTimes.length < limit) {
        _requestTimes.push(now);
        return;
      }

      const waitMs = (windowMs - (now - _requestTimes[0])) + RATE_LIMIT_SAFETY_MS;
      if (now - _lastBudgetLogAt > 30000) {
        _lastBudgetLogAt = now;
        console.warn(`[Discord] Soft cap reached (${limit} requests / ${Math.round(windowMs / 1000)}s) — delaying ${Math.ceil(waitMs / 1000)}s to avoid burst traffic`);
      }
      await sleep(waitMs);
    }
  });

  _budgetTail = task.catch(() => {});
  return task;
}

function rawRequest({ url, method, headers, body, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method,
      headers,
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body: data }));
    });

    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error('Discord request timeout'));
    });

    if (body) req.write(body);
    req.end();
  });
}

async function discordRequest(opts, attempt = 0) {
  const {
    url,
    method = 'POST',
    headers = {},
    json = null,
    timeoutMs = 15000,
    bucketKey,
    label = 'Discord request',
  } = opts;

  const target = typeof url === 'string' ? new URL(url) : url;
  const body = json == null ? null : JSON.stringify(json);
  const requestHeaders = {
    'User-Agent': (loadClanConfig().discord.botUserAgent || FALLBACK_USER_AGENT),
    ...(body ? {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    } : {}),
    ...headers,
  };

  await waitForBucket(bucketKey);
  await reserveBudgetSlot();

  const result = await rawRequest({
    url: target,
    method,
    headers: requestHeaders,
    body,
    timeoutMs,
  });

  const parsed = parseJson(result.body);
  noteBucketWindow(bucketKey, result.headers);

  if (result.status === 429) {
    const retryMs = computeRetryAfterMs(result.headers, parsed);
    const until = Date.now() + retryMs;
    _bucketWaitUntil.set(bucketKey, until);
    if (parsed?.global) _globalWaitUntil = Math.max(_globalWaitUntil, until);
    if (attempt >= MAX_429_RETRIES) {
      throw new Error(`${label} rate-limited after ${MAX_429_RETRIES + 1} attempts`);
    }
    await sleep(retryMs);
    return discordRequest(opts, attempt + 1);
  }

  if (result.status >= 200 && result.status < 300) {
    return { ...result, json: parsed };
  }

  throw new Error(`${label} ${result.status}: ${result.body.slice(0, 300)}`);
}

function postWebhook(webhookUrl, body, opts = {}) {
  const bucketKey = opts.bucketKey || `webhook:${webhookUrl}`;
  return queueByBucket(bucketKey, () => discordRequest({
    url: webhookUrl,
    method: 'POST',
    json: body,
    timeoutMs: opts.timeoutMs || 10000,
    bucketKey,
    label: 'Discord webhook',
  }));
}

function discordApiRequest({ token, endpoint, method = 'GET', body = null, timeoutMs = 15000, bucketKey = null }) {
  // Endpoints like '/users/@me/channels' must concatenate, not URL-resolve —
  // new URL('/users/...', 'https://discord.com/api/v10') drops the /api/v10 prefix.
  const rel = endpoint.startsWith('/') ? endpoint : '/' + endpoint;
  const url = endpoint.startsWith('http') ? new URL(endpoint) : new URL(API_BASE + rel);
  const key = bucketKey || `bot:${token}`;
  return queueByBucket(key, () => discordRequest({
    url,
    method,
    json: body,
    timeoutMs,
    bucketKey: key,
    label: 'Discord API',
    headers: {
      'Authorization': `Bot ${token}`,
    },
  }));
}

async function sendBotDm(token, userId, body, opts = {}) {
  if (!token || !userId) return null;
  const create = await discordApiRequest({
    token,
    endpoint: '/users/@me/channels',
    method: 'POST',
    body: { recipient_id: userId },
    timeoutMs: opts.timeoutMs || 15000,
    bucketKey: `dm-channel:${userId}`,
  });
  const channelId = create.json?.id;
  if (!channelId) throw new Error(`Discord DM channel missing for user ${userId}`);
  return discordApiRequest({
    token,
    endpoint: `/channels/${channelId}/messages`,
    method: 'POST',
    body,
    timeoutMs: opts.timeoutMs || 15000,
    bucketKey: `dm-message:${channelId}`,
  });
}

async function sendAdminDms(body, opts = {}) {
  const env = loadEnv();
  const token = process.env.DISCORD_BOT_TOKEN || env.DISCORD_BOT_TOKEN;
  const adminUserIds = loadClanConfig().discord.adminUserIds || [];
  if (!token || !adminUserIds.length) return { sent: 0, skipped: true };

  let sent = 0;
  const errors = [];
  for (const userId of adminUserIds) {
    try {
      await sendBotDm(token, userId, body, opts);
      sent += 1;
    } catch (e) {
      errors.push(`${userId}: ${e.message}`);
    }
  }
  if (!sent && errors.length) throw new Error(errors.join('; '));
  return { sent, errors };
}

module.exports = { postWebhook, discordApiRequest, sendBotDm, sendAdminDms };
