#!/usr/bin/env node
// E-1, Jira edition — generate the exact tracker call plan from the ledger for a project that
// tracks in Jira (beta / BET). Deterministic: same ledger in, same calls out, byte for byte.
// No model chooses a state, a transition id, an order or a body here.
//
// This is scripts/linear-plan.mjs with the tracker swapped, and it exists for the same reason:
// the write gate can only refuse calls that are not in an approved plan, so the plan itself must
// come from code, not from a model that has been *asked* not to improvise. The gate
// (.claude/hooks/tracker-write-gate.mjs) is already tracker-agnostic — it hashes whatever call it
// is handed — so the plan file this writes is byte-compatible with what scripts/qa-approve.mjs
// consumes. Only the shape of the calls differs, and that lives in lib/jira-ops.mjs.
//
// Three differences from the Linear generator, all forced by Jira:
//   · a status change is a workflow transition id, not a field write (profile.jira.transitions);
//   · there are no attachment tools on the Jira MCP, so evidence is never planned — the prose has
//     to stand on its own anyway (R-10);
//   · the site is behind a Cloudflare WAF that 403s payload-shaped comment bodies, so a comment it
//     would reject refuses the whole plan instead of being skipped. Skipping would leave a
//     developer with a status change and no explanation, which is exactly what R-04 forbids.
//
//   node scripts/jira-plan.mjs --ledger _LEDGER-R2.json --out _JIRA-PLAN-R2.json [--live _LIVE.json]

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { args, fail, loadProfile, HUB } from '../lib/profile.mjs';
import { validateLedger } from '../lib/ledger.mjs';
import { route, stateFor } from '../lib/routing.mjs';
import { canonicalOp, describeOp, sha256, defaultMaxApplies } from '../lib/tracker-ops.mjs';
import { jiraConfig, commentOp, transitionOp, wafViolations } from '../lib/jira-ops.mjs';

const { flags } = args();
if (!flags.ledger) fail('usage: jira-plan.mjs --ledger <ledger.json> [--project <slug>] [--out <plan.json>] [--live <live.json>] [--only BET-1,BET-2] [--comment-only] [--force]', 2);

const ledgerPath = resolve(flags.ledger);
const ledgerRaw = readFileSync(ledgerPath, 'utf8');
const ledger = JSON.parse(ledgerRaw);
const slug = flags.project || ledger.project;
const profile = loadProfile(slug);

// ---- (a) the profile must carry the board's own ids and state names -------------------------
let jira;
try {
  jira = jiraConfig(profile);
} catch (e) {
  fail(
    `[jira-plan] ${slug}: ${e.message} — refusing to plan Jira writes without the board's own cloudId, ` +
      `project key, workflow transition ids and tool names (R-01/R-04). Read them (READ-only) into ` +
      `profiles/${slug}.json first. A guessed transition id moves a ticket somewhere nobody approved.`,
    2,
  );
}
const stateMap = profile.linear?.stateMap;
if (!stateMap)
  fail(`[jira-plan] ${slug} has no linear.stateMap — refusing to plan tracker writes with another project's default state names (R-04). Read the board's statuses (READ-only) into profiles/${slug}.json first.`, 2);

// ---- (b) an invalid ledger is not a source of truth -----------------------------------------
const { errors } = validateLedger(ledger, { profile, currentBuildId: ledger.build?.buildId });
if (errors.length && !flags.force) {
  console.error('[jira-plan] refusing to plan writes from an invalid ledger:');
  for (const e of errors) console.error(`  ✗ ${e}`);
  process.exit(1);
}
// --force is a marker, not a bypass: the plan records that its ledger failed validation and
// qa-approve refuses it unless the user explicitly accepts writing from a broken ledger.
const forced = errors.length > 0;
if (forced)
  console.error(`[jira-plan] ⚠ --force: planning from a ledger with ${errors.length} validation error(s); the plan is marked forced and qa-approve will refuse it without --accept-forced`);

// ---- (c) current board state, if supplied — skip no-op transitions instead of churning ------
const liveState = new Map();
if (flags.live && existsSync(flags.live)) {
  const live = JSON.parse(readFileSync(flags.live, 'utf8'));
  for (const t of Array.isArray(live) ? live : live.tickets || []) liveState.set(t.id, t.state || t.status);
}

// --only: plan a subset of the ledger. A name that is not in the ledger is a typo, not an empty
// selection — refuse, or a mistyped key would silently drop out of the correction.
let plannedTickets = ledger.tickets;
if (flags.only) {
  const want = String(flags.only).split(',').map((s) => s.trim()).filter(Boolean);
  const have = new Set(ledger.tickets.map((t) => t.id));
  const unknown = want.filter((id) => !have.has(id));
  if (unknown.length) fail(`[jira-plan] --only names ticket(s) not in the ledger: ${unknown.join(', ')}`, 2);
  const sel = new Set(want);
  plannedTickets = ledger.tickets.filter((t) => sel.has(t.id));
}

/** Routes whose target state IS where the ticket already belongs — comment, never move (R-02/R-04). */
const HOLD_ROUTES = new Set(['stagingQaHold', 'blocked']);

const ops = [];
const notes = [];
const wafBlocked = [];
let n = 0;
const add = (tool, argsObj, meta = {}) => {
  const opId = `op-${String(++n).padStart(3, '0')}`;
  // a comment is not idempotent — one approval, one comment; transitions may be retried (R-01)
  // The approval prompt prints only `summary`; a bare transition id is not something a human can approve,
  // so state ops carry the board's state names next to the id (from → to).
  const base = describeOp(tool, argsObj);
  const summary = meta.kind === 'state' ? `${base} — ${meta.from || '?'} → ${meta.to}` : base;
  ops.push({ opId, tool, args: argsObj, summary, maxApplies: defaultMaxApplies(meta.kind), ...meta });
};

for (const t of plannedTickets) {
  let r;
  try {
    r = route(t);
  } catch (e) {
    notes.push(`${t.id}: skipped — ${e.message}`);
    continue;
  }

  // ---- (d) comment first — the explanation belongs on the ticket before the status moves ----
  if (t.comment) {
    const hits = wafViolations(t.comment);
    if (hits.length) wafBlocked.push({ ticket: t.id, patterns: hits });
    else {
      const c = commentOp(t.id, t.comment, jira);
      add(c.tool, c.args, { ticket: t.id, kind: 'comment' });
    }
  }

  // ---- (e) the status move, last ------------------------------------------------------------
  const target = stateFor(r.route, stateMap);
  // --comment-only: a re-check the user asked to report on the ticket without moving it (e.g. a bug
  // re-verified on a new build while it sits in Backlog). The flag can only REMOVE ops — it never
  // adds one — and every suppressed move is named in the notes so the omission is visible.
  if (flags['comment-only']) {
    notes.push(`${t.id}: ${t.verdict} — routed to "${target}", transition suppressed (--comment-only)`);
    continue;
  }
  if (HOLD_ROUTES.has(r.route)) {
    // R-02/R-04: a case QA could not run, and a ticket waiting on a product decision, both stay in
    // the QA queue. Jira has no "leave it where it is" transition, so the correct call is no call.
    notes.push(`${t.id}: ${t.verdict} — stays in ${target} (hold)`);
    continue;
  }
  const current = liveState.get(t.id);
  if (current && current === target) {
    notes.push(`${t.id}: already in "${target}" — no transition planned`);
    continue;
  }
  let op;
  try {
    op = transitionOp(t.id, target, jira);
  } catch (e) {
    // An unmapped state is a profile gap, not a ticket to skip: the ticket would keep its old
    // status while the run reported success.
    fail(`[jira-plan] ${t.id}: ${e.message} — add the transition to profiles/${slug}.json (read it off the board) and regenerate.`, 1);
  }
  add(op.tool, op.args, { ticket: t.id, kind: 'state', from: current || null, to: target });
}

// A comment the WAF would 403 must be rewritten, never skipped — see the header. Refuse the whole
// plan so the rewrite happens before anyone is asked to approve it.
if (wafBlocked.length) {
  fail(
    `[jira-plan] refusing to plan ${wafBlocked.length} comment(s) the Jira site's Cloudflare WAF would reject:\n` +
      wafBlocked.map((b) => `  ✗ ${b.ticket}: ${b.patterns.join(', ')}`).join('\n') +
      `\nRewrite them as plain prose — no shell snippets, no headers, no markup or JSON, no SQL/HTTP\n` +
      `keywords in capitals (R-10). A comment the WAF blocks is not skippable: the developer would get\n` +
      `a status change with no explanation.`,
    1,
  );
}

// The Jira MCP has no create-issue-from-plan path wired into this pipeline, so new bugs are
// reported, never written. Saying so in the plan is the point: a silent omission reads as "no bugs".
for (const [field, list] of [['newBugs', ledger.newBugs], ['candidateBugs', ledger.candidateBugs]]) {
  for (const b of list || []) notes.push(`ledger.${field}: "${b.title || b.id || '(untitled)'}" not planned — file Jira issues separately`);
}

const plan = {
  schemaVersion: 1,
  project: slug,
  runId: ledger.runId,
  generatedAt: new Date().toISOString(),
  ledgerFile: basename(ledgerPath),
  ledgerSha256: sha256(ledgerRaw),
  forced,
  commentOnly: !!flags['comment-only'],
  forcedValidationErrors: forced ? errors : undefined,
  build: ledger.build?.buildId || null,
  ops: ops.map((o) => ({ ...o, hash: canonicalOp(o.tool, o.args).hash })),
  notes,
};

const out = flags.out ? resolve(HUB, flags.out) : join(dirname(ledgerPath), `_JIRA-PLAN-${ledger.runId}.json`);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(plan, null, 2) + '\n');

const byKind = {};
for (const o of ops) byKind[o.kind || o.tool] = (byKind[o.kind || o.tool] || 0) + 1;

console.log(`[jira-plan] wrote ${out}`);
console.log(`  ${ops.length} operations across ${new Set(ops.map((o) => o.ticket).filter(Boolean)).size} tickets (Jira ${jira.projectKey})`);
for (const [k, v] of Object.entries(byKind)) console.log(`    ${k.padEnd(18)} ${v}`);
if (notes.length) {
  console.log('\n  Not planned (and why):');
  for (const x of notes) console.log(`    · ${x}`);
}
console.log(
  `\n  Nothing is authorised yet. Show this plan to the user, and only if they approve:\n` +
    `    node scripts/qa-approve.mjs --plan ${out} --user-quote "<their exact words>"`
);
