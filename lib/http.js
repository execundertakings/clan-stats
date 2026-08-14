'use strict';
// ── lib/http.js — HTTP response helpers, body parsing, security headers ───────

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.txt':  'text/plain; charset=utf-8',
};

function buildSecurityHeaders(contentType, extra = {}, req = null) {
  const headers = {
    'Content-Type': contentType,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-XSS-Protection': '1; mode=block',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://unpkg.com https://cdn.tailwindcss.com https://cdnjs.cloudflare.com",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.tailwindcss.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data: blob: https://*.pubg.com https://cdn.akamai.steamstatic.com",
      "connect-src 'self'",
    ].join('; '),
  };
  if (req && requestIsSecure(req)) {
    headers['Strict-Transport-Security'] = 'max-age=31536000';
  }
  return { ...headers, ...extra };
}

function jsonRes(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, buildSecurityHeaders('application/json', {
    'Content-Length': Buffer.byteLength(body),
  }, res.req));
  res.end(body);
  return true; // signals to router that the request was handled
}

function errRes(res, msg, status = 400) {
  jsonRes(res, { error: msg }, status);
}

function htmlRes(res, html, status = 200, extra = {}) {
  const body = Buffer.from(html, 'utf8');
  res.writeHead(status, buildSecurityHeaders('text/html; charset=utf-8', {
    'Content-Length': body.length,
    ...extra,
  }, res.req));
  res.end(body);
}

function requestIsSecure(req) {
  if (req.socket && req.socket.encrypted) return true;
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  if (proto === 'https') return true;
  return false;
}

const MAX_BODY = 1 * 1024 * 1024; // 1 MB

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { req.destroy(); return reject(new Error('Body too large')); }
      body += c;
    });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

module.exports = {
  MIME,
  buildSecurityHeaders,
  jsonRes,
  errRes,
  htmlRes,
  requestIsSecure,
  MAX_BODY,
  parseBody,
};
