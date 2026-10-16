#!/usr/bin/env node
// Comment-only edition of scripts/jira-plan.mjs — turn reviewed comment DRAFTS for tickets that
// sit outside the run ledger (re-checks of already-filed bugs, follow-ups on closed tickets) into
// the exact addCommentToJiraIssue calls, in the plan shape scripts/qa-approve.mjs freezes and the
// write gate enforces (R-01).
//
// jira-plan.mjs is ledger-driven, so a comment on a ticket the run did not adjudicate had no
// generator and ended up hand-typed into a plan. This closes that gap without widening anything:
// it emits COMMENT ops only — never a transition, an edit or a create — and refuses a draft file
// that asks for anything else.
//
// Deterministic: same drafts + live pull in, same calls out (op-001… in file order). Nothing here
// decides *what* to say — the drafts carry the reviewed prose. This script only refuses drafts that
// cannot be posted as written, each with a named reason and a non-zero exit:
//   · an empty body, or a draft id used twice (or the same body twice on one ticket — the gate
//     counts applies per call hash, so the second would be denied mid-replay);
//   · a body the Cloudflare WAF would 403 (lib/jira-ops.mjs wafViolations);
//   · a body that leaks an internal QA artefact — result/ledger files, screenshots, PAR-/RC-/run ids (R-10);
//   · a ticket key from another project, or one that is not in the --live pull (a typo'd key would
//     post a QA note onto some unrelated issue);
//   · a draft carrying a transition / state / edit field (comment-only generator).
// The plan's runId is "<run>-CM" so its approval file never collides with the run's own plan or
// the new-bug plan ("<run>-NB").
//
//   node scripts/jira-comments-plan.mjs --drafts _COMMENTS-R1.json --live _LIVE-R1.json --out _JIRA-COMMENTS-PLAN-R1.json [--project <slug>]

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { args, fail, loadProfile } from '../lib/profile.mjs';
import { canonicalOp, describeOp, sha256, defaultMaxApplies } from '../lib/tracker-ops.mjs';
import { jiraConfig, commentOp, wafViolations, internalArtefactLeaks } from '../lib/jira-ops.mjs';

const { flags } = args();
const USAGE = 'usage: jira-comments-plan.mjs --drafts <_COMMENTS-….json> --live <_LIVE-….json> [--out <plan.json>] [--project <slug>]';
if (!flags.drafts || flags.drafts === true) fail(USAGE, 2);
if (!flags.live || flags.live === true) fail(`[jira-comments-plan] --live is required: every ticket key is checked against the live pull. ${USAGE}`, 2);

const draftsPath = resolve(flags.drafts);
const draftsRaw = readFileSync(draftsPath, 'utf8');
const drafts = JSON.parse(draftsRaw);
const slug = flags.project || drafts.project;
if (!slug) fail('[jira-comments-plan] no project: pass --project or put "project" in the drafts file');
if (drafts.project && flags.project && drafts.project !== flags.project)
  fail(`[jira-comments-plan] drafts file is for "${drafts.project}", not "${flags.project}"`);
const profile = loadProfile(slug);

let jira;
try {
  jira = jiraConfig(profile);
} catch (e) {
  fail(`[jira-comments-plan] ${slug} cannot be planned for Jira: ${e.message}`);
}
if (!drafts.runId || !Array.isArray(drafts.comments)) fail('[jira-comments-plan] drafts file needs { runId, comments: [] }');
if (!drafts.comments.length) fail('[jira-comments-plan] drafts file has no comments');

const livePath = resolve(flags.live);
if (!existsSync(livePath)) fail(`[jira-comments-plan] --live file not found: ${livePath}`);
const liveRaw = readFileSync(livePath, 'utf8');
const live = JSON.parse(liveRaw);
const liveTickets = Array.isArray(live) ? live : live.tickets || [];
if (!liveTickets.length) fail(`[jira-comments-plan] --live pull ${basename(livePath)} has no tickets — cannot check a single key against it`);
const liveState = new Map(liveTickets.map((t) => [t.id || t.key, t.state || t.status || null]));

const KEY_RE = new RegExp(`^${jira.projectKey}-\\d+$`);
const ALLOWED = new Set(['commentId', 'ticket', 'platform', 'bodyMd']);
// Provenance fields (sourceRc, sourceCandidate, evidence, evidenceRestriction…) stay in the drafts
// file for the QA lead; they are never posted and never copied into the plan.
const PROVENANCE = /^(source|evidence)[A-Za-z]*$/;
// Fields that would make a draft more than a comment. Named so the refusal says why.
const NOT_A_COMMENT = /^(transition|transitionId|state|status|to|from|kind|tool|summary|fields|additional_fields|priority|labels|assignee|description|issueType|issueTypeName)$/i;
const MAX_BODY = 32000; // Jira rejects a comment body above 32,767 characters

const errors = [];
const ops = [];
const seenIds = new Set();
const seenBodies = new Set();
let n = 0;

for (const d of drafts.comments) {
  const where = `comment ${d?.commentId || '(no id)'}`;
  if (!d || typeof d !== 'object') {
    errors.push(`${where}: not an object`);
    continue;
  }
  const before = errors.length;
  if (!d.commentId) errors.push(`${where}: commentId is missing`);
  else if (seenIds.has(d.commentId)) errors.push(`${where}: duplicate commentId — each draft id must be unique`);
  else seenIds.add(d.commentId);

  for (const k of Object.keys(d)) {
    if (NOT_A_COMMENT.test(k)) errors.push(`${where}: carries "${k}" — this generator plans comments only, never a transition, edit or create (use jira-plan.mjs / jira-newbugs-plan.mjs)`);
    else if (!ALLOWED.has(k) && !PROVENANCE.test(k)) errors.push(`${where}: unknown field "${k}" (allowed: ${[...ALLOWED].join(', ')}, plus source*/evidence* provenance)`);
  }

  const key = d.ticket;
  if (typeof key !== 'string' || !/^[A-Z][A-Z0-9]*-\d+$/.test(key)) errors.push(`${where}: ticket "${key}" is not an issue key`);
  else if (!KEY_RE.test(key)) errors.push(`${where}: ticket ${key} is not in project ${jira.projectKey} (profile ${slug})`);
  else if (!liveState.has(key)) errors.push(`${where}: ticket ${key} is not in the live pull ${basename(livePath)} — refusing to comment on a key nobody has seen`);

  const body = typeof d.bodyMd === 'string' ? d.bodyMd.trim() : '';
  if (!body) errors.push(`${where}: bodyMd is empty`);
  else {
    if (body.length > MAX_BODY) errors.push(`${where}: body is ${body.length} chars, Jira allows ~32,767`);
    const waf = wafViolations(body);
    if (waf.length) errors.push(`${where}: body would be blocked by the Cloudflare WAF (${waf.join(', ')}) — rewrite as plain prose`);
    const leaks = internalArtefactLeaks(body);
    if (leaks.length) errors.push(`${where}: body leaks an internal QA artefact (${leaks.join(', ')}) — dev-facing text must stand alone (R-10)`);
    const dupKey = `${key}\u0000${body}`;
    if (seenBodies.has(dupKey)) errors.push(`${where}: the same body is already drafted for ${key} — identical calls share one hash and the second would be denied`);
    seenBodies.add(dupKey);
  }
  if (errors.length > before) continue;

  const call = commentOp(key, body, jira);
  ops.push({
    opId: `op-${String(++n).padStart(3, '0')}`,
    tool: call.tool,
    args: call.args,
    summary: describeOp(call.tool, call.args),
    maxApplies: defaultMaxApplies('comment'),
    ticket: key,
    kind: 'comment',
    commentId: d.commentId,
    liveState: liveState.get(key),
  });
}

// Invariant, not a draft check: whatever happened above, nothing but the profile's comment tool leaves here.
for (const o of ops) if (o.tool !== jira.tools.comment || o.kind !== 'comment') errors.push(`${o.opId}: not a comment op (${o.tool}) — internal error`);

if (errors.length) {
  console.error(`[jira-comments-plan] REFUSED — ${errors.length} problem(s):`);
  for (const e of errors) console.error('  · ' + e);
  process.exit(1);
}

const plan = {
  schemaVersion: 1,
  project: slug,
  runId: `${drafts.runId}-CM`,
  sourceRunId: drafts.runId,
  generatedAt: new Date().toISOString(),
  ledgerFile: basename(draftsPath),
  ledgerSha256: sha256(draftsRaw),
  liveFile: basename(livePath),
  liveSha256: sha256(liveRaw),
  forced: false,
  commentOnly: true,
  build: drafts.build?.buildId || drafts.build || null,
  ops: ops.map((o) => ({ ...o, hash: canonicalOp(o.tool, o.args).hash })),
  notes: [],
};

const out = flags.out ? resolve(flags.out) : resolve(dirname(draftsPath), `_JIRA-COMMENTS-PLAN-${drafts.runId}.json`);
if (!existsSync(dirname(out))) mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(plan, null, 2) + '\n');
console.log(`[jira-comments-plan] ${ops.length} comment op(s) across ${new Set(ops.map((o) => o.ticket)).size} ticket(s) (Jira ${jira.projectKey}) → ${out}`);
for (const o of plan.ops) console.log(`  ${o.opId} ${o.commentId} [${o.liveState || '?'}] ${o.summary}`);
console.log(
  `\n  Nothing is authorised yet. Show this plan to the user, and only if they approve:\n` +
    `    node scripts/qa-approve.mjs --plan ${out} --user-quote "<their exact words>"`
);
