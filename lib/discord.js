'use strict';
// ── lib/discord.js — Discord webhook poster ───────────────────────────────────
// No dependencies — pure Node.js https module.

const https = require('https');

/**
 * POST a payload to a Discord webhook URL.
 * body should be a Discord webhook payload object (embeds, content, etc.)
 */
function postWebhook(webhookUrl, body) {
  return new Promise((resolve, reject) => {
    const json   = JSON.stringify(body);
    const parsed = new URL(webhookUrl);

    const options = {
      hostname: parsed.hostname,
      path:     parsed.pathname + parsed.search,
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(json),
        'User-Agent':     'APES-ClanBot/1.0',
      },
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        // 204 No Content is the normal success for webhooks
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve();
        } else {
          reject(new Error(`Discord webhook ${res.statusCode}: ${data.slice(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Discord webhook timeout')); });
    req.write(json);
    req.end();
  });
}

module.exports = { postWebhook };
