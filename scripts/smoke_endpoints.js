#!/usr/bin/env node
'use strict';

const http = require('http');
const https = require('https');

const baseUrl = new URL(process.argv[2] || process.env.CLAN_BASE_URL || 'http://127.0.0.1:3002');
const endpoints = [
  '/api/health',
  '/api/config',
  '/api/members',
  '/api/clan/stats',
  '/api/match-history',
  '/api/weapons',
  '/api/squad-stats',
  '/api/heatmap',
  '/api/telemetry-insights',
  '/api/ai-insights',
  '/api/gateway/status',
];

function requestJson(pathname) {
  const url = new URL(pathname, baseUrl);
  const transport = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = transport.get(url, { headers: { Accept: 'application/json' } }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`${pathname}: HTTP ${res.statusCode}`));
        }
        try {
          JSON.parse(body);
          resolve({ pathname, status: res.statusCode, bytes: Buffer.byteLength(body) });
        } catch {
          reject(new Error(`${pathname}: response was not JSON`));
        }
      });
    });
    req.setTimeout(20_000, () => req.destroy(new Error(`${pathname}: timed out`)));
    req.on('error', reject);
  });
}

(async () => {
  const results = [];
  for (const endpoint of endpoints) results.push(await requestJson(endpoint));
  for (const result of results) {
    console.log(`✓ ${result.status} ${result.pathname} (${result.bytes} bytes)`);
  }
  console.log(`Smoke OK: ${results.length} endpoints at ${baseUrl.origin}`);
})().catch(error => {
  console.error(`Smoke failed: ${error.message}`);
  process.exit(1);
});
