// Selftest section for the pieces taken from petrkindlmann/qa-skills (MIT) on 2026-10-16 (see
// _IDEAS-FROM-REPOS.md): the plan linter (scripts/plan-lint.mjs → qa-gates), RunResult refusing a
// missing run id or an existing file, capture() matchCount → run-result-validate, and the page helpers
// clickUnique / fillAndConfirm / assertLinkHost (driven against a fake page in a child process, because
// sections are synchronous and the helpers are async).
//
// Every "it warns" check has a sibling proving a good input stays quiet.

import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { RunResult } from '../../harness/lib/evidence.mjs';
import { lintPlan } from '../plan-lint.mjs';

export default function section(h) {
  const { check, assert, run, TMP, HUB } = h;
  const DIR = join(TMP, 'qa-skills-ideas');
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  const put = (name, obj) => {
    const p = join(DIR, name);
    writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) + '\n');
    return p;
  };
  const out = (r) => (r.stdout || '') + (r.stderr || '');
  const codes = (r) => [...r.warnings, ...r.errors].map((x) => x.code).sort();

  console.log('\nRepo ideas (qa-skills): plan lint, result overwrite, unique match, link host');

  const good = {
    runId: 'R-SELF', ticketId: 'T-1', scopeQuestions: [],
    steps: [
      { caseId: 'T-1-1', surface: 'app.example', precond: 'Logged in as qa+t1@example.com', actions: ['Open Profile', 'Change the display name to "Ada QA"', 'Click Save'], expected: 'Toast "Profile saved"; header shows "Ada QA"', verifyBy: 'observedText of the header', mutating: true },
      { caseId: 'T-1-2', surface: 'app.example', precond: 'Same account', actions: ['Reload the page'], expected: 'Header still shows "Ada QA" after reload', evidence: ['header text'] },
      { caseId: 'T-1-3', surface: 'app.example', precond: 'Same account', actions: ['Set the display name to "" (empty)', 'Click Save'], expected: 'Inline error "Name is required"; header unchanged', verifyBy: 'error text' },
    ],
  };

  check('plan-lint: a well-designed plan is quiet', () => {
    const r = lintPlan(good, 'good');
    assert(!r.errors.length && !r.warnings.length, `good plan flagged: ${codes(r).join(', ')}`);
  });

  check('plan-lint: no expected / duplicate or missing caseId are errors, and the CLI exits 1', () => {
    const bad = { runId: 'R-SELF', steps: [
      { caseId: 'B-1', surface: 's', precond: 'p', actions: ['Open X'], verifyBy: 'text' },
      { caseId: 'B-1', surface: 's', precond: 'p', actions: ['Open Y'], expected: 'Y heading shows "Orders"', verifyBy: 'text' },
      { surface: 's', precond: 'p', actions: ['Open Z'], expected: 'Z shows "Done"', verifyBy: 'text' },
    ] };
    const r = lintPlan(bad, 'bad');
    for (const c of ['no-expected', 'duplicate-caseId', 'no-caseId']) assert(r.errors.some((e) => e.code === c), `${c} not raised: ${codes(r).join(', ')}`);
    const res = run('plan-lint.mjs', [put('_PLAN-R-SELF-B.json', bad)]);
    assert(res.status === 1, `CLI exit ${res.status} on a plan with errors: ${out(res)}`);
    const ok = run('plan-lint.mjs', [put('_PLAN-R-SELF-G.json', good)]);
    assert(ok.status === 0, `CLI rejected the good plan: ${out(ok)}`);
  });

  check('plan-lint: each test-design gap warns (vague expected, unbounded wait, vague data, restated action, no oracle, no precond)', () => {
    const p = { runId: 'R-SELF', steps: [
      { caseId: 'W-1', surface: 's', precond: 'p', actions: ['Open the report'], expected: 'Works as expected', verifyBy: 'text' },
      { caseId: 'W-2', surface: 's', precond: 'p', actions: ['Click Export', 'Wait a few seconds'], expected: 'File "report.csv" downloads', verifyBy: 'download name' },
      { caseId: 'W-3', surface: 's', precond: 'p', actions: ['Enter valid data in the form'], expected: 'Banner "Saved" shows', verifyBy: 'text' },
      { caseId: 'W-4', surface: 's', precond: 'p', actions: ['Click the Save button'], expected: 'Save button clicked', verifyBy: 'text' },
      { caseId: 'W-5', surface: 's', precond: 'p', actions: ['Open Orders'], expected: 'Heading "Orders" shows; an invalid filter shows "No results"' },
      { caseId: 'W-6', surface: 's', actions: ['Open Billing'], expected: 'Heading "Billing" shows', verifyBy: 'text' },
    ] };
    const want = { 'W-1': 'vague-expected', 'W-2': 'unbounded-wait', 'W-3': 'vague-data', 'W-4': 'expected-restates-action', 'W-5': 'no-oracle', 'W-6': 'no-precond' };
    const r = lintPlan(p, 'w');
    for (const [id, code] of Object.entries(want)) assert(r.warnings.some((w) => w.caseId === id && w.code === code), `${id} should warn ${code}; got ${JSON.stringify(r.warnings.map((w) => [w.caseId, w.code]))}`);
    assert(!r.errors.length, `warnings-only plan raised errors: ${codes(r).join(', ')}`);
    const res = run('plan-lint.mjs', [put('_PLAN-R-SELF-W.json', p)]);
    assert(res.status === 0, `warnings alone failed the CLI: ${out(res)}`);
    assert(run('plan-lint.mjs', ['--strict', put('_PLAN-R-SELF-W2.json', p)]).status === 1, '--strict did not fail on warnings');
  });

  check('plan-lint: no negative case, a write never read back, and an implied case with no scope question warn', () => {
    const p = { runId: 'R-SELF', scopeQuestions: [], steps: [
      { caseId: 'N-1', surface: 's', precond: 'p', actions: ['Add item "Pen" to the cart'], expected: 'Cart badge shows 1', verifyBy: 'badge text', mutating: true },
      { caseId: 'N-2', surface: 's', precond: 'p', actions: ['Open the cart'], expected: 'Row "Pen" with qty 1', verifyBy: 'row text' },
      { caseId: 'N-3', surface: 's', precond: 'p', actions: ['Click Checkout'], expected: 'Page heading "Checkout"', verifyBy: 'heading text', basis: 'implied' },
    ] };
    const r = lintPlan(p, 'n');
    for (const c of ['no-negative-case', 'mutating-no-persistence', 'implied-no-question']) assert(r.warnings.some((w) => w.code === c), `${c} not raised: ${codes(r).join(', ')}`);
    // Held / deferred cases are not linted as runnable.
    const held = lintPlan({ steps: [{ caseId: 'H-1', surface: 's', disposition: 'DEFERRED: needs a handset' }, { caseId: 'H-2', surface: 's', runnable: false }] }, 'h');
    assert(!held.errors.length, `a deferred case without expected was an error: ${codes(held).join(', ')}`);
  });

  check('qa-gates runs plan lint when the run has plans, and a plan error fails the gates', () => {
    const rd = join(DIR, 'gates');
    mkdirSync(rd, { recursive: true });
    writeFileSync(join(rd, '_PLAN-R-SELFPL-T-1.json'), JSON.stringify({ steps: [{ caseId: 'X', surface: 's', precond: 'p', actions: ['a'] }] }));
    const r = run('qa-gates.mjs', ['--project', 'selftest', '--run', 'R-SELFPL', '--reports-dir', rd]);
    assert(/plan lint/.test(out(r)) && r.status !== 0, `plan error did not fail qa-gates (exit ${r.status}):\n${out(r).slice(-600)}`);
    writeFileSync(join(rd, '_PLAN-R-SELFPL-T-1.json'), JSON.stringify(good));
    const ok = run('qa-gates.mjs', ['--project', 'selftest', '--run', 'R-SELFPL', '--reports-dir', rd]);
    assert(/plan lint/.test(out(ok)) && ok.status === 0, `good plan failed qa-gates (exit ${ok.status}):\n${out(ok).slice(-600)}`);
  });

  // ── RunResult overwrite refusal ────────────────────────────────────────────────────────────
  check('RunResult refuses a missing run id and an existing file; resume, overwrite and QA_OVERWRITE_RESULT=1 are the ways through', () => {
    const saved = process.env.QA_OVERWRITE_RESULT;
    delete process.env.QA_OVERWRITE_RESULT;
    try {
      const rd = join(DIR, 'rr');
      mkdirSync(rd, { recursive: true });
      for (const runId of [undefined, '', 'undefined']) {
        let threw = false;
        try { new RunResult({ ticketId: 'T-1', project: 'x', runId, reportsDir: rd }); } catch { threw = true; }
        assert(threw, `runId=${JSON.stringify(runId)} accepted`);
      }
      const first = new RunResult({ ticketId: 'T-1', project: 'x', runId: 'R-SELF', reportsDir: rd });
      first.write();
      assert(existsSync(first.outPath), 'result not written');
      let threw = false;
      try { new RunResult({ ticketId: 'T-1', project: 'x', runId: 'R-SELF', reportsDir: rd }); } catch (e) { threw = /already exists/.test(e.message); }
      assert(threw, 'an existing result file was not refused');
      new RunResult({ ticketId: 'T-1', project: 'x', runId: 'R-SELF', reportsDir: rd, resume: true });
      new RunResult({ ticketId: 'T-1', project: 'x', runId: 'R-SELF', reportsDir: rd, overwrite: true });
      process.env.QA_OVERWRITE_RESULT = '1';
      new RunResult({ ticketId: 'T-1', project: 'x', runId: 'R-SELF', reportsDir: rd });
    } finally {
      if (saved === undefined) delete process.env.QA_OVERWRITE_RESULT; else process.env.QA_OVERWRITE_RESULT = saved;
    }
  });

  // ── matchCount → run-result-validate ───────────────────────────────────────────────────────
  check('run-result-validate warns when a captured selector matched more than one visible element', () => {
    const rd = join(DIR, 'mc');
    mkdirSync(rd, { recursive: true });
    const ev = (n) => ({ url: 'https://app.example/x', host: 'app.example', httpStatus: 200, statusSource: 'document', selector: '.chip', matchCount: n, observedText: 'Pending', buildId: 'index-abc.js', screenshot: null });
    const res = (caseId, n) => ({ caseId, plannedSurface: 'app.example', expected: 'Pending', actual: null, ranOk: true, error: null, evidence: ev(n), startedAt: '2026-10-16T00:00:00Z', finishedAt: '2026-10-16T00:00:01Z' });
    writeFileSync(join(rd, '_RESULT-R-SELFMC-T-1.json'), JSON.stringify({ schemaVersion: 1, ticketId: 'T-1', project: 'x', runId: 'R-SELFMC', buildId: 'index-abc.js', startedAt: '2026-10-16T00:00:00Z', finishedAt: '2026-10-16T00:00:01Z', results: [res('C-1', 2), res('C-2', 1)] }));
    const r = run('run-result-validate.mjs', ['--dir', rd, '--run', 'R-SELFMC']);
    const o = out(r);
    assert(/C-1[^\n]*matched 2 visible elements/.test(o), `no matchCount warning:\n${o}`);
    assert(!/C-2[^\n]*matched/.test(o), `a unique match warned:\n${o}`);
  });

  // ── page helpers against a fake page (child process: the helpers are async) ────────────────
  check('clickUnique refuses 0 or 2 visible matches; fillAndConfirm catches a cleared field; assertLinkHost blocks a prod href', () => {
    const script = put('page-helpers.mjs', `
import { clickUnique, fillAndConfirm, assertLinkHost, visibleMatches } from ${JSON.stringify(join(HUB, 'harness/lib/page.mjs'))};
const els = { '.one': [{ v: true }], '.two': [{ v: true }, { v: true }], '.hidden-dupe': [{ v: false }, { v: true }], '.none': [] };
const values = {};
let clicks = 0;
const loc = (sel) => {
  const list = els[sel] || [{ v: true }];
  const at = (i) => ({
    isVisible: async () => list[i].v, click: async () => { clicks++; },
    waitFor: async () => {}, fill: async (x) => { values[sel] = x; if (sel === '#zip') values['#city'] = ''; },
    inputValue: async () => values[sel] ?? '', getAttribute: async () => (sel === 'a.prod' ? 'https://www.alpha.example/terms' : '/terms'),
  });
  const one = at(0);
  return { count: async () => list.length, nth: at, first: () => one, fill: one.fill, inputValue: one.inputValue, toString: () => sel };
};
const page = { locator: loc, url: () => 'https://staging-customer.alpha.example/x' };
const r = {};
const throws = async (fn) => { try { await fn(); return null; } catch (e) { return e.message; } };
r.two = await throws(() => clickUnique(page, '.two'));
r.none = await throws(() => clickUnique(page, '.none'));
r.one = await throws(() => clickUnique(page, '.one'));
r.hiddenDupe = await throws(() => clickUnique(page, '.hidden-dupe'));
r.clicks = clicks;
r.visible = await visibleMatches(page, '.two');
r.fillLost = await throws(() => fillAndConfirm(page, [['#city', 'Boston'], ['#zip', '02101']]));
r.fillOk = await throws(() => fillAndConfirm(page, [['#zip', '02101'], ['#city', 'Boston']]));
r.prod = await assertLinkHost(page, 'a.prod', { allow: ['staging-customer.alpha.example'], forbid: ['www.alpha.example'] });
r.rel = await assertLinkHost(page, 'a.rel', { allow: ['staging-customer.alpha.example'], forbid: ['www.alpha.example'] });
console.log(JSON.stringify(r));
`);
    const res = spawnSync('node', [script], { encoding: 'utf8' });
    assert(res.status === 0, `helper script failed: ${out(res)}`);
    const r = JSON.parse(res.stdout.trim().split('\n').pop());
    assert(/2 visible matches/.test(r.two || ''), `two matches clicked: ${r.two}`);
    assert(/0 visible matches/.test(r.none || ''), `no match clicked: ${r.none}`);
    assert(r.one === null && r.hiddenDupe === null && r.clicks === 2, `unique / hidden-duplicate click failed: ${JSON.stringify(r)}`);
    assert(r.visible === 2, `visibleMatches ${r.visible}`);
    assert(/#city: wanted "Boston", has ""/.test(r.fillLost || ''), `cleared field not caught: ${r.fillLost}`);
    assert(r.fillOk === null, `correct fill order rejected: ${r.fillOk}`);
    assert(r.prod.ok === false && /forbidden/.test(r.prod.why), `prod href passed: ${JSON.stringify(r.prod)}`);
    assert(r.rel.ok === true && r.rel.host === 'staging-customer.alpha.example', `relative staging href failed: ${JSON.stringify(r.rel)}`);
  });
}
