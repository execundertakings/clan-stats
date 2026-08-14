'use strict';

// Cross-process sliding-window limiter for the PUBG free-tier allowance.
// The web server, notifier, and deterministic pipeline run in separate Node
// processes, so an in-memory queue alone cannot enforce the shared 10 RPM cap.

const fs = require('fs');
const path = require('path');

function parseRetryAfterMs(value, now = Date.now()) {
  if (value == null || String(value).trim() === '') return null;

  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.ceil(seconds * 1000)) + 250;

  const dateMs = Date.parse(String(value));
  if (!Number.isFinite(dateMs)) return null;
  return Math.max(0, dateMs - now) + 250;
}

class SharedSlidingWindowLimiter {
  constructor({
    dataDir,
    limit = 9,
    windowMs = 60_000,
    safetyMs = 500,
    lockStaleMs = 30_000,
    lockPollMs = 50,
    now = () => Date.now(),
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  }) {
    if (!dataDir) throw new Error('SharedSlidingWindowLimiter requires dataDir');
    this.dataDir = dataDir;
    this.limit = limit;
    this.windowMs = windowMs;
    this.safetyMs = safetyMs;
    this.lockStaleMs = lockStaleMs;
    this.lockPollMs = lockPollMs;
    this.now = now;
    this.sleep = sleep;
    this.stateFile = path.join(dataDir, '.pubg-rate-state.json');
    this.lockDir = path.join(dataDir, '.pubg-rate-state.lock');
  }

  _readCallTimes(now) {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      const values = Array.isArray(parsed) ? parsed : parsed.callTimes;
      if (!Array.isArray(values)) return [];
      return values
        .filter(value => Number.isFinite(value) && value <= now && now - value < this.windowMs)
        .sort((a, b) => a - b);
    } catch {
      return [];
    }
  }

  _writeCallTimes(callTimes) {
    const tmp = `${this.stateFile}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ callTimes }));
    fs.renameSync(tmp, this.stateFile);
  }

  async _acquireLock() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    for (;;) {
      try {
        fs.mkdirSync(this.lockDir);
        return;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        try {
          const age = this.now() - fs.statSync(this.lockDir).mtimeMs;
          if (age > this.lockStaleMs) {
            fs.rmdirSync(this.lockDir);
            continue;
          }
        } catch (statError) {
          if (statError.code !== 'ENOENT') throw statError;
          continue;
        }
        await this.sleep(this.lockPollMs);
      }
    }
  }

  _releaseLock() {
    try { fs.rmdirSync(this.lockDir); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  async takeSlot({ onWait } = {}) {
    for (;;) {
      await this._acquireLock();
      let waitMs = 0;
      let count = 0;
      try {
        const now = this.now();
        const callTimes = this._readCallTimes(now);
        count = callTimes.length;
        if (count < this.limit) {
          callTimes.push(now);
          this._writeCallTimes(callTimes);
          return;
        }
        waitMs = Math.max(1, this.windowMs - (now - callTimes[0]) + this.safetyMs);
      } finally {
        this._releaseLock();
      }

      if (onWait) onWait(waitMs, count, this.limit);
      await this.sleep(waitMs);
    }
  }
}

module.exports = { SharedSlidingWindowLimiter, parseRetryAfterMs };
