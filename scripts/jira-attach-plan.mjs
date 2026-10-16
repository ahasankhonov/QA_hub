#!/usr/bin/env node
// Screenshot edition of scripts/jira-newbugs-plan.mjs — turn the run's attachments MAP (which review
// copy goes on which create/comment op) into one upload op per (issue, file), in the plan shape that
// scripts/qa-approve.mjs freezes. R-01 / R-10.
//
// The uploads go over Jira REST, which the PreToolUse write gate cannot see, so the uploader
// (scripts/jira-attach-apply.mjs) enforces the approval itself and re-runs every check below.
// The plan's runId is "<run>-AT" so its approval never collides with the -NB / -CM plans.
//
// Every map entry is resolved to a LIVE key from the hub's own record of what was applied:
//   · a create op → by its draftId, through _JIRA-NEWBUGS-APPLIED-<run>.json, cross-checked against
//     the gate's .qa-approvals/<run>-NB.applied.jsonl and the title (P-level aside). NOT by opId: the
//     map was written against the 51-op draft plan and the applied plan has 50, so its opIds shift.
//   · a comment op → its target key, which must be on a comment the gate recorded in -CM.applied.jsonl.
// A create whose draft was never filed is skipped with a recorded reason if it has no files and
// refused if it has some. Refused, exit 1, nothing written:
//   · a path outside projects/<p>/qa-reports/_JIRA-ATTACHMENTS-<run>/ after realpath (symlinks, "..");
//   · a PII scan that is missing or does not parse (fail closed);
//   · a non-image by magic bytes, > 10 MB;
//   · a key that is not in the applied mappings; a duplicate (key, sha256).
// A PII-flagged image (its sha256 matches a flagged entry in ANY _PII-SCAN-<run>-*.json — see
// lib/jira-attach.mjs piiBlocklist) is refused by hash on every run, without --drop: it is left out
// and recorded in plan.excluded with reason "PII-flagged (<scan file>)". The uploader re-runs the
// same check and refuses such an op outright.
// --drop names files (hub-relative) to leave out on purpose; each is recorded in plan.excluded with
// the reasons its checks gave. A --drop that matches no file is itself refused.
//
//   node scripts/jira-attach-plan.mjs --map _JIRA-ATTACHMENTS-MAP-<run>.json \
//     --applied _JIRA-NEWBUGS-APPLIED-<run>.json --applied-cm .qa-approvals/<run>-CM.applied.jsonl \
//     --project beta --run <run> --out _JIRA-ATTACH-PLAN-<run>.json [--drop <path>,<path>]

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { HUB, args, fail, loadProfile } from '../lib/profile.mjs';
import { canonicalOp, sha256 } from '../lib/tracker-ops.mjs';
import { jiraConfig } from '../lib/jira-ops.mjs';
import {
  ATTACH_TOOL, ATTACH_ENDPOINT, RUN_ID_RE, KNOWN_PII_SHA256, attachDirRel, piiBlocklist, indexSources, checkAttachmentFile, attachOpId, attachFilename, piiReason,
} from '../lib/jira-attach.mjs';

const { flags } = args();
const USAGE = 'usage: jira-attach-plan.mjs --map <map.json> --applied <_JIRA-NEWBUGS-APPLIED-<run>.json> --applied-cm <CM applied.jsonl> --project <slug> --run <runId> [--out <plan.json>] [--drop <path,...>]';
for (const k of ['map', 'applied', 'applied-cm', 'project', 'run']) if (!flags[k] || flags[k] === true) fail(USAGE, 2);
const slug = String(flags.project);
const run = String(flags.run);
if (!RUN_ID_RE.test(slug) || !RUN_ID_RE.test(run)) fail('[jira-attach-plan] --project/--run may only contain letters, digits, . _ -', 2);

let jira;
try {
  jira = jiraConfig(loadProfile(slug));
} catch (e) {
  fail(`[jira-attach-plan] ${slug} cannot be planned for Jira: ${e.message}`);
}
const KEY_RE = new RegExp(`^${jira.projectKey}-\\d+$`);
const hubRel = (p) => relative(HUB, resolve(p));

const refusals = [];
const notes = [];
const skipped = [];
const excluded = [];

// ---- new bugs: draftId → created key ------------------------------------------------------------
const appliedPath = resolve(String(flags.applied));
const appliedRaw = readFileSync(appliedPath, 'utf8');
let applied;
try {
  applied = JSON.parse(appliedRaw);
} catch {
  fail(`[jira-attach-plan] ${basename(appliedPath)} is not JSON. --applied takes _JIRA-NEWBUGS-APPLIED-<run>.json: the gate's NB applied.jsonl records op hashes, not the keys Jira created.`);
}
if (!applied || typeof applied.mapping !== 'object' || !Array.isArray(applied.ops))
  fail(`[jira-attach-plan] ${basename(appliedPath)} has no { mapping, ops } — it does not record which keys were created`);
if (!String(applied.runId || '').startsWith(run)) fail(`[jira-attach-plan] ${basename(appliedPath)} is for run ${applied.runId}, not ${run}`);

// The gate's own record of the creates it allowed — the ground truth the APPLIED file must agree with.
const gateLines = (p) =>
  existsSync(p)
    ? readFileSync(p, 'utf8').split('\n').filter((l) => l.trim()).map((l, i) => {
        try {
          return JSON.parse(l);
        } catch {
          fail(`[jira-attach-plan] ${hubRel(p)} line ${i + 1} is not JSON — refusing to trust a corrupt applied log`);
        }
      })
    : null;
const nbJsonlPath = join(HUB, '.qa-approvals', `${applied.runId}.applied.jsonl`);
const nbGate = gateLines(nbJsonlPath);
if (!nbGate) fail(`[jira-attach-plan] no gate record ${hubRel(nbJsonlPath)} — cannot prove the creates in ${basename(appliedPath)} happened`);

const byDraft = new Map();
const seenKeys = new Set();
for (const o of applied.ops) {
  const where = `${basename(appliedPath)} ${o.opId} (${o.draftId})`;
  if (!KEY_RE.test(o.key || '')) { refusals.push(`${where}: created key "${o.key}" is not a ${jira.projectKey} key`); continue; }
  if (applied.mapping[o.draftId] !== o.key) { refusals.push(`${where}: mapping says ${applied.mapping[o.draftId]}, op says ${o.key}`); continue; }
  if (seenKeys.has(o.key)) { refusals.push(`${where}: key ${o.key} appears twice`); continue; }
  seenKeys.add(o.key);
  const g = nbGate.filter((l) => l.opId === o.opId);
  if (!g.length) { refusals.push(`${where}: no line for ${o.opId} in ${hubRel(nbJsonlPath)} — the gate never allowed this create`); continue; }
  const head = String(o.summary || '').slice(0, 60);
  if (!g.some((l) => String(l.summary || '').includes(head)))
    refusals.push(`${where}: the gate's line for ${o.opId} is a different issue ("${String(g[0].summary).slice(0, 90)}")`);
  byDraft.set(o.draftId, o);
}

// ---- comments: keys the gate recorded a comment on ----------------------------------------------
const cmPath = resolve(String(flags['applied-cm']));
const cmRaw = readFileSync(cmPath, 'utf8');
const cmKeys = new Set();
for (const l of gateLines(cmPath)) {
  const m = /^comment on (\S+) \(/.exec(String(l.summary || ''));
  if (m && KEY_RE.test(m[1])) cmKeys.add(m[1]);
}
if (!cmKeys.size) refusals.push(`${hubRel(cmPath)} records no comment on a ${jira.projectKey} key`);

// ---- the map --------------------------------------------------------------------------------------
const mapPath = resolve(String(flags.map));
const mapRaw = readFileSync(mapPath, 'utf8');
const map = JSON.parse(mapRaw);
const entries = Array.isArray(map) ? map : map.entries;
if (!Array.isArray(entries)) fail('[jira-attach-plan] the map must be an array of { opId, op, target, files, folder }');

const blocklist = piiBlocklist(HUB, slug, run);
for (const p of blocklist.problems) refusals.push(`PII scan: ${p}`);
const sources = indexSources(HUB, slug, run);
const dirRel = attachDirRel(slug, run);
const drop = new Set(flags.drop && flags.drop !== true ? String(flags.drop).split(',').map((s) => s.trim()).filter(Boolean) : []);
const dropUsed = new Set();

// The image a scan names by hash (the unmasked one) is never named in a plan, even as excluded.
const isNamedPii = (sha, bl) => KNOWN_PII_SHA256.includes(sha) || [...bl.prefixes].some((p) => sha.startsWith(p));

const ops = [];
const seenPair = new Set();
let pLevelOnly = 0;
let opIdShift = 0;
let piiRefused = 0;

for (const e of entries) {
  const where = `map ${e.opId} (${e.op}${e.draftId ? ' ' + e.draftId : ''} → ${e.op === 'comment' ? e.target : 'create'})`;
  const files = Array.isArray(e.files) ? e.files : [];
  let issueKey = null;
  if (e.op === 'create') {
    const a = byDraft.get(e.draftId);
    if (!a) {
      if (files.length) refusals.push(`${where}: draft ${e.draftId} was never created (not in ${basename(appliedPath)}) but has ${files.length} file(s) — they have no issue to go to`);
      else skipped.push({ mapOpId: e.opId, draftId: e.draftId || null, reason: `draft ${e.draftId} was never created (not in ${basename(appliedPath)}: ${applied.planned ?? '?'} planned, ${applied.applied ?? '?'} applied); it has no files, so nothing is lost` });
      continue;
    }
    const norm = (t) => String(t || '').replace(/ – P[1-4] – /, ' – P? – ').trim();
    if (norm(e.target) !== norm(a.summary)) {
      refusals.push(`${where}: its title is not the title of ${a.key} (${a.draftId}) — the map and the applied record disagree`);
      continue;
    }
    if (String(e.target).trim() !== String(a.summary).trim()) pLevelOnly++;
    if (e.opId !== a.opId) opIdShift++;
    issueKey = a.key;
  } else if (e.op === 'comment') {
    if (!KEY_RE.test(e.target || '')) { refusals.push(`${where}: target "${e.target}" is not a ${jira.projectKey} key`); continue; }
    if (!cmKeys.has(e.target)) {
      if (files.length) refusals.push(`${where}: ${e.target} has no applied comment in ${hubRel(cmPath)} — not in the applied mappings`);
      else skipped.push({ mapOpId: e.opId, issueKey: e.target, reason: `no applied comment on ${e.target}; no files` });
      continue;
    }
    issueKey = e.target;
  } else {
    refusals.push(`${where}: unknown op "${e.op}"`);
    continue;
  }

  if (!files.length) {
    skipped.push({ mapOpId: e.opId, issueKey, reason: 'no files in the map entry' });
    continue;
  }
  const folder = String(e.folder || '');
  if (!folder.startsWith(basename(dirRel) + '/')) {
    refusals.push(`${where}: folder "${folder}" is not inside ${basename(dirRel)}/`);
    continue;
  }
  for (const f of files) {
    const rel = `${dirname(dirRel)}/${folder}/${String(f)}`; // not join(): a ".." must reach the check, not be normalised away
    const chk = checkAttachmentFile(HUB, rel, { project: slug, sourceRunId: run, blocklist, sources });
    // A PII hit is refused by hash on every run — no --drop needed, none consulted. It is recorded
    // (path withheld for an image a scan names only in prose / the hard-coded list) and left out.
    if (chk.piiHit) {
      if (drop.has(rel)) dropUsed.add(rel);
      const reason = piiReason(chk.piiScans);
      const withheld = chk.sha256 && isNamedPii(chk.sha256, blocklist);
      piiRefused++;
      excluded.push({
        ...(withheld ? {} : { opId: attachOpId(issueKey, chk.sha256), sha256: chk.sha256 }),
        mapOpId: e.opId,
        issueKey,
        path: withheld ? '(PII image — path withheld)' : rel,
        reason,
        reasons: [reason, ...chk.problems.map((p) => p.replace(rel, '<file>'))],
      });
      continue;
    }
    if (drop.has(rel)) {
      dropUsed.add(rel);
      excluded.push({ mapOpId: e.opId, issueKey, path: chk.sha256 && isNamedPii(chk.sha256, blocklist) ? '(PII image — path withheld)' : rel, reasons: chk.problems.length ? chk.problems.map((p) => p.replace(rel, '<file>')) : ['dropped by the operator (no check failed)'] });
      continue;
    }
    if (!chk.ok) {
      for (const p of chk.problems) refusals.push(`${where}: ${p}`);
      continue;
    }
    const pair = `${issueKey}|${chk.sha256}`;
    if (seenPair.has(pair)) {
      refusals.push(`${where}: ${rel} duplicates an image already planned for ${issueKey} (sha256 ${chk.sha256.slice(0, 12)}…)`);
      continue;
    }
    seenPair.add(pair);
    const args = { issueKey, path: rel, filename: attachFilename(rel), sha256: chk.sha256, bytes: chk.bytes, contentType: chk.contentType };
    ops.push({
      opId: attachOpId(issueKey, chk.sha256),
      tool: ATTACH_TOOL,
      issueKey,
      path: rel,
      sha256: chk.sha256,
      bytes: chk.bytes,
      contentType: chk.contentType,
      args,
      hash: canonicalOp(ATTACH_TOOL, args).hash,
      summary: `attach ${args.filename} (${chk.bytes} bytes, ${chk.contentType}) → ${issueKey}`,
      maxApplies: 1,
      kind: 'attachment',
      ticket: issueKey,
      source: { mapOpId: e.opId, op: e.op, draftId: e.draftId || null, rc: e.sourceRc || null },
    });
  }
}
for (const d of drop) if (!dropUsed.has(d)) refusals.push(`--drop ${d} matches no file in the map`);
const ids = new Set();
for (const o of ops) {
  if (ids.has(o.opId)) refusals.push(`opId ${o.opId} collides`);
  ids.add(o.opId);
}

if (refusals.length) {
  console.error(`[jira-attach-plan] REFUSED — ${refusals.length} problem(s); no plan written:`);
  for (const r of refusals) console.error('  · ' + r);
  for (const x of excluded.filter((x) => x.reason)) console.error(`  (also left out: ${x.path} (${x.issueKey}) — ${x.reasons.join('; ')})`);
  process.exit(1);
}
if (!ops.length) fail('[jira-attach-plan] nothing to plan: no map entry has a file');

if (opIdShift) notes.push(`${opIdShift} create entr${opIdShift === 1 ? 'y' : 'ies'} resolved by draftId: the map's opId differs from the applied opId (map written against the 51-op draft plan)`);
if (piiRefused) notes.push(`${piiRefused} image(s) refused as PII-flagged by a _PII-SCAN-${run}-*.json hash and left out (see excluded[].reason)`);
if (pLevelOnly) notes.push(`${pLevelOnly} create title(s) differ from the map only in the P-level segment (re-levelled before filing)`);

const plan = {
  schemaVersion: 1,
  project: slug,
  runId: `${run}-AT`,
  sourceRunId: run,
  generatedAt: new Date().toISOString(),
  tracker: 'jira',
  cloudId: jira.cloudId,
  endpoint: ATTACH_ENDPOINT,
  attachmentsDir: dirRel,
  ledgerFile: basename(mapPath),
  ledgerSha256: sha256(mapRaw),
  appliedFile: hubRel(appliedPath),
  appliedSha256: sha256(appliedRaw),
  appliedNbGateFile: hubRel(nbJsonlPath),
  appliedCmFile: hubRel(cmPath),
  appliedCmSha256: sha256(cmRaw),
  piiScans: blocklist.scans,
  ops,
  skipped,
  excluded,
  notes,
};

const out = flags.out && flags.out !== true ? resolve(String(flags.out)) : join(HUB, 'projects', slug, 'qa-reports', `_JIRA-ATTACH-PLAN-${run}.json`);
if (!existsSync(dirname(out))) mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(plan, null, 2) + '\n');
const perKey = {};
for (const o of ops) perKey[o.issueKey] = (perKey[o.issueKey] || 0) + 1;
console.log(`[jira-attach-plan] ${ops.length} upload op(s) on ${Object.keys(perKey).length} issue(s), runId ${plan.runId} → ${out}`);
for (const s of skipped) console.log(`  skipped ${s.mapOpId}: ${s.reason}`);
for (const x of excluded) console.log(`  excluded ${x.path} (${x.issueKey}): ${x.reasons.join('; ')}`);
for (const n of notes) console.log(`  note: ${n}`);
