#!/usr/bin/env node
// R-11 gate — validate the verdict ledger before anything is generated from it.
// Enforces R-02 (probe), R-04 (routing + PARTIAL sub-reason), R-05 (surface/build),
// R-09 (typed evidence), R-10 (self-contained comments), and the dedupe record on each candidate
// bug: candidateBugs[].dedupe {query, states, outcome, matchId} must cover a closed state (Done/Canceled…)
// — a closed match is a regression, not a new bug (lib/dedupe-check.mjs; a missing/legacy record WARNs).
//
//   node scripts/ledger-validate.mjs --ledger _LEDGER-R4.json [--project alpha] [--build <id>]

import { readFileSync } from 'node:fs';
import { args, fail, loadProfile } from '../lib/profile.mjs';
import { validateLedger } from '../lib/ledger.mjs';
import { checkCandidateDedupe } from '../lib/dedupe-check.mjs';

const { flags } = args();
if (!flags.ledger) fail('usage: ledger-validate.mjs --ledger <ledger.json> [--project <slug>] [--build <id>] [--json]', 2);

const ledger = JSON.parse(readFileSync(flags.ledger, 'utf8'));
const slug = flags.project || ledger.project;
let profile = null;
try {
  profile = slug ? loadProfile(slug) : null;
} catch (e) {
  console.error(`[ledger-validate] WARN ${e.message} — validating without project state map / mention suffix`);
}

const currentBuildId = flags.build || ledger.build?.buildId || null;
const { errors, warnings, counts } = validateLedger(ledger, { profile, currentBuildId });
const dedupe = checkCandidateDedupe(ledger, profile);
errors.push(...dedupe.errors);
warnings.push(...dedupe.warnings);

if (flags.json) {
  console.log(JSON.stringify({ errors, warnings, counts }, null, 2));
} else {
  console.log(`Ledger ${ledger.runId || '(no runId)'} — ${counts.total} tickets @ build ${currentBuildId || '(none)'}`);
  console.log(`  tested ${counts.tested} · carried forward ${counts.carriedForward}`);
  console.log(`  buckets: ${Object.entries(counts.buckets).map(([k, v]) => `${k}=${v}`).join(' · ') || '(none)'}`);
  console.log(`  proposed states: ${Object.entries(counts.byProposedState).map(([k, v]) => `${k}=${v}`).join(' · ') || '(none)'}`);
  if (warnings.length) {
    console.log('');
    for (const w of warnings) console.log(`  WARN ${w}`);
  }
}

if (errors.length) {
  console.error(`\n[ledger-validate] FAILED — ${errors.length} error(s):`);
  for (const e of errors) console.error(`  ✗ ${e}`);
  console.error('\nNothing may be generated from an invalid ledger — that is how a misfiled verdict reaches a dev.');
  process.exit(1);
}
console.log('\n[ledger-validate] OK');
