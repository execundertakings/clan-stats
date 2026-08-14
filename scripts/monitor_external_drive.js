#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const TARGET_VOLUME = process.env.DRIVE_MONITOR_VOLUME || '/Volumes/Storage';
const SECONDARY_VOLUME = process.env.DRIVE_MONITOR_SECONDARY || '/Volumes/TM-Backup';
const INTERVAL_MS = Number(process.env.DRIVE_MONITOR_INTERVAL_MS || 60000);
const HEARTBEAT_MS = Number(process.env.DRIVE_MONITOR_HEARTBEAT_MS || 5 * 60000);
const LOG_DIR = path.join(os.homedir(), 'Library', 'Logs');
const SUPPORT_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'clan-stats');
const LOG_FILE = path.join(LOG_DIR, 'external-drive-monitor.log');
const STATE_FILE = path.join(SUPPORT_DIR, 'external-drive-monitor-state.json');

function nowIso() {
  return new Date().toISOString();
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function ensureDirs() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.mkdirSync(SUPPORT_DIR, { recursive: true });
}

function appendLog(message, payload = null) {
  const line = payload == null
    ? `[${nowIso()}] ${message}\n`
    : `[${nowIso()}] ${message} ${JSON.stringify(payload)}\n`;
  fs.appendFileSync(LOG_FILE, line);
}

function run(cmd, args = [], timeoutMs = 10000) {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (e) {
    const stderr = e.stderr ? String(e.stderr).trim() : '';
    const stdout = e.stdout ? String(e.stdout).trim() : '';
    return `[exit ${e.status ?? 'signal'}] ${stderr || stdout || e.message}`;
  }
}

function shell(script, timeoutMs = 15000) {
  return run('/bin/bash', ['-lc', script], timeoutMs);
}

function parseField(text, label) {
  const re = new RegExp(`^\\s*${label}:\\s*(.+)$`, 'mi');
  return text.match(re)?.[1]?.trim() || '';
}

function isMounted(volume) {
  const info = run('/usr/sbin/diskutil', ['info', volume], 5000);
  return /\bMounted:\s+Yes\b/i.test(info) && !/Unable to find disk/i.test(info);
}

function getVolumeInfo(volume) {
  const info = run('/usr/sbin/diskutil', ['info', volume], 5000);
  const physicalStore = parseField(info, 'APFS Physical Store');
  const wholeDisk = physicalStore ? physicalStore.replace(/s\d+$/i, '') : '';
  return {
    mounted: /\bMounted:\s+Yes\b/i.test(info),
    device: parseField(info, 'Device Identifier'),
    wholeDisk,
    protocol: parseField(info, 'Protocol'),
    smart: parseField(info, 'SMART Status'),
    free: parseField(info, 'Container Free Space') || parseField(info, 'Volume Free Space'),
    raw: info.slice(0, 4000),
  };
}

function countFiles(dir, pattern) {
  return shell(`[ -d ${JSON.stringify(dir)} ] && find ${JSON.stringify(dir)}/ -maxdepth 1 -name ${JSON.stringify(pattern)} | wc -l || echo 0`, 15000)
    .replace(/\s+/g, ' ')
    .trim();
}

function sample() {
  const storageMounted = isMounted(TARGET_VOLUME);
  const secondaryMounted = isMounted(SECONDARY_VOLUME);
  const storageInfo = storageMounted ? getVolumeInfo(TARGET_VOLUME) : null;
  const physicalDisk = storageInfo?.wholeDisk || '';

  return {
    at: nowIso(),
    targetVolume: TARGET_VOLUME,
    mounted: storageMounted,
    secondaryVolume: SECONDARY_VOLUME,
    secondaryMounted,
    storageInfo: storageInfo ? {
      device: storageInfo.device,
      wholeDisk: storageInfo.wholeDisk,
      protocol: storageInfo.protocol,
      smart: storageInfo.smart,
      free: storageInfo.free,
    } : null,
    df: shell(`df -h ${JSON.stringify(TARGET_VOLUME)} ${JSON.stringify(SECONDARY_VOLUME)} 2>&1`, 5000),
    tmutil: shell('/usr/bin/tmutil status 2>&1 | /usr/bin/sed -n "1,30p"', 5000),
    iostat: physicalDisk ? shell(`/usr/sbin/iostat -Id ${physicalDisk} 1 2 | /usr/bin/tail -n 3`, 5000) : '',
    cacheCounts: storageMounted ? {
      matches: countFiles(path.join(TARGET_VOLUME, 'Clan stats page', 'data', 'match_cache'), '*.json'),
      telemetry: countFiles(path.join(TARGET_VOLUME, 'Clan stats page', 'data', 'telemetry_cache'), '*.json.gz'),
    } : null,
  };
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return {}; }
}

function writeState(state) {
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

function notify(title, message) {
  const safeTitle = String(title).replace(/"/g, '\\"');
  const safeMessage = String(message).replace(/"/g, '\\"');
  run('/usr/bin/osascript', ['-e', `display notification "${safeMessage}" with title "${safeTitle}" sound name "Basso"`], 5000);
}

function captureBundle(reason, current, previous) {
  const file = path.join(LOG_DIR, `external-drive-monitor-${reason}-${stamp()}.log`);
  const sections = [
    ['reason', reason],
    ['current sample', JSON.stringify(current, null, 2)],
    ['previous state', JSON.stringify(previous, null, 2)],
    ['diskutil list', run('/usr/sbin/diskutil', ['list'], 10000)],
    ['diskutil list external', run('/usr/sbin/diskutil', ['list', 'external'], 10000)],
    ['mount', run('/sbin/mount', [], 10000)],
    ['df', shell('df -h 2>&1', 10000)],
    ['pmset custom', run('/usr/bin/pmset', ['-g', 'custom'], 10000)],
    ['pmset assertions', run('/usr/bin/pmset', ['-g', 'assertions'], 10000)],
    ['tmutil status', shell('/usr/bin/tmutil status 2>&1', 10000)],
    ['system profiler storage summary', shell('/usr/sbin/system_profiler SPUSBDataType SPThunderboltDataType SPStorageDataType 2>/dev/null | /usr/bin/grep -Ei "Raycue|RTL|Storage|TM-Backup|USB|Thunderbolt|Mount Point|BSD Name|Media Name|Device Name|Protocol|External|NVMe|SATA|disk[0-9]" || true', 30000)],
    ['recent disk logs', shell('/usr/bin/log show --style syslog --last 30m --predicate \'(process == "kernel" OR process == "diskarbitrationd" OR process == "backupd" OR process == "powerd") AND (eventMessage CONTAINS[c] "disk4" OR eventMessage CONTAINS[c] "disk5" OR eventMessage CONTAINS[c] "disk6" OR eventMessage CONTAINS[c] "USB" OR eventMessage CONTAINS[c] "I/O" OR eventMessage CONTAINS[c] "reset" OR eventMessage CONTAINS[c] "stall" OR eventMessage CONTAINS[c] "unmount" OR eventMessage CONTAINS[c] "removed disk" OR eventMessage CONTAINS[c] "RTL" OR eventMessage CONTAINS[c] "external")\' 2>/dev/null | /usr/bin/tail -n 400', 45000)],
  ];

  fs.writeFileSync(file, sections.map(([name, body]) => `\n===== ${name} =====\n${body}\n`).join(''));
  appendLog(`captured ${reason} bundle`, { file });
  return file;
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  ensureDirs();
  let state = readState();
  appendLog('monitor started', { target: TARGET_VOLUME, secondary: SECONDARY_VOLUME, intervalMs: INTERVAL_MS });

  while (true) {
    const current = sample();
    const previousMounted = state.lastMounted;
    const currentMounted = current.mounted;
    const lastHeartbeatAt = state.lastHeartbeatAt ? new Date(state.lastHeartbeatAt).getTime() : 0;
    const heartbeatDue = !lastHeartbeatAt || Date.now() - lastHeartbeatAt >= HEARTBEAT_MS;

    if (previousMounted === undefined) {
      appendLog('initial sample', current);
    } else if (previousMounted && !currentMounted) {
      const bundle = captureBundle('disconnect', current, state);
      appendLog('DISCONNECT detected', { bundle, current });
      notify('External Drive Disconnected', `Storage disappeared. Diagnostic bundle: ${path.basename(bundle)}`);
    } else if (!previousMounted && currentMounted) {
      const bundle = captureBundle('remount', current, state);
      appendLog('REMOUNT detected', { bundle, current });
      notify('External Drive Remounted', 'Storage is mounted again.');
    } else if (heartbeatDue) {
      appendLog('heartbeat', current);
      state.lastHeartbeatAt = current.at;
    }

    state = {
      ...state,
      lastMounted: currentMounted,
      lastSampleAt: current.at,
      lastSample: current,
      lastHeartbeatAt: state.lastHeartbeatAt,
    };
    writeState(state);
    await sleep(INTERVAL_MS);
  }
}

main().catch(e => {
  appendLog('fatal monitor error', { message: e.message, stack: e.stack });
  process.exit(1);
});
