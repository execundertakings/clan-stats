#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.dirname(__dirname);
const TARGETS = ['server.js', 'build.js', 'lib', 'routes', 'scripts', 'test'];

function collect(target, out = []) {
  const absolute = path.join(ROOT, target);
  if (!fs.existsSync(absolute)) return out;
  const stat = fs.statSync(absolute);
  if (stat.isFile()) {
    if (absolute.endsWith('.js')) out.push(absolute);
    return out;
  }
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
    const child = path.join(target, entry.name);
    if (entry.isDirectory()) collect(child, out);
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(path.join(ROOT, child));
  }
  return out;
}

const files = TARGETS.flatMap(target => collect(target)).sort();
const failures = [];

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) failures.push({ file, output: result.stderr || result.stdout });
}

if (failures.length) {
  for (const failure of failures) {
    console.error(`\n${path.relative(ROOT, failure.file)}\n${failure.output.trim()}`);
  }
  process.exit(1);
}

console.log(`Syntax OK: ${files.length} JavaScript files`);
