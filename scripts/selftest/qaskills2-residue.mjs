// Selftest section for qa-skills second read, idea "residue" (2026-10-16, see _IDEAS-FROM-REPOS.md):
// RunResult.created() registers the test data a case made (harness/lib/evidence.mjs), run-result-validate
// rejects a malformed register, and scripts/residue.mjs folds the registers across runs into _RESIDUE.md.
// Run alone: node scripts/selftest/run-section.mjs scripts/selftest/qaskills2-residue.mjs
//
// Every RunResult here writes under TMP, never into a live project, and residue.mjs gets --root.

import { mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { RunResult } from '../../harness/lib/evidence.mjs';
import { foldCreated } from '../residue.mjs';

export default function section(h) {
  const { check, assert, mustReject, mustAccept, run, w, TMP, HUB } = h;
  const DIR = join(TMP, 'qaskills2-residue');
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  const read = (p) => JSON.parse(readFileSync(p, 'utf8'));
  const throws = (fn, re) => { try { fn(); } catch (e) { return re.test(e.message); } return false; };
  const fresh = (name) => new RunResult({ ticketId: 'T-1', project: 'selftest', runId: `R-SELFRES-${name}`, reportsDir: join(DIR, 'rr'), buildId: 'index-SELF.js' });
  const residue = (argv) => spawnSync('node', [join(HUB, 'scripts', 'residue.mjs'), ...argv], { encoding: 'utf8' });
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;

  console.log('\nRepo ideas (qa-skills 2nd read): residue — created[] register + _RESIDUE.md');

  check('residue: rec.created() is on disk right after the call, before any case, with the case surface once the case exists', () => {
    const rec = fresh('wt');
    rec.created('AC-1', { type: 'listing', id: 4711, label: '[QA] AC-1 listing', cleanup: 'left' });
    const d = read(rec.outPath);
    assert(Array.isArray(d.created) && d.created.length === 1, `created not written through: ${JSON.stringify(d.created)}`);
    const e = d.created[0];
    assert(e.caseId === 'AC-1' && e.type === 'listing' && e.id === '4711' && e.cleanup === 'left' && e.at, `entry: ${JSON.stringify(e)}`);
    assert(d.results.length === 0, 'a case appeared from nowhere');
    rec.held('AC-2', { surface: 'staging.example.test', reason: 'held: selftest' });
    rec.created('AC-2', { type: 'upload', id: 'u-1', cleanup: 'deleted' });
    assert(read(rec.outPath).created[1].surface === 'staging.example.test', `surface not taken from the case: ${JSON.stringify(read(rec.outPath).created[1])}`);
  });

  check('residue: an unknown cleanup, a missing id and a missing type throw (and write nothing)', () => {
    const rec = fresh('bad');
    assert(throws(() => rec.created('AC-1', { type: 'listing', id: 'x', cleanup: 'gone' }), /cleanup "gone" is not one of/), 'bad cleanup accepted');
    assert(throws(() => rec.created('AC-1', { type: 'listing', cleanup: 'left' }), /id is required/), 'missing id accepted');
    assert(throws(() => rec.created('AC-1', { type: 'listing', id: '', cleanup: 'left' }), /id is required/), 'empty id accepted');
    assert(throws(() => rec.created('AC-1', { id: 'x', cleanup: 'left' }), /type is required/), 'missing type accepted');
    assert(!existsSync(rec.outPath), 'a refused created() still wrote the file');
  });

  check("residue: the same type+id updates the entry ('left' → 'deleted'), no duplicate; another type with that id is its own entry", () => {
    const rec = fresh('upsert');
    rec.created('AC-1', { type: 'listing', id: 'L-9', label: '[QA] keep for AC-3', cleanup: 'left' });
    rec.created('teardown', { type: 'listing', id: 'L-9', cleanup: 'deleted' });
    rec.created('AC-1', { type: 'offer', id: 'L-9', cleanup: 'left' });
    const c = read(rec.outPath).created;
    assert(c.length === 2, `expected 2 entries, got ${c.length}: ${JSON.stringify(c)}`);
    const l = c.find((e) => e.type === 'listing');
    assert(l.cleanup === 'deleted' && l.caseId === 'AC-1' && l.label === '[QA] keep for AC-3' && l.updatedAt, `upsert lost data: ${JSON.stringify(l)}`);
    const resumed = new RunResult({ ticketId: 'T-1', project: 'selftest', runId: 'R-SELFRES-upsert', reportsDir: join(DIR, 'rr'), resume: true });
    resumed.created('AC-1', { type: 'offer', id: 'L-9', cleanup: 'deleted' });
    assert(read(rec.outPath).created.length === 2, 'resume: created[] was not carried over, or the upsert duplicated');
  });

  const BUILD = 'index-SELF.js';
  const base = {
    ticketId: 'T-2', project: 'selftest', runId: 'R-SELFRES', buildId: BUILD,
    results: [{ caseId: 'AC-1', plannedSurface: 'staging.example.test', ranOk: true,
      evidence: { url: 'https://staging.example.test/x', host: 'staging.example.test', httpStatus: 200, selector: 'body', observedText: 'ok', buildId: BUILD } }],
  };
  const entry = { caseId: 'AC-1', type: 'listing', id: 'L-1', label: '[QA] x', cleanup: 'left', at: '2026-10-16T10:00:00.000Z' };

  check('residue: run-result-validate accepts an old result without created[] and one with a valid register', () => {
    mustAccept(run('run-result-validate.mjs', ['--result', w('qaskills2-residue/v-old.json', base), '--build', BUILD]), 'result without created');
    mustAccept(run('run-result-validate.mjs', ['--result', w('qaskills2-residue/v-good.json', { ...base, created: [entry] }), '--build', BUILD]), 'result with a valid created[]');
  });

  check('residue: run-result-validate rejects a bad cleanup, a missing id, a missing type and a non-array created', () => {
    const bad = (name, created) => run('run-result-validate.mjs', ['--result', w(`qaskills2-residue/v-${name}.json`, { ...base, created }), '--build', BUILD]);
    mustReject(bad('cleanup', [{ ...entry, cleanup: 'cleaned' }]), 'created[0]: cleanup "cleaned"', 'bad cleanup');
    mustReject(bad('noid', [entry, { ...entry, id: undefined }]), 'created[1]: id is required', 'missing id');
    mustReject(bad('notype', [{ ...entry, type: '' }]), 'created[0]: type is required', 'missing type');
    mustReject(bad('object', { ...entry }), 'created must be an array', 'created as an object');
  });

  check('residue: fold — the latest state wins regardless of input order; equal times keep run order', () => {
    const rows = [
      { file: 'b', runId: 'R2', ticketId: 'T', runAt: '2026-10-17T00:00:00Z', created: [{ ...entry, cleanup: 'deleted', at: '2026-10-17T01:00:00Z' }, { ...entry, id: 'L-3', cleanup: 'deleted', at: '2026-10-16T05:00:00Z' }] },
      { file: 'a', runId: 'R1', ticketId: 'T', runAt: '2026-10-16T00:00:00Z', created: [{ ...entry, at: '2026-10-16T01:00:00Z' }, { ...entry, id: 'L-2', at: null }, { ...entry, id: 'L-3', at: '2026-10-16T05:00:00Z' }] },
      { file: 'c', runId: 'R3', ticketId: 'T', runAt: '2026-10-18T00:00:00Z', created: [{ ...entry, id: 'L-2', cleanup: 'needs-admin', at: null }, { type: 'x' }] },
    ];
    const f = foldCreated(rows);
    const byId = Object.fromEntries(f.items.map((i) => [i.id, i]));
    assert(byId['L-1'].cleanup === 'deleted' && !byId['L-1'].open && byId['L-1'].first.runId === 'R1' && byId['L-1'].history.length === 2, `L-1: ${JSON.stringify(byId['L-1'])}`);
    assert(byId['L-2'].cleanup === 'needs-admin' && byId['L-2'].open && byId['L-2'].last.runId === 'R3', `L-2 (no at → file run time): ${JSON.stringify(byId['L-2'])}`);
    assert(byId['L-3'].cleanup === 'deleted', `L-3 (same time in R1 and R2 → the later run wins): ${JSON.stringify(byId['L-3'])}`);
    assert(f.open.length === 1 && f.skipped.length === 1 && f.skipped[0].file === 'c', `open ${f.open.length}, skipped ${JSON.stringify(f.skipped)}`);
  });

  check("residue: two runs (X 'left' then 'deleted', Y 'needs-admin') → --write lists Y not X, .md carries the generated header", () => {
    const root = join(DIR, 'hub');
    const rd = join(root, 'projects', 'selftestproj', 'qa-reports');
    const res = (p, obj) => w(join('qaskills2-residue', 'hub', 'projects', 'selftestproj', 'qa-reports', p), obj);
    // R-B ran first but sorts after R-A by name, and lives in a subfolder: order is by time, the scan is recursive.
    res('R-B-results/_RESULT-R-B-T-1.json', { ...base, runId: 'R-B', ticketId: 'T-1', startedAt: '2026-10-16T09:00:00Z',
      created: [{ caseId: 'AC-1', type: 'listing', id: 'X-100', label: '[QA] X', cleanup: 'left', at: '2026-10-16T09:05:00Z' },
        { caseId: 'AC-2', type: 'account', id: 'Y-200', label: '[QA] Y dealer (admin delete only)', cleanup: 'needs-admin', surface: 'staging.example.test', at: '2026-10-16T09:06:00Z' }] });
    res('_RESULT-R-A-T-1.json', { ...base, runId: 'R-A', ticketId: 'T-1', executedAt: '2026-10-17T09:00:00Z',
      created: [{ caseId: 'teardown', type: 'listing', id: 'X-100', cleanup: 'deleted', at: '2026-10-17T09:30:00Z' }] });
    res('_RESULT-R-A-T-2.json', { ...base, runId: 'R-A', ticketId: 'T-2' }); // an old-shape result in the same tree
    const r = residue(['--project', 'selftestproj', '--root', root, '--write']);
    mustAccept(r, 'residue --write');
    const md = readFileSync(join(rd, '_RESIDUE.md'), 'utf8');
    const json = read(join(rd, '_RESIDUE.json'));
    assert(/^> \*\*Generated by `scripts\/residue\.mjs` — do not hand-edit\.\*\*.*before 2026-10-16.*_HISTORY\.md/.test(md.split('\n')[0]), `header line: ${md.split('\n')[0]}`);
    const openPart = md.split('## Closed')[0];
    assert(openPart.includes('Y-200') && !openPart.includes('X-100'), `open section wrong:\n${openPart}`);
    assert(json.open.map((i) => i.id).join() === 'Y-200' && json.closed.map((i) => i.id).join() === 'X-100' && json.scanned === 3, `json: ${JSON.stringify(json.counts)} scanned ${json.scanned}`);
    assert(/Y-200/.test(r.stdout) && !/X-100/.test(r.stdout), `table:\n${r.stdout}`);
  });

  check('residue: zero registers says so plainly (exit 0); unknown project and missing --project exit non-zero', () => {
    const root = join(DIR, 'hub');
    w(join('qaskills2-residue', 'hub', 'projects', 'emptyproj', 'qa-reports', '_RESULT-R-A-T-1.json'), base);
    const empty = residue(['--project', 'emptyproj', '--root', root]);
    mustAccept(empty, 'residue on a project with no registers');
    assert(/no registered test data/.test(empty.stdout), `empty: ${out(empty)}`);
    assert(!existsSync(join(root, 'projects', 'emptyproj', 'qa-reports', '_RESIDUE.md')), 'wrote without --write');
    mustReject(residue(['--project', 'nosuchproj', '--root', root]), 'unknown project', 'unknown project');
    mustReject(residue(['--root', root]), 'usage', 'no --project');
  });
}
