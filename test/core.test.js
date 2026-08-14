'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isCountingSquadMatch,
  getMatchFilterDecision,
  summarizeTags,
} = require('../lib/match-filters');
const { getSeasonBoundary } = require('../lib/season-boundaries');
const { loadClanConfig, frontendClanConfig, validateClanConfig } = require('../lib/config');

test('only official squad modes count', () => {
  assert.equal(isCountingSquadMatch('official', 'squad'), true);
  assert.equal(isCountingSquadMatch('official', 'squad-fpp'), true);
  assert.equal(isCountingSquadMatch('official', 'duo-fpp'), false);
  assert.equal(isCountingSquadMatch('custom', 'squad-fpp'), false);
  assert.equal(isCountingSquadMatch('airoyale', 'squad'), false);
});

test('special-mode signals are excluded even when the base mode says squad', () => {
  const decision = getMatchFilterDecision({
    matchType: 'official',
    gameMode: 'squad-fpp',
    tags: { event: ['payday'] },
  });
  assert.equal(decision.counts, false);
  assert.equal(decision.reason, 'excluded-special-mode');
  assert.equal(decision.review, true);
});

test('nested match tags flatten deterministically', () => {
  assert.equal(summarizeTags({ event: ['alpha', { mode: 'beta' }] }), 'event | alpha | mode | beta');
});

test('current clan config is valid and exposes only the public identity', () => {
  const config = loadClanConfig();
  assert.deepEqual(validateClanConfig(config), []);
  assert.equal(config.clan.shortName, '3PI');
  assert.equal(config.clan.tag, '3PI');
  assert.equal(config.site.publicUrl, 'https://3pi.executiveundertakings.com');

  const frontend = frontendClanConfig();
  assert.equal(frontend.shortName, '3PI');
  assert.equal(Object.hasOwn(frontend, 'discord'), false);
});

test('season 42 uses its verified official boundary', () => {
  assert.deepEqual(getSeasonBoundary('division.bro.official.pc-2018-42'), {
    startAt: '2026-06-17T08:30:00Z',
    source: 'official-patch-notes-42.1',
  });
  assert.equal(getSeasonBoundary('unknown-season'), null);
});
