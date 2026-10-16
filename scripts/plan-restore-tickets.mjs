#!/usr/bin/env node
// E-1c — withdraw a question that should never have been asked.
//
//   node scripts/plan-restore-tickets.mjs --project alpha --run R4 \
//     --ids projects/alpha/qa-reports/_R4-COMMENT-IDS.json \
//     --out projects/alpha/qa-reports/_PLAN-R4-batch3.json
//
// Why this exists: R-02 says "the agent can't run this" is a claim to disprove with a probe naming
// a specific missing capability. In R4 batch 2, 18 tickets were parked in Blocked with a request
// that a fixture be seeded — fixtures the harness can already create. That is QA's own work, not a
// question, so the comment is deleted (not superseded: leaving it would keep a false request on a
// dev's board) and the ticket returns to the untested-work state to be run properly.
//
// What is NOT authored here: the destination state. It resolves from the profile's
// linear.stateMap.stagingQaHold, so the name is never typed into a plan (R-04).

import { readFileSync, writeFileSync } from 'node:fs';
import { args, fail, loadProfile } from '../lib/profile.mjs';
import { canonicalOp, describeOp, sha256 } from '../lib/tracker-ops.mjs';

const { flags } = args();
if (!flags.project || !flags.run || !flags.ids || !flags.out) {
  fail('usage: plan-restore-tickets.mjs --project <slug> --run <runId> --ids <ids.json> --out <plan.json>', 2);
}

const idsRaw = readFileSync(flags.ids, 'utf8');
const ids = JSON.parse(idsRaw);
const profile = loadProfile(flags.project);
const target = profile.linear?.stateMap?.stagingQaHold;
if (!target) fail(`[plan-restore] ${flags.project} has no linear.stateMap.stagingQaHold`, 2);

// An anomaly means the collector could not tell which comment is ours. Deleting the wrong comment
// destroys someone else's writing and is not undoable through this tool, so refuse the whole plan
// rather than emitting the subset that happened to be clean.
if (Array.isArray(ids.anomalies) && ids.anomalies.length) {
  fail(
    `[plan-restore] ${ids.anomalies.length} anomaly/anomalies in ${flags.ids} — refusing to plan any delete until each is resolved by hand:\n` +
      ids.anomalies.map((a) => `  ${a.ticket}: ${a.problem}`).join('\n'),
    1,
  );
}

const entries = ids.comments || [];
if (!entries.length) fail(`[plan-restore] no comments listed in ${flags.ids}`, 1);

const ops = [];
const notes = [];
let n = 0;
const add = (tool, argsObj, meta) => {
  const opId = `op-${String(++n).padStart(3, '0')}`;
  const { hash } = canonicalOp(tool, argsObj);
  ops.push({ opId, tool, args: argsObj, summary: describeOp(tool, argsObj), ...meta, hash });
};

const seen = new Set();
for (const e of entries) {
  if (!e.ticket || !e.commentId) fail(`[plan-restore] entry missing ticket or commentId: ${JSON.stringify(e)}`, 1);
  if (seen.has(e.commentId)) fail(`[plan-restore] comment ${e.commentId} listed twice — a double delete would fail closed`, 1);
  seen.add(e.commentId);

  add('mcp__claude_ai_Linear__delete_comment', { id: e.commentId }, {
    ticket: e.ticket,
    kind: 'delete-comment',
    // Carried for the human reading the plan; excluded from args, so it cannot affect the hash.
    bodyTail: e.bodyTail || null,
  });

  // Only move a ticket that is not already where it belongs — an op that changes nothing still has
  // to be approved, replayed and audited, and it muddies the count of what this run actually did.
  if (e.state === target) {
    notes.push(`${e.ticket}: already in "${target}" — comment deleted, no transition needed`);
    continue;
  }
  add('mcp__claude_ai_Linear__save_issue', { id: e.ticket, state: target }, {
    ticket: e.ticket,
    kind: 'state',
    from: e.state || null,
    to: target,
  });
}

const plan = {
  schemaVersion: 1,
  project: flags.project,
  runId: flags.run,
  generatedAt: null,
  idsFile: flags.ids,
  idsSha256: sha256(idsRaw),
  intent:
    'Withdraw the R4 batch-2 fixture requests from the tickets QA can test itself (R-02), and return them to the untested-work state.',
  ops,
  notes,
};

writeFileSync(flags.out, JSON.stringify(plan, null, 2));
const kinds = {};
for (const o of ops) kinds[o.kind] = (kinds[o.kind] || 0) + 1;
console.log(`[plan-restore] ${ops.length} op(s) across ${new Set(ops.map((o) => o.ticket)).size} ticket(s) → ${flags.out}`);
console.log(`  by kind: ${JSON.stringify(kinds)}`);
console.log(`  destination state: "${target}" (from profile stateMap.stagingQaHold)`);
for (const note of notes) console.log(`  note: ${note}`);
