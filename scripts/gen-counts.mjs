#!/usr/bin/env node
// R-11 — the headline numbers, derived. Cheap enough for the main thread to call directly instead
// of reading result files (R-12: the dispatcher does not open result files).
//
//   node scripts/gen-counts.mjs --ledger _LEDGER-R4.json [--project <slug>] [--json]
// The project's linear.stateMap names the target states; without one the defaults print with a warning.
//
// Matrix mode — a parity matrix summary (present/candidate-missing/unclear/held/app-only per role), generated, never typed:
//   node scripts/gen-counts.mjs --matrix _PARITY-MATRIX-R-20260929-AND.json [--json]

import { readFileSync } from 'node:fs';
import { args, fail, loadProfile } from '../lib/profile.mjs';
import { computeCounts } from '../lib/ledger.mjs';

const { flags } = args();
if (flags.matrix) {
  const matrix = JSON.parse(readFileSync(flags.matrix, 'utf8'));
  const rows = Array.isArray(matrix.rows) ? matrix.rows : [];
  if (rows.length === 0) fail('[gen-counts] matrix has zero rows (R-07)');

  // Statuses (2026-09-29): present · candidate-missing (not seen in the app yet — a case must
  // search for it; NOT a verdict) · unclear · held (deliberately not tested, e.g. Assistant) ·
  // app-only (in the app, no web counterpart). 'missing' is kept as its own bucket for older
  // matrices. Anything else is refused rather than silently counted as unclear (R-11).
  const STATUSES = ['present', 'candidate-missing', 'missing', 'unclear', 'held', 'app-only'];
  const perRole = {};
  const totals = Object.fromEntries(STATUSES.map((k) => [k, 0]));
  const missing = [];
  const bad = [];
  for (const r of rows) {
    const role = r.role || '(no role)';
    const bucket = (perRole[role] ||= Object.fromEntries(STATUSES.map((k) => [k, 0])));
    if (!STATUSES.includes(r.status)) {
      bad.push(`${r.rowId}: status "${r.status}"`);
      continue;
    }
    bucket[r.status]++;
    totals[r.status]++;
    if (r.status === 'missing' || r.status === 'candidate-missing') missing.push(`${r.rowId} — ${r.feature || '(no feature)'} (${role}, ${r.status})`);
  }
  if (bad.length) fail(`[gen-counts] matrix row(s) with an unknown status (allowed: ${STATUSES.join(', ')}):\n${bad.map((x) => '  · ' + x).join('\n')}`);

  if (flags.json) {
    console.log(JSON.stringify({ runId: matrix.runId, total: rows.length, totals, perRole, missing }, null, 2));
  } else {
    const fmt = (c) => STATUSES.filter((k) => k !== 'missing' || c.missing).map((k) => `${k}=${c[k]}`).join('  ');
    console.log(`${matrix.runId || '(no runId)'} parity matrix: ${rows.length} row(s) — ${fmt(totals)}`);
    for (const [role, c] of Object.entries(perRole)) console.log(`  ${role.padEnd(20)} ${fmt(c)}`);
    if (missing.length) {
      console.log('\nMissing / candidate-missing features (candidate = not yet found in the app, not a verdict):');
      for (const m of missing) console.log(`  · ${m}`);
    }
  }
  process.exit(0);
}
if (!flags.ledger) fail('usage: gen-counts.mjs --ledger <ledger.json> [--project <slug>] [--json]\n   or: gen-counts.mjs --matrix <_PARITY-MATRIX-run.json> [--json]', 2);

const ledger = JSON.parse(readFileSync(flags.ledger, 'utf8'));
const slug = flags.project || ledger.project;
let stateMap = null;
try {
  stateMap = loadProfile(slug).linear?.stateMap || null;
} catch (e) {
  if (flags.project) fail(`[gen-counts] cannot load profile ${slug}: ${e.message}`);
}
if (!stateMap) console.error(`[gen-counts] WARN no linear.stateMap for ${slug} — target states below are DEFAULT names, not this board's (R-04)`);
const counts = computeCounts(ledger, { stateMap: stateMap || {} });

if (flags.json) {
  console.log(JSON.stringify({ runId: ledger.runId, build: ledger.build?.buildId, ...counts }, null, 2));
} else {
  console.log(`${ledger.runId} @ ${ledger.build?.buildId}: ${counts.total} tickets (${counts.tested} tested, ${counts.carriedForward} carried)`);
  for (const [k, v] of Object.entries(counts.buckets)) console.log(`  ${k.padEnd(30)} ${v}`);
  console.log('  ' + '-'.repeat(34));
  for (const [k, v] of Object.entries(counts.byProposedState)) console.log(`  → ${k.padEnd(28)} ${v}`);
}
