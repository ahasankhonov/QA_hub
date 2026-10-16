#!/usr/bin/env node
// Ticket-less case expander for a parity run (no tracker tickets to test against — e.g. Beta
// mobile, R-20260929-AND). Turns a `_PARITY-MATRIX-<run>.json` + the mobile plan's Part C checklist
// table into the `_CASES-<run>.json` contract scripts/run-plan.mjs expects. Deterministic: the same
// matrix + plan + extra file always produce the same cases in the same order.
//
//   node scripts/parity-cases.mjs --matrix _PARITY-MATRIX-R-20260929-AND.json \
//        --plan projects/beta/qa-reports/_MOBILE-PLAN.md \
//        --out projects/beta/qa-reports/_CASES-R-20260929-AND.json \
//        [--extra extra-cases.json] [--project beta] [--runId R-20260929-AND]
//
// --extra: a JSON array of case objects (or {cases:[...]}) appended verbatim, after id-format /
//          duplicate validation, so a coordinator can add a one-off case (e.g. MOB-ROLE-1, a
//          role-refusal check that isn't tied to one plan-table row) without hand-editing the
//          generated file.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { args, fail, HUB } from '../lib/profile.mjs';

const { flags } = args();
if (!flags.matrix || !flags.plan) {
  fail('usage: parity-cases.mjs --matrix <_PARITY-MATRIX-run.json> --plan <_MOBILE-PLAN.md> --out <_CASES-run.json> [--extra <extra.json>] [--mob-spec <spec.json>] [--extra-out <f>] [--project <slug>] [--runId <id>]', 2);
}

const PAR_ID_RE = /^PAR-[A-Z0-9]+-\d+$/;
const MOB_ID_RE = /^MOB-(?:[A-Z]+-)?\d+$/;

const matrix = JSON.parse(readFileSync(resolve(flags.matrix), 'utf8'));
const planMd = readFileSync(resolve(flags.plan), 'utf8');

const project = flags.project || matrix.project;
const runId = flags.runId || flags.run || matrix.runId;
if (!project) fail('[parity-cases] no project: pass --project or put "project" in the matrix file');
if (!runId) fail('[parity-cases] no runId: pass --runId or put "runId" in the matrix file');

const rows = Array.isArray(matrix.rows) ? matrix.rows : [];
if (rows.length === 0) fail('[parity-cases] matrix has zero rows — nothing to expand (R-07)');

// --- PAR cases: one per matrix row, area code + sequential-per-area number -------------------
function areaCode(area) {
  const code = String(area || '').toUpperCase().replace(/[^A-Z0-9]+/g, '');
  return code || 'GEN';
}

const areaCounters = new Map();
const parCases = [];
for (const row of rows) {
  if (!row.rowId) fail('[parity-cases] a matrix row has no rowId');
  const code = areaCode(row.area);
  const n = (areaCounters.get(code) || 0) + 1;
  areaCounters.set(code, n);
  const surfaces = [];
  if (row.webRoute) surfaces.push('web.beta.example:8443');
  surfaces.push('com.beta');
  parCases.push({
    id: `PAR-${code}-${n}`,
    kind: 'parity',
    matrixRow: row.rowId,
    area: row.area,
    feature: row.feature,
    role: row.role,
    webRoute: row.webRoute ?? null,
    appScreen: row.appScreen ?? null,
    matrixStatus: row.status,
    surfaces,
    expected: row.webBehaviour ? `App matches web: ${row.webBehaviour}` : `App matches web for "${row.feature}"`,
    // row.case: the analyst's executable spec for this row (preconditions, webSteps, appSteps,
    // expected, evidence, lane, account, hold). It can refine but never re-key the case.
    ...Object.fromEntries(Object.entries(row.case || {}).filter(([k]) => !['id', 'kind', 'matrixRow', 'matrixStatus'].includes(k))),
  });
}

// --- MOB cases: parsed from the plan's "Part C: mobile-specific checklist" table ------------
// Cell grammar (fixed 2026-09-29 — R-20260929-AND merged four Session cases into one MOB-6
// because only ',' separated items, and split the Payments/Push notes into fake cases):
//   · items are separated by a top-level ',' OR ';' — one inside (...), `...` or "..." belongs to
//     the item it's nested in;
//   · a cell may hold several sentences ('. ' + capital, at top level). A sentence that is entirely
//     **bold** ("**No card entry.**") or that is a "<label>: <instruction>." preamble before the
//     last sentence ("FCM on a Google-APIs image: **probe first**.") is a ROW NOTE — a constraint
//     every item in the row inherits (`rowNotes`), never a case of its own.
/** Split on top-level separators only (default ',' and ';'). */
function splitTopLevel(text, seps = [',', ';']) {
  const out = [];
  let depth = 0;
  let tick = false;
  let quote = false;
  let cur = '';
  for (const ch of text) {
    if (ch === '`') tick = !tick;
    else if (ch === '"' && !tick) quote = !quote;
    else if (!tick && !quote && ch === '(') depth++;
    else if (!tick && !quote && ch === ')') depth = Math.max(0, depth - 1);
    if (seps.includes(ch) && depth === 0 && !tick && !quote) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** Split a raw (still **-marked) cell into sentences at top-level '. ' + capital. */
function splitSentences(raw) {
  const out = [];
  let depth = 0;
  let tick = false;
  let cur = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    cur += ch;
    if (ch === '`') tick = !tick;
    else if (!tick && ch === '(') depth++;
    else if (!tick && ch === ')') depth = Math.max(0, depth - 1);
    if (ch === '.' && depth === 0 && !tick) {
      const rest = raw.slice(i + 1);
      const m = rest.match(/^(\*\*)?\s+(?=(\*\*)?[A-Z])/);
      if (m) {
        cur += m[1] || '';
        out.push(cur.trim());
        cur = '';
        i += m[0].length;
      }
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const stripMd = (t) => t.replace(/\*\*/g, '').trim();
const cleanTitle = (t) => stripMd(t).replace(/[.\s]+$/, '').trim();

function parseCell(raw) {
  const sentences = splitSentences(raw);
  const notes = [];
  const itemSentences = [];
  sentences.forEach((sen, i) => {
    const isLast = i === sentences.length - 1;
    if (/^\*\*[^*]+\*\*\.?$/.test(sen)) notes.push(stripMd(sen));
    else if (!isLast && sentences.length > 1 && /^[^,;:()]+:\s/.test(stripMd(sen))) notes.push(stripMd(sen));
    else itemSentences.push(sen);
  });
  const titles = [];
  for (const sen of itemSentences) for (const piece of splitTopLevel(stripMd(sen))) {
    const t = cleanTitle(piece);
    if (t) titles.push(t);
  }
  return { titles, notes };
}

function parsePlanMobileItems(md) {
  const lines = md.split('\n');
  const start = lines.findIndex((l) => /^#{1,4}\s*Part C:/i.test(l.trim()));
  if (start === -1) fail('[parity-cases] plan has no "Part C: mobile-specific checklist" heading');
  let end = lines.findIndex((l, i) => i > start && /^#{1,4}\s/.test(l.trim()));
  if (end === -1) end = lines.length;
  const tableLines = lines.slice(start, end).filter((l) => l.trim().startsWith('|'));
  if (tableLines.length < 3) fail('[parity-cases] Part C has no markdown table (need header + separator + ≥1 data row)');
  const dataRows = tableLines.slice(2); // [0]=header, [1]=--- separator
  const items = [];
  for (const line of dataRows) {
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 2) continue;
    const area = stripMd(cells[0]);
    const { titles, notes } = parseCell(cells[1]);
    for (const title of titles) items.push(notes.length ? { area, title, rowNotes: notes } : { area, title });
  }
  if (items.length === 0) fail('[parity-cases] Part C table parsed to zero case items — check its shape');
  return items;
}

const mobItems = parsePlanMobileItems(planMd);
// --mob-spec: analyst enrichment keyed by the parsed "<area> :: <title>" (preconditions, appSteps,
// expected, evidence, lane, account, screen, hold…). A spec key that matches no parsed item is a
// stale spec and is refused; an item with no spec is reported (it still runs on its bare title).
const RESERVED = new Set(['id', 'kind', 'matrixRow', 'area', 'title']);
let mobSpec = null;
if (flags['mob-spec']) mobSpec = JSON.parse(readFileSync(resolve(flags['mob-spec']), 'utf8'));
const specByKey = (mobSpec && mobSpec.byItem) || {};
const usedSpec = new Set();
const unspecified = [];
const mobCases = mobItems.map((item, i) => {
  const key = `${item.area} :: ${item.title}`;
  const base = {
    id: `MOB-${i + 1}`,
    kind: 'mobile',
    area: item.area,
    title: item.title,
    ...(item.rowNotes ? { rowNotes: item.rowNotes } : {}),
    expected: item.title,
    surface: 'com.beta',
    platforms: ['android', 'ios'],
  };
  const spec = specByKey[key];
  if (!spec) {
    if (mobSpec) unspecified.push(key);
    return base;
  }
  usedSpec.add(key);
  for (const [k, v] of Object.entries(spec)) if (!RESERVED.has(k)) base[k] = v;
  return base;
});
const staleSpec = Object.keys(specByKey).filter((k) => !usedSpec.has(k));
if (staleSpec.length) fail(`[parity-cases] --mob-spec has key(s) matching no Part C item (stale spec):\n${staleSpec.map((k) => '  · ' + k).join('\n')}`);

// --- extra cases (coordinator additions) -----------------------------------------------------
let extraCases = [];
if (flags.extra) {
  const extraRaw = JSON.parse(readFileSync(resolve(flags.extra), 'utf8'));
  extraCases = Array.isArray(extraRaw) ? extraRaw : extraRaw.cases || [];
}
if (mobSpec && Array.isArray(mobSpec.extraCases)) extraCases = [...extraCases, ...mobSpec.extraCases];

const cases = [...parCases, ...mobCases, ...extraCases];

// --- validate before writing: id format + no duplicates (same shape run-plan.mjs enforces) ---
const idErrors = [];
const seen = new Set();
for (const c of cases) {
  if (!c.id) {
    idErrors.push('a case has no id');
    continue;
  }
  if (seen.has(c.id)) idErrors.push(`duplicate case id "${c.id}"`);
  seen.add(c.id);
  const isPar = c.id.startsWith('PAR-');
  const isMob = c.id.startsWith('MOB-');
  if (!isPar && !isMob) idErrors.push(`case id "${c.id}" is neither PAR-<AREA>-<n> nor MOB-<n>`);
  else if (isPar && !PAR_ID_RE.test(c.id)) idErrors.push(`case id "${c.id}" does not match PAR-<AREA>-<n>`);
  else if (isMob && !MOB_ID_RE.test(c.id)) idErrors.push(`case id "${c.id}" does not match MOB-<n> / MOB-<AREA>-<n>`);
}
if (idErrors.length) fail(`[parity-cases] refusing to write a cases file with bad id(s):\n${idErrors.map((e) => '  · ' + e).join('\n')}`);

const out = {
  runId,
  project,
  mode: 'ticketless',
  buildId: matrix.buildId || null,
  source: { matrix: flags.matrix, plan: flags.plan },
  cases,
};

const outPath = flags.out ? resolve(HUB, flags.out) : resolve(HUB, `projects/${project}/qa-reports/_CASES-${runId}.json`);
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n');
// --extra-out: the MOB-/MOB-ROLE- subset (plan items + extras) as its own file, for readers who
// want the mobile spec without the PAR rows. _CASES stays the full live queue the gates read (R-07).
if (flags['extra-out']) {
  const extraOutPath = resolve(HUB, flags['extra-out']);
  const subset = cases.filter((c) => c.id.startsWith('MOB-'));
  writeFileSync(extraOutPath, JSON.stringify({ runId, project, mode: 'ticketless', buildId: matrix.buildId || null, derivedFrom: outPath, note: 'Derived subset of the _CASES file (MOB-* + MOB-ROLE-*). Edit the --mob-spec source, not this file.', cases: subset }, null, 2) + '\n');
  console.log(`[parity-cases] ${subset.length} MOB/MOB-ROLE case(s) → ${extraOutPath}`);
}
if (unspecified.length) console.log(`[parity-cases] WARN ${unspecified.length} Part C item(s) have no --mob-spec entry:\n${unspecified.map((k) => '  · ' + k).join('\n')}`);
console.log(
  `[parity-cases] ${parCases.length} PAR case(s) + ${mobCases.length} MOB case(s) from the plan` +
    (extraCases.length ? ` + ${extraCases.length} extra` : '') +
    ` = ${cases.length} total → ${outPath}`
);
