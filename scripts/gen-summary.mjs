#!/usr/bin/env node
// R-11 — generate _SUMMARY.md from the ledger. No model authors a count or a classification.
//
// ALP-282 shipped into a dev-facing document as FAIL while its own ledger recorded a clean PASS.
// It was caught only because a summary listed 27 tickets under a "26 FAIL" heading. The fix is not
// "check more carefully"; it is that there is no longer a hand-authored path for this file.
//
//   node scripts/gen-summary.mjs --ledger _LEDGER-R4.json [--out _SUMMARY.md] [--prose notes.md]

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { args, fail, loadProfile, reportsDir, HUB } from '../lib/profile.mjs';
import { validateLedger, computeCounts, ticketCaseCounts } from '../lib/ledger.mjs';
import { route, stateFor } from '../lib/routing.mjs';

const { flags } = args();
if (!flags.ledger) fail('usage: gen-summary.mjs --ledger <ledger.json> [--out <file>] [--prose <file>] [--force]', 2);

const ledger = JSON.parse(readFileSync(flags.ledger, 'utf8'));
const slug = flags.project || ledger.project;
let profile = null;
try {
  profile = loadProfile(slug);
} catch { /* validated below; a missing profile only loses the state map */ }

const { errors, warnings } = validateLedger(ledger, { profile, currentBuildId: ledger.build?.buildId });
if (errors.length && !flags.force) {
  console.error('[gen-summary] refusing to generate from an invalid ledger:');
  for (const e of errors) console.error(`  ✗ ${e}`);
  console.error('Fix the ledger, or pass --force if you genuinely want a draft of a broken run.');
  process.exit(1);
}

const stateMap = profile?.linear?.stateMap || {};
const counts = computeCounts(ledger, { stateMap });
const forced = errors.length > 0; // only reachable with --force
const out = flags.out ? resolve(HUB, flags.out) : join(reportsDir(slug), '_SUMMARY.md');

const BUCKET_ORDER = ['PASS', 'PASS_SCOPE', 'FAIL', 'PARTIAL:mixed', 'PARTIAL:coverage-gap', 'PARTIAL:blocked-on-definition', 'NEEDS_MANUAL', 'BLOCKED'];
const orderedBuckets = [
  ...BUCKET_ORDER.filter((b) => counts.buckets[b]),
  ...Object.keys(counts.buckets).filter((b) => !BUCKET_ORDER.includes(b)),
];

const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim();
const L = [];

L.push(`# ${profile?.name || slug} — QA summary`);
L.push('');
L.push(`**Run** \`${ledger.runId}\` · **build** \`${ledger.build?.buildId}\` · generated ${new Date().toISOString()}`);
L.push('');
L.push('> Generated from `' + (flags.ledger.split('/').pop()) + '` by `scripts/gen-summary.mjs`. Do not hand-edit —');
L.push('> every count and classification here is derived from the ledger (R-11). Edit the ledger and re-run.');
L.push('');

if (forced) {
  L.push(`> ⚠ **GENERATED WITH \`--force\` FROM A LEDGER THAT FAILED VALIDATION (${errors.length} error(s)).** Draft only — not a deliverable.`);
  L.push('');
}
L.push('## Counts');
L.push('');
L.push('| Bucket | Count | Routes to |');
L.push('|---|---:|---|');
for (const b of orderedBuckets) {
  const [verdict, reason] = b.split(':');
  let target = '—';
  try {
    target = stateFor(route({ verdict, partialReason: reason }).route, stateMap);
  } catch { /* invalid bucket already reported */ }
  L.push(`| \`${b}\` | ${counts.buckets[b]} | ${target} |`);
}
L.push(`| **total** | **${counts.total}** | |`);
L.push('');
L.push(`Freshly tested this run: **${counts.tested}** · carried forward from a previous run: **${counts.carriedForward}**.`);
L.push('');
L.push('Proposed board moves: ' + Object.entries(counts.byProposedState).map(([k, v]) => `**${v}** → ${k}`).join(' · ') + '.');
L.push('');
L.push('_Nothing has been written to the tracker. Writes require an approved plan (R-01)._');
L.push('');

if (flags.prose && existsSync(flags.prose)) {
  L.push('## Notes');
  L.push('');
  L.push(readFileSync(flags.prose, 'utf8').trim());
  L.push('');
}

L.push('## Per ticket');
L.push('');
L.push('| Ticket | Verdict | Proposed | Surface | Build | Cases (P/F/NM/NT) | Note |');
L.push('|---|---|---|---|---|---|---|');
for (const t of ledger.tickets) {
  let target = '—';
  try {
    target = stateFor(route(t).route, stateMap);
  } catch { /* reported by the validator */ }
  const cc = ticketCaseCounts(t);
  const n = (v) => cc[v];
  const verdict = t.verdict + (t.partialReason ? ` (${t.partialReason})` : '');
  const note = t.carriedForward
    ? `carried from ${t.carriedFrom?.runId} — not re-run`
    : esc(t.headline || (t.scopeQuestion ? `scope question: ${t.scopeQuestion}` : ''));
  L.push(
    `| ${t.id} | ${verdict} | ${target} | ${esc(t.surface || '—')} | \`${esc(t.buildId || t.carriedFrom?.buildId || '—')}\` | ` +
      `${n('PASS')}/${n('FAIL')}/${n('NEEDS_MANUAL')}/${n('NOT_TESTED')} | ${note} |`
  );
}
L.push('');

const failing = ledger.tickets.filter((t) => t.verdict === 'FAIL' || (t.verdict === 'PARTIAL' && t.partialReason === 'mixed'));
if (failing.length) {
  L.push('## Failing cases');
  L.push('');
  for (const t of failing) {
    L.push(`### ${t.id} — ${esc(t.title)}`);
    L.push('');
    for (const c of (t.cases || []).filter((c) => c.verdict === 'FAIL')) {
      L.push(`- **${c.caseId}** — expected: ${esc(c.expected)}`);
      L.push(`  - observed: ${esc(c.evidence?.observedText || c.actual)}`);
      L.push(`  - at \`${esc(c.evidence?.url)}\`${c.evidence?.httpStatus !== undefined ? ` (HTTP ${c.evidence.httpStatus})` : ''}${c.evidence?.selector ? ` · \`${esc(c.evidence.selector)}\`` : ''}`);
      if (c.evidence?.screenshot) L.push(`  - screenshot: \`${esc(c.evidence.screenshot)}\``);
    }
    L.push('');
  }
}

const nm = ledger.tickets.filter((t) => (t.needsManual || []).length);
if (nm.length) {
  L.push('## Needs manual (QA lead only — never a bug, never Slack)');
  L.push('');
  for (const t of nm) {
    for (const e of t.needsManual) {
      L.push(`- **${t.id} ${e.caseId}** — missing: ${esc(e.probe?.missingCapability)}`);
      L.push(`  - probe: ${esc(e.probe?.attempted)} → ${esc(e.probe?.failureMode)}`);
    }
  }
  L.push('');
}

const scope = ledger.tickets.filter((t) => t.scopeQuestion);
if (scope.length) {
  L.push('## Scope questions for PM (not defects)');
  L.push('');
  for (const t of scope) L.push(`- **${t.id}** — ${esc(t.scopeQuestion)}`);
  L.push('');
}

if (warnings.length) {
  L.push('## Validator warnings');
  L.push('');
  for (const w of warnings) L.push(`- ${w}`);
  L.push('');
}

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, L.join('\n'));
console.log(`[gen-summary] wrote ${out} — ${counts.total} tickets, ${orderedBuckets.length} buckets, derived from the ledger.`);
