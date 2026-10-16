#!/usr/bin/env node
// Prune old R-15 archive snapshots (taken by the archive-guard hook, retired 2026-10-09) from HUB/.qa-backups.
//
// The archive guard snapshots every protected file before it changes, so .qa-backups grows forever.
// This keeps, per protected path, the newest N snapshots (default 20), every snapshot younger than
// D days (default 14), and the snapshot the index uses as its last-good baseline. Everything else is a
// candidate. It is a dry run by default; --apply MOVES candidates to ~/.Trash/qa-backups-pruned-<stamp>/
// (never deletes), so a mistaken prune is recoverable from the Trash.
//
//   node scripts/prune-backups.mjs [--apply] [--keep N] [--days D]

import { readdirSync, statSync, mkdirSync, renameSync, copyFileSync, unlinkSync, existsSync } from 'node:fs';
import { dirname, join, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { makeContext, loadIndex, saveIndex, utcStamp, logEvent } from '../lib/archive-policy.mjs';

const HUB = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SNAP_RE = /^(\d{8}T\d{6}Z)-[0-9a-f]{8}(\.[^.]*)?$/i;

function parseArgs(argv) {
  const opts = { apply: false, keep: 20, days: 14 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') opts.apply = true;
    else if (a === '--keep') opts.keep = Number(argv[++i]);
    else if (a === '--days') opts.days = Number(argv[++i]);
    else if (a === '-h' || a === '--help') {
      console.log('usage: node scripts/prune-backups.mjs [--apply] [--keep N] [--days D]');
      process.exit(0);
    } else {
      console.error(`unknown argument: ${a}`);
      process.exit(2);
    }
  }
  if (!Number.isInteger(opts.keep) || opts.keep < 1) fail('--keep must be a whole number of at least 1');
  if (!Number.isFinite(opts.days) || opts.days < 0) fail('--days must be a number of at least 0');
  return opts;
}

function fail(msg) {
  console.error(`prune-backups: ${msg}`);
  process.exit(2);
}

/** Snapshot time from its name (UTC stamp), falling back to mtime. */
function snapTime(name, abs) {
  const m = SNAP_RE.exec(name);
  if (m) {
    const s = m[1];
    const t = Date.parse(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z`);
    if (Number.isFinite(t)) return t;
  }
  try {
    return statSync(abs).mtimeMs;
  } catch {
    return 0;
  }
}

/** Group snapshot files by the directory that stands for one protected path. */
function collectGroups(root) {
  const groups = new Map();
  const walk = (dir) => {
    let ents = [];
    try {
      ents = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && SNAP_RE.test(e.name)) {
        if (!groups.has(dir)) groups.set(dir, []);
        groups.get(dir).push({ abs: p, name: e.name, t: snapTime(e.name, p), size: statSync(p).size });
      }
    }
  };
  walk(root);
  return groups;
}

function moveFile(src, dest) {
  mkdirSync(dirname(dest), { recursive: true });
  try {
    renameSync(src, dest);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    copyFileSync(src, dest); // across volumes: copy, then remove the original only once the copy exists
    if (existsSync(dest)) unlinkSync(src);
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const ctx = makeContext(HUB);
  if (!existsSync(ctx.backups)) {
    console.log(`nothing to prune: ${ctx.backups} does not exist`);
    return;
  }
  const index = loadIndex(ctx);
  const baselines = new Set(Object.values(index).map((e) => e?.latest).filter(Boolean).map((p) => resolve(p).toLowerCase()));
  const cutoff = Date.now() - opts.days * 86400_000;
  const candidates = [];
  for (const [, snaps] of collectGroups(ctx.backups)) {
    snaps.sort((a, b) => b.t - a.t || b.name.localeCompare(a.name));
    snaps.forEach((s, i) => {
      if (i < opts.keep) return;
      if (s.t >= cutoff) return;
      if (baselines.has(resolve(s.abs).toLowerCase())) return;
      candidates.push(s);
    });
  }
  const bytes = candidates.reduce((n, s) => n + s.size, 0);
  const verb = opts.apply ? 'moving' : 'would move';
  for (const s of candidates) console.log(`${verb} ${relative(ctx.backups, s.abs)} (${s.size} bytes)`);
  console.log(`${candidates.length} snapshot(s), ${bytes} bytes ${opts.apply ? 'moved' : 'would move'} (keep newest ${opts.keep} per file and anything younger than ${opts.days} days).`);
  if (!opts.apply) {
    if (candidates.length) console.log('dry run: nothing changed. Re-run with --apply to move them to the Trash.');
    return;
  }
  if (!candidates.length) return;
  const trash = join(os.homedir(), '.Trash', `qa-backups-pruned-${utcStamp()}`);
  const moved = new Set();
  for (const s of candidates) {
    moveFile(s.abs, join(trash, relative(ctx.backups, s.abs)));
    moved.add(resolve(s.abs).toLowerCase());
  }
  // Drop index references to anything we moved (a damage record's bad copy, for instance).
  let changed = false;
  for (const e of Object.values(index)) {
    if (e?.damaged?.snapshot && moved.has(resolve(e.damaged.snapshot).toLowerCase())) {
      e.damaged.snapshot = join(trash, relative(ctx.backups, e.damaged.snapshot));
      changed = true;
    }
    if (e?.latest && moved.has(resolve(e.latest).toLowerCase())) {
      delete e.latest;
      changed = true;
    }
  }
  if (changed) saveIndex(ctx, index);
  logEvent(ctx, { event: 'prune', moved: candidates.length, bytes, trash });
  console.log(`moved to ${trash}`);
}

main();
void sep;
