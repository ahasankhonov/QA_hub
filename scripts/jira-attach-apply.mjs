#!/usr/bin/env node
// Replays an APPROVED screenshot plan (scripts/jira-attach-plan.mjs) to Jira over REST. R-01 / R-10.
//
// The PreToolUse write gate only sees MCP calls, and a REST upload is not one, so this script IS the
// gate for its own sends. It refuses everything unless:
//   · .qa-approvals/<plan.runId>.approved.json exists, is not expired, names this plan, and its
//     planSha256 equals the sha256 of the plan file's bytes (same derivation as the gate and
//     qa-approve: lib/tracker-ops.mjs sha256 over the file read as utf8);
//   · the hub config is safe (lib/tracker-ops.mjs configProblem — the gate's own invariant);
//   · every op is in the approval with the same hash, and its args hash to it;
//   · every file passes lib/jira-attach.mjs again (realpath containment, PII blocklist, magic bytes,
//     size) and still has the sha256 and size the plan froze.
// All of that runs before the FIRST send; one problem anywhere and nothing is sent. Each file is then
// read once, re-hashed, and exactly those bytes are uploaded. Ops already recorded as uploaded in
// .qa-approvals/<runId>.applied.jsonl are skipped, so a re-run is idempotent; each result is appended
// there as one JSON line. The token and the auth header are never printed.
//
// --dry-run runs every check (a missing approval is REPORTED as a refusal, not skipped) and prints
// what would be sent. It returns before the credentials are read or the network code is reached.
//
//   node scripts/jira-attach-apply.mjs --plan projects/<p>/qa-reports/_JIRA-ATTACH-PLAN-<run>.json --dry-run

import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { canonicalOp, sha256, configProblem } from '../lib/tracker-ops.mjs';
import { parseArgs, readJson } from '../lib/cli.mjs';
import { ATTACH_TOOL, RUN_ID_RE, piiBlocklist, indexSources, checkAttachmentFile, attachDirRel } from '../lib/jira-attach.mjs';

const HUB = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APPROVALS = join(HUB, '.qa-approvals');
const { flags } = parseArgs(process.argv.slice(2));
const DRY = flags['dry-run'] === true;
const TAG = `[jira-attach-apply${DRY ? ' --dry-run' : ''}]`;

function refuse(problems) {
  console.error(`${TAG} REFUSED — ${problems.length} problem(s); nothing sent:`);
  for (const p of problems) console.error('  · ' + p);
  process.exit(1);
}

if (!flags.plan || flags.plan === true) {
  console.error('usage: jira-attach-apply.mjs --plan <plan.json> [--dry-run]');
  process.exit(2);
}
const planPath = resolve(String(flags.plan));
if (!existsSync(planPath)) refuse([`plan ${planPath} does not exist`]);
const planRaw = readFileSync(planPath, 'utf8');
let plan;
try {
  plan = JSON.parse(planRaw);
} catch (e) {
  refuse([`plan is not JSON (${e.message})`]);
}
if (!RUN_ID_RE.test(plan.runId || '') || !RUN_ID_RE.test(plan.project || '') || !RUN_ID_RE.test(plan.sourceRunId || ''))
  refuse(['plan runId / project / sourceRunId missing or malformed']);
if (!/^[0-9a-f-]{36}$/.test(plan.cloudId || '')) refuse(['plan has no cloudId']);
if (!Array.isArray(plan.ops) || !plan.ops.length) refuse(['plan has no ops']);

const problems = [];

// ---- 1. config: the same fail-closed invariant the write gate and qa-approve enforce --------------
const unsafe = configProblem({ hub: HUB, home: process.env.HOME || homedir(), env: process.env });
if (unsafe) problems.push(unsafe);

// ---- 2. approval: exists, live, this plan, these bytes --------------------------------------------
const planSha256 = sha256(planRaw);
const approvalPath = join(APPROVALS, `${plan.runId}.approved.json`);
let approvedOps = new Map();
const approval = existsSync(approvalPath) ? readJson(approvalPath) : null;
if (!existsSync(approvalPath)) {
  problems.push(`no approval: ${approvalPath.replace(HUB + '/', '')} does not exist. The plan must be shown to the user and frozen with qa-approve after they approve it in their own words.`);
} else if (!approval) {
  problems.push(`approval ${plan.runId}.approved.json is unparseable — fail closed`);
} else {
  if (approval.runId !== plan.runId) problems.push(`approval is for run ${approval.runId}, plan is ${plan.runId}`);
  if (!approval.expiresAt || !(Date.parse(approval.expiresAt) > Date.now())) problems.push(`approval expired at ${approval.expiresAt}`);
  if (approval.planSha256 !== planSha256)
    problems.push(`approval sha256 mismatch: the plan on disk is ${planSha256.slice(0, 16)}…, the approval froze ${String(approval.planSha256).slice(0, 16)}… — the plan changed after approval (VOID)`);
  let samePlan = false;
  try {
    samePlan = !!approval.planPath && realpathSync(resolve(HUB, approval.planPath)) === realpathSync(planPath);
  } catch {
    samePlan = false;
  }
  if (!samePlan) problems.push(`approval names plan ${approval.planPath}, not ${planPath.replace(HUB + '/', '')}`);
  for (const o of Array.isArray(approval.ops) ? approval.ops : []) approvedOps.set(o.opId, o);
  if (!approvedOps.size) problems.push('approval lists no ops');
}

// ---- 3. every op: shape, approval, file checks -----------------------------------------------------
const appliedPath = join(APPROVALS, `${plan.runId}.applied.jsonl`);
const appliedLines = existsSync(appliedPath)
  ? readFileSync(appliedPath, 'utf8').split('\n').filter((l) => l.trim()).map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return { corrupt: true };
      }
    })
  : [];
if (appliedLines.some((l) => l.corrupt)) problems.push(`${appliedPath.replace(HUB + '/', '')} has a corrupt line — cannot tell what was already sent`);

let blocklist;
try {
  blocklist = piiBlocklist(HUB, plan.project, plan.sourceRunId);
  for (const p of blocklist.problems) problems.push(`PII scan: ${p}`);
} catch (e) {
  problems.push(`PII scan could not be read (${e.message}) — fail closed`);
}
const sources = (() => {
  try {
    return indexSources(HUB, plan.project, plan.sourceRunId);
  } catch (e) {
    problems.push(`${attachDirRel(plan.project, plan.sourceRunId)}/INDEX.json unreadable (${e.message})`);
    return new Map();
  }
})();

const todo = [];
const done = [];
const ids = new Set();
for (const o of plan.ops) {
  const where = `${o.opId} (${o.issueKey})`;
  if (ids.has(o.opId)) { problems.push(`${where}: duplicate opId`); continue; }
  ids.add(o.opId);
  if (o.tool !== ATTACH_TOOL) { problems.push(`${where}: tool "${o.tool}" is not ${ATTACH_TOOL}`); continue; }
  const a = o.args || {};
  if (a.issueKey !== o.issueKey || a.path !== o.path || a.sha256 !== o.sha256 || a.bytes !== o.bytes || a.contentType !== o.contentType)
    { problems.push(`${where}: args disagree with the op's own fields`); continue; }
  if (!/^[A-Z][A-Z0-9]+-\d+$/.test(o.issueKey || '')) { problems.push(`${where}: "${o.issueKey}" is not an issue key`); continue; }
  const hash = canonicalOp(ATTACH_TOOL, a).hash;
  if (hash !== o.hash) { problems.push(`${where}: hash does not match its args — the plan was edited by hand`); continue; }
  const ap = approvedOps.get(o.opId);
  if (approval && !ap) problems.push(`${where}: not in the approval`);
  else if (ap && ap.hash !== hash) problems.push(`${where}: approved with a different hash`);
  const mine = appliedLines.filter((l) => l.opId === o.opId && l.hash === hash);
  if (mine.some((l) => l.status === 'uploaded')) { done.push(o); continue; }
  const max = ap?.maxApplies ?? approval?.maxApplies ?? o.maxApplies ?? 1;
  if (mine.length >= max) problems.push(`${where}: already attempted ${mine.length}× (limit ${max}) — re-approve to retry`);
  if (!blocklist) continue;
  const chk = checkAttachmentFile(HUB, o.path, { project: plan.project, sourceRunId: plan.sourceRunId, blocklist, sources });
  for (const p of chk.problems) problems.push(`${where}: ${p}`);
  if (chk.sha256 && chk.sha256 !== o.sha256) problems.push(`${where}: ${o.path} changed since the plan (sha256 ${chk.sha256.slice(0, 12)}… ≠ ${String(o.sha256).slice(0, 12)}…)`);
  else if (chk.bytes !== undefined && chk.bytes !== o.bytes) problems.push(`${where}: ${o.path} is ${chk.bytes} bytes, the plan froze ${o.bytes}`);
  if (chk.contentType && chk.contentType !== o.contentType) problems.push(`${where}: content type is ${chk.contentType}, the plan froze ${o.contentType}`);
  todo.push({ op: o, hash });
}

if (problems.length) refuse(problems);

const perKey = {};
for (const { op } of todo) perKey[op.issueKey] = (perKey[op.issueKey] || 0) + 1;
console.log(`${TAG} approval OK (${plan.runId}, expires ${approval.expiresAt}); ${todo.length} to send, ${done.length} already uploaded.`);

if (DRY) {
  for (const { op } of todo) console.log(`  would send ${op.opId}: ${op.path.split('/').slice(-2).join('/')} (${op.bytes} B, ${op.contentType}) → POST …/issue/${op.issueKey}/attachments`);
  console.log(`${TAG} per issue: ${Object.entries(perKey).map(([k, n]) => `${k}×${n}`).join(' ')}`);
  console.log(`${TAG} no network call made.`);
  process.exit(0);
}

// ───────────────────────────── network: never reached with --dry-run ─────────────────────────────
await send();

/** Credentials exactly as scripts/gen-bug-inventory-docx.mjs reads them. Never printed. */
function loadCredentials() {
  const ref = readFileSync(join(HUB, `projects/${plan.project}/_reference/jira-api-token.md`), 'utf8');
  const email = ref.match(/\*\*Email:\*\*\s*(\S+)/)?.[1];
  const token = ref.match(/\*\*Token:\*\*\s*(\S+)/)?.[1];
  const cloudId = ref.match(/\*\*cloudId:\*\*\s*(\S+)/)?.[1];
  if (!email || !token || !cloudId) refuse(['could not parse email/token/cloudId from the project\'s jira-api-token.md']);
  if (cloudId !== plan.cloudId) refuse([`the token file is for cloud ${cloudId}, the plan targets ${plan.cloudId}`]);
  const auth = 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');
  return { cloudId, auth, scrub: (s) => String(s).split(token).join('***').split(auth).join('***') };
}

async function send() {
  if (DRY) throw new Error('send() reached in --dry-run — refusing'); // belt and braces
  const cred = loadCredentials();
  mkdirSync(APPROVALS, { recursive: true });
  let failed = 0;
  for (const { op, hash } of todo) {
    // Re-read, re-check and re-hash right before the send; upload exactly the bytes that were hashed.
    const chk = checkAttachmentFile(HUB, op.path, { project: plan.project, sourceRunId: plan.sourceRunId, blocklist, sources });
    if (!chk.ok || chk.sha256 !== op.sha256 || chk.bytes !== op.bytes) {
      record(op, hash, { status: 'refused', reason: chk.problems.join('; ') || `sha256/size changed since the plan` });
      refuse([`${op.opId}: ${op.path} failed its pre-send re-check — stopped before sending it`]);
    }
    const form = new FormData();
    form.append('file', new Blob([chk.buf], { type: op.contentType }), op.args.filename);
    const url = `https://api.atlassian.com/ex/jira/${cred.cloudId}/rest/api/3/issue/${encodeURIComponent(op.issueKey)}/attachments`;
    let status = 0;
    let body = '';
    try {
      const r = await fetch(url, { method: 'POST', headers: { Authorization: cred.auth, 'X-Atlassian-Token': 'no-check', Accept: 'application/json' }, body: form });
      status = r.status;
      body = await r.text();
    } catch (e) {
      body = cred.scrub(e.message);
    }
    let att = null;
    try {
      att = JSON.parse(body)?.[0] || null;
    } catch { /* non-JSON error body */ }
    if (status === 200 && att?.id && Number(att.size) === op.bytes) {
      record(op, hash, { status: 'uploaded', attachmentId: String(att.id), httpStatus: status });
      console.log(`  uploaded ${op.opId} → ${op.issueKey} attachment ${att.id}`);
    } else {
      failed++;
      record(op, hash, { status: 'failed', attachmentId: att?.id ? String(att.id) : null, httpStatus: status, error: cred.scrub(body).slice(0, 200) });
      console.error(`  FAILED ${op.opId} → ${op.issueKey}: HTTP ${status} ${cred.scrub(body).slice(0, 200)}`);
      break; // stop on the first failure; a re-run skips what was uploaded
    }
  }
  process.exit(failed ? 1 : 0);
}

function record(op, hash, extra) {
  appendFileSync(
    appliedPath,
    JSON.stringify({ at: new Date().toISOString(), runId: plan.runId, opId: op.opId, tool: ATTACH_TOOL, hash, issueKey: op.issueKey, sha256: op.sha256, ...extra }) + '\n'
  );
}
