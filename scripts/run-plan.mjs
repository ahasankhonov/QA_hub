#!/usr/bin/env node
// R-06 + R-07 — build the diff-aware run plan, keyed on (ticket.updatedAt, buildId).
//
// H-4: a prior verdict may be carried forward only if the ticket has not changed AND the build has
//      not changed. A redeploy invalidates every carry-forward.
// H-5: zero input produces zero differences, which reads exactly like a clean pass. So: assert the
//      live queue is non-empty, reconcile tested + carried + skipped against it, and print the age
//      of every carried verdict rather than letting it disappear into a total.
//
//   node scripts/run-plan.mjs --project alpha \
//        --live _LIVE-STAGING-QA.json --prior _LEDGER-2026-08-05.json \
//        --build-file _BUILD-R4.json --out _RUN-PLAN-R4.json
//
// --live : [{ id, title, updatedAt, state?, priority? }]  a FRESH pull of the Staging QA queue
// --prior: a previous ledger (optional; without one every ticket is tested)
//
// Ticket-less mode (a project with no tracker tickets for this pass, e.g. Beta mobile
// R-20260929-AND): pass --cases + --matrix instead of --live. Case ids are generated
// (`PAR-<AREA>-<n>` parity cases, `MOB-<n>` / `MOB-<AREA>-<n>` mobile-specific cases — see
// scripts/parity-cases.mjs) rather than pulled from a tracker, but R-07 still applies in full:
// non-zero case count, tested+carried+skipped == cases, and the matrix/case cross-reference must
// be exhaustive in both directions (every matrix row has ≥1 covering case, every PAR case points at
// a real row) — an uncovered row or a dangling reference fails loudly rather than silently shrinking
// the run.
//
//   node scripts/run-plan.mjs --project beta \
//        --cases _CASES-R-20260929-AND.json --matrix _PARITY-MATRIX-R-20260929-AND.json \
//        --build-file _BUILD-R-20260929-AND.json --out _RUN-PLAN-R-20260929-AND.json

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { args, fail, HUB, loadProfile } from '../lib/profile.mjs';

const { flags } = args();

// Case id shapes accepted for a ticket-less run. MOB additionally allows an uppercase area segment
// (`MOB-ROLE-1`) for a coordinator-added case that isn't tied to one plan-table row — still rejects
// `MOB-x`, a bare `MOB-`, a lowercase segment (`MOB-role-1`), and (via the PAR regex) a bare `PAR-1`
// with no area.
const PAR_ID_RE = /^PAR-[A-Z0-9]+-\d+$/;
const MOB_ID_RE = /^MOB-(?:[A-Z]+-)?\d+$/;

if (flags.cases) {
  runTicketlessPlan();
} else if (flags.live && flags.project) {
  runTicketPlan();
} else {
  fail(
    'usage: run-plan.mjs --project <slug> --live <live.json> [--prior <ledger.json>] (--build <id> | --build-file <f>) [--out <f>] [--max-age-days N]\n' +
      '   or: run-plan.mjs --project <slug> --cases <_CASES-run.json> --matrix <_PARITY-MATRIX-run.json> [--prior <ledger.json>] (--build <id> | --build-file <f>) [--out <f>] [--max-age-days N]',
    2
  );
}

function resolveBuildId() {
  let buildId = flags.build;
  if (!buildId && flags['build-file']) buildId = JSON.parse(readFileSync(flags['build-file'], 'utf8')).buildId;
  if (!buildId) {
    fail(
      '[run-plan] R-06 FAILED — no build id. Capture one first:\n' +
        `  node scripts/build-id.mjs ${flags.project} --write <path>\n` +
        'Without a build id, carried-forward verdicts cannot be invalidated by a redeploy.'
    );
  }
  return buildId;
}

function writePlan(plan) {
  if (flags.out) {
    const abs = resolve(HUB, flags.out);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, JSON.stringify(plan, null, 2) + '\n');
    console.error(`[run-plan] wrote ${abs}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Ticket-less mode: the "live queue" is a generated cases file, cross-checked against a parity
// matrix instead of a tracker pull.
// ---------------------------------------------------------------------------------------------
function runTicketlessPlan() {
  if (!flags.project) fail('usage: run-plan.mjs --project <slug> --cases <cases.json> --matrix <matrix.json> ...', 2);
  if (!flags.matrix) fail('[run-plan] ticket-less mode needs --matrix <_PARITY-MATRIX-run.json> alongside --cases (R-07 coverage check)', 2);

  const profile = loadProfile(flags.project);
  const casesFile = JSON.parse(readFileSync(flags.cases, 'utf8'));
  const matrixFile = JSON.parse(readFileSync(flags.matrix, 'utf8'));

  const cases = Array.isArray(casesFile.cases) ? casesFile.cases : [];
  if (cases.length === 0) {
    fail(
      '[run-plan] R-07 FAILED — the cases file has zero cases.\n' +
        'Zero cases produce zero differences, which is indistinguishable from a clean pass.'
    );
  }

  // ---- id format ------------------------------------------------------------------------
  const idErrors = [];
  const seenIds = new Set();
  for (const c of cases) {
    if (!c.id) {
      idErrors.push('a case has no id');
      continue;
    }
    if (seenIds.has(c.id)) idErrors.push(`duplicate case id "${c.id}"`);
    seenIds.add(c.id);
    const isPar = c.id.startsWith('PAR-');
    const isMob = c.id.startsWith('MOB-');
    if (!isPar && !isMob) idErrors.push(`case id "${c.id}" is neither PAR-<AREA>-<n> nor MOB-<n>`);
    else if (isPar && !PAR_ID_RE.test(c.id)) idErrors.push(`case id "${c.id}" does not match PAR-<AREA>-<n> (e.g. PAR-COURSES-1)`);
    else if (isMob && !MOB_ID_RE.test(c.id)) idErrors.push(`case id "${c.id}" does not match MOB-<n> / MOB-<AREA>-<n> (e.g. MOB-3, MOB-ROLE-1)`);
  }
  if (idErrors.length) {
    fail(`[run-plan] R-07 FAILED — malformed/duplicate case id(s):\n${idErrors.map((e) => '  · ' + e).join('\n')}`);
  }

  // ---- matrix/case cross-reference, both directions -------------------------------------
  const rows = Array.isArray(matrixFile.rows) ? matrixFile.rows : [];
  if (rows.length === 0) fail('[run-plan] R-07 FAILED — the parity matrix has zero rows.');
  const rowIds = new Set(rows.map((r) => r.rowId));
  const coverage = new Map(rows.map((r) => [r.rowId, 0]));
  const matrixErrors = [];
  for (const c of cases) {
    if (!c.id.startsWith('PAR-')) continue;
    if (!c.matrixRow) {
      matrixErrors.push(`${c.id}: PAR case has no matrixRow`);
      continue;
    }
    if (!rowIds.has(c.matrixRow)) {
      matrixErrors.push(`${c.id}: matrixRow "${c.matrixRow}" does not exist in the matrix`);
      continue;
    }
    coverage.set(c.matrixRow, (coverage.get(c.matrixRow) || 0) + 1);
  }
  for (const r of rows) {
    if (!r.rowId) {
      matrixErrors.push('a matrix row has no rowId');
      continue;
    }
    if (!coverage.get(r.rowId)) matrixErrors.push(`matrix row ${r.rowId} (${r.feature || r.area || '?'}) has no PAR case covering it`);
  }
  if (matrixErrors.length) {
    fail(`[run-plan] R-07 FAILED — matrix/case coverage is not exhaustive:\n${matrixErrors.map((e) => '  · ' + e).join('\n')}`);
  }

  const buildId = resolveBuildId();

  // ---- diff-aware carry-forward, keyed on case id instead of ticket id ------------------
  const prior = flags.prior ? JSON.parse(readFileSync(flags.prior, 'utf8')) : null;
  const priorById = new Map((prior?.tickets || []).map((t) => [t.id, t]));
  const priorBuild = prior?.build?.buildId || null;
  const buildChanged = priorBuild && priorBuild !== buildId;

  const DAY = 86400000;
  const now = Date.now();
  const maxAgeDays = flags['max-age-days'] ? Number(flags['max-age-days']) : 14;

  const toTest = [];
  const carried = [];
  const skipped = [];

  for (const c of cases) {
    const p = priorById.get(c.id);
    const reasonsToTest = [];

    if (!p) reasonsToTest.push('no prior verdict');
    else {
      const priorCaseBuild = p.carriedForward ? p.carriedFrom?.buildId : p.buildId;
      if (!priorCaseBuild) reasonsToTest.push('prior verdict has no build id — untrustworthy');
      else if (priorCaseBuild !== buildId) reasonsToTest.push(`build moved ${priorCaseBuild} → ${buildId}`);

      const observedAt = p.observedAt || prior?.generatedAt;
      if (!observedAt) reasonsToTest.push('prior verdict has no timestamp');
      if (observedAt && now - Date.parse(observedAt) > maxAgeDays * DAY)
        reasonsToTest.push(`verdict is ${Math.round((now - Date.parse(observedAt)) / DAY)}d old (> ${maxAgeDays}d)`);

      if (p.verdict === 'PARTIAL' && p.partialReason === 'coverage-gap')
        reasonsToTest.push('prior verdict was a coverage gap — it was never finished');
      if (p.verdict === 'NEEDS_MANUAL') reasonsToTest.push('prior verdict was needs-manual — re-probe (R-02)');
    }

    if (reasonsToTest.length) {
      toTest.push({ id: c.id, title: c.title || c.feature || c.expected || null, kind: c.kind || null, reasons: reasonsToTest });
    } else {
      const observedAt = p.observedAt || prior.generatedAt;
      carried.push({
        id: c.id,
        title: c.title || c.feature || c.expected || null,
        verdict: p.verdict,
        partialReason: p.partialReason ?? null,
        buildId,
        carriedFrom: { runId: prior.runId, buildId: p.buildId ?? priorBuild, observedAt },
        ageDays: Math.round((now - Date.parse(observedAt)) / DAY),
      });
    }
  }

  for (const [id, p] of priorById) {
    if (!cases.some((c) => c.id === id)) skipped.push({ id, reason: 'no longer generated by this run', priorVerdict: p.verdict });
  }

  if (toTest.length + carried.length !== cases.length) {
    fail(
      `[run-plan] R-07 FAILED — reconciliation: ${toTest.length} to test + ${carried.length} carried ` +
        `= ${toTest.length + carried.length}, but the cases file holds ${cases.length}. ` +
        `Every case must land in exactly one bucket.`
    );
  }

  const plan = {
    schemaVersion: 1,
    project: flags.project,
    runId: flags.runId || flags.run || casesFile.runId || null,
    mode: 'ticketless',
    generatedAt: new Date().toISOString(),
    build: { buildId, priorBuildId: priorBuild, changed: !!buildChanged },
    priorLedger: flags.prior || null,
    source: { cases: flags.cases, matrix: flags.matrix },
    liveCount: cases.length,
    toTest,
    carried,
    skipped,
    stateMap: profile.linear?.stateMap || null,
  };

  writePlan(plan);

  console.log(`Run plan (ticket-less) — ${flags.project} @ build ${buildId}`);
  if (buildChanged) console.log(`  ⚠ BUILD CHANGED since ${prior.runId} (${priorBuild}) — every prior verdict is invalidated (R-06)`);
  console.log(`  cases           : ${cases.length}`);
  console.log(`  matrix rows     : ${rows.length}`);
  console.log(`  to test         : ${toTest.length}`);
  console.log(`  carried forward : ${carried.length}`);
  console.log(`  no longer generated: ${skipped.length}`);
  if (carried.length) {
    console.log('\nCarried-forward verdicts (age matters — these were not re-run):');
    for (const c of carried.sort((a, b) => b.ageDays - a.ageDays)) console.log(`  ${c.id.padEnd(16)} ${String(c.verdict).padEnd(13)} ${c.ageDays}d old, from ${c.carriedFrom.runId}`);
  }
  if (skipped.length) {
    console.log('\nDropped since the last run:');
    for (const s of skipped) console.log(`  ${s.id.padEnd(16)} was ${s.priorVerdict} — ${s.reason}`);
  }
  if (toTest.length) {
    console.log('\nTo test, and why:');
    for (const t of toTest) console.log(`  ${t.id.padEnd(16)} ${t.reasons.join('; ')}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Ticket mode (unchanged behaviour, moved into a function so both modes share one entry point).
// ---------------------------------------------------------------------------------------------
function runTicketPlan() {
const profile = loadProfile(flags.project);
const live = JSON.parse(readFileSync(flags.live, 'utf8'));
const liveList = Array.isArray(live) ? live : live.tickets || [];

let buildId = flags.build;
if (!buildId && flags['build-file']) buildId = JSON.parse(readFileSync(flags['build-file'], 'utf8')).buildId;
if (!buildId) {
  fail(
    '[run-plan] R-06 FAILED — no build id. Capture one first:\n' +
      `  node scripts/build-id.mjs ${flags.project} --write <path>\n` +
      'Without a build id, carried-forward verdicts cannot be invalidated by a redeploy.'
  );
}

// ---- H-5: an empty queue must fail loudly ------------------------------------------------
if (liveList.length === 0) {
  fail(
    '[run-plan] R-07 FAILED — the live Staging QA queue is empty.\n' +
      'Zero tickets produce zero differences, which is indistinguishable from a clean pass. If the\n' +
      'queue is genuinely empty, say so explicitly; do not let a run report success on no input.\n' +
      'If it is not empty, the pull is broken — check the team id and the state filter.'
  );
}

const prior = flags.prior ? JSON.parse(readFileSync(flags.prior, 'utf8')) : null;
const priorById = new Map((prior?.tickets || []).map((t) => [t.id, t]));
const priorBuild = prior?.build?.buildId || null;
const buildChanged = priorBuild && priorBuild !== buildId;

const DAY = 86400000;
const now = Date.now();
const maxAgeDays = flags['max-age-days'] ? Number(flags['max-age-days']) : 14;

const toTest = [];
const carried = [];
const skipped = [];

for (const t of liveList) {
  const p = priorById.get(t.id);
  const reasonsToTest = [];

  if (!p) reasonsToTest.push('no prior verdict');
  else {
    // R-06 key part 1: the build
    const priorTicketBuild = p.carriedForward ? p.carriedFrom?.buildId : p.buildId;
    if (!priorTicketBuild) reasonsToTest.push('prior verdict has no build id — untrustworthy');
    else if (priorTicketBuild !== buildId)
      reasonsToTest.push(`build moved ${priorTicketBuild} → ${buildId}`);

    // R-06 key part 2: the ticket
    const observedAt = p.observedAt || prior?.generatedAt;
    if (!observedAt) reasonsToTest.push('prior verdict has no timestamp');
    else if (t.updatedAt && Date.parse(t.updatedAt) > Date.parse(observedAt))
      reasonsToTest.push(`ticket updated ${t.updatedAt} after the verdict ${observedAt}`);

    // Staleness, even when nothing moved.
    if (observedAt && now - Date.parse(observedAt) > maxAgeDays * DAY)
      reasonsToTest.push(`verdict is ${Math.round((now - Date.parse(observedAt)) / DAY)}d old (> ${maxAgeDays}d)`);

    // An unfinished ticket is never carried.
    if (p.verdict === 'PARTIAL' && p.partialReason === 'coverage-gap')
      reasonsToTest.push('prior verdict was a coverage gap — it was never finished');
    if (p.verdict === 'NEEDS_MANUAL') reasonsToTest.push('prior verdict was needs-manual — re-probe (R-02)');
  }

  if (reasonsToTest.length) {
    toTest.push({ id: t.id, title: t.title, priority: t.priority ?? null, updatedAt: t.updatedAt ?? null, reasons: reasonsToTest });
  } else {
    const observedAt = p.observedAt || prior.generatedAt;
    carried.push({
      id: t.id,
      title: t.title,
      verdict: p.verdict,
      partialReason: p.partialReason ?? null,
      buildId,
      carriedFrom: { runId: prior.runId, buildId: p.buildId ?? priorBuild, observedAt },
      ageDays: Math.round((now - Date.parse(observedAt)) / DAY),
    });
  }
}

// Tickets that had a verdict last time and are no longer in the queue — informational, but they
// must be named rather than silently vanishing from the totals.
for (const [id, p] of priorById) {
  if (!liveList.some((t) => t.id === id))
    skipped.push({ id, reason: 'no longer in Staging QA', priorVerdict: p.verdict });
}

// ---- H-5 reconciliation ------------------------------------------------------------------
if (toTest.length + carried.length !== liveList.length) {
  fail(
    `[run-plan] R-07 FAILED — reconciliation: ${toTest.length} to test + ${carried.length} carried ` +
      `= ${toTest.length + carried.length}, but the live queue holds ${liveList.length}. ` +
      `Every live ticket must land in exactly one bucket.`
  );
}

const plan = {
  schemaVersion: 1,
  project: flags.project,
  runId: flags.runId || flags.run || null,
  generatedAt: new Date().toISOString(),
  build: { buildId, priorBuildId: priorBuild, changed: !!buildChanged },
  priorLedger: flags.prior || null,
  liveCount: liveList.length,
  toTest,
  carried,
  skipped,
  stateMap: profile.linear?.stateMap || null,
};

if (flags.out) {
  const abs = resolve(HUB, flags.out);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, JSON.stringify(plan, null, 2) + '\n');
  console.error(`[run-plan] wrote ${abs}`);
}

// ---- human report: nothing is allowed to be invisible ------------------------------------
console.log(`Run plan — ${flags.project} @ build ${buildId}`);
if (buildChanged)
  console.log(`  ⚠ BUILD CHANGED since ${prior.runId} (${priorBuild}) — every prior verdict is invalidated (R-06)`);
console.log(`  live Staging QA : ${liveList.length}`);
console.log(`  to test         : ${toTest.length}`);
console.log(`  carried forward : ${carried.length}`);
console.log(`  no longer queued: ${skipped.length}`);

if (carried.length) {
  console.log('\nCarried-forward verdicts (age matters — these were not re-run):');
  for (const c of carried.sort((a, b) => b.ageDays - a.ageDays))
    console.log(`  ${c.id.padEnd(10)} ${String(c.verdict).padEnd(13)} ${c.ageDays}d old, from ${c.carriedFrom.runId}`);
}
if (skipped.length) {
  console.log('\nDropped out of the queue since the last run:');
  for (const s of skipped) console.log(`  ${s.id.padEnd(10)} was ${s.priorVerdict} — ${s.reason}`);
}
if (toTest.length) {
  console.log('\nTo test, and why:');
  for (const t of toTest) console.log(`  ${t.id.padEnd(10)} ${t.reasons.join('; ')}`);
}
}
