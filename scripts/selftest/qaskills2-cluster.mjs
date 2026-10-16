// Selftest section for qa-skills second read, idea "cluster" (2026-10-16, see _IDEAS-FROM-REPOS.md):
// scripts/failure-cluster.mjs, deterministic failure fingerprints + cross-ticket clusters for orchestrator step 6.
// Run alone: node scripts/selftest/run-section.mjs scripts/selftest/qaskills2-cluster.mjs
//
// A fingerprint is only useful if it is stable (ids, UUIDs, timestamps, quoted values do not split it) and
// sharp (status, method and route do split it). The CLI fixture is three tickets with one shared 500, one
// unrelated 404 and a 401 poll that only rides on passing cases.

import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeSignal, signalsOf, clusterCases, casesFrom, ledgerVerdicts } from '../failure-cluster.mjs';

export default function section(h) {
  const { check, assert, mustReject, mustAccept, run, TMP } = h;
  const DIR = join(TMP, 'qaskills2-cluster');
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  const fp = (kind, raw) => makeSignal(kind, raw).fingerprint;
  const API = 'https://api.example.test/api/v1';

  console.log('\nRepo ideas (qa-skills 2nd read): failure clusters');

  check('cluster: same call with different ids, UUIDs, timestamps and query → same fingerprint; v1 kept, query dropped', () => {
    const a = makeSignal('call', { method: 'get', url: `${API}/offers/123?ts=1697000000`, status: 500,
      message: 'Offer 123 failed at 2026-10-16T10:00:00.000Z (req 08b33429-5ca8-45cc-86d4-52881d8d73d6)' });
    const b = makeSignal('call', { method: 'GET', url: `${API}/offers/08b33429-5ca8-45cc-86d4-52881d8d73d6/?ts=1`, status: '500',
      message: 'Offer 98765 failed at 2026-10-15T09:12:33Z (req fdb9b0fe-38cb-404f-8355-f95cc8499331)' });
    assert(a.fingerprint === b.fingerprint, `split: ${a.signature} | ${b.signature}`);
    assert(/^[0-9a-f]{16}$/.test(a.fingerprint), `fingerprint is not 16 hex: ${a.fingerprint}`);
    assert(a.signature.includes('api.example.test/api/v1/offers/:id') && !a.signature.includes('?'), `signature: ${a.signature}`);
  });

  check('cluster: a different status → a different fingerprint', () => {
    const u = { method: 'GET', url: `${API}/offers/1`, message: 'x' };
    assert(fp('call', { ...u, status: 500 }) !== fp('call', { ...u, status: 502 }), '500 and 502 merged');
  });

  check('cluster: a different method → a different fingerprint', () => {
    const u = { url: `${API}/offers/1`, status: 500, message: 'x' };
    assert(fp('call', { ...u, method: 'GET' }) !== fp('call', { ...u, method: 'POST' }), 'GET and POST merged');
  });

  check('cluster: a different route or host → a different fingerprint', () => {
    const u = { method: 'GET', status: 500, message: 'x' };
    assert(fp('call', { ...u, url: `${API}/offers/7` }) !== fp('call', { ...u, url: `${API}/orders/7` }), '/offers/:id and /orders/:id merged');
    assert(fp('call', { ...u, url: `${API}/offers/7` }) !== fp('call', { ...u, url: 'https://api.other.test/api/v1/offers/7' }), 'two hosts merged');
  });

  check('cluster: different quoted values and numbers in a message → same fingerprint', () => {
    assert(fp('console', { message: "TypeError: Cannot read properties of undefined (reading 'foo')" }) ===
      fp('console', { message: 'TypeError: Cannot read properties of undefined (reading "bar")' }), 'quoted values split');
    assert(fp('pageerror', { message: 'Expected 3 items, got 7' }) === fp('pageerror', { message: 'Expected 10 items, got 2' }), 'numbers split');
  });

  check('cluster: the ledger verdict beats matchesExpected; a case the ledger lacks falls back to it', () => {
    const files = [{ file: '/x/_RESULT-R-L-QA-9.json', doc: { runId: 'R-L', ticketId: 'QA-9', results: [
      { caseId: 'C1', matchesExpected: false, evidence: { failedCalls: [{ method: 'GET', url: `${API}/a/1`, status: 500 }] } },
      { caseId: 'C2', matchesExpected: false, evidence: {} },
    ] } }];
    const verdictOf = ledgerVerdicts({ tickets: [{ id: 'QA-9', cases: [{ caseId: 'C1', verdict: 'PASS' }] }] });
    const { cases, source } = casesFrom(files, 'R-L', verdictOf);
    assert(cases[0].failing === false && cases[1].failing === true, `failing: ${cases.map((c) => c.failing)}`);
    assert(source.ledger === 1 && source.matchesExpected === 1, `source: ${JSON.stringify(source)}`);
    assert(clusterCases(cases)[0].label === 'background', 'a ledger-PASS-only cluster should be background');
  });

  // ── CLI fixture: three tickets ──────────────────────────────────────────────────────────────────
  const RES = join(DIR, 'results');
  mkdirSync(RES, { recursive: true });
  const poll = (since) => ({ method: 'GET', url: `${API}/notifications/poll?since=${since}`, status: 401, message: '{"message":"Unauthorized"}' });
  const file = (ticket, results) =>
    writeFileSync(join(RES, `_RESULT-R-T1-${ticket}.json`), JSON.stringify({ schemaVersion: 1, ticketId: ticket, project: 'zz-selftest', runId: 'R-T1', results }, null, 2));
  file('QA-1', [
    { caseId: 'QA-1-C1', matchesExpected: false, evidence: {
      failedCalls: [{ method: 'GET', url: `${API}/offers/111?x=1`, status: 500, message: '{"message":"Internal server error","traceId":"abc123def456"}' }],
      consoleErrors: ['Failed to load resource: the server responded with a status of 500 ()'] } },
    { caseId: 'QA-1-C2', matchesExpected: true, evidence: { failedCalls: [poll('2026-10-16T08:00:00Z')] } },
  ]);
  file('QA-2', [
    { caseId: 'QA-2-C1', matchesExpected: false, evidence: [{
      failedCalls: [{ method: 'GET', url: `${API}/offers/08b33429-5ca8-45cc-86d4-52881d8d73d6`, status: 500, message: '{"message":"Internal server error"}' }] }] },
    { caseId: 'QA-2-C2', matchesExpected: true, evidence: { failedCalls: [poll('2026-10-16T09:30:12Z')] } },
  ]);
  file('QA-3', [
    { caseId: 'QA-3-C1', matchesExpected: false, evidence: { failedCalls: [{ method: 'GET', url: `${API}/brand-load/`, status: 404, message: 'Cannot GET /api/v1/brand-load/' }] } },
    { caseId: 'QA-3-C2', matchesExpected: true, evidence: { failedCalls: [poll('1697000000')] } },
  ]);
  const OUT = join(DIR, 'out.json');
  const cli = (...extra) => run('failure-cluster.mjs', ['--project', 'zz-selftest', '--run', 'R-T1', '--results', RES, ...extra]);

  check('cluster CLI: 3 tickets → one shared 500 on QA-1+QA-2, a single 404, a background 401 poll; exit 0', () => {
    const r = cli('--out', OUT);
    mustAccept(r, 'fixture run');
    const rep = JSON.parse(readFileSync(OUT, 'utf8'));
    const by = (re) => rep.clusters.filter((c) => re.test(c.signature));
    const offers = by(/offers\/:id 500/);
    assert(offers.length === 1, `offers 500 clusters: ${offers.length} (${rep.clusters.map((c) => c.signature).join(' | ')})`);
    assert(offers[0].label === 'shared' && offers[0].tickets.join(',') === 'QA-1,QA-2' && offers[0].failing === 2, `offers: ${JSON.stringify(offers[0])}`);
    const brand = by(/brand-load 404/);
    assert(brand.length === 1 && brand[0].label === 'single' && brand[0].tickets.join(',') === 'QA-3', `brand-load: ${JSON.stringify(brand)}`);
    const pl = by(/notifications\/poll 401/);
    assert(pl.length === 1 && pl[0].label === 'background' && pl[0].tickets.length === 3, `poll: ${JSON.stringify(pl)}`);
    assert(rep.clusters.length === 3 && !rep.clusters.some((c) => c.kind === 'console'),
      `the "Failed to load resource" line beside its failedCall should be dropped; clusters: ${rep.clusters.map((c) => c.signature).join(' | ')}`);
    assert(rep.labels.shared === 1 && rep.labels.single === 1 && rep.labels.background === 1, `labels: ${JSON.stringify(rep.labels)}`);
    assert(/shared\s+2 tickets/.test(r.stdout) && r.stdout.includes(offers[0].fingerprint), `stdout lacks the shared line:\n${r.stdout}`);
  });

  check('cluster CLI: a missing --run → usage error (exit 2)', () => {
    const r = run('failure-cluster.mjs', ['--project', 'zz-selftest', '--results', RES]);
    mustReject(r, 'usage', 'missing --run');
    assert(r.status === 2, `exit ${r.status}`);
  });

  check('cluster CLI: a run with zero result files → exit 1, not an empty "no clusters" report', () => {
    const out = join(DIR, 'nope.json');
    const r = run('failure-cluster.mjs', ['--project', 'zz-selftest', '--run', 'R-NOPE', '--results', RES, '--out', out]);
    mustReject(r, 'no _RESULT files', 'zero result files');
    assert(r.status === 1 && !existsSync(out), `exit ${r.status}, out written: ${existsSync(out)}`);
  });

  check('cluster CLI: --out onto a _LEDGER/_HISTORY name is refused and nothing is written (R-15)', () => {
    for (const name of ['_LEDGER-R-T1.json', '_HISTORY.md']) {
      const r = cli('--out', join(DIR, name));
      mustReject(r, 'refusing to write', `--out ${name}`);
      assert(!existsSync(join(DIR, name)), `${name} was written`);
    }
  });
}
