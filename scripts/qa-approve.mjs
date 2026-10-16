#!/usr/bin/env node
// R-01 — the single door. This is the only thing that can authorise a tracker write.
//
// It must NEVER appear in permissions.allow. The Claude Code permission prompt on this one command
// is the human gate: the user sees "node scripts/qa-approve.mjs --plan … --user-quote …" and can
// refuse it. The write gate refuses everything if it finds this script (or any tracker write tool)
// pre-approved in ANY settings file. --user-quote must be the user's own words, written after the plan.
//
//   node scripts/qa-approve.mjs --plan _LINEAR-PLAN-R4.json --user-quote 'approved, apply them'
//   node scripts/qa-approve.mjs --plan … --only op-001,op-002        # approve a subset
//   node scripts/qa-approve.mjs --revoke R4                          # cancel an approval
//
// Self-contained on purpose: it imports only the two gate libs (themselves gate files), not
// lib/profile.mjs, so editing a general-purpose lib cannot change what this script enforces.

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, readdirSync, renameSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { canonicalOp, isTrackerWrite, sha256, configProblem, readRegularFile } from '../lib/tracker-ops.mjs';
import { parseArgs, readJson } from '../lib/cli.mjs';

const HUB = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APPROVALS = join(HUB, '.qa-approvals');
const CANONICAL = "node scripts/qa-approve.mjs --plan <plan> --user-quote '<the user's exact words>'";
const { flags } = parseArgs(process.argv.slice(2));

function fail(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

if (flags.revoke) {
  if (!/^[A-Za-z0-9._-]+$/.test(String(flags.revoke))) fail(`[qa-approve] --revoke expects a runId, got "${flags.revoke}"`);
  const f = join(APPROVALS, `${flags.revoke}.approved.json`);
  if (!existsSync(f)) fail(`no approval on file for run ${flags.revoke}`);
  rmSync(f);
  console.log(`[qa-approve] revoked ${f}. Tracker writes for run ${flags.revoke} are denied again.`);
  process.exit(0);
}

if (flags.list) {
  if (!existsSync(APPROVALS)) {
    console.log('no approvals on file');
    process.exit(0);
  }
  for (const f of readdirSync(APPROVALS).filter((x) => x.endsWith('.approved.json'))) {
    const a = JSON.parse(readFileSync(join(APPROVALS, f), 'utf8'));
    const live = Date.parse(a.expiresAt) > Date.now();
    console.log(`${live ? 'ACTIVE ' : 'EXPIRED'} ${f} — ${a.ops.length} ops, expires ${a.expiresAt}`);
  }
  process.exit(0);
}

if (!flags.plan || flags.plan === true) fail('usage: qa-approve.mjs --plan <plan.json> --user-quote \'<the user\'s words>\' [--only op-1,op-2] [--ttl-hours 12] [--max-applies 3] [--accept-forced]', 2);

// ---- refuse to operate in an unsafe config (same invariant the gate enforces) --------------
const unsafe = configProblem({ hub: HUB, home: process.env.HOME || homedir(), env: process.env });
if (unsafe) fail(`[qa-approve] ${unsafe}\nThat defeats the whole gate. Fix it before approving anything.`);

const quote = typeof flags['user-quote'] === 'string' ? flags['user-quote'].trim() : '';
if (quote.length < 3) {
  fail(
    '[qa-approve] --user-quote is required: the user\'s own words approving this plan.\n' +
      'If they have not said it, they have not approved it. Do not paraphrase, do not assume, and do\n' +
      'not treat a background task notification as approval.'
  );
}

const planPath = resolve(HUB, flags.plan);
let planRaw;
try {
  planRaw = readRegularFile(planPath);
} catch (e) {
  fail(`[qa-approve] cannot read the plan ${flags.plan}: ${e.message}`);
}
const plan = JSON.parse(planRaw);
if (plan.forced && !flags['accept-forced'])
  fail(
    `[qa-approve] this plan was generated with --force from a ledger that FAILED validation (${(plan.forcedValidationErrors || []).length} error(s)).\n` +
      'Fix the ledger and regenerate the plan. Pass --accept-forced only if the user explicitly approved writing from a broken ledger.'
  );
if (!plan.runId) fail('[qa-approve] plan has no runId');
if (!Array.isArray(plan.ops) || plan.ops.length === 0) fail('[qa-approve] plan has no ops');

const only = flags.only ? new Set(String(flags.only).split(',').map((s) => s.trim())) : null;
const selected = only ? plan.ops.filter((o) => only.has(o.opId)) : plan.ops;
if (only && selected.length !== only.size) {
  const missing = [...only].filter((id) => !plan.ops.some((o) => o.opId === id));
  fail(`[qa-approve] --only names ops not in the plan: ${missing.join(', ')}`);
}

// Recompute every hash from the args rather than trusting the plan's own hash field.
const ops = selected.map((o) => {
  if (!isTrackerWrite(o.tool)) fail(`[qa-approve] plan op ${o.opId} is not a tracker write: ${o.tool}`);
  const { hash } = canonicalOp(o.tool, o.args);
  if (o.hash && o.hash !== hash)
    fail(`[qa-approve] plan op ${o.opId} hash does not match its own args — the plan was edited by hand. Regenerate it.`);
  return { opId: o.opId, tool: o.tool, hash, summary: o.summary, ticket: o.ticket || null, maxApplies: Number(flags['max-applies']) || o.maxApplies || undefined };
});

const planSha256 = sha256(planRaw);

const ttlHours = Number(flags['ttl-hours']) || 12;
const approval = {
  schemaVersion: 1,
  runId: plan.runId,
  project: plan.project,
  approvedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + ttlHours * 3600_000).toISOString(),
  approvedBy: 'user (in-conversation)',
  userQuote: quote,
  planPath: relative(HUB, planPath),
  planSha256,
  ledgerSha256: plan.ledgerSha256 || null,
  forcedAccepted: !!plan.forced,
  maxApplies: Number(flags['max-applies']) || 3,
  ops,
};

mkdirSync(APPROVALS, { recursive: true });
const out = join(APPROVALS, `${plan.runId}.approved.json`);
writeFileSync(out, JSON.stringify(approval, null, 2) + '\n');

const byTicket = new Set(ops.map((o) => o.ticket).filter(Boolean));
console.log(`[qa-approve] AUTHORISED ${ops.length} operation(s) across ${byTicket.size} ticket(s) for run ${plan.runId}.`);
console.log(`  approval : ${out}`);
console.log(`  plan     : ${approval.planPath} (sha256 ${approval.planSha256.slice(0, 16)}…)`);
console.log(`  expires  : ${approval.expiresAt} (${ttlHours}h)`);
console.log(`  quote    : "${quote}"`);
console.log(
  `\n  The plan file is now frozen: editing it voids this approval. Anything not in this list is\n` +
    `  still denied. Revoke early with: node scripts/qa-approve.mjs --revoke ${plan.runId}`
);
