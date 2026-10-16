#!/usr/bin/env node
// E-1b — generate a tracker plan for tickets whose outcome depends on an answer from a human
// (dev or PM), from a routing file that names the tickets and the ask.
//
//   node scripts/plan-questions.mjs --project alpha --run R4 \
//     --routing projects/alpha/qa-reports/_QUESTION-ROUTING-R4.json \
//     --out projects/alpha/qa-reports/_PLAN-R4-batch2.json
//
// Why this exists separately from linear-plan.mjs: that script derives the destination state from
// the verdict via the profile's stateMap (R-04), which is correct for a verdict-driven pass. This
// one implements a *lead's explicit instruction* to park question-blocked tickets in Blocked so the
// board shows who is being waited on. The distinction matters, so it is a different file with a
// different input rather than a flag that quietly overrides routing.
//
// What is still NOT authored here: the comment prose. Each body is the ledger's own generated
// comment for that ticket, with the routing file's one-line ask and the mention appended. If a
// ticket has no ledger comment, this refuses rather than inventing one.

import { readFileSync, writeFileSync } from 'node:fs';
import { args, fail, loadProfile, reportsDir } from '../lib/profile.mjs';
import { canonicalOp, describeOp, sha256 } from '../lib/tracker-ops.mjs';
import { route, stateFor } from '../lib/routing.mjs';

const { flags } = args();
if (!flags.project || !flags.run || !flags.routing || !flags.out) {
  fail('usage: plan-questions.mjs --project <slug> --run <runId> --routing <routing.json> --out <plan.json> [--mention-id <uuid>]', 2);
}

const dir = reportsDir(flags.project);
// --ledger overrides the derived path, matching linear-plan.mjs. Needed so the gate can be tested
// against a throwaway ledger without writing one into a real project's reports directory.
const ledgerPath = flags.ledger || `${dir}/_LEDGER-${flags.run}.json`;
const ledgerRaw = readFileSync(ledgerPath, 'utf8');
const ledger = JSON.parse(ledgerRaw);
const routing = JSON.parse(readFileSync(flags.routing, 'utf8'));
const profile = loadProfile(flags.project);
const stateMap = profile.linear?.stateMap;
if (!stateMap) fail(`[plan-questions] ${flags.project} has no linear.stateMap (R-04) — refusing to plan writes with default state names`, 2);

const target = routing.transitionTo;
const known = new Set(Object.values(stateMap));
if (!known.has(target)) {
  fail(`[plan-questions] "${target}" is not a state in ${flags.project}'s linear.stateMap (${[...known].join(', ')})`, 2);
}

// Mention form. The Linear MCP contract for save_comment is explicit: "To mention a user, use
// @displayName (e.g., @johndoe)" — so the display name is what resolves to a real mention and a
// notification, NOT a markdown link carrying the user id. Use `--mention id` only if that contract
// changes; resolve the display name with list_users, since it is not always the first name.
const handle = flags.handle || routing.mentionHandle || routing.mentionUser;
const id = flags['mention-id'] || routing.mentionUserId;
const form = flags.mention || 'plain';
if (form === 'id' && !id) fail('[plan-questions] --mention id needs --mention-id or routing.mentionUserId', 2);
const mention = form === 'plain' ? `@${handle}` : `@[${handle}](${id})`;

// R-02 — asking a human is a last resort that has to be earned.
//
// In R4 batch 2, 18 tickets were parked in Blocked asking a developer to seed fixtures the harness
// could already create. Nothing in this script stopped it: it faithfully generated exactly the plan
// it was given. A question with no probe behind it is the most expensive thing QA can produce — it
// costs a developer's attention and returns a fixture we could have built ourselves — so the probe
// is required here, in the same shape `run-result-validate.mjs` demands for a needs-manual case.
const PROBE_FIELDS = ['attempted', 'failureMode', 'missingCapability', 'evidence'];

// R-02 names these as covered, so they can never be the missing capability. Email is a connected
// Gmail account with `+alias`; Alpha card payments are PAYGW UAT test cards. Both were cited as
// blockers in past runs and both were wrong.
const COVERED = [
  [/\b(e-?mail|gmail|inbox|verification link|magic link)\b/i, 'email is covered — Gmail is connected on qa@your-company.example and supports +aliasing'],
  [/\b(card|payment|checkout|paygw|stripe)\b/i, 'Alpha card payments are covered — PAYGW UAT test cards 1363840922445543 / 1973028358426285, clientId 1183'],
];

// The R4 batch-2 wording, near-verbatim. A fixture that does not exist yet is work, not a missing
// capability — the distinction R-02 exists to draw.
const NOT_A_CAPABILITY = [
  /\b(no|there is no|isn'?t (a|an)|lack of|missing|need|needs?)\b.{0,40}\b(fixture|test data|seed|sample|deal|listing|account|record)\b/i,
  /\b(deal|ticket|listing|account)\b.{0,40}\bnot (currently )?(in|at|available)\b/i,
  /\bno (deal|listing|account|record)s? (is|are)? ?(currently )?(at|in)\b/i,
];

const probeErrors = [];
for (const entry of routing.tickets) {
  const p = entry.probe;
  if (!p || typeof p !== 'object') {
    probeErrors.push(`${entry.id}: no probe. R-02 — "the agent can't run this" is a claim to disprove, not a category to pick. Record what you attempted, how it failed, the specific capability that is missing, and the evidence.`);
    continue;
  }
  for (const f of PROBE_FIELDS) if (!p[f]) probeErrors.push(`${entry.id}: probe.${f} is missing`);
  const cap = String(p.missingCapability || '');
  for (const [re, why] of COVERED) {
    if (re.test(cap)) probeErrors.push(`${entry.id}: probe.missingCapability claims "${cap}" — ${why}. Test it rather than asking.`);
  }
  for (const re of NOT_A_CAPABILITY) {
    if (re.test(cap)) probeErrors.push(`${entry.id}: probe.missingCapability describes a fixture that has not been built, not a capability QA lacks: "${cap}". Genuinely uncovered means real-device mic/camera/GPS/biometric/NFC, push on hardware, SMS, or manual OAuth/CAPTCHA. Build the fixture.`);
  }
}
if (probeErrors.length) {
  fail(
    `[plan-questions] refusing to ask a human on ${probeErrors.length} ground(s) — every question needs a recorded probe (R-02):\n` +
      probeErrors.map((e) => `  ✗ ${e}`).join('\n'),
    1,
  );
}

const ops = [];
const notes = [];
let n = 0;
const add = (tool, argsObj, meta) => {
  const opId = `op-${String(++n).padStart(3, '0')}`;
  const { hash } = canonicalOp(tool, argsObj);
  ops.push({ opId, tool, args: argsObj, summary: describeOp(tool, argsObj), ...meta, hash });
};

for (const entry of routing.tickets) {
  const t = ledger.tickets.find((x) => x.id === entry.id);
  if (!t) fail(`[plan-questions] ${entry.id} is in the routing file but not in ${ledgerPath}`, 1);
  // A ticket whose defect passed carries no defect comment — its generated prose is the
  // scopeQuestion instead. Either is ledger output; what this refuses to do is write prose of its
  // own when the ledger has none.
  const prose = t.comment || t.scopeQuestion;
  if (!prose) fail(`[plan-questions] ${entry.id} has neither a ledger comment nor a scopeQuestion — refusing to invent prose for it`, 1);

  // When the prose IS the question, appending the routing file's restatement of it would say the
  // same thing twice; close with the address instead.
  const close = t.comment
    ? `${mention} — ${entry.ask}`
    : `${mention} — could you make this call? The reported defect itself is fixed and verified on the current build; QA is holding the ticket here rather than closing it because this decision is still open.`;
  const body = `${prose.trim()}\n\n---\n\n${close}`;
  // The probe rides along in the op's metadata, not its args, so it is visible to whoever approves
  // the plan without changing the call hash. Someone approving a question to a developer should be
  // able to see what QA tried first, on the same screen, without opening another file.
  add('mcp__claude_ai_Linear__save_comment', { issueId: entry.id, body }, { ticket: entry.id, kind: 'comment', probe: entry.probe });

  // R-02 carve-out: a NEEDS_MANUAL ticket keeps its derived state. The rule is explicit that a
  // case QA cannot run stays in Staging QA and never goes to Blocked, so the instruction to park
  // question-blocked tickets in Blocked is applied to everything EXCEPT these. They still get the
  // comment, which is what actually carries the request to a human.
  const derived = stateFor(route(t).route, stateMap);
  if (t.verdict === 'NEEDS_MANUAL') {
    notes.push(`${entry.id}: NEEDS_MANUAL — comment only, stays in "${derived}" (R-02 forbids Blocked for a case QA cannot run)`);
    continue;
  }
  if (derived === target) {
    notes.push(`${entry.id}: already routes to "${target}" by verdict — transition still issued to move it off Staging QA`);
  }
  add('mcp__claude_ai_Linear__save_issue', { id: entry.id, state: target }, { ticket: entry.id, kind: 'state', to: target });
}

const plan = {
  schemaVersion: 1,
  project: flags.project,
  runId: flags.run,
  generatedAt: null,
  ledgerFile: ledgerPath,
  ledgerSha256: sha256(ledgerRaw),
  routingFile: flags.routing,
  build: ledger.build,
  ops,
  notes,
};

writeFileSync(flags.out, JSON.stringify(plan, null, 2));
const kinds = {};
for (const o of ops) kinds[o.kind] = (kinds[o.kind] || 0) + 1;
console.log(`[plan-questions] ${ops.length} op(s) across ${new Set(ops.map((o) => o.ticket)).size} ticket(s) → ${flags.out}`);
console.log(`  by kind: ${JSON.stringify(kinds)}`);
console.log(`  mention: ${mention}`);
for (const note of notes) console.log(`  note: ${note}`);
