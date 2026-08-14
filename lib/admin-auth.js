'use strict';

const crypto = require('crypto');
const { loadEnv } = require('./config');
const { errRes } = require('./http');

const DEFAULT_ADMIN_PASSWORD_HASH = '6f3bf6fa0e9c71b9440f78a13caa26bd0af843bbd4e0af3b2a79f94e5887d352';
const WINDOW_MS = 5 * 60 * 1000;
const MAX_FAILURES = 8;
const failures = new Map();

function adminPasswordHash() {
  const env = loadEnv();
  return String(process.env.ADMIN_PASSWORD_HASH || env.ADMIN_PASSWORD_HASH || DEFAULT_ADMIN_PASSWORD_HASH).trim();
}

function hashPassword(password) {
  return crypto.createHash('sha256').update(String(password || ''), 'utf8').digest('hex');
}

function safeEqualHex(a, b) {
  if (!/^[a-f0-9]{64}$/i.test(a || '') || !/^[a-f0-9]{64}$/i.test(b || '')) return false;
  const aa = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function clientKey(req) {
  return String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown')
    .split(',')[0]
    .trim();
}

function failureState(req) {
  const key = clientKey(req);
  const now = Date.now();
  const state = failures.get(key) || { count: 0, resetAt: now + WINDOW_MS };
  if (state.resetAt <= now) {
    state.count = 0;
    state.resetAt = now + WINDOW_MS;
  }
  failures.set(key, state);
  return state;
}

function verifyAdminPassword(password) {
  return safeEqualHex(hashPassword(password), adminPasswordHash());
}

function noteAdminFailure(req) {
  const state = failureState(req);
  state.count++;
}

function adminBlocked(req) {
  return failureState(req).count >= MAX_FAILURES;
}

function clearAdminFailures(req) {
  failures.delete(clientKey(req));
}

function adminPasswordFromRequest(req) {
  return req.headers['x-admin-password'] || '';
}

function isLocalDirectRequest(req) {
  const remote = String(req.socket?.remoteAddress || '');
  const hasForwardedHeaders = !!(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for']);
  return !hasForwardedHeaders && (remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1');
}

function requireAdmin(req, res, options = {}) {
  if (options.allowLocal && isLocalDirectRequest(req)) return true;
  if (adminBlocked(req)) {
    errRes(res, 'Too many admin authentication failures; try again later', 429);
    return false;
  }
  if (verifyAdminPassword(adminPasswordFromRequest(req))) {
    clearAdminFailures(req);
    return true;
  }
  noteAdminFailure(req);
  errRes(res, 'Admin authentication required', 401);
  return false;
}

function verifyAdminRequest(req, password) {
  if (adminBlocked(req)) return { ok: false, status: 429, error: 'Too many admin authentication failures; try again later' };
  if (verifyAdminPassword(password)) {
    clearAdminFailures(req);
    return { ok: true };
  }
  noteAdminFailure(req);
  return { ok: false, status: 401, error: 'Incorrect password' };
}

module.exports = {
  requireAdmin,
  verifyAdminRequest,
  verifyAdminPassword,
  isLocalDirectRequest,
};
