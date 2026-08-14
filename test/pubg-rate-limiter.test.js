'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { SharedSlidingWindowLimiter, parseRetryAfterMs } = require('../lib/pubg-rate-limiter');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'clan-rate-limit-test-'));
}

test('Retry-After supports seconds and HTTP dates', () => {
  assert.equal(parseRetryAfterMs('2'), 2250);
  assert.equal(parseRetryAfterMs('invalid'), null);
  assert.equal(parseRetryAfterMs('Thu, 01 Jan 1970 00:00:05 GMT', 1000), 4250);
});

test('shared limiter waits after the configured window is full', async t => {
  const dataDir = tempDir();
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  let now = 10_000;
  const waits = [];
  const limiter = new SharedSlidingWindowLimiter({
    dataDir,
    limit: 2,
    windowMs: 1000,
    safetyMs: 10,
    now: () => now,
    sleep: async ms => { waits.push(ms); now += ms; },
  });

  await limiter.takeSlot();
  await limiter.takeSlot();
  await limiter.takeSlot();

  assert.deepEqual(waits, [1010]);
  const state = JSON.parse(fs.readFileSync(path.join(dataDir, '.pubg-rate-state.json'), 'utf8'));
  assert.deepEqual(state.callTimes, [11_010]);
});

test('separate limiter instances coordinate through the same state file', async t => {
  const dataDir = tempDir();
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  let now = 20_000;
  const waits = [];
  const options = {
    dataDir,
    limit: 2,
    windowMs: 1000,
    safetyMs: 10,
    now: () => now,
    sleep: async ms => { waits.push(ms); now += ms; },
  };
  const serverLimiter = new SharedSlidingWindowLimiter(options);
  const pipelineLimiter = new SharedSlidingWindowLimiter(options);

  await serverLimiter.takeSlot();
  await pipelineLimiter.takeSlot();
  await serverLimiter.takeSlot();
  assert.deepEqual(waits, [1010]);
});

test('malformed state is recovered without blocking requests', async t => {
  const dataDir = tempDir();
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dataDir, '.pubg-rate-state.json'), '{broken');

  const limiter = new SharedSlidingWindowLimiter({ dataDir });
  await limiter.takeSlot();

  const state = JSON.parse(fs.readFileSync(path.join(dataDir, '.pubg-rate-state.json'), 'utf8'));
  assert.equal(state.callTimes.length, 1);
});
