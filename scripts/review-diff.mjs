#!/usr/bin/env node
// Blind review vs the ledger (shadow mode, PLAN Phase 1): compare every reviewer node's
// <run>-graph/_VERDICTS-<node>.json with the ledger, case by case. Informational — the review never
// overwrites the ledger; each disagreement is listed under "Waiting on a human" in _GRAPH-<run>.md.
//
//   node scripts/review-diff.mjs --project gamma --run R-20261013-SQ7 [--reports-dir <dir>] [--json]

import { join } from 'node:path';
import { args, fail, reportsDir } from '../lib/profile.mjs';
import { graphDir, readJsonSafe, reviewDiffs, reviewDisagrees, describeReview } from '../lib/graph.mjs';

const { flags } = args();
if (!flags.project || !flags.run) fail('usage: review-diff.mjs --project <slug> --run <runId> [--reports-dir <dir>] [--json]', 2);
const rdir = typeof flags['reports-dir'] === 'string' ? flags['reports-dir'] : reportsDir(flags.project);
const ledger = readJsonSafe(join(rdir, `_LEDGER-${flags.run}.json`));
if (!ledger) fail(`[review-diff] no readable _LEDGER-${flags.run}.json in ${rdir}`, 1);
const reviews = reviewDiffs(graphDir(rdir, flags.run), ledger);

if (flags.json) { console.log(JSON.stringify(reviews, null, 2)); process.exit(0); }
if (!reviews.length) { console.log(`[review-diff] no reviewer verdicts in ${flags.run}-graph/ yet`); process.exit(0); }
for (const r of reviews) {
  if (!reviewDisagrees(r)) { console.log(`  = ${r.ticket.padEnd(10)} ${r.node.padEnd(22)} agrees: ticket ${r.ticketLedger}, ${r.cases} case(s)`); continue; }
  console.log(`  ≠ ${String(r.ticket).padEnd(10)} ${r.node.padEnd(22)} ${describeReview(r)}`);
  for (const d of r.diffs) console.log(`      ${d.caseId.padEnd(8)} ledger ${String(d.ledger).padEnd(12)} review ${String(d.review).padEnd(12)} ${d.why.slice(0, 110)}`);
  for (const d of r.doubts) console.log(`      ${d.caseId.padEnd(8)} plan vs AC  ${d.text.slice(0, 130)}`);
}
const n = reviews.filter(reviewDisagrees).length;
console.log(`[review-diff] ${reviews.length} review(s): ${reviews.length - n} agree, ${n} disagree${n ? ' — each waits on a human (shadow mode: the ledger is unchanged)' : ''}`);
