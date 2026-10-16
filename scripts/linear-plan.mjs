#!/usr/bin/env node
// E-1 — generate the exact tracker call plan from the ledger. Deterministic: same ledger in, same
// calls out, byte for byte. No model chooses a state, a priority, an order or a body here.
//
// `linear-writer` used to be a generative model performing a transform its own prompt described as
// "never add, re-prioritize, or invent changes". This is that transform, in code. The agent's only
// remaining job is to issue the calls this file emits — and the PreToolUse gate refuses anything
// that is not in the approved plan, so it cannot deviate even if it tries.
//
//   node scripts/linear-plan.mjs --ledger _LEDGER-R4.json --out _LINEAR-PLAN-R4.json [--live _LIVE.json]

import { readFileSync, writeFileSync, mkdirSync, statSync, existsSync } from 'node:fs';
import { basename, dirname, extname, join, resolve, isAbsolute } from 'node:path';
import { args, fail, loadProfile, reportsDir, HUB } from '../lib/profile.mjs';
import { validateLedger } from '../lib/ledger.mjs';
import { route, stateFor } from '../lib/routing.mjs';
import { canonicalOp, describeOp, sha256, defaultMaxApplies } from '../lib/tracker-ops.mjs';

const { flags } = args();
if (!flags.ledger) fail('usage: linear-plan.mjs --ledger <ledger.json> [--out <plan.json>] [--live <live.json>] [--only ALP-1,ALP-2] [--delete-first <ids.json>] [--force]', 2);

const ledgerRaw = readFileSync(flags.ledger, 'utf8');
const ledger = JSON.parse(ledgerRaw);
const slug = flags.project || ledger.project;
const profile = loadProfile(slug);
// A project that tracks elsewhere must never get Linear calls planned for it, even with a stateMap
// (gamma carries one for Asana) — use that tracker's own plan script.
if (profile.tracker?.kind && profile.tracker.kind !== 'linear')
  fail(`[linear-plan] ${slug} tracks in ${profile.tracker.kind}, not Linear — use scripts/${profile.tracker.kind}-plan.mjs (R-01)`, 2);
const stateMap = profile.linear?.stateMap;
if (!stateMap)
  fail(`[linear-plan] ${slug} has no linear.stateMap — refusing to plan tracker writes with another project's default state names (R-04). Read the board's states (READ-only) into profiles/${slug}.json first.`, 2);

const { errors } = validateLedger(ledger, { profile, currentBuildId: ledger.build?.buildId });
if (errors.length && !flags.force) {
  console.error('[linear-plan] refusing to plan writes from an invalid ledger:');
  for (const e of errors) console.error(`  ✗ ${e}`);
  process.exit(1);
}
// --force is a marker, not a bypass: the plan records that its ledger failed validation and
// qa-approve refuses it unless the user explicitly accepts writing from a broken ledger.
const forced = errors.length > 0;
if (forced)
  console.error(`[linear-plan] ⚠ --force: planning from a ledger with ${errors.length} validation error(s); the plan is marked forced and qa-approve will refuse it without --accept-forced`);

// Current board state, if supplied — lets us skip no-op transitions instead of churning the board.
const liveState = new Map();
if (flags.live && existsSync(flags.live)) {
  const live = JSON.parse(readFileSync(flags.live, 'utf8'));
  for (const t of Array.isArray(live) ? live : live.tickets || []) liveState.set(t.id, t.state || t.status);
}

// --only: plan a subset of the ledger. For correcting a previous batch without re-issuing calls
// that already landed. A name that is not in the ledger is a typo, not an empty selection — refuse,
// or a mistyped ticket would silently drop out of the correction.
let plannedTickets = ledger.tickets;
if (flags.only) {
  const want = String(flags.only).split(',').map((s) => s.trim()).filter(Boolean);
  const have = new Set(ledger.tickets.map((t) => t.id));
  const unknown = want.filter((id) => !have.has(id));
  if (unknown.length) fail(`[linear-plan] --only names ticket(s) not in the ledger: ${unknown.join(', ')}`, 2);
  const sel = new Set(want);
  plannedTickets = ledger.tickets.filter((t) => sel.has(t.id));
}

// --delete-first: remove a stale comment before posting the replacement. Used when a previous batch
// put prose on a ticket that is now known to be wrong — superseding it in place would leave the
// wrong text on a developer's board. Refuses on any collector anomaly, because deleting the wrong
// comment destroys someone else's writing and cannot be undone through this tool.
const staleComment = new Map();
if (flags['delete-first']) {
  const raw = JSON.parse(readFileSync(flags['delete-first'], 'utf8'));
  if (Array.isArray(raw.anomalies) && raw.anomalies.length) {
    fail(
      `[linear-plan] ${raw.anomalies.length} anomaly/anomalies in ${flags['delete-first']} — refusing to plan any delete:\n` +
        raw.anomalies.map((a) => `  ${a.ticket}: ${a.problem}`).join('\n'),
      1,
    );
  }
  for (const c of raw.comments || []) {
    if (!c.ticket || !c.commentId) fail(`[linear-plan] delete-first entry missing ticket or commentId: ${JSON.stringify(c)}`, 1);
    if (staleComment.has(c.ticket)) fail(`[linear-plan] ${c.ticket} listed twice in ${flags['delete-first']}`, 1);
    staleComment.set(c.ticket, c);
  }
}

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.pdf': 'application/pdf', '.txt': 'text/plain', '.json': 'application/json' };

const ops = [];
const notes = [];
let n = 0;
const add = (tool, argsObj, meta = {}) => {
  const opId = `op-${String(++n).padStart(3, '0')}`;
  // a create is not idempotent — one approval, one issue/comment; transitions may be retried (R-01)
  ops.push({ opId, tool, args: argsObj, summary: describeOp(tool, argsObj), maxApplies: defaultMaxApplies(meta.kind), ...meta });
};

for (const t of plannedTickets) {
  let r;
  try {
    r = route(t);
  } catch (e) {
    notes.push(`${t.id}: skipped — ${e.message}`);
    continue;
  }
  const target = stateFor(r.route, stateMap);

  // 0. retract the superseded comment, before its replacement is posted.
  const stale = staleComment.get(t.id);
  if (stale) {
    add('mcp__claude_ai_Linear__delete_comment', { id: stale.commentId }, {
      ticket: t.id,
      kind: 'delete-comment',
      bodyTail: stale.bodyTail || null,
    });
    staleComment.delete(t.id);
  }

  // 1. comment first — the explanation should be on the ticket before the state moves under it.
  // A route that carries no comment (PASS) still gets one when a recorded user ruling asks for it;
  // ledger-validate checks that ruling (verbatim quote, R-10) before any plan is built from it.
  const rulingComment = Array.isArray(t.rulings) && t.rulings.some((x) => x?.postComment === true && x?.userQuote);
  if ((r.requiresComment || rulingComment) && t.comment) {
    add('mcp__claude_ai_Linear__save_comment', { issueId: t.id, body: t.comment }, { ticket: t.id, kind: 'comment' });
  }

  // 2. evidence, so the comment it supports is already there.
  for (const rel of t.attachments || []) {
    // Evidence paths are reports-dir-relative; some executors write them hub-root-relative
    // ("projects/<slug>/qa-reports/…"), so fall back to the hub root before calling one missing.
    let abs = isAbsolute(rel) ? rel : resolve(reportsDir(slug), rel);
    if (!existsSync(abs) && !isAbsolute(rel) && existsSync(resolve(HUB, rel))) abs = resolve(HUB, rel);
    if (!existsSync(abs)) {
      notes.push(`${t.id}: attachment missing on disk, not planned — ${rel}`);
      continue;
    }
    const size = statSync(abs).size;
    const filename = basename(abs);
    const contentType = MIME[extname(abs).toLowerCase()] || 'application/octet-stream';
    add('mcp__claude_ai_Linear__prepare_attachment_upload', { issue: t.id, filename, contentType, size }, { ticket: t.id, kind: 'attach-prepare', localPath: abs });
    add('mcp__claude_ai_Linear__create_attachment_from_upload', { issue: t.id, title: filename }, { ticket: t.id, kind: 'attach-finalize', localPath: abs });
  }

  // 3. the state move, last.
  if (r.transition) {
    const current = liveState.get(t.id);
    if (current && current === target) {
      notes.push(`${t.id}: already in "${target}" — no transition planned`);
    } else {
      add('mcp__claude_ai_Linear__save_issue', { id: t.id, state: target }, { ticket: t.id, kind: 'state', from: current || null, to: target });
    }
  } else {
    // R-04's "holds in Staging QA" assumes the ticket is ALREADY there — true on a normal run,
    // false when a previous batch moved it somewhere it does not belong. Without this, a coverage-gap
    // or needs-manual ticket sitting in Blocked would get its comment and silently stay in Blocked,
    // which is precisely the state R-02 forbids for a case QA cannot run. Only fires when the live
    // state is known, so a run without --live still cannot invent a move.
    const current = liveState.get(t.id);
    if (current && current !== target) {
      add('mcp__claude_ai_Linear__save_issue', { id: t.id, state: target }, { ticket: t.id, kind: 'state-repatriate', from: current, to: target });
      notes.push(`${t.id}: ${t.verdict} holds in "${target}", but the ticket is in "${current}" — corrective transition planned`);
    } else {
      notes.push(`${t.id}: ${t.verdict} holds in Staging QA by rule R-04 — comment only, no transition`);
    }
  }
}

// A stale comment left unmatched means a retraction we intended silently did not happen — the wrong
// prose would stay on the board while the run reported success. That is the exact failure this
// correction exists to fix, so refuse rather than note it.
if (staleComment.size) {
  fail(
    `[linear-plan] ${staleComment.size} comment(s) to delete belong to ticket(s) that were not planned ` +
      `(not in --only, or routing skipped them): ${[...staleComment.keys()].join(', ')}`,
    1,
  );
}

// New bugs, if the ledger carries them. Suppressed under --only: the selection names tickets to
// correct, and filing the run's whole backlog of new bugs alongside them would be a change nobody
// approved when they approved the correction.
if (flags.only && (ledger.candidateBugs || []).length) {
  notes.push(`${ledger.candidateBugs.length} candidate bug(s) not planned — --only restricts this plan to named tickets`);
}
for (const b of flags.only ? [] : ledger.candidateBugs || []) {
  if (b.dupeOf) {
    notes.push(`bug "${b.title}" not planned — duplicate of ${b.dupeOf}`);
    continue;
  }
  add(
    'mcp__claude_ai_Linear__save_issue',
    {
      team: profile.linear?.team,
      title: b.title,
      description: b.body,
      state: stateFor('newBug', stateMap),
      priority: b.priority,
      assignee: profile.bugAssignee,
    },
    { kind: 'new-bug' }
  );
}

const plan = {
  schemaVersion: 1,
  project: slug,
  runId: ledger.runId,
  generatedAt: new Date().toISOString(),
  ledgerFile: basename(flags.ledger),
  ledgerSha256: sha256(ledgerRaw),
  forced,
  forcedValidationErrors: forced ? errors : undefined,
  build: ledger.build?.buildId || null,
  ops: ops.map((o) => ({ ...o, hash: canonicalOp(o.tool, o.args).hash })),
  notes,
};

const out = flags.out ? resolve(HUB, flags.out) : join(reportsDir(slug), `_LINEAR-PLAN-${ledger.runId}.json`);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(plan, null, 2) + '\n');

const byKind = {};
for (const o of ops) byKind[o.kind || o.tool] = (byKind[o.kind || o.tool] || 0) + 1;

console.log(`[linear-plan] wrote ${out}`);
console.log(`  ${ops.length} operations across ${new Set(ops.map((o) => o.ticket).filter(Boolean)).size} tickets`);
for (const [k, v] of Object.entries(byKind)) console.log(`    ${k.padEnd(18)} ${v}`);
if (notes.length) {
  console.log('\n  Not planned (and why):');
  for (const x of notes) console.log(`    · ${x}`);
}
console.log(
  `\n  Nothing is authorised yet. Show this plan to the user, and only if they approve:\n` +
    `    node scripts/qa-approve.mjs --plan ${out} --user-quote "<their exact words>"`
);
