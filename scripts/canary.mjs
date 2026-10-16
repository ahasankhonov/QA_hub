#!/usr/bin/env node
// Plant one provably-false prior note per reviewed ticket (canary.md, the reviewer 2026-10-15).
// Built BY SCRIPT from the run's own evidence, so it is always refutable from the _RESULT file.
//
//   node scripts/canary.mjs --project gamma --run R-20261013-SQ7 --ticket GAM-114 [--seed 0] [--reports-dir <dir>]
//
// Writes/merges <run>-graph/_CANARY.json and prints the note to paste under "## Prior notes (unverified)"
// in that ticket's reviewer prompt. A ticket's canary is never replaced once a reviewer may have seen it.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { args, fail, reportsDir } from '../lib/profile.mjs';
import { buildCanary, canarySelfCheck } from '../lib/handoff.mjs';
import { graphDir, readJsonSafe } from '../lib/graph.mjs';

const { flags } = args();
if (!flags.project || !flags.run || !flags.ticket) fail('usage: canary.mjs --project <slug> --run <runId> --ticket <id> [--seed n] [--reports-dir <dir>] [--result <file>]', 2);

const rdir = typeof flags['reports-dir'] === 'string' ? flags['reports-dir'] : reportsDir(flags.project);
const resultPath = typeof flags.result === 'string' ? flags.result : join(rdir, `_RESULT-${flags.run}-${flags.ticket}.json`);
const result = readJsonSafe(resultPath);
if (!result) fail(`[canary] no readable run result at ${resultPath}`);
const ledger = readJsonSafe(join(rdir, `_LEDGER-${flags.run}.json`));
const ledgerTicket = ledger?.tickets?.find((t) => t.id === flags.ticket) || null;

const dir = graphDir(rdir, flags.run);
mkdirSync(dir, { recursive: true });
const file = join(dir, '_CANARY.json');
const all = readJsonSafe(file) || { run: flags.run, tickets: {} };
if (all.tickets[flags.ticket]) {
  console.log(all.tickets[flags.ticket].note);
  console.error(`[canary] ${flags.ticket} already has a canary in this graph — reusing it (never replaced).`);
  process.exit(0);
}

const c = buildCanary({ result, ledgerTicket, seed: Number(flags.seed || 0) });
if (!c) fail(`[canary] ${flags.ticket}: the evidence has no refutable case (no 2xx, nothing ranOk) — review wave has no canary; say so in the graph.`);
const self = canarySelfCheck(c);
if (!self.ok)
  fail(`[canary] pattern self-check failed — flags a rejection: ${JSON.stringify(self.flagsRejection)}; misses a repeat: ${JSON.stringify(self.missesRepeat)} — fix lib/handoff.mjs buildCanary`);

all.tickets[flags.ticket] = { ...c, createdAt: new Date().toISOString(), source: resultPath.split('/').pop() };
writeFileSync(file, JSON.stringify(all, null, 2) + '\n');
console.log(c.note);
