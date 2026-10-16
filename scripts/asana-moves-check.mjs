#!/usr/bin/env node
// Did the hand-made Asana moves land where the approved plan said? (moveMode "manual", R-04)
//
// asana-plan.mjs writes plan.manualMoves when the connector cannot move tasks; the user does them in
// Asana. This compares a FRESH READ-only live pull ({ id, gid, board, section }) against that list,
// so a task dragged into the wrong column — or not dragged at all — is caught, not assumed done.
// Exit 0 only when every move is confirmed.
//
//   node scripts/asana-moves-check.mjs --plan _ASANA-PLAN-R1.json --live _LIVE-R1-after.json

import { readFileSync, existsSync } from 'node:fs';
import { args, fail } from '../lib/profile.mjs';

const { flags } = args();
if (!flags.plan || !flags.live) fail('usage: asana-moves-check.mjs --plan <plan.json> --live <fresh live.json>', 2);
for (const f of [flags.plan, flags.live]) if (!existsSync(f)) fail(`[asana-moves-check] ${f} does not exist`, 2);

const plan = JSON.parse(readFileSync(flags.plan, 'utf8'));
if (plan.moveMode !== 'manual' || !Array.isArray(plan.manualMoves))
  fail(`[asana-moves-check] ${flags.plan} has no manual moves (moveMode = ${plan.moveMode || 'unset'}) — nothing to check`, 2);

const raw = JSON.parse(readFileSync(flags.live, 'utf8'));
const live = new Map();
for (const t of Array.isArray(raw) ? raw : raw.tickets || []) live.set(String(t.gid), t);

let bad = 0;
for (const m of plan.manualMoves) {
  const rec = live.get(m.taskGid);
  const now = rec ? rec.section || rec.state || rec.status || null : null;
  let status;
  if (!rec) status = 'MISSING from the live pull';
  else if (now === m.to) status = 'ok';
  else if (now === m.from) status = `NOT MOVED (still in "${now}")`;
  else status = `WRONG COLUMN ("${now}", expected "${m.to}")`;
  if (status !== 'ok') bad++;
  console.log(`  ${status === 'ok' ? '✓' : '✗'} ${m.ticket} (${m.board}) → "${m.to}" — ${status}`);
}

console.log(`\n[asana-moves-check] ${plan.manualMoves.length - bad}/${plan.manualMoves.length} moves confirmed for run ${plan.runId}`);
if (bad) process.exit(1);
