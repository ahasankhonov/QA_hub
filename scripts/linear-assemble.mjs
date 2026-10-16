#!/usr/bin/env node
// Deterministic Linear intake assembler — the Linear counterpart of `jira-pull.mjs --from`.
// No network, no token, no model in the loop: the hub has no Linear API key, so Linear is read through
// the MCP connector only, and an agent saves each get_issue / list_comments result to its own file AS
// RETURNED. This script turns that directory into the two files every later stage reads.
//
// Why a script: twice on Alpha R7 (2026-09-10) the haiku intake agent was asked to write the raw pull
// "verbatim" and wrote a summary — 50–200-char bodies for 1,000–3,000-char tickets, 0–1 comments for
// 3–9, and on ALP-595 a body quoting a hub memory that is not in Linear. H-1 counts AC/TC ids in the raw,
// so a thin raw made the gate vacuous. Per-ticket files keep each response small enough to save whole,
// and assembling them in code means no model composes the raw file.
//
//   node scripts/linear-assemble.mjs --project <slug> --run <runId> --from <dir> [--out-dir <dir>] [--force]
//
// --from: a directory of per-ticket dumps (any file name; the ticket id is read from the response, and
//         from the file name for a comments dump, which carries no id):
//           issue-<ID>.json     get_issue response
//           comments-<ID>.json  list_comments response — an array, or { comments | nodes: [...], hasNextPage | pageInfo }
//           <ID>.json           or both in one file: { issue, comments }
//         A { data } wrapper and an MCP envelope ({ content: [{ type: "text", text: "<json>" }] }) are unwrapped.
//         Refused: any hasNextPage: true (the pull is incomplete), an issue with no comments dump (save
//         { "comments": [], "hasNextPage": false } for a ticket with none), a get_issue missing its own fields
//         (title, description, updatedAt, status, url — a model that rewrote the response drops them), a
//         comments dump with no issue, two dumps of one ticket, an id the file name contradicts.
//
// Writes into projects/<slug>/qa-reports/ (R-03), refusing to overwrite unless --force (the asana-pull rule):
//   _INTAKE-<run>-raw.json  [{ id, title, updatedAt, createdAt, state, priority, assignee, project, parentId, labels,
//                              url, body, comments:[{author, body, createdAt, updatedAt, quotedText, parentId}],
//                              relations:[{id, title, state, updatedAt, type}], attachments:[...], documents:[...] }]
//   _LIVE-<run>.json        [{ id, title, updatedAt, state, priority }]   ← the shape run-plan.mjs reads
// It prints each ticket's body/comment lengths and the median, and warns loudly under the H-1 raw floor
// (lib/raw-floor.mjs) — the same floor intake-assert.mjs then FAILS on unless --allow-thin-raw.
// Then: ticket-intake emits _INTAKE-<run>.json from the raw, and
//       node scripts/intake-assert.mjs --raw _INTAKE-<run>-raw.json --spec _INTAKE-<run>.json

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import { HUB, args, fail, loadProfile, reportsDir } from '../lib/profile.mjs';
import { FLOOR, rawFloor } from '../lib/raw-floor.mjs';

const { flags } = args();
if (!flags.project || !flags.run || typeof flags.from !== 'string')
  fail('usage: linear-assemble.mjs --project <slug> --run <runId> --from <dir> [--out-dir <dir>] [--force]', 2);

const profile = loadProfile(flags.project);
if (profile.jira) fail(`[linear-assemble] profiles/${flags.project}.json is Jira-tracked — use scripts/jira-pull.mjs`, 2);
if (profile.tracker?.kind && profile.tracker.kind !== 'linear')
  fail(`[linear-assemble] profiles/${flags.project}.json is tracked in ${profile.tracker.kind}, not Linear`, 2);
const prefix = profile.linear?.prefix;
if (!prefix) fail(`[linear-assemble] no linear.prefix in profiles/${flags.project}.json`, 2);
const queue = profile.linear?.stateMap?.stagingQaHold || 'Staging QA';

const fromDir = isAbsolute(flags.from) ? flags.from : join(process.cwd(), flags.from);
if (!existsSync(fromDir) || !statSync(fromDir).isDirectory()) fail(`[linear-assemble] --from ${flags.from} is not a directory`, 2);
const outDir =
  typeof flags['out-dir'] === 'string'
    ? isAbsolute(flags['out-dir']) ? flags['out-dir'] : join(HUB, flags['out-dir'])
    : reportsDir(flags.project);

// ---- reading the dumps ------------------------------------------------------------------------------
const ID_RE = new RegExp(`^${prefix}-\\d+$`, 'i');
const FILE_ID_RE = new RegExp(`(?<![A-Za-z0-9])(${prefix}-\\d+)(?![0-9])`, 'i');
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const isTextParts = (a) => Array.isArray(a) && a.length > 0 && a.every((x) => x?.type === 'text' && typeof x.text === 'string');

/** Strip an MCP text envelope and a lone { data } wrapper, as many layers as there are. */
function unwrap(v) {
  for (let i = 0; i < 6; i++) {
    if (isTextParts(v)) v = JSON.parse(v.map((x) => x.text).join(''));
    else if (isObj(v) && isTextParts(v.content)) v = JSON.parse(v.content.map((x) => x.text).join(''));
    else if (isObj(v) && Object.keys(v).length === 1 && 'data' in v) v = v.data;
    else return v;
  }
  return v;
}

/** A list_comments response in any of its shapes → { list, more } (more = a further page exists); null if not one. */
function commentPage(v) {
  v = unwrap(v);
  if (Array.isArray(v)) return { list: v, more: false };
  if (!isObj(v)) return null;
  const more = v.hasNextPage === true || v.pageInfo?.hasNextPage === true;
  for (const k of ['comments', 'nodes']) {
    if (v[k] === undefined) continue;
    const inner = commentPage(v[k]);
    if (inner) return { list: inner.list, more: more || inner.more };
  }
  return null;
}

const problems = [];
const warnings = [];
const issues = new Map(); // id → { issue, file }
const comments = new Map(); // id → { page, file }

const files = readdirSync(fromDir).filter((f) => f.toLowerCase().endsWith('.json') && !f.startsWith('.') && !f.startsWith('_')).sort();
if (!files.length) fail(`[linear-assemble] ${flags.from} holds no .json dumps — nothing to assemble (R-07)`, 1);

const putComments = (id, page, file) => {
  if (comments.has(id)) return problems.push(`${id}: two comments dumps (${comments.get(id).file}, ${file}) — keep one`);
  if (page.more) problems.push(`${id}: ${file} has hasNextPage: true — only the first page of comments was saved; fetch every page (a truncated raw is not verbatim)`);
  comments.set(id, { page, file });
};
const putIssue = (issue, file) => {
  const id = [issue.identifier, issue.id].map((x) => String(x ?? '')).find((x) => ID_RE.test(x))?.toUpperCase();
  if (!id) return problems.push(`${file}: no ${prefix}-n identifier in the get_issue response (id "${issue.id ?? ''}") — not this project's ticket, or not a get_issue response`), null;
  const named = FILE_ID_RE.exec(file)?.[1]?.toUpperCase();
  if (named && named !== id) problems.push(`${file}: the file name says ${named} but the response is ${id} — a dump was saved under the wrong name`);
  const missing = ['title', 'description', 'updatedAt', 'url'].filter((k) => !(k in issue));
  if (!('status' in issue) && !('state' in issue)) missing.push('status');
  if (missing.length) problems.push(`${id}: ${file} lacks ${missing.join(', ')} — not a get_issue response as returned; re-save it untouched`);
  if (issues.has(id)) return problems.push(`${id}: two issue dumps (${issues.get(id).file}, ${file}) — keep one`), null;
  issues.set(id, { issue, file });
  return id;
};

for (const file of files) {
  let v;
  try {
    v = unwrap(JSON.parse(readFileSync(join(fromDir, file), 'utf8')));
  } catch (e) {
    problems.push(`${file}: not valid JSON (${e.message.split('\n')[0]}) — re-save the response as returned`);
    continue;
  }
  if (isObj(v) && isObj(unwrap(v.issue))) {
    const id = putIssue(unwrap(v.issue), file);
    if (id && v.comments !== undefined) {
      const page = commentPage(v.comments);
      if (page) putComments(id, page, file);
      else problems.push(`${id}: ${file} has a "comments" value that is not a list_comments response`);
    }
    continue;
  }
  if (isObj(v) && typeof v.title === 'string') {
    const id = putIssue(v, file);
    // get_issue does not normally carry comments; if this one does, they count as its dump.
    if (id && v.comments !== undefined && commentPage(v.comments)) putComments(id, commentPage(v.comments), file);
    continue;
  }
  const page = commentPage(v);
  if (page) {
    const id = FILE_ID_RE.exec(file)?.[1]?.toUpperCase();
    if (!id) problems.push(`${file}: a comments dump whose file name carries no ${prefix}-n id — name it comments-<ID>.json`);
    else putComments(id, page, file);
    continue;
  }
  problems.push(`${file}: neither a get_issue nor a list_comments response`);
}

for (const [id, { file }] of comments) if (!issues.has(id)) problems.push(`${id}: ${file} has comments but no get_issue dump for the ticket`);
for (const [id, { file }] of issues)
  if (!comments.has(id)) problems.push(`${id}: no list_comments dump next to ${file} — a raw without its comments is not verbatim (for a ticket with none save { "comments": [], "hasNextPage": false })`);

if (problems.length) {
  console.error(`\n[linear-assemble] REFUSED — ${problems.length} problem(s); nothing written:`);
  for (const p of problems) console.error(`  ✗ ${p}`);
  process.exit(1);
}

// ---- mapping ------------------------------------------------------------------------------------------
const name = (v) => (v == null ? null : typeof v === 'string' ? v : v.name ?? v.displayName ?? null);

/** get_issue gives { blocks:[], blockedBy:[], relatedTo:[], duplicateOf } — flattened to one typed list. */
function flatRelations(rel) {
  if (Array.isArray(rel)) return rel;
  if (!isObj(rel)) return [];
  const out = [];
  for (const [type, v] of Object.entries(rel))
    for (const r of Array.isArray(v) ? v : v ? [v] : []) out.push(typeof r === 'string' ? { id: r, type } : { ...r, type });
  return out;
}

function mapIssue(id, issue, page) {
  return {
    id,
    title: issue.title,
    updatedAt: issue.updatedAt ?? null,
    createdAt: issue.createdAt ?? null,
    state: name(issue.status ?? issue.state),
    priority: issue.priority ?? null, // verbatim — Linear gives { value, name }
    assignee: name(issue.assignee),
    project: name(issue.project),
    parentId: issue.parentId ?? issue.parent?.identifier ?? null,
    labels: (issue.labels || []).map(name),
    url: issue.url,
    body: issue.description ?? null, // verbatim: a ticket with no description stays null
    comments: page.list.map((c) => ({
      author: name(c.author ?? c.user),
      body: c.body ?? '',
      createdAt: c.createdAt ?? null,
      updatedAt: c.updatedAt ?? null,
      quotedText: c.quotedText ?? null,
      parentId: c.parentId ?? null,
      ...(Array.isArray(c.attachments) && c.attachments.length ? { attachments: c.attachments } : {}),
    })),
    relations: flatRelations(issue.relations),
    attachments: issue.attachments || [],
    documents: issue.documents || [],
  };
}

const keyNum = (k) => Number(String(k).split('-').pop()) || 0;
const raw = [...issues]
  .sort(([a], [b]) => keyNum(a) - keyNum(b))
  .map(([id, { issue }]) => mapIssue(id, issue, comments.get(id).page));
const live = raw.map(({ id, title, updatedAt, state, priority }) => ({ id, title, updatedAt, state, priority }));

// ---- report: lengths, the floor, the queue ------------------------------------------------------------
const w = (s, n) => String(s).padEnd(n);
console.log(`${w('TICKET', 12)}${w('BODY', 8)}${w('COMMENTS', 10)}${w('COMMENT CHARS', 15)}STATE`);
for (const t of raw) {
  const cl = t.comments.map((c) => c.body.length);
  console.log(`${w(t.id, 12)}${w((t.body || '').length, 8)}${w(t.comments.length, 10)}${w(cl.reduce((a, b) => a + b, 0), 15)}${t.state ?? '?'}`);
}
const floor = rawFloor(raw);
console.log(`\nmedian body ${floor.stats.medianBody} chars · ${floor.stats.comments} comments, median ${floor.stats.medianComment} chars (H-1 floor: body ${FLOOR.medianBody}, comment ${FLOOR.medianComment})`);
if (floor.findings.length) {
  console.log(`\n⚠⚠⚠ THIN RAW — ${floor.findings.length} raw-floor finding(s). intake-assert.mjs will FAIL this pull unless --allow-thin-raw:`);
  for (const f of floor.findings) console.log(`  ⚠ ${f}`);
  console.log(
    `  Before waiving: get_issue one of the thinnest tickets yourself and compare its description length with\n` +
      `  the body above. Equal → the tickets really are short; waive with a reason. Shorter here → the dumps were\n` +
      `  retyped, not saved; re-pull them.`
  );
}
for (const x of warnings) console.log(`  WARN  ${x}`);
const offQueue = raw.filter((t) => t.state !== queue).map((t) => `${t.id}(${t.state})`);
if (offQueue.length) console.log(`  ⚠ not in "${queue}": ${offQueue.join(' ')}`);

// ---- write --------------------------------------------------------------------------------------------
const outs = { raw: join(outDir, `_INTAKE-${flags.run}-raw.json`), live: join(outDir, `_LIVE-${flags.run}.json`) };
const exists = Object.values(outs).filter((p) => existsSync(p));
if (exists.length && !flags.force)
  fail(`[linear-assemble] refusing to overwrite ${exists.map((p) => basename(p)).join(', ')} — pick a new --run id, or pass --force if they are this script's own output`, 1);

mkdirSync(outDir, { recursive: true });
writeFileSync(outs.raw, JSON.stringify(raw, null, 2) + '\n');
writeFileSync(outs.live, JSON.stringify(live, null, 2) + '\n');

console.log(`\n[linear-assemble] ${raw.length} ticket(s) from ${files.length} dump file(s) in ${basename(fromDir)} (no network)`);
console.log(`  comments: ${raw.reduce((n, t) => n + t.comments.length, 0)} · body bytes: ${raw.reduce((n, t) => n + Buffer.byteLength(t.body || ''), 0)}`);
console.log(`  keys:     ${raw.map((t) => t.id).join(' ')}`);
for (const p of Object.values(outs)) console.log(`  wrote ${p}`);
console.log(`next: ticket-intake emits _INTAKE-${flags.run}.json from the raw, then node scripts/intake-assert.mjs --raw ${outs.raw} --spec ${join(outDir, `_INTAKE-${flags.run}.json`)}`);
