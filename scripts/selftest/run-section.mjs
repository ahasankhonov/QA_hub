#!/usr/bin/env node
// Run ONE selftest section on its own, with its own temp dir, so a builder can iterate on a section
// without running (or colliding with) the full `npm run selftest`, whose TMP is the fixed .qa-selftest/.
//
//   node scripts/selftest/run-section.mjs scripts/selftest/<section>.mjs [--keep]
//
// The helpers match scripts/selftest-gates.mjs (check, assert, mustReject, mustAccept, run, w, TMP, HUB).
// The full suite is still the gate: a section that passes here must also pass inside `npm run selftest`.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const HUB = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/selftest/run-section.mjs <section.mjs> [--keep]');
  process.exit(2);
}
const TMP = join(HUB, `.qa-selftest-section-${basename(file, '.mjs')}`);
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

const w = (name, obj) => {
  const p = join(TMP, name);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) + '\n');
  return p;
};
let passed = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`  ✗ ${name}\n      ${String(e.message).split('\n').join('\n      ')}`);
  }
}
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
const mustReject = (res, needle, what) => {
  const out = (res.stdout || '') + (res.stderr || '');
  assert(res.status !== 0, `${what}: the gate ACCEPTED a known-bad input (exit 0).\n${out.slice(0, 600)}`);
  if (needle) assert(out.includes(needle), `${what}: rejected, but not for the expected reason "${needle}".\n${out.slice(0, 600)}`);
};
const mustAccept = (res, what) => {
  const out = (res.stdout || '') + (res.stderr || '');
  assert(res.status === 0, `${what}: the gate REJECTED a known-good input (exit ${res.status}).\n${out.slice(0, 800)}`);
};
const run = (script, argv) => spawnSync('node', [join(HUB, 'scripts', script), ...argv], { encoding: 'utf8' });

const section = (await import(pathToFileURL(resolve(file)).href)).default;
section({ check, assert, mustReject, mustAccept, run, w, TMP, HUB });
if (!process.argv.includes('--keep')) rmSync(TMP, { recursive: true, force: true });
console.log(failures.length ? `\nSECTION FAILED — ${failures.length} of ${passed + failures.length}` : `\nSECTION OK — ${passed} checks`);
process.exit(failures.length ? 1 : 0);
