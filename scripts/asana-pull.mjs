#!/usr/bin/env node
// Deterministic Asana intake assembler for profiles with `tracker.kind: "asana"` (gamma).
// The Asana counterpart of `jira-pull.mjs --from`: no network, no token, no model in the loop.
//
// Why a script: the first gamma intake (R-20261006-INTAKE) was assembled by an agent, and three
// things in it were judgement calls that belong in code —
//   · the ledger id. Asana has no ticket key; "GAM-<n>" lives only as a "[GAM-n]" suffix on the task
//     title. 3 of 221 tasks on the boards have none, and one says "[GAM-117 follow-up]". A task with no
//     id cannot be ledgered, planned or moved, so it is refused here instead of guessed at downstream;
//   · the queue. `completed` is NOT the queue: an Asana rule auto-completes a task when Task Progress
//     = Done, so all 9 Staging QA tasks read completed=true. The queue is the section (column) on the
//     board, and only the section is used to select tickets;
//   · the acceptance criteria — quoted verbatim from the "Acceptance Criteria:" bullets, numbered here.
//
// Verbatim check: the raw is copied out of MCP responses by an agent (no REST token for Asana), so it
// can drift. get_task returns the description twice — `notes` and `html_notes` — and a retyped copy
// would have to drift identically in both. Their word sequences must match or the pull is refused.
// Ask for `notes,html_notes` in get_task's opt_fields.
//
//   node scripts/asana-pull.mjs --project gamma --run <runId> --from <dump.json> \
//        [--column "Staging QA"] [--out-dir <dir>] [--allow-unidentified] [--force]
//
// --from: [{ task, stories?, attachments?, subtasks? }] — each value the verbatim get_task /
//         get_stories_for_task / get_attachments_for_object / get_subtasks response (a { data } wrapper is
//         unwrapped). Tasks outside --column are listed and skipped, not dropped silently.
//
// Writes into projects/<slug>/qa-reports/ (R-03), refusing to overwrite unless --force:
//   _INTAKE-<run>-raw.json  [{ id, gid, title, board, section, url, task, stories, attachments, subtasks }]
//   _LIVE-<run>.json        { column, tickets: [{ id, gid, title, board, section, state, updatedAt, priority, completed }] }
//                           ← what run-plan.mjs (id, updatedAt) and asana-plan.mjs (gid, board, section) read
//   _INTAKE-<run>.json      the ticket spec: acs ("AC-n <verbatim bullet>"), testCases, comments, relations
// Then run H-1: node scripts/intake-assert.mjs --raw _INTAKE-<run>-raw.json --spec _INTAKE-<run>.json

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import { HUB, args, fail, loadProfile, reportsDir } from '../lib/profile.mjs';

const { flags } = args();
if (!flags.project || !flags.run || typeof flags.from !== 'string')
  fail('usage: asana-pull.mjs --project <slug> --run <runId> --from <dump.json> [--column "<section>"] [--out-dir <dir>] [--allow-unidentified] [--force]', 2);

const profile = loadProfile(flags.project);
if (profile.tracker?.kind !== 'asana' || !profile.asana?.boards)
  fail(`[asana-pull] profiles/${flags.project}.json is not Asana-tracked (tracker.kind = ${profile.tracker?.kind || 'unset'}) or has no asana.boards`, 2);

const prefix = profile.linear?.prefix || String(profile.tracker?.ticketPrefix || '').split('-')[0];
if (!prefix) fail(`[asana-pull] no ticket prefix in profiles/${flags.project}.json (linear.prefix)`, 2);
const column = typeof flags.column === 'string' ? flags.column : profile.linear?.stateMap?.stagingQaHold || 'Staging QA';

const fromPath = isAbsolute(flags.from) ? flags.from : join(process.cwd(), flags.from);
if (!existsSync(fromPath)) fail(`[asana-pull] --from ${flags.from} does not exist`, 2);
const outDir =
  typeof flags['out-dir'] === 'string'
    ? isAbsolute(flags['out-dir']) ? flags['out-dir'] : join(HUB, flags['out-dir'])
    : reportsDir(flags.project);

// ---- boards: project gid → board name, and the section gids the profile pinned ---------------------
const boardByProject = new Map();
for (const [name, b] of Object.entries(profile.asana.boards)) boardByProject.set(String(b.projectGid), { name, sections: b.sections || {} });

const unwrap = (v) => (v && typeof v === 'object' && !Array.isArray(v) && 'data' in v ? v.data : v);
const dump = JSON.parse(readFileSync(fromPath, 'utf8'));
const entries = (Array.isArray(dump) ? dump : dump.entries || dump.tasks || []).map((e) =>
  e && e.task ? { ...e, task: unwrap(e.task) } : { task: unwrap(e) }
);
if (!entries.length) fail(`[asana-pull] ${flags.from} holds no tasks — nothing to assemble (R-07)`, 1);

// ---- helpers ---------------------------------------------------------------------------------------
const ID_RE = new RegExp(`\\[(${prefix}-\\d+)\\]\\s*$`);
const ANY_TAG_RE = new RegExp(`\\[\\s*${prefix}[^\\]]*\\]`, 'i');
function parseId(name) {
  const m = ID_RE.exec(String(name || ''));
  if (m) return { id: m[1] };
  const odd = ANY_TAG_RE.exec(String(name || ''));
  return { id: null, why: odd ? `non-standard id tag "${odd[0]}"` : `no "[${prefix}-n]" suffix in the title` };
}

const decode = (s) =>
  s.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
const words = (s) => (String(s || '').normalize('NFKC').match(/[\p{L}\p{N}]+/gu) || []).join(' ');

/** Bullets under a bare "<Heading>:" line (optionally **bold**), verbatim, continuation lines joined. */
function bulletsUnder(notes, headingRe) {
  const lines = String(notes || '').split('\n');
  const at = lines.findIndex((l) => {
    const m = /^\s*(?:\*\*|__)?\s*([^:*_]+?)\s*[:.]?\s*(?:\*\*|__)?\s*:?\s*$/.exec(l);
    return m && headingRe.test(m[1]) && m[1].trim().split(/\s+/).length <= 4;
  });
  if (at < 0) return null;
  const items = [];
  for (let i = at + 1; i < lines.length; i++) {
    const l = lines[i];
    const b = /^\s*(?:[-*+•]|\d+[.)])\s+(.*\S)\s*$/.exec(l);
    if (b) items.push(b[1]);
    else if (!l.trim()) { if (items.length && !/^\s*(?:[-*+•]|\d+[.)])\s/.test(lines[i + 1] || '')) break; }
    else if (/^\s/.test(l) && items.length) items[items.length - 1] += ` ${l.trim()}`;
    else if (items.length) break;
  }
  return items;
}

/** Numbered cases under a "TEST CASES (…)" / "EXTRA SPEC CHECKS (…)" heading (the client QA's 2026-10-12 QA TEST PLAN
 *  format): "TC1 …" / "SC1 …" lines with no bullet, each continued by the bullet / indented / plain lines that
 *  follow it, until the next id, a "====" rule, or an ALL-CAPS section heading ("PASS RULE", "OUT OF SCOPE (…)").
 *  The id is the ticket's own number (TC-7 stays TC-7 even when TC-5 has sub-bullets), never a running index,
 *  so H-1 can match it against the body. Returns null when the heading is absent. */
function casesUnder(notes, headingRe, idRe) {
  const lines = String(notes || '').split('\n');
  const bare = (l) => l.replace(/\(.*?\)/g, ' ').replace(/\*\*|__/g, '').replace(/[:.,]\s*$/, '').replace(/\s+/g, ' ').trim();
  const at = lines.findIndex((l) => headingRe.test(bare(l)));
  if (at < 0) return null;
  const capsHeading = (l) => { const b = bare(l); return b.length >= 4 && /^[A-Z0-9][A-Z0-9 ,'/+&-]*$/.test(b) && !idRe.test(l); };
  const items = [];
  for (let i = at + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^=+\s*$/.test(l)) break;
    const m = idRe.exec(l);
    if (m) { items.push({ id: m[1].toUpperCase().replace(/^([A-Z]+)-?(\d+)/, '$1-$2'), text: l.trim() }); continue; }
    if (!l.trim()) { if (items.length && capsHeading(lines[i + 1] || '')) break; continue; }
    if (capsHeading(l)) break;
    if (items.length) items[items.length - 1].text += ` ${l.trim()}`;
  }
  return items;
}

const field = (task, name) => (task.custom_fields || []).find((f) => f.name === name)?.display_value ?? null;
const fieldLine = (notes, label) => (new RegExp(`^\\s*${label}:\\s*(.+)$`, 'im').exec(String(notes || '')) || [])[1]?.trim() ?? null;

// ---- assemble ----------------------------------------------------------------------------------------
const problems = [];
const warnings = [];
const skipped = [];
const raw = [];
const live = [];
const spec = [];
const seen = new Map();
let completedInQueue = 0;

for (const e of entries) {
  const task = e.task || {};
  const gid = String(task.gid || '');
  if (!gid) { problems.push(`an entry has no task.gid — not a get_task response`); continue; }

  const homes = (task.memberships || [])
    .map((m) => ({ board: boardByProject.get(String(m.project?.gid)), section: m.section }))
    .filter((h) => h.board);
  if (!homes.length) { skipped.push(`${gid} "${task.name}": on no board in profile.asana.boards`); continue; }
  const home = homes.find((h) => h.section?.name === column);
  if (!home) { skipped.push(`${gid} "${task.name}": in "${homes.map((h) => h.section?.name).join('", "')}", not "${column}"`); continue; }
  if (homes.filter((h) => h.section?.name === column).length > 1)
    warnings.push(`${gid}: in "${column}" on more than one board — using ${home.board.name}`);

  const pinned = home.board.sections[column];
  if (pinned && home.section.gid && String(home.section.gid) !== String(pinned))
    problems.push(`${gid}: "${column}" on ${home.board.name} is section ${home.section.gid}, profile pins ${pinned} — the profile is stale; re-read the sections (READ-only)`);

  let { id, why } = parseId(task.name);
  if (!id) {
    if (!flags['allow-unidentified']) {
      problems.push(`${gid} "${task.name}" (${home.board.name} / ${column}): ${why} — it cannot be ledgered or planned. Ask the PM to add the id, or pass --allow-unidentified to key it as ASANA-${gid}`);
      continue;
    }
    id = `ASANA-${gid}`;
    warnings.push(`${gid} "${task.name}": ${why} — keyed as ${id}`);
  }
  if (seen.has(id)) { problems.push(`${id}: two tasks carry this id (${seen.get(id)} and ${gid}) — the ledger cannot tell them apart`); continue; }
  seen.set(id, gid);

  // Verbatim cross-check: notes vs html_notes.
  if (typeof task.html_notes === 'string') {
    const a = words(task.notes);
    const b = words(decode(task.html_notes.replace(/<[^>]+>/g, ' ')));
    if (a !== b) {
      let i = 0;
      while (i < a.length && a[i] === b[i]) i++;
      problems.push(`${id}: notes and html_notes disagree near "${a.slice(Math.max(0, i - 25), i + 25)}" — the raw is not a verbatim copy of get_task; re-pull it`);
    }
  } else warnings.push(`${id}: no html_notes in the raw — the verbatim cross-check could not run (add html_notes to opt_fields)`);

  const stories = unwrap(e.stories) ?? [];
  const attachments = unwrap(e.attachments) ?? [];
  const subtasks = unwrap(e.subtasks) ?? [];
  for (const [label, v] of [['stories', e.stories], ['attachments', e.attachments], ['subtasks', e.subtasks]])
    if (v && v.next_page) problems.push(`${id}: ${label} has a next_page — the pull is truncated; fetch every page`);
  if (e.stories === undefined) warnings.push(`${id}: no stories in the raw — comments cannot be read`);

  if (task.completed) completedInQueue++;
  const board = home.board.name;
  const projectGid = [...boardByProject].find(([, b]) => b === home.board)[0];
  const url = task.permalink_url || `https://app.asana.com/0/${projectGid}/${gid}`;

  raw.push({ id, gid, title: task.name, board, section: column, url, task, stories, attachments, subtasks });
  live.push({
    id, gid, title: task.name, board, section: column, state: column,
    updatedAt: task.modified_at || null, priority: field(task, 'Priority'), completed: !!task.completed,
  });

  const acItems = bulletsUnder(task.notes, /^acceptance\s*criteria$/i);
  const tcItems = bulletsUnder(task.notes, /^test\s*cases?$/i);
  const tcCases = casesUnder(task.notes, /^test\s*cases?\b/i, /^\s*(TC-?\d+)\b/i);
  const scCases = casesUnder(task.notes, /^extra\s*spec\s*checks?\b/i, /^\s*(SC-?\d+)\b/i);
  if (!acItems) warnings.push(`${id}: no "Acceptance Criteria:" section in the notes — the analyst has nothing to plan from but the prose`);
  else if (!acItems.length) warnings.push(`${id}: "Acceptance Criteria:" heading with no bullets under it`);

  spec.push({
    id, gid, title: task.name, board, section: column,
    priority: field(task, 'Priority'), taskProgress: field(task, 'Task Progress'),
    assignee: task.assignee?.name ?? null, dueOn: task.due_on ?? null, updatedAt: task.modified_at ?? null,
    completed: !!task.completed, completedAt: task.completed_at ?? null, permalink: url,
    acs: (acItems || []).map((t, i) => `AC-${i + 1} ${t}`),
    testCases: tcCases?.length ? tcCases : (tcItems || []).map((t, i) => ({ id: `TC-${i + 1}`, text: t })),
    specChecks: scCases || [],
    comments: (Array.isArray(stories) ? stories : [])
      .filter((s) => s.resource_subtype === 'comment_added')
      .map((s) => ({ author: s.created_by?.name ?? null, createdAt: s.created_at ?? null, text: s.text ?? '' })),
    attachments: (Array.isArray(attachments) ? attachments : []).map((a) => ({ name: a.name, host: a.host ?? null, createdAt: a.created_at ?? null, gid: a.gid })),
    relations: {
      dependsOnPerNotes: fieldLine(task.notes, 'Depends on'),
      asanaDependencies: (task.dependencies || []).map((d) => d.gid),
      asanaDependents: (task.dependents || []).map((d) => d.gid),
      groundedIn: fieldLine(task.notes, 'Grounded in'),
      subtasks: Array.isArray(subtasks) ? subtasks.length : 0,
    },
    _source: `${basename(fromPath)} via asana-pull.mjs — acs are the verbatim bullets under "Acceptance Criteria:" numbered by script; testCases/specChecks are the verbatim "TCn …"/"SCn …" lines under "TEST CASES (…)" / "EXTRA SPEC CHECKS (…)" keyed by their own number (fallback: bullets under "Test Cases:", numbered by script)`,
  });
}

// ---- report + write -------------------------------------------------------------------------------
for (const s of skipped) console.log(`  skip  ${s}`);
for (const w of warnings) console.log(`  WARN  ${w}`);
if (completedInQueue)
  console.log(`  note  ${completedInQueue} of ${raw.length} queued task(s) read completed=true — ignored: the queue is the "${column}" section, not the completed flag`);

if (problems.length) {
  console.error(`\n[asana-pull] REFUSED — ${problems.length} problem(s); nothing written:`);
  for (const p of problems) console.error(`  ✗ ${p}`);
  process.exit(1);
}
if (!raw.length) fail(`[asana-pull] no task in "${column}" on any profiled board — an empty queue is not a clean pass (R-07)`, 1);

const outs = {
  raw: join(outDir, `_INTAKE-${flags.run}-raw.json`),
  live: join(outDir, `_LIVE-${flags.run}.json`),
  spec: join(outDir, `_INTAKE-${flags.run}.json`),
};
const exists = Object.values(outs).filter((p) => existsSync(p));
if (exists.length && !flags.force)
  fail(`[asana-pull] refusing to overwrite ${exists.map((p) => basename(p)).join(', ')} — pick a new --run id, or pass --force if they are this script's own output`, 1);

const order = (a, b) => a.id.localeCompare(b.id, 'en', { numeric: true });
raw.sort(order); live.sort(order); spec.sort(order);
mkdirSync(outDir, { recursive: true });
writeFileSync(outs.raw, JSON.stringify(raw, null, 2) + '\n');
writeFileSync(outs.live, JSON.stringify({ column, source: basename(fromPath), tickets: live }, null, 2) + '\n');
writeFileSync(outs.spec, JSON.stringify(spec, null, 2) + '\n');

const acTotal = spec.reduce((n, t) => n + t.acs.length, 0);
console.log(`\n[asana-pull] ${raw.length} ticket(s) in "${column}" (${[...new Set(live.map((t) => t.board))].join(', ')}) · ${acTotal} ACs · ${skipped.length} skipped`);
for (const p of Object.values(outs)) console.log(`  wrote ${p}`);
console.log(`next: node scripts/intake-assert.mjs --raw ${outs.raw} --spec ${outs.spec}`);
