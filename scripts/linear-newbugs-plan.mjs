#!/usr/bin/env node
// Linear edition of scripts/jira-newbugs-plan.mjs — turn reviewed bug DRAFTS into the exact
// save_issue create calls, in the plan shape that scripts/qa-approve.mjs freezes and the write
// gate enforces (R-01). linear-plan.mjs files ledger candidateBugs; this one exists for bugs
// written up for developers after a run (a project, labels and related tickets per issue).
//
// Deterministic: same drafts in, same calls out. It refuses drafts that cannot be posted as written:
//   · a body that leaks an internal QA artefact — a result file, a screenshot, a ledger (R-10);
//   · a body without the dev-facing sections (steps, expected, actual) or a "Done when" line;
//   · a URL on a host that is not one of the project's staging surfaces (R-13);
//   · a related ticket that is not a <prefix>-N key; a duplicateOf draft is noted, never created.
// The plan's runId is "<run>-NB" so its approval file never collides with the run's own plan.
//
//   node scripts/linear-newbugs-plan.mjs --drafts _NEWBUGS-R17.json [--out plan.json] [--only B-1,B-2]

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { args, fail, loadProfile } from '../lib/profile.mjs';
import { stateFor } from '../lib/routing.mjs';
import { canonicalOp, describeOp, sha256, defaultMaxApplies } from '../lib/tracker-ops.mjs';
import { internalArtefactLeaks } from '../lib/jira-ops.mjs';

const { flags } = args();
if (!flags.drafts) fail('usage: linear-newbugs-plan.mjs --drafts <drafts.json> [--project <slug>] [--out <plan.json>] [--only B-1,B-2]', 2);

const draftsPath = resolve(flags.drafts);
const draftsRaw = readFileSync(draftsPath, 'utf8');
const drafts = JSON.parse(draftsRaw);
const slug = flags.project || drafts.project;
if (!slug) fail('[linear-newbugs-plan] no project: pass --project or put "project" in the drafts file');
const profile = loadProfile(slug);
// A project that tracks elsewhere must never get Linear calls planned for it, even with a stateMap
// (gamma carries one for Asana) — use that tracker's own plan script.
if (profile.tracker?.kind && profile.tracker.kind !== 'linear')
  fail(`[linear-newbugs-plan] ${slug} tracks in ${profile.tracker.kind}, not Linear — use scripts/${profile.tracker.kind}-plan.mjs (R-01)`, 2);
const lin = profile.linear;
if (!lin?.team || !lin?.prefix) fail(`[linear-newbugs-plan] profiles/${slug}.json has no linear.team/prefix`);
if (!lin.stateMap) fail(`[linear-newbugs-plan] ${slug} has no linear.stateMap (R-04)`);
if (!drafts.runId || !Array.isArray(drafts.drafts)) fail('[linear-newbugs-plan] drafts file needs { runId, drafts: [] }');

const SURFACES = new Set(Object.entries(profile.surfaces || {}).filter(([k]) => k !== 'forbidden').map(([, v]) => v));
const FORBIDDEN = new Set(profile.surfaces?.forbidden || []);
const KEY_RE = new RegExp(`^${lin.prefix}-\\d+$`);
const HEADINGS = ['## Steps to reproduce', '## Expected', '## Actual', '## Done when'];
const STATE = stateFor('newBug', lin.stateMap);

let selected = drafts.drafts;
if (flags.only) {
  const sel = new Set(String(flags.only).split(',').map((s) => s.trim()));
  selected = selected.filter((d) => sel.has(d.draftId));
  if (selected.length !== sel.size) fail(`[linear-newbugs-plan] --only names a draft that is not in the file: ${[...sel].filter((id) => !selected.some((d) => d.draftId === id)).join(', ')}`);
}

const errors = [];
const notes = [];
const ops = [];
let n = 0;
for (const d of selected) {
  const where = `draft ${d.draftId || '(no id)'}`;
  const before = errors.length;
  if (!d.draftId) errors.push(`${where}: draftId is missing`);
  if (typeof d.title !== 'string' || d.title.trim().length < 10) errors.push(`${where}: title is missing or too short`);
  if (typeof d.descriptionMd !== 'string') errors.push(`${where}: descriptionMd is missing`);
  else for (const h of HEADINGS) if (!d.descriptionMd.includes(h)) errors.push(`${where}: body lacks the "${h}" section`);
  if (![1, 2, 3, 4].includes(d.priority)) errors.push(`${where}: priority must be 1-4 (Urgent/High/Medium/Low), got ${d.priority}`);
  for (const k of d.relatedTo || []) if (!KEY_RE.test(k)) errors.push(`${where}: relatedTo "${k}" is not a ${lin.prefix} key`);
  if (d.duplicateOf != null && !KEY_RE.test(d.duplicateOf)) errors.push(`${where}: duplicateOf must be a ${lin.prefix} key or null`);
  for (const [field, text] of [['title', d.title], ['descriptionMd', d.descriptionMd]]) {
    const leaks = internalArtefactLeaks(text);
    if (leaks.length) errors.push(`${where}: ${field} leaks an internal QA artefact (${leaks.join(', ')}) — dev-facing text must stand alone (R-10)`);
    for (const m of String(text ?? '').matchAll(/https?:\/\/([a-z0-9.:-]+)/gi)) {
      const host = m[1].toLowerCase().replace(/[.:]+$/, "");
      if (FORBIDDEN.has(host) || !SURFACES.has(host)) errors.push(`${where}: ${field} links ${host}, which is not a staging surface of ${slug} (R-13)`);
    }
  }
  if (errors.length > before) continue;
  if (d.duplicateOf) {
    notes.push(`${d.draftId}: duplicate of ${d.duplicateOf} — not created`);
    continue;
  }
  const a = { team: lin.team, title: d.title.trim(), description: d.descriptionMd.trim(), state: STATE, priority: d.priority };
  if (drafts.linearProject) a.project = drafts.linearProject;
  if (Array.isArray(drafts.labels) && drafts.labels.length) a.labels = drafts.labels;
  if (profile.bugAssignee) a.assignee = profile.bugAssignee;
  if (d.relatedTo?.length) a.relatedTo = d.relatedTo;
  const tool = 'mcp__claude_ai_Linear__save_issue';
  ops.push({ opId: `op-${String(++n).padStart(3, '0')}`, tool, args: a, summary: describeOp(tool, a), maxApplies: defaultMaxApplies('new-bug'), kind: 'new-bug', ticket: d.draftId });
}

if (errors.length) {
  console.error(`[linear-newbugs-plan] REFUSED — ${errors.length} problem(s):`);
  for (const e of errors) console.error('  · ' + e);
  process.exit(1);
}
if (!ops.length) fail('[linear-newbugs-plan] nothing to plan: every selected draft is a duplicate or the selection is empty');

const plan = {
  schemaVersion: 1,
  project: slug,
  runId: `${drafts.runId}-NB`,
  sourceRunId: drafts.runId,
  generatedAt: new Date().toISOString(),
  ledgerFile: basename(draftsPath),
  ledgerSha256: sha256(draftsRaw),
  build: drafts.build || null,
  ops: ops.map((o) => ({ ...o, hash: canonicalOp(o.tool, o.args).hash })),
  notes,
};
const out = flags.out ? resolve(flags.out) : resolve(dirname(draftsPath), `_LINEAR-NEWBUGS-PLAN-${drafts.runId}.json`);
if (!existsSync(dirname(out))) mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(plan, null, 2) + '\n');
console.log(`[linear-newbugs-plan] ${ops.length} create op(s) from ${selected.length} draft(s) (${notes.length} duplicate(s) skipped) → ${out}`);
for (const o of plan.ops) console.log(`  ${o.opId} ${o.ticket} p${o.args.priority} ${o.args.state} :: ${o.args.title}`);
for (const x of notes) console.log(`  note: ${x}`);
console.log(`\n  Nothing is authorised yet. Show this plan to the user, and only if they approve:\n    node scripts/qa-approve.mjs --plan ${out} --user-quote "<their exact words>"`);
