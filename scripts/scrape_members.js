#!/usr/bin/env node
'use strict';
// Scrapes Greg's recent match history to find clan members by squad.
// Writes results to data/scraped_members.json

const fs      = require('fs');
const path    = require('path');
const ROOT    = path.join(__dirname, '..');

const { getMatch } = require(path.join(ROOT, 'lib/pubg'));
const { DATA }     = require(path.join(ROOT, 'lib/config'));

const GREG_ID = 'account.d37764f6787b4098a6ce16d751a65117';
const OUT_FILE = path.join(DATA, 'scraped_members.json');
const LOG_FILE = path.join(DATA, 'scrape.log');

const matchIds = [
  '57a57f23-a99e-4388-bef1-91106646cc80',
  '949a2447-5184-40f7-a02a-cb608c95260b',
  '737eb566-5bab-45e6-b57d-b0e6ae77daaa',
  'd0188013-6734-4d2a-b178-6540bac06307',
  '427b0a0f-08c7-40c9-b1c1-8f21f5980a1c',
  '4ff2638c-c2dc-4760-9454-a27ee1bd75b0',
  '6679097a-ea20-45bd-9139-a5fe209e167b',
  '7165d949-51f0-4d60-a63a-225c440662a1',
  'eaf633d0-1068-4757-ba9c-e0cc8570f0f5',
  '65921cce-4016-4719-a6cb-b5bf84f9dc95',
  '6973145d-c802-4d79-b763-91296186b249',
  '75382e53-b781-47b9-abe1-24dd559c46d4',
  'f23cc190-e22e-4ebf-b70b-0441d6c4f2df',
  '0de5f81a-c883-4a8b-964d-eb961516fe3f',
  '8c08fe18-85d1-4253-bc93-fe9e73f030f8',
];

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

(async () => {
  const clanMembers = new Map();

  log('Starting match scrape for ' + matchIds.length + ' matches...');

  for (let i = 0; i < matchIds.length; i++) {
    const matchId = matchIds[i];
    try {
      // Reuse the shared PUBG wrapper so this script respects the same queue and
      // disk cache as the live app instead of pacing itself independently.
      const d = await getMatch(matchId);
      const participants = (d.included || []).filter(x => x.type === 'participant');
      const rosters      = (d.included || []).filter(x => x.type === 'roster');

      const gregP = participants.find(p => p.attributes.stats.playerId === GREG_ID);
      if (!gregP) { log('Greg not in match ' + matchId.slice(0,8)); continue; }

      const gregRoster = rosters.find(r =>
        r.relationships.participants.data.some(p => p.id === gregP.id)
      );
      if (!gregRoster) { log('No roster for Greg in ' + matchId.slice(0,8)); continue; }

      const squadIds = new Set(gregRoster.relationships.participants.data.map(p => p.id));
      const added = [];
      for (const p of participants) {
        if (squadIds.has(p.id)) {
          const { playerId, name } = p.attributes.stats;
          if (!clanMembers.has(playerId)) {
            clanMembers.set(playerId, name);
            added.push(name);
          }
        }
      }
      log(`Match ${i+1}/${matchIds.length} (${matchId.slice(0,8)}): squad=[${[...squadIds].length}] new=${added.join(',') || 'none'} total=${clanMembers.size}`);
    } catch (e) {
      log('Error on ' + matchId.slice(0,8) + ': ' + e.message);
    }
  }

  const result = [...clanMembers.entries()].map(([accountId, name]) => ({
    name, accountId, addedAt: new Date().toISOString(), source: 'clan',
  }));

  fs.writeFileSync(OUT_FILE, JSON.stringify(result, null, 2));
  log(`Done. ${result.length} unique members found. Written to ${OUT_FILE}`);
  log('Names: ' + result.map(m => m.name).join(', '));
})();
