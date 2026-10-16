#!/usr/bin/env node
// R-19 — grade every node's handoff block. NO-VERDICT and DISCOUNTED never count as a pass.
//
//   node scripts/handoff-grade.mjs --project gamma --run R-20261013-SQ7 [--reports-dir <dir>] [--report-only]
//   node scripts/handoff-grade.mjs --file reply.md [--canary <_CANARY.json> --ticket GAM-114] [--verdicts <_VERDICTS-x.json>] [--reviewer]
//
// Run mode grades <run>-graph/handoffs/*.md, writes <run>-graph/_GRADES.json, and exits 1 when any
// handoff is NO-VERDICT or DISCOUNTED, or a reviewer node has no canary (a skipped canary is not a
// passed one). A node whose handoff is in _EVENTS.jsonl but has no handoffs/<node>.md grades NO-VERDICT. --report-only always exits 0. A reviewer's priorNote ({status, field, actual} in its
// _VERDICTS-<node>.json) decides the canary first: confirmed or a wrong value → DISCOUNTED; rejected
// with the recorded value → proven. Without one (or with any other status) the handoff is NO-VERDICT:
// the canary was never checked. A reviewer whose findings repeat the canary is DISCOUNTED either way.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { args, fail, reportsDir } from '../lib/profile.mjs';
import { parseHandoff, gradeHandoff } from '../lib/handoff.mjs';
import { graphDir, listHandoffs, readJsonSafe, readEvents, isReviewerNode, ticketOfNode } from '../lib/graph.mjs';

const { flags } = args();

if (typeof flags.file === 'string') {
  if (!existsSync(flags.file)) fail(`[handoff-grade] no such file ${flags.file}`, 2);
  const canaries = typeof flags.canary === 'string' ? readJsonSafe(flags.canary) : null;
  const canary = canaries && flags.ticket ? canaries.tickets?.[flags.ticket] : null;
  const priorNote = typeof flags.verdicts === 'string' ? readJsonSafe(flags.verdicts)?.priorNote : undefined;
  const g = gradeHandoff(parseHandoff(readFileSync(flags.file, 'utf8')), { canary, isReviewer: !!flags.reviewer || !!canary, priorNote });
  console.log(JSON.stringify(g, null, 2));
  process.exit(g.grade === 'NO-VERDICT' || g.grade === 'DISCOUNTED' ? 1 : 0);
}

if (!flags.project || !flags.run) fail('usage: handoff-grade.mjs --project <slug> --run <runId> [--reports-dir <dir>] [--report-only]  |  --file <md> [--canary <json> --ticket <id>] [--verdicts <json>] [--reviewer]', 2);
const rdir = typeof flags['reports-dir'] === 'string' ? flags['reports-dir'] : reportsDir(flags.project);
const dir = graphDir(rdir, flags.run);
let events;
try { events = readEvents(dir); } catch (e) { fail(`[handoff-grade] ${e.message}`, 1); }
// A handoff the trace records but no file holds is never silently skipped: it grades NO-VERDICT.
const onFile = new Set(listHandoffs(dir).map((h) => h.node));
const traced = [...new Set(events.filter((e) => e.event === 'handoff' && e.node).map((e) => e.node))].filter((n) => !onFile.has(n));
const handoffs = [...listHandoffs(dir), ...traced.map((node) => ({ node, path: null }))];
if (!handoffs.length) fail(`[handoff-grade] no handoffs in ${join(dir, 'handoffs')}`, 1);
const canaries = readJsonSafe(join(dir, '_CANARY.json'))?.tickets || {};

const grades = {};
const bad = [];
for (const h of handoffs) {
  const reviewer = isReviewerNode(h.node);
  const ticket = ticketOfNode(h.node);
  const canary = reviewer && ticket ? canaries[ticket] || null : null;
  // the reviewer's own record of the prior note: "rejected" + the value actually recorded proves it read the field
  const priorNote = reviewer ? readJsonSafe(join(dir, `_VERDICTS-${h.node}.json`))?.priorNote : undefined;
  const g = gradeHandoff(parseHandoff(h.path ? readFileSync(h.path, 'utf8') : ''), { canary, isReviewer: reviewer, priorNote });
  if (!h.path) g.reasons.unshift(`the trace records a handoff from ${h.node} but handoffs/${h.node}.md does not exist — save the node's final reply there and grade again`);
  if (reviewer && !canary) g.reasons.push(`no canary planted for ${ticket || h.node} — this review wave was not canary-checked`);
  grades[h.node] = { ...g, reviewer, ticket, canaryChecked: !!canary, file: h.path ? h.path.split('/').slice(-2).join('/') : null };
  const mark = g.grade === 'NO-VERDICT' || g.grade === 'DISCOUNTED' ? '✗' : reviewer && !canary ? '⚠' : '✓';
  console.log(`  ${mark} ${h.node.padEnd(28)} ${g.grade.padEnd(11)} checks=${g.checks} findings=${g.findings}${canary ? ` canary:${g.canary}` : ''}`);
  for (const r of g.reasons) console.log(`      - ${r}`);
  for (const wn of g.warnings) console.log(`      · ${wn}`);
  if (mark !== '✓') bad.push(h.node);
}
writeFileSync(join(dir, '_GRADES.json'), JSON.stringify({ run: flags.run, gradedAt: new Date().toISOString(), grades }, null, 2) + '\n');
console.log(`[handoff-grade] ${handoffs.length} handoff(s) graded → ${join(dir, '_GRADES.json').split('/').slice(-2).join('/')}`);
if (bad.length && !flags['report-only']) {
  console.error(`[handoff-grade] ${bad.length} handoff(s) do not count: ${bad.join(', ')}`);
  process.exit(1);
}
