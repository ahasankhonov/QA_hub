// Selftest section for qa-skills second read, idea "dedupe" (2026-10-16, see _IDEAS-FROM-REPOS.md).
// Run alone: node scripts/selftest/run-section.mjs scripts/selftest/qaskills2-dedupe.mjs
//
// Verifier step 4 searched the queue-shaped cache (Alpha: 289 of 644 ids) and missed ALP-482. Each
// candidate bug now records dedupe {query, states, outcome, matchId}; ledger-validate rejects a search
// that never reached a closed state, and an old ledger without the record still passes with a WARN.
// Every bad input is the same minimal valid ledger with one dedupe record changed.

import { join } from 'node:path';
import { closedStates, checkCandidateDedupe } from '../../lib/dedupe-check.mjs';
import { loadProfile } from '../../lib/profile.mjs';

export default function section(h) {
  const { check, assert, mustReject, mustAccept, run, w } = h;
  const BUILD = 'index-SELFTEST01.js';
  const daysAgo = (n) => new Date(Date.now() - n * 86400_000).toISOString();
  const bug = (dedupe) => ({ draftId: 'D-1', title: 'Dealer signature missing on the bill of sale', severity: 'high', ...(dedupe === undefined ? {} : { dedupe }) });
  // Shape copied from the R-11 section of selftest-gates.mjs (its clean ledger validates).
  const ledger = (candidateBugs) => ({
    schemaVersion: 1, runId: 'SELFTEST-DEDUPE', project: 'alpha', generatedAt: daysAgo(1),
    build: { buildId: BUILD },
    tickets: [{
      id: 'ALP-301', verdict: 'PASS', surface: 'staging-dealer.alpha.example', buildId: BUILD, observedAt: daysAgo(1),
      cases: [{ caseId: 'AC-1', verdict: 'PASS' }],
      ...(candidateBugs ? { candidateBugs } : {}),
    }],
  });
  const validate = (name, l) => run('ledger-validate.mjs', ['--ledger', w(join('qaskills2-dedupe', `${name}.json`), l), '--project', 'alpha']);
  const out = (r) => (r.stdout || '') + (r.stderr || '');
  const full = { query: 'dealer signature bill of sale', states: 'all', outcome: 'new' };

  console.log('\nRepo ideas (qa-skills 2nd read): dedupe searches every state, recorded in the ledger');

  check('dedupe: closed states come from each profile; open states are never closed', () => {
    const want = { alpha: ['Done', 'Canceled'], beta: ['PRODUCTION'], gamma: ['Done', 'Canceled'] };
    for (const [slug, names] of Object.entries(want)) {
      const got = closedStates(loadProfile(slug)).states;
      for (const n of names) assert(got.includes(n), `${slug}: ${n} missing from ${got.join(', ')}`);
      for (const open of ['Staging QA', 'Release Candidate', 'Production QA', 'Reopen', 'STAGING', 'READY FOR QA'])
        assert(!got.includes(open), `${slug}: open state "${open}" classed closed`);
    }
  });

  check('dedupe: the base fixture (no candidate bug) validates, so every rejection below is the dedupe check', () =>
    mustAccept(validate('base', ledger()), 'base ledger'));

  check('dedupe: an open-only states list ["Staging QA","Reopen"] → rejected, naming Done · Canceled · Duplicate and the entry', () => {
    const r = validate('open-only', ledger([bug({ ...full, states: ['Staging QA', 'Reopen'] })]));
    mustReject(r, 'covers no closed state', 'open-only states');
    for (const n of ['Done', 'Canceled', 'Duplicate', 'D-1']) assert(out(r).includes(n), `message does not name ${n}:\n${out(r).slice(0, 600)}`);
  });

  check('dedupe: a missing query → rejected', () =>
    mustReject(validate('no-query', ledger([bug({ states: 'all', outcome: 'new' })])), '.query is missing', 'missing query'));

  check('dedupe: regression-closed with no matchId → rejected', () =>
    mustReject(validate('no-match', ledger([bug({ ...full, outcome: 'regression-closed' })])), 'needs matchId', 'regression-closed without matchId'));

  check('dedupe: an unknown outcome → rejected', () =>
    mustReject(validate('bad-outcome', ledger([bug({ ...full, outcome: 'dupe' })])), '.outcome "dupe" invalid', 'unknown outcome'));

  check('dedupe: a full record with "all" → accepted, no dedupe WARN', () => {
    const r = validate('full-all', ledger([bug(full)]));
    mustAccept(r, 'full record with "all"');
    assert(!/WARN .*dedupe/.test(out(r)), `unexpected dedupe WARN:\n${out(r).slice(0, 600)}`);
  });

  check('dedupe: regression-closed + matchId over a list with a closed state, and duplicate-open + matchId → accepted', () =>
    mustAccept(validate('closed-list', ledger([
      bug({ query: 'dealer signature', states: ['Staging QA', 'Done'], outcome: 'regression-closed', matchId: 'ALP-482' }),
      { ...bug({ query: 'signature pad', states: ['all'], outcome: 'duplicate-open', matchId: 'ALP-621' }), draftId: 'D-2' },
    ])), 'closed-list records'));

  check('dedupe: an old-shape ledger (candidate bug, no dedupe) → accepted with a WARN naming the entry', () => {
    const r = validate('old-shape', ledger([bug()]));
    mustAccept(r, 'old-shape ledger');
    assert(/WARN \[ALP-301\] candidate bug D-1: no dedupe record/.test(out(r)), `no WARN for the missing record:\n${out(r).slice(0, 600)}`);
  });

  check('dedupe: the live legacy shapes (prose string, Alpha {existingIssue…}) and bare references WARN, never fail', () => {
    const legacy = ledger([
      bug('No matching issue (list_issues team ALP). Propose new.'),
      { ...bug({ existingIssue: 'ALP-663', existingState: 'Ready for Dev', relation: 'same root cause', action: 'reference-existing' }), draftId: 'D-2' },
      'G2-C04',
    ]);
    const r = validate('legacy', legacy);
    mustAccept(r, 'legacy shapes');
    assert((out(r).match(/WARN .*legacy dedupe/g) || []).length === 2 && /1 bare reference\(s\) \(G2-C04\)/.test(out(r)), `legacy WARNs missing:\n${out(r).slice(0, 900)}`);
  });

  check('dedupe: a top-level candidate bug (ticket-less shape) and the other trackers are checked too', () => {
    const top = { ...ledger(), candidateBugs: [{ title: 'Network listing never appears', dedupe: { query: 'listing network', states: ['Staging QA'], outcome: 'new' } }] };
    const r = checkCandidateDedupe(top, loadProfile('alpha'));
    assert(r.errors.length === 1 && r.errors[0].startsWith('candidate bug "Network listing never appears"'), `top-level: ${r.errors.join(' | ') || 'no error'}`);
    const px = (states) => checkCandidateDedupe(ledger([bug({ query: 'otp', states, outcome: 'new' })]), loadProfile('beta')).errors;
    assert(px(['READY FOR QA', 'STAGING']).some((e) => e.includes('missing PRODUCTION')), 'beta open-only list passed');
    assert(!px(['READY FOR QA', 'PRODUCTION']).length, 'beta list with PRODUCTION rejected');
    const spx = checkCandidateDedupe(ledger([bug({ query: 'export', states: ['Gathering Requirements'], outcome: 'new' })]), loadProfile('gamma')).errors;
    assert(spx.length === 1 && /missing Done · Canceled · Duplicate \(gamma asana states\)/.test(spx[0]), `gamma: ${spx.join(' | ') || 'no error'}`);
  });
}
