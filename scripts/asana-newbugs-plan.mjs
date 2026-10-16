#!/usr/bin/env node
// Asana edition of scripts/linear-newbugs-plan.mjs — turn reviewed bug DRAFTS into the exact
// asana_create_task calls, in the plan shape that scripts/qa-approve.mjs freezes and the write
// gate enforces (R-01). asana-plan.mjs plans comments only and never creates tasks; this script is
// the "filed separately" path its notes point to: a NEW task per bug, placed in the stateMap.newBug
// column (Gathering Requirements) of the app's board (profile.tracker.routing.newBug).
//
// Deterministic: same drafts in, same calls out. It refuses drafts that cannot be posted as written:
//   · a body that leaks an internal QA artefact — a result file, a screenshot, a ledger (R-10);
//   · a body without the dev-facing sections (steps, expected, actual) or a "Done when" line;
//   · a URL on a host that is not one of the project's staging surfaces (R-13);
//   · a related ticket that is not a <prefix>-N key; a duplicateOf draft is noted, never created;
//   · a board or column the profile does not carry a verified gid for.
// The plan's runId is "<run>-NB" so its approval file never collides with the run's own plan.
//
//   node scripts/asana-newbugs-plan.mjs --drafts _NEWBUGS-R1.json [--out plan.json] [--only B-1,B-2]

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { args, fail, loadProfile } from '../lib/profile.mjs';
import { stateFor } from '../lib/routing.mjs';
import { canonicalOp, describeOp, sha256, defaultMaxApplies } from '../lib/tracker-ops.mjs';
import { internalArtefactLeaks } from '../lib/jira-ops.mjs';

const { flags } = args();
if (!flags.drafts) fail('usage: asana-newbugs-plan.mjs --drafts <drafts.json> [--project <slug>] [--out <plan.json>] [--only B-1,B-2]', 2);

const draftsPath = resolve(flags.drafts);
const draftsRaw = readFileSync(draftsPath, 'utf8');
const drafts = JSON.parse(draftsRaw);
const slug = flags.project || drafts.project;
if (!slug) fail('[asana-newbugs-plan] no project: pass --project or put "project" in the drafts file');
const profile = loadProfile(slug);
if (profile.tracker?.kind !== 'asana')
  fail(`[asana-newbugs-plan] ${slug} tracks in ${profile.tracker?.kind || 'an unknown tracker'}, not Asana (R-01)`, 2);
const asana = profile.asana;
const stateMap = profile.linear?.stateMap || profile.tracker?.stateMap;
if (!stateMap) fail(`[asana-newbugs-plan] ${slug} has no stateMap (R-04)`);
if (!asana?.boards) fail(`[asana-newbugs-plan] profiles/${slug}.json has no asana.boards (verified gids)`);
if (!drafts.runId || !Array.isArray(drafts.drafts)) fail('[asana-newbugs-plan] drafts file needs { runId, drafts: [] }');

const prefix = String(profile.tracker?.ticketPrefix || 'GAM-<n>').replace(/-<n>$/, '');
const SURFACES = new Set(Object.entries(profile.surfaces || {}).filter(([k, v]) => k !== 'forbidden' && typeof v === 'string' && !/Note$/.test(k)).map(([, v]) => v));
const FORBIDDEN = new Set(profile.surfaces?.forbidden || []);
const KEY_RE = new RegExp(`^${prefix}-\\d+$`);
const HEADINGS = ['Steps to reproduce:', 'Expected:', 'Actual:', 'Done when:'];
const SEVERITIES = profile.tracker?.bugConventions?.severity || ['Blocker', 'Critical', 'Major', 'Minor', 'Trivial'];
const COLUMN = stateFor('newBug', stateMap);
const defaultBoard = drafts.board || profile.tracker?.boards?.[0];

let selected = drafts.drafts;
if (flags.only) {
  const sel = new Set(String(flags.only).split(',').map((s) => s.trim()));
  selected = selected.filter((d) => sel.has(d.draftId));
  if (selected.length !== sel.size) fail(`[asana-newbugs-plan] --only names a draft that is not in the file: ${[...sel].filter((id) => !selected.some((d) => d.draftId === id)).join(', ')}`);
}

const errors = [];
const notes = [];
const ops = [];
let n = 0;
for (const d of selected) {
  const where = `draft ${d.draftId || '(no id)'}`;
  const before = errors.length;
  const boardName = d.board || defaultBoard;
  const board = asana.boards[boardName];
  if (!d.draftId) errors.push(`${where}: draftId is missing`);
  if (!board?.projectGid) errors.push(`${where}: board "${boardName}" has no verified projectGid in the profile`);
  else if (!board.sections?.[COLUMN]) errors.push(`${where}: board "${boardName}" has no verified gid for column "${COLUMN}"`);
  if (typeof d.title !== 'string' || d.title.trim().length < 10) errors.push(`${where}: title is missing or too short`);
  if (typeof d.notes !== 'string') errors.push(`${where}: notes is missing`);
  else for (const h of HEADINGS) if (!d.notes.includes(h)) errors.push(`${where}: notes lack the "${h}" section`);
  if (!SEVERITIES.includes(d.severity)) errors.push(`${where}: severity must be one of ${SEVERITIES.join('/')}, got ${d.severity}`);
  else if (typeof d.notes === 'string' && !d.notes.includes(`Severity: ${d.severity}`)) errors.push(`${where}: notes must state "Severity: ${d.severity}"`);
  for (const k of d.relatedTo || []) if (!KEY_RE.test(k)) errors.push(`${where}: relatedTo "${k}" is not a ${prefix} key`);
  if (d.duplicateOf != null && !KEY_RE.test(d.duplicateOf)) errors.push(`${where}: duplicateOf must be a ${prefix} key or null`);
  for (const [field, text] of [['title', d.title], ['notes', d.notes]]) {
    const leaks = internalArtefactLeaks(text);
    if (leaks.length) errors.push(`${where}: ${field} leaks an internal QA artefact (${leaks.join(', ')}) — dev-facing text must stand alone (R-10)`);
    for (const m of String(text ?? '').matchAll(/https?:\/\/([a-z0-9.:-]+)/gi)) {
      const host = m[1].toLowerCase().replace(/[.:]+$/, '');
      if (FORBIDDEN.has(host) || !SURFACES.has(host)) errors.push(`${where}: ${field} links ${host}, which is not a staging surface of ${slug} (R-13)`);
    }
  }
  if (errors.length > before) continue;
  if (d.duplicateOf) {
    notes.push(`${d.draftId}: duplicate of ${d.duplicateOf} — not created`);
    continue;
  }
  const a = { name: d.title.trim(), notes: d.notes.trim(), project_id: board.projectGid, section_id: board.sections[COLUMN] };
  const tool = 'mcp__claude_ai_Asana__asana_create_task';
  ops.push({ opId: `op-${String(++n).padStart(3, '0')}`, tool, args: a, summary: describeOp(tool, a), maxApplies: defaultMaxApplies('new-bug'), kind: 'new-bug', ticket: d.draftId, board: boardName, column: COLUMN, severity: d.severity, relatedTo: d.relatedTo || [] });
}

if (errors.length) {
  console.error(`[asana-newbugs-plan] REFUSED — ${errors.length} problem(s):`);
  for (const e of errors) console.error('  · ' + e);
  process.exit(1);
}
if (!ops.length) fail('[asana-newbugs-plan] nothing to plan: every selected draft is a duplicate or the selection is empty');

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
const out = flags.out ? resolve(flags.out) : resolve(dirname(draftsPath), `_ASANA-NEWBUGS-PLAN-${drafts.runId}.json`);
if (!existsSync(dirname(out))) mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(plan, null, 2) + '\n');
console.log(`[asana-newbugs-plan] ${ops.length} create op(s) from ${selected.length} draft(s) (${notes.length} duplicate(s) skipped) → ${out}`);
for (const o of plan.ops) console.log(`  ${o.opId} ${o.ticket} ${o.severity} → ${o.board} / ${o.column} :: ${o.args.name}`);
for (const x of notes) console.log(`  note: ${x}`);
console.log(`\n  Nothing is authorised yet. Show this plan to the user, and only if they approve:\n    node scripts/qa-approve.mjs --plan ${out} --user-quote "<their exact words>"`);
