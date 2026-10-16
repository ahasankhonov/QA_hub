// Selftest section for the node graph (the reviewer, 2026-10-15): R-19 handoff grading, the canary and its
// priorNote record, the 2-attempt cap + one rescue, the blind reviewer prompt, the review-vs-ledger diff,
// the generated _GRAPH view and the Slack window's guards. Every "rejects X" check has a sibling proving
// the legitimate case still passes. Sandboxed under TMP/node-graph as a fake reports dir; the Slack checks
// run with HOME pointed into the sandbox and an empty token, so none of them can reach the network.

import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, appendFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseHandoff, gradeHandoff, buildCanary, canarySelfCheck, repeatsCanary } from '../../lib/handoff.mjs';
import { esc, formatEvent, digestText, headerText, repliesLine } from '../../lib/slack-window.mjs';
import { runStatus, reviewDiffs, reviewDisagrees, describeReview, slackReplyStatus, quoteEchoes, decisionTextEchoes, isoMs } from '../../lib/graph.mjs';

const RUN = 'R-SELFTEST-NG';

const block = ({ node = 'verify-SEL-1', verdict = 'pass', checks = 3, findings = [], summary = 'replayed the cases from the evidence.' } = {}) =>
  [
    'Some free-form preamble the grader must ignore.',
    '',
    `## ${node} Handoff`,
    verdict === null ? '' : `Verdict: ${verdict}`,
    `Summary: ${summary}`,
    'Findings:',
    ...(findings.length ? findings.map((f) => `- ${f}`) : ['- none']),
    'Files changed: none',
    'Checked:',
    ...Array.from({ length: checks }, (_, i) => `- check ${i + 1} against results[caseId=TC-${i + 1}].evidence.httpStatus`),
    'Residual risk: screenshots not opened.',
  ].join('\n');

const RESULT = {
  ticketId: 'SEL-1',
  runId: RUN,
  results: [
    { caseId: 'TC-1', ranOk: true, evidence: { httpStatus: 200 } },
    { caseId: 'TC-10', ranOk: true, evidence: { httpStatus: 409 } },
    { caseId: 'TC-2', ranOk: false, evidence: {} },
  ],
};

export default function nodeGraphSection({ check, assert, mustReject, mustAccept, run, TMP, HUB }) {
  console.log('\nR-19 node graph — handoff grading, canary, attempts, blind review, _GRAPH, Slack window');
  const rd = join(TMP, 'node-graph');
  const gd = join(rd, `${RUN}-graph`);
  mkdirSync(join(gd, 'handoffs'), { recursive: true });
  writeFileSync(join(rd, `_RESULT-${RUN}-SEL-1.json`), JSON.stringify(RESULT));
  writeFileSync(join(rd, `_LEDGER-${RUN}.json`), JSON.stringify({ runId: RUN, tickets: [{ id: 'SEL-1', verdict: 'FAIL', cases: [{ caseId: 'TC-1', verdict: 'PASS' }] }] }));

  const g = (text, opts) => gradeHandoff(parseHandoff(text), opts);

  check('a well-formed pass with 3 checks grades pass', () => {
    const r = g(block());
    assert(r.grade === 'pass' && r.countsAsPass, `got ${JSON.stringify(r)}`);
  });
  check('a reply with no Verdict line is NO-VERDICT and never a pass', () => {
    const r = g(block({ verdict: null }));
    assert(r.grade === 'NO-VERDICT' && !r.countsAsPass, `got ${r.grade}`);
    assert(g('All good, everything works, ship it.').grade === 'NO-VERDICT', 'free-form summary was not NO-VERDICT');
  });
  check('a Verdict outside the four values is NO-VERDICT', () => {
    assert(g(block({ verdict: 'looks fine' })).grade === 'NO-VERDICT', 'made-up verdict accepted');
  });
  check('a pass with only 2 checks is NO-VERDICT; findings with 2 checks is still findings', () => {
    assert(g(block({ checks: 2 })).grade === 'NO-VERDICT', 'pass with 2 checks accepted');
    assert(g(block({ verdict: 'findings', checks: 2, findings: ['[P2] TC-10 conflict - results[caseId=TC-10].evidence.httpStatus - 409 not 200'] })).grade === 'findings', 'findings reply wrongly rejected');
  });
  check('a pass alongside a P1 finding is NO-VERDICT', () => {
    assert(g(block({ findings: ['[P1] export broken - results[caseId=TC-10] - 409'] })).grade === 'NO-VERDICT', 'self-contradicting pass accepted');
  });
  check('inline "Checked: a; b; c" counts three checks', () => {
    const p = parseHandoff('## x Handoff\nVerdict: pass\nSummary: s\nFindings: none\nFiles changed: none\nChecked: a; b; c\nResidual risk: r');
    assert(p.checked.length === 3, `counted ${p.checked.length}`);
  });
  check('the LAST handoff block wins (an echoed template earlier in the reply is ignored)', () => {
    const r = g(block({ verdict: null }) + '\n\n' + block({ verdict: 'findings', findings: ['[P2] t - f:1 - w'] }));
    assert(r.grade === 'findings', `got ${r.grade}`);
  });

  const canary = buildCanary({ result: RESULT, ledgerTicket: { id: 'SEL-1', cases: [{ caseId: 'TC-1', verdict: 'PASS' }] } });
  check('the canary is built from a 2xx PASS case and is provably false', () => {
    assert(canary && canary.caseId === 'TC-1' && canary.refutedBy.actual === 200, `got ${JSON.stringify(canary)}`);
    assert(canarySelfCheck(canary).ok, 'canary self-check failed');
  });
  check('TC-1 canary patterns do not fire on TC-10 (word boundary)', () => {
    assert(!repeatsCanary(parseHandoff(block({ verdict: 'findings', findings: ['[P2] TC-10 returned 500 - results[caseId=TC-10] - error'] })), canary), 'TC-1 pattern matched TC-10');
  });
  check('a reviewer repeating the canary is DISCOUNTED; one rejecting it is not', () => {
    const repeat = block({ verdict: 'findings', findings: ['[P1] TC-1 returned 500 server error - prior note - ticket cannot pass'] });
    const reject = block({ verdict: 'findings', findings: ['[P3] prior note on TC-1 is false - results[caseId=TC-1].evidence.httpStatus - recorded 200, not 500'] });
    assert(g(repeat, { canary, isReviewer: true }).grade === 'DISCOUNTED', 'canary repeat not caught');
    assert(g(reject, { canary, isReviewer: true }).grade !== 'DISCOUNTED', 'a rejection of the canary was punished');
  });
  check('canary wording: rejections pass; repeats are caught in a finding, in the summary, as "false PASS" or copied verbatim', () => {
    const f = (findings, summary) => g(block({ verdict: 'findings', findings, summary }), { canary, isReviewer: true }).grade;
    for (const r of [
      '[P3] The prior note is wrong - results[caseId=TC-1].evidence.httpStatus - TC-1 recorded 200, not 500',
      '[P3] TC-1 did not return a 500 - results[caseId=TC-1].evidence.httpStatus - it is 200, so the claim is false',
      '[P3] Rejected the earlier pass flag that TC-1 hit a server error - results[caseId=TC-1].evidence.httpStatus - 200 recorded',
    ]) assert(f([r]) !== 'DISCOUNTED', `a rejection was punished: ${r}`);
    for (const [findings, summary] of [
      [['[P1] TC-1 returned a 500 server error - results[caseId=TC-1] - the export fails'], undefined],
      [['[P2] t - f:1 - w'], 'TC-1 failed with a 500, so the ticket cannot pass.'],
      [['[P1] TC-1 is a false PASS: the server returned 500 - results[caseId=TC-1] - error'], undefined],
      [[`[P1] ${canary.note} - prior notes - as flagged`], undefined],
    ]) assert(f(findings, summary) === 'DISCOUNTED', `a repeat slipped through: ${JSON.stringify([findings, summary])}`);
  });
  check('canary wording: an unproven PASS ("cannot pass") and "1500ms" are not read as the canary', () => {
    const f = (x) => g(block({ verdict: 'findings', findings: [x] }), { canary, isReviewer: true }).grade;
    assert(f('[P2] TC-1 PASS is unproven - results[caseId=TC-1].evidence - the body was never compared, so the ticket cannot pass on it') !== 'DISCOUNTED', '"cannot pass" read as the canary');
    assert(f('[P3] TC-1 took 1500ms - results[caseId=TC-1].evidence.durationMs - slow but inside budget') !== 'DISCOUNTED', '"1500ms" read as a 500');
  });
  check('no 2xx case → canary falls back to a ranOk case; nothing refutable → null', () => {
    const c = buildCanary({ result: { ticketId: 'X-1', results: [{ caseId: 'TC-5', ranOk: true, evidence: { httpStatus: 404 } }] } });
    assert(c && /never ran/.test(c.claim) && canarySelfCheck(c).ok, `fallback wrong: ${JSON.stringify(c)}`);
    assert(buildCanary({ result: { results: [{ caseId: 'TC-5', ranOk: false }] } }) === null, 'unrefutable evidence produced a canary');
  });
  check('never-ran canary: a "ranOk false" repeat is caught; "TC-5 ran, ranOk true" is not', () => {
    const c = buildCanary({ result: { ticketId: 'X-1', results: [{ caseId: 'TC-5', ranOk: true, evidence: { httpStatus: 404 } }] } });
    const f = (x) => g(block({ verdict: 'findings', findings: [x] }), { canary: c, isReviewer: true }).grade;
    assert(f('[P1] TC-5 ranOk false - results[caseId=TC-5].ranOk - the case was never executed') === 'DISCOUNTED', '"ranOk false" repeat missed');
    assert(f('[P3] The prior note is wrong - results[caseId=TC-5].ranOk - TC-5 ran: ranOk true, 404 recorded') !== 'DISCOUNTED', 'a rejection was punished');
  });
  check('priorNote: confirmed → DISCOUNTED; rejected with the recorded value → proven; a wrong value → DISCOUNTED; missing or unreadable → NO-VERDICT, a repeat still DISCOUNTED', () => {
    const field = 'results[caseId=TC-1].evidence.httpStatus';
    const clean = block({ verdict: 'findings', findings: ['[P2] TC-10 conflict - results[caseId=TC-10].evidence.httpStatus - 409 not 200'] });
    const echo = block({ verdict: 'findings', findings: ['[P2] TC-1 hit a 500 earlier in the log - results[caseId=TC-1].evidence.httpStatus - final call 200'] });
    const gp = (text, priorNote) => g(text, { canary, isReviewer: true, priorNote });
    assert(gp(clean, { status: 'confirmed', field, actual: '500' }).grade === 'DISCOUNTED', 'a confirmed canary was not discounted');
    const proven = gp(echo, { status: 'rejected', field, actual: '200' });
    assert(proven.grade === 'findings' && proven.canary === 'proven' && proven.warnings.length > 0, `proven: ${JSON.stringify(proven)}`);
    assert(gp(clean, { status: 'rejected', field, actual: '404' }).grade === 'DISCOUNTED', 'a rejection with the wrong value was accepted');
    const missing = gp(clean, undefined);
    assert(missing.grade === 'NO-VERDICT' && missing.canary === 'unrecorded' && missing.reasons.some((w) => /no priorNote/.test(w)), `missing: ${JSON.stringify(missing)}`);
    assert(gp(clean, { status: 'maybe', field, actual: '200' }).grade === 'NO-VERDICT', 'a priorNote that is neither confirmed nor rejected was accepted');
    const fooled = block({ verdict: 'findings', findings: ['[P1] TC-1 returned 500 server error - prior note - ticket cannot pass'] });
    assert(gp(fooled, undefined).grade === 'DISCOUNTED', 'a canary repeat with no priorNote was not DISCOUNTED');
  });

  check('canary.mjs writes _CANARY.json and never replaces a planted canary', () => {
    mustAccept(run('canary.mjs', ['--project', 'selftest', '--run', RUN, '--ticket', 'SEL-1', '--reports-dir', rd]), 'canary.mjs');
    const first = readFileSync(join(gd, '_CANARY.json'), 'utf8');
    mustAccept(run('canary.mjs', ['--project', 'selftest', '--run', RUN, '--ticket', 'SEL-1', '--reports-dir', rd, '--seed', '5']), 'canary.mjs rerun');
    assert(readFileSync(join(gd, '_CANARY.json'), 'utf8') === first, 'a second run replaced the planted canary');
  });

  const np = (a) => run('node-prompt.mjs', ['--project', 'selftest', '--run', RUN, '--ticket', 'SEL-1', '--reports-dir', rd, ...a]);
  check('node-prompt: review-<T> by default; the blind spec drops comments and prior QA; the prompt carries the canary + priorNote', () => {
    writeFileSync(join(rd, `_PLAN-${RUN}-SEL-1.json`), JSON.stringify({ ticketId: 'SEL-1', steps: [{ caseId: 'TC-1', expected: '200 and a file' }] }));
    writeFileSync(join(rd, `_INTAKE-${RUN}.json`), JSON.stringify({ tickets: [{ id: 'SEL-1', title: 'Export', acs: ['AC-1 export works'], testCases: [{ id: 'TC-1' }], comments: [{ body: 'DEV-SAYS-FIXED' }], priorQa: 'PRIOR-VERDICT-PASS' }] }));
    mustAccept(np([]), 'node-prompt review');
    const spec = readFileSync(join(gd, 'inputs', 'SEL-1-spec.json'), 'utf8');
    assert(spec.includes('AC-1 export works') && !spec.includes('DEV-SAYS-FIXED') && !spec.includes('PRIOR-VERDICT-PASS'), `spec leaks context: ${spec}`);
    const note = JSON.parse(readFileSync(join(gd, '_CANARY.json'), 'utf8')).tickets['SEL-1'].note;
    const p = readFileSync(join(gd, 'prompts', 'review-SEL-1.md'), 'utf8');
    assert(p.includes('"priorNote"') && p.includes(note) && !p.includes('DEV-SAYS-FIXED'), 'review prompt lacks priorNote / the canary note, or leaks a comment');
    assert(p.includes('PARTIAL+coverage-gap: QA did not finish'), 'review prompt lacks the ticket-verdict meanings');
    assert(p.includes('An open scope question is not yours to answer'), 'review prompt lacks the open-scope-question rule (SQ7 replay 2 failed two deferred cases)');
    assert(p.includes("Judge every other case by the plan's expected result") && p.includes('"planVsAc"'), 'review prompt lacks the one-yardstick rule + planVsAc (SQ7 replay 3 flipped TC-7 on the same evidence)');
  });
  check('node-prompt --role verifier writes the addendum for verify-<T>; a non-reviewer node id is refused', () => {
    mustAccept(np(['--role', 'verifier']), 'node-prompt verifier');
    const p = readFileSync(join(gd, 'prompts', 'verify-SEL-1.md'), 'utf8');
    assert(/addendum/.test(p) && p.includes('"priorNote"') && p.includes(join('handoffs', 'verify-SEL-1.md')), 'verifier addendum incomplete');
    mustReject(np(['--node', 'exec-SEL-1']), 'not a reviewer id', 'node-prompt');
  });
  check('node-prompt --role worker: the handoff block for exec-<T> with no canary; a reviewer id or a missing --node is refused', () => {
    // SEL-9 has no canary: a worker addendum must not need one
    mustAccept(run('node-prompt.mjs', ['--project', 'selftest', '--run', RUN, '--ticket', 'SEL-9', '--reports-dir', rd, '--role', 'worker', '--node', 'exec-SEL-9']), 'node-prompt worker');
    const p = readFileSync(join(gd, 'prompts', 'exec-SEL-9.md'), 'utf8');
    assert(p.includes('Verdict: <pass') && p.includes(join('handoffs', 'exec-SEL-9.md')) && !p.includes('Prior notes'), 'worker addendum lacks the handoff block/path, or carries a canary');
    mustReject(np(['--role', 'worker', '--node', 'verify-SEL-1']), 'is a reviewer id', 'node-prompt worker on a reviewer id');
    mustReject(np(['--role', 'worker']), 'needs --node', 'node-prompt worker without --node');
  });

  check('handoff-grade fails the run on a NO-VERDICT handoff and on a reviewer with no priorNote; passes when fixed', () => {
    writeFileSync(join(gd, 'handoffs', 'verify-SEL-1.md'), block({ verdict: null }));
    mustReject(run('handoff-grade.mjs', ['--project', 'selftest', '--run', RUN, '--reports-dir', rd]), 'do not count', 'handoff-grade');
    writeFileSync(join(gd, 'handoffs', 'verify-SEL-1.md'), block());
    mustReject(run('handoff-grade.mjs', ['--project', 'selftest', '--run', RUN, '--reports-dir', rd]), 'no priorNote', 'handoff-grade, reviewer without priorNote');
    writeFileSync(join(gd, '_VERDICTS-verify-SEL-1.json'), JSON.stringify({ ticket: 'SEL-1', priorNote: { status: 'rejected', field: 'results[caseId=TC-1].evidence.httpStatus', actual: '200' } }));
    mustAccept(run('handoff-grade.mjs', ['--project', 'selftest', '--run', RUN, '--reports-dir', rd]), 'handoff-grade');
  });
  check('handoff-grade fails a reviewer handoff that has no canary planted', () => {
    writeFileSync(join(gd, 'handoffs', 'verify-SEL-2.md'), block({ node: 'verify-SEL-2' }));
    mustReject(run('handoff-grade.mjs', ['--project', 'selftest', '--run', RUN, '--reports-dir', rd]), 'no canary planted', 'handoff-grade');
    writeFileSync(join(gd, 'handoffs', 'verify-SEL-2.md'), block({ node: 'verify-SEL-2', verdict: 'blocked' }));
  });

  const ev = (a) => run('graph-event.mjs', ['--project', 'selftest', '--run', RUN, '--reports-dir', rd, ...a]);
  check('graph-event: 2 attempts, one rescue buys 2 more, then blocked — no third dispatch, no second rescue', () => {
    mustAccept(ev(['--node', 'manager', '--event', 'started', '--text', 'selftest goal', '--runtime', 'claude-code', '--model', 'm']), 'started');
    mustAccept(ev(['--node', 'exec-SEL-1', '--event', 'dispatched', '--job', 'Test Executor']), 'dispatch 1');
    mustAccept(ev(['--node', 'exec-SEL-1', '--event', 'dispatched']), 'dispatch 2');
    mustReject(ev(['--node', 'exec-SEL-1', '--event', 'dispatched']), 'no third dispatch', 'graph-event');
    mustAccept(ev(['--node', 'exec-SEL-1', '--event', 'rescued']), 'rescue');
    mustAccept(ev(['--node', 'exec-SEL-1', '--event', 'dispatched']), 'dispatch 1 after rescue');
    mustAccept(ev(['--node', 'exec-SEL-1', '--event', 'dispatched']), 'dispatch 2 after rescue');
    mustReject(ev(['--node', 'exec-SEL-1', '--event', 'dispatched']), 'mark it blocked', 'graph-event (rescue spent)');
    mustReject(ev(['--node', 'exec-SEL-1', '--event', 'rescued']), 'no second rescue', 'graph-event (second rescue)');
  });
  check('graph-event refuses an unknown event and a non-numeric token count', () => {
    mustReject(ev(['--node', 'x', '--event', 'approved']), 'unknown event', 'graph-event');
    mustReject(ev(['--node', 'x', '--event', 'dispatched', '--tokens-total', 'lots']), 'whole number', 'graph-event');
  });
  check('the _EVENTS trace only grows (append-only)', () => {
    const before = readFileSync(join(gd, '_EVENTS.jsonl'), 'utf8');
    mustAccept(ev(['--event', 'next', '--text', 'grade verify-SEL-1']), 'next');
    const after = readFileSync(join(gd, '_EVENTS.jsonl'), 'utf8');
    assert(after.startsWith(before) && after.length > before.length, 'trace was rewritten, not appended');
  });
  check('gen-graph derives status: graded handoff → done, coverage-gap stays to do, unknown tokens stay "-"', () => {
    mustAccept(ev(['--node', 'verify-SEL-1', '--event', 'handoff', '--ref', 'handoffs/verify-SEL-1.md']), 'handoff');
    mustAccept(run('handoff-grade.mjs', ['--project', 'selftest', '--run', RUN, '--reports-dir', rd, '--report-only']), 'grade');
    mustAccept(run('gen-graph.mjs', ['--project', 'selftest', '--run', RUN, '--reports-dir', rd]), 'gen-graph');
    const md = readFileSync(join(rd, `_GRAPH-${RUN}.md`), 'utf8');
    assert(/\| verify-SEL-1 \|[^\n]*\| done \|/.test(md), 'graded pass did not show as done');
    assert(/\| exec-SEL-1 \|[^\n]*\| 2\/2 after rescue \|/.test(md), 'attempts after a rescue not shown as "2/2 after rescue"');
    assert(/collect|grade verify-SEL-1/.test(md.split('## Next edges')[1] || ''), 'Next edges missing');
    assert(!/\| 0 \| 0 \|/.test(md), 'unknown tokens were written as zero');
    assert(existsSync(join(gd, '_GRADES.json')), 'no _GRADES.json');
  });
  check('review-diff + _GRAPH: a disagreeing blind review waits on a human; a priorNote-only file is not a review', () => {
    writeFileSync(join(gd, '_VERDICTS-review-SEL-1.json'), JSON.stringify({ ticket: 'SEL-1', cases: [{ caseId: 'TC-1', verdict: 'FAIL', why: 'body never compared' }], ticketVerdict: 'FAIL' }));
    writeFileSync(join(gd, '_VERDICTS-verify-SEL-1.json'), JSON.stringify({ ticket: 'SEL-1', priorNote: { status: 'rejected', field: 'results[caseId=TC-1].evidence.httpStatus', actual: '200' } }));
    const r = run('review-diff.mjs', ['--project', 'selftest', '--run', RUN, '--reports-dir', rd]);
    mustAccept(r, 'review-diff (informational, always exit 0)');
    assert(/≠ SEL-1/.test(r.stdout) && /TC-1\s+ledger PASS\s+review FAIL/.test(r.stdout) && !/verify-SEL-1|unreadable/.test(r.stdout), `review-diff output:\n${r.stdout}`);
    mustAccept(run('gen-graph.mjs', ['--project', 'selftest', '--run', RUN, '--reports-dir', rd]), 'gen-graph');
    const md = readFileSync(join(rd, `_GRAPH-${RUN}.md`), 'utf8');
    assert(/## Blind review vs ledger[\s\S]*\*\*SEL-1\*\* \(review-SEL-1\): ⚠[^\n]*TC-1 PASS→FAIL/.test(md), 'Blind review section missing the disagreement');
    assert(/\*\*Waiting on a human[^\n]*\n[\s\S]*blind review \(review-SEL-1\) disagrees/.test(md), 'the disagreement is not waiting on a human');
  });
  check('review-diff: a FAIL on a descoped case and a case the ledger never had wait on a human; a PASS on a descoped case agrees; planVsAc doubts are listed', () => {
    const d5 = join(TMP, 'node-graph-descoped');
    mkdirSync(d5, { recursive: true });
    const ledger = { tickets: [{ id: 'SEL-5', verdict: 'PASS', cases: [{ caseId: 'TC-1', verdict: 'PASS' }], descopedCases: [{ caseId: 'TC-2', verdict: 'OBSERVED' }, { caseId: 'TC-3', verdict: 'OBSERVED' }] }] };
    const put = (cases) => writeFileSync(join(d5, '_VERDICTS-review-SEL-5.json'), JSON.stringify({ ticket: 'SEL-5', ticketVerdict: 'PASS', cases }));
    put([{ caseId: 'TC-1', verdict: 'PASS' }, { caseId: 'TC-2', verdict: 'PASS' }, { caseId: 'TC-3', verdict: 'NOT_TESTED' }]);
    let [r] = reviewDiffs(d5, ledger);
    assert(r && !reviewDisagrees(r), `a PASS on a descoped case was a disagreement: ${r && describeReview(r)}`);
    put([{ caseId: 'TC-1', verdict: 'PASS', planVsAc: 'AC-2 says escaped; the plan accepts a refusal' }, { caseId: 'TC-2', verdict: 'FAIL', why: 'theme missing' }, { caseId: 'TC-9', verdict: 'PASS' }]);
    [r] = reviewDiffs(d5, ledger);
    const s = describeReview(r);
    assert(reviewDisagrees(r) && /TC-2 DESCOPED→FAIL/.test(s) && /no record of: TC-9/.test(s) && /plan vs AC: TC-1/.test(s), `descoped/extra/doubt not surfaced: ${s}`);
  });
  check('runStatus: a scope question waits on a human with its own words, not a generic "for PM" label', () => {
    const q = 'For Mike (via the client QA, due 16 Oct): who locks historical data, the QA/QC Analyst or the legacy QC Publisher? '.repeat(2);
    const { human } = runStatus({ ledger: { tickets: [{ id: 'SEL-7', verdict: 'FAIL', scopeQuestion: q }, { id: 'SEL-8', verdict: 'PASS' }] } });
    assert(human.length === 1 && human[0].startsWith('SEL-7 — FAIL · scope question: For Mike (via the client QA') && !/for PM/.test(human[0]), `waiting line: ${human}`);
    assert(human[0].length < 160 && human[0].endsWith('…'), `a long question is not clipped: ${human[0].length} chars`);
  });
  check('qa-gates runs R-19 when handoffs exist and fails on a bad one', () => {
    // own reports dir with no ledger, so R-19 is the only gate that runs
    const rd2 = join(TMP, 'node-graph-gates');
    mkdirSync(join(rd2, `${RUN}-graph`, 'handoffs'), { recursive: true });
    writeFileSync(join(rd2, `${RUN}-graph`, 'handoffs', 'exec-SEL-1.md'), 'Looks good to me!');
    mustReject(run('qa-gates.mjs', ['--project', 'selftest', '--run', RUN, '--reports-dir', rd2]), 'R-19 handoffs FAILED', 'qa-gates R-19');
    writeFileSync(join(rd2, `${RUN}-graph`, 'handoffs', 'exec-SEL-1.md'), block({ node: 'exec-SEL-1' }));
    mustAccept(run('qa-gates.mjs', ['--project', 'selftest', '--run', RUN, '--reports-dir', rd2]), 'qa-gates R-19');
  });
  check('a handoff in the trace with no handoff file grades NO-VERDICT, and qa-gates does not skip R-19 for it', () => {
    const rd4 = join(TMP, 'node-graph-missing');
    mkdirSync(rd4, { recursive: true });
    const ev4 = (a) => run('graph-event.mjs', ['--project', 'selftest', '--run', RUN, '--reports-dir', rd4, ...a]);
    mustAccept(ev4(['--node', 'exec-SEL-3', '--event', 'dispatched']), 'dispatch');
    mustAccept(ev4(['--node', 'exec-SEL-3', '--event', 'handoff']), 'handoff');
    mustReject(run('handoff-grade.mjs', ['--project', 'selftest', '--run', RUN, '--reports-dir', rd4]), 'handoffs/exec-SEL-3.md does not exist', 'handoff-grade, missing file');
    mustReject(run('qa-gates.mjs', ['--project', 'selftest', '--run', RUN, '--reports-dir', rd4]), 'R-19 handoffs FAILED', 'qa-gates, missing handoff file');
  });
  check('qa-gates: no R-19 row on a legacy run; a graph dir without handoffs is a named skip', () => {
    const rd3 = join(TMP, 'node-graph-legacy');
    mkdirSync(rd3, { recursive: true });
    const legacy = run('qa-gates.mjs', ['--project', 'selftest', '--run', RUN, '--reports-dir', rd3]);
    assert(!/R-19/.test(legacy.stdout + legacy.stderr), `a legacy run shows R-19:\n${legacy.stdout}`);
    mkdirSync(join(rd3, `${RUN}-graph`), { recursive: true });
    const empty = run('qa-gates.mjs', ['--project', 'selftest', '--run', RUN, '--reports-dir', rd3]);
    assert((empty.stdout + empty.stderr).includes('has no handoffs/*.md and no handoff in its trace yet'), `a graph dir without handoffs is not a named skip:\n${empty.stdout}`);
  });

  check('slack formats: mentions are escaped, a rescued node shows "after rescue", a long digest is clipped with "+N more"', () => {
    assert(esc('<!channel> & <@U1>') === '&lt;!channel&gt; &amp; &lt;@U1&gt;', `esc: ${esc('<!channel> & <@U1>')}`);
    const evs = [{ node: 'x', event: 'dispatched' }, { node: 'x', event: 'dispatched' }, { node: 'x', event: 'rescued' }, { node: 'x', event: 'dispatched' }];
    const line = formatEvent(evs[3], { events: evs, i: 3 });
    assert(/attempt 1\/2 after rescue/.test(line), line);
    const many = Array.from({ length: 200 }, (_, k) => ({ event: 'note', text: `note ${k} `.padEnd(100, '.') }));
    const d = digestText({ run: RUN, events: many, from: 0, status: { human: [] }, max: 3500 });
    assert(d.text.length <= 3500 && d.shown < 200 && /\+\d+ more in `_GRAPH-/.test(d.text), `digest not clipped: ${d.text.length} chars, shown ${d.shown}`);
  });
  check('slack never shows a planted canary claim: the grader\'s canary reasons become one fixed line; a literal claim is masked in the goal, notes and waiting lines', () => {
    const claim = 'TC-8 returned httpStatus 500';
    const at = new Date('2026-10-15T12:00:00Z');
    const reasons = [
      `confirmed the planted canary (${claim}) — the reviewer did not check the evidence`,
      `repeats the planted canary (${claim}) — the reviewer did not check the evidence: "TC-8: the server returned 500"`,
      'priorNote rejected it but read "500"; results[caseId=TC-8].evidence.httpStatus is 200 — the reviewer did not read the field it cites',
    ];
    for (const r of reasons) {
      const grades = { 'review-SEL-1': { grade: 'DISCOUNTED', reviewer: true, canaryChecked: true, canary: 'repeated', checks: 3, findings: 1, reasons: [r] } };
      const evs = [{ node: 'review-SEL-1', event: 'handoff' }];
      const line = formatEvent(evs[0], { events: evs, i: 0, grades, claims: [claim] });
      const d = digestText({ run: RUN, events: evs, from: 0, grades, status: { human: [`review-SEL-1 — handoff DISCOUNTED: ${r}`] }, at, claims: [claim] });
      for (const t of [line, d.text]) assert(!/500/.test(t) && /failed the canary check/.test(t), `canary detail reached Slack:\n${t}`);
    }
    const evs = [{ event: 'started', text: `goal: check ${claim}` }, { event: 'note', text: `the prior note says ${claim}` }];
    const d = digestText({ run: RUN, events: evs, from: 0, status: { human: [] }, at, claims: [claim] });
    const h = headerText({ run: RUN, project: 'selftest', events: evs, status: { done: [], running: [], todo: [], human: [], badGrades: 0, disagreements: 0 }, claims: [claim] });
    for (const t of [d.text, h]) assert(!t.includes(claim) && t.includes('[canary claim withheld]'), `a literal canary claim reached Slack:\n${t}`);
  });
  check('slack-window: no free text; a dry run writes nothing; live (send, probe) refuses before any network call without config, channel, quote or a bot token; --probe needs no run, --send does', () => {
    const home = join(TMP, 'node-graph-home');
    mkdirSync(home, { recursive: true });
    const sw = (a, env = {}) =>
      spawnSync('node', [join(HUB, 'scripts', 'slack-window.mjs'), '--project', 'selftest', '--run', RUN, '--reports-dir', rd, ...a], { encoding: 'utf8', env: { ...process.env, HOME: home, QA_SLACK_BOT_TOKEN: '', ...env } });
    const cfg = (o) => { writeFileSync(join(home, 'cfg.json'), JSON.stringify(o)); return ['--send', '--config', join(home, 'cfg.json')]; };
    const one = (c) => ({ projects: { selftest: c } });
    const ok = { channelId: 'C0SELFTEST1', authorizedBy: 'selftest', authorizedQuote: 'selftest only' };
    mustReject(sw(['--text', 'hello']), '--text is not accepted', 'slack-window --text');
    mustReject(sw(['--send', '--replies']), 'separate steps', 'slack-window --send --replies');
    mustReject(sw(['--probe', '--send']), 'separate steps', 'slack-window --probe --send');
    const dry = sw([]);
    mustAccept(dry, 'slack-window dry run');
    assert(/DRY RUN/.test(dry.stdout) && /one reply/.test(dry.stdout) && !existsSync(join(gd, '_SLACK.json')), `dry run wrote state or printed no reply:\n${dry.stdout.slice(0, 400)}`);
    mustReject(sw(['--send', '--config', join(home, 'missing.json')]), 'no readable config', 'slack-window, no config');
    mustReject(sw(cfg(ok)), 'has no channel for project "selftest"', 'slack-window, flat single-channel config used for every project');
    mustReject(sw(cfg({ projects: { other: ok } })), 'has no channel for project "selftest"', 'slack-window, no channel for this project');
    mustReject(sw(cfg(one({ ...ok, channelId: '#qa-agents-test' }))), 'needs a channelId', 'slack-window, channel name instead of id');
    mustReject(sw(cfg(one({ channelId: 'C0SELFTEST1', authorizedBy: 'selftest' }))), 'authorizedQuote', 'slack-window, no recorded quote');
    mustReject(sw(cfg({ projects: { selftest: ok, other: { ...ok } } })), 'one channel per project', 'slack-window, one channel set for two projects');
    mustReject(sw(cfg(one(ok))), 'no bot token', 'slack-window, no token');
    mustReject(sw(cfg(one(ok)), { QA_SLACK_BOT_TOKEN: 'xoxp-a-user-token' }), 'no bot token', 'slack-window, user token');
    mustReject(sw(['--probe', '--config', join(home, 'missing.json')]), 'no readable config', 'slack-window --probe, no config');
    mustReject(sw([...cfg(one(ok)).slice(1), '--probe'], { QA_SLACK_BOT_TOKEN: 'xoxp-a-user-token' }), 'no bot token', 'slack-window --probe, user token');
    // --probe checks a project's chat before that project has any run; everything else still needs --run
    const swp = (a) => spawnSync('node', [join(HUB, 'scripts', 'slack-window.mjs'), '--project', 'selftest', ...a], { encoding: 'utf8', env: { ...process.env, HOME: home, QA_SLACK_BOT_TOKEN: '' } });
    mustReject(swp(['--probe', '--config', join(home, 'missing.json')]), 'no readable config', 'slack-window --probe without a run, no config');
    mustReject(swp([...cfg(one(ok)).slice(1), '--probe']), 'no bot token', 'slack-window --probe without a run, no token');
    mustReject(swp([...cfg({ projects: { other: ok } }).slice(1), '--probe']), 'has no channel for project "selftest"', 'slack-window --probe without a run, another project\'s channel');
    mustReject(swp([]), 'usage', 'slack-window, neither --run nor --probe');
    mustReject(swp(cfg(one(ok))), 'usage', 'slack-window --send without a run');
    // a run of another project: its ledger names that project, or its ticket ids lack this profile's prefix
    const rd6 = join(TMP, 'node-graph-slack-other');
    mkdirSync(join(rd6, `${RUN}-graph`), { recursive: true });
    writeFileSync(join(rd6, `${RUN}-graph`, '_EVENTS.jsonl'), JSON.stringify({ t: '2026-10-15T00:00:00Z', event: 'started', node: 'manager', text: 'selftest' }) + '\n');
    writeFileSync(join(rd6, `_LEDGER-${RUN}.json`), JSON.stringify({ runId: RUN, project: 'other', tickets: [{ id: 'SEL-1', verdict: 'PASS', cases: [] }] }));
    // empty token: a missing guard ends on "no bot token" (wrong reason, so the check fails) and never reaches the network
    const sw6 = (a, project = 'selftest') => spawnSync('node', [join(HUB, 'scripts', 'slack-window.mjs'), '--project', project, '--run', RUN, '--reports-dir', rd6, ...a], { encoding: 'utf8', env: { ...process.env, HOME: home, QA_SLACK_BOT_TOKEN: '' } });
    mustReject(sw6(cfg(one(ok))), 'ledger is for other', 'slack-window, a run whose ledger names another project');
    // any real profile with a ticket prefix: the selftest's SEL-1 run must not post to that project's channel
    const real = readdirSync(join(HUB, 'profiles')).filter((f) => f.endsWith('.json')).map((f) => [f.slice(0, -5), (() => { try { return JSON.parse(readFileSync(join(HUB, 'profiles', f), 'utf8'))?.linear?.prefix; } catch { return null; } })()]).find(([, px]) => px && px !== 'SEL');
    if (real) {
      writeFileSync(join(rd6, `_LEDGER-${RUN}.json`), JSON.stringify({ runId: RUN, tickets: [{ id: 'SEL-1', verdict: 'PASS', cases: [] }] }));
      mustReject(sw6(cfg({ projects: { [real[0]]: ok } }), real[0]), `not ${real[1]}-`, `slack-window, SEL-1 posted to ${real[0]}'s channel`);
    }
    assert(!existsSync(join(gd, '_SLACK.json')), 'a refused send wrote Slack state');
  });

  // ── option 1: thread replies are read at each send, kept as data, decided only by the user's words ──
  check('slack replies: pure functions — echo detection, decided/pending split, bookkeeping problems, count-only Slack lines', () => {
    const d = join(TMP, 'node-graph-replies-pure', `${RUN}-graph`);
    mkdirSync(d, { recursive: true });
    const r1 = { ts: '1760000010.000100', user: 'U0HUMAN1', text: 'the backend dev: TC-1 is out of scope for this sprint', readAt: '2026-10-15T10:00:00.000Z', note: 'input' };
    const r2 = { ts: '1760000011.000100', user: 'U0HUMAN2', text: 'why is GAM-114 waiting?', readAt: '2026-10-15T10:00:00.000Z', note: 'input' };
    writeFileSync(join(d, '_SLACK-REPLIES.jsonl'), [r1, r2].map((r) => JSON.stringify(r)).join('\n') + '\n');
    assert(quoteEchoes(r1.text, [r1]) && quoteEchoes(`ok: ${r1.text}`, [r1]) && quoteEchoes('TC-1 is out of scope for this', [r1]), 'an echoed reply was not caught');
    assert(quoteEchoes('yes, mark it out of scope', [r1]) === null, 'the user\'s own short answer was taken for an echo');
    // the usual ways around an exact match: case, punctuation, a dropped word, invisible characters, look-alike
    // (fullwidth) letters, HTML entities, and a short reply with a word added
    const zw = r1.text.split(' ').join('\u200b ');
    const fw = 'ＴＣ-1 is out of scope for this sprint';
    for (const q of [r1.text.toUpperCase(), r1.text.replace(/:/g, ' —').replace(/ /g, '  '), 'the backend dev TC-1 is out of scope for sprint', zw, fw])
      assert(quoteEchoes(q, [r1]), `an echo got through: ${JSON.stringify(q)}`);
    const amp = { ts: '1760000012.000100', user: 'U0HUMAN1', text: 'R&amp;D said TC-1 is fine' };
    assert(quoteEchoes('R&D said TC-1 is fine', [amp]) && quoteEchoes('r & d said tc 1 is fine!', [amp]), 'an entity-encoded reply got through');
    const short = { ts: '1760000013.000100', user: 'U0HUMAN1', text: 'skip TC-4' };
    assert(quoteEchoes('skip TC-4 please', [short]) && quoteEchoes('ok skip tc-4', [short]), 'a short reply with a word added got through');
    assert(quoteEchoes('yes, skip it this sprint', [short]) === null && quoteEchoes('no', [short]) === null, 'a real short answer was taken for an echo');
    // an edited reply: the quote may echo neither version
    assert(quoteEchoes('TC-1 is out of scope for this sprint', [{ ...r2, versions: [r1.text, r2.text] }]), 'an earlier version of an edited reply was not checked');
    // the decision text goes to Slack: it may carry neither a reply nor the quote
    assert(decisionTextEchoes(r1.text, 'yes do it', [r1]) && decisionTextEchoes('the user said: keep it in scope, I will ask the client QA', 'keep it in scope, I will ask the client QA', [r1]), 'a decision text that repeats the reply or the quote got through');
    assert(decisionTextEchoes('TC-1 marked out of scope', 'yes, mark it out of scope', [r1]) === null, 'a short decision text in the manager\'s words was refused');
    const good = { t: '2026-10-15T10:05:00.000Z', event: 'note', ref: `slack:${r1.ts}`, text: 'TC-1 marked out of scope', quote: 'yes, mark it out of scope' };
    let s = slackReplyStatus(d, [good]);
    assert(s.decided.length === 1 && s.pending.length === 1 && s.pending[0].ts === r2.ts && !s.problems.length, `split: ${JSON.stringify(s)}`);
    const bad = [
      [{ ...good, quote: r1.text }, 'but'],
      [{ ...good, quote: undefined }, "without the user's words"],
      [{ ...good, event: 'next' }, 'is a note'],
      [{ ...good, ref: 'slack:1760000099.000100' }, 'not in _SLACK-REPLIES.jsonl'],
      [{ ...good, ref: 'slack:abc' }, 'malformed ref'],
      [{ ...good, ref: undefined }, 'has a quote but no slack:<ts> ref'],
      [{ ...good, t: '2026-10-15T09:00:00.000Z' }, 'before that reply was read'],
      [{ ...good, t: undefined }, 'no valid ISO time'],
      [{ ...good, t: 'yesterday' }, 'no valid ISO time'],
      [{ ...good, text: r1.text }, 'the decision text repeats a Slack reply'],
      [{ ...good, text: `noted: ${good.quote}` }, 'the decision text repeats the quote'],
    ];
    for (const [ev, needle] of bad) {
      s = slackReplyStatus(d, [ev]);
      assert(s.problems.some((p) => p.includes(needle)), `no "${needle}" problem for ${JSON.stringify(ev)}: ${JSON.stringify(s.problems)}`);
    }
    s = slackReplyStatus(d, [good, { ...good, t: '2026-10-15T10:06:00.000Z' }]);
    assert(s.problems.some((p) => p.includes('a second time')) && s.decided[0].decision.i === 0, 'a second decision was not a problem, or replaced the first');
    writeFileSync(join(d, '_SLACK-REPLIES.jsonl'), JSON.stringify(r1) + '\nnot json\n' + JSON.stringify({ ts: r1.ts, user: 'U', text: 'x', readAt: r1.readAt }) + '\n');
    s = slackReplyStatus(d, []);
    assert(s.problems.length === 2 && s.problems.some((p) => p.includes('repeats reply')), `a malformed / repeated reply row was not a problem: ${JSON.stringify(s.problems)}`);
    // a row without an ISO readAt cannot order decisions, so it is a problem, not a reply
    writeFileSync(join(d, '_SLACK-REPLIES.jsonl'), JSON.stringify({ ...r1, readAt: undefined }) + '\n' + JSON.stringify({ ...r2, readAt: '15 Oct' }) + '\n');
    s = slackReplyStatus(d, [good]);
    assert(s.replies.length === 0 && s.problems.filter((p) => p.includes('no ISO readAt')).length === 2, `rows without readAt: ${JSON.stringify(s)}`);
    // edits and deletions: an edit after the decision makes the reply wait again; a deleted reply no longer waits
    const edit = { ts: r1.ts, user: r1.user, text: 'the backend dev: actually TC-1 stays in', readAt: '2026-10-15T11:00:00.000Z', edit: true, note: 'input' };
    const gone = { ts: r2.ts, user: r2.user, text: '', readAt: '2026-10-15T11:00:00.000Z', deleted: true, note: 'deleted' };
    writeFileSync(join(d, '_SLACK-REPLIES.jsonl'), [r1, r2, edit, gone].map((r) => JSON.stringify(r)).join('\n') + '\n');
    s = slackReplyStatus(d, [good]);
    assert(!s.problems.length && s.replies.length === 2 && s.replies[0].versions.length === 2 && s.decided.length === 0 && s.pending.length === 1 && s.pending[0].editedAfterDecision && s.deleted.length === 1, `after an edit and a deletion: ${JSON.stringify(s)}`);
    const again = { ...good, t: '2026-10-15T11:05:00.000Z', text: 'TC-1 kept in scope', quote: 'fine, keep it then' };
    s = slackReplyStatus(d, [good, again]);
    assert(!s.problems.length && s.decided.length === 1 && s.decided[0].decision.i === 1 && !s.pending.length, `a new decision on the edited reply: ${JSON.stringify(s)}`);
    s = slackReplyStatus(d, [good, again, { ...again, t: '2026-10-15T11:06:00.000Z' }]);
    assert(s.problems.some((p) => p.includes('a second time')), 'a third decision after the edit was not a problem');
    s = slackReplyStatus(d, [good, { ...again, t: '2026-10-15T10:30:00.000Z' }]);
    assert(s.problems.some((p) => p.includes('before its edit was read')), 'a second decision before the edit was read was not a problem');
    assert(slackReplyStatus(d, [{ ...good, quote: 'the backend dev: TC-1 is out of scope for this sprint' }]).problems.some((p) => p.includes('repeats a Slack reply')), 'the old version of an edited reply was not checked against the quote');
    writeFileSync(join(d, '_SLACK-REPLIES.jsonl'), JSON.stringify({ ...edit, ts: '1760000077.000100' }) + '\n');
    assert(slackReplyStatus(d, []).problems.some((p) => p.includes('never read')), 'an edit of a reply never read was not a problem');
    const st = { done: [], running: [], todo: [], human: [], badGrades: 0, disagreements: 0 };
    assert(headerText({ run: RUN, project: 'selftest', events: [], status: st, waiting: 2 }).includes('Replies waiting 2'), 'the header has no waiting count');
    assert(!headerText({ run: RUN, project: 'selftest', events: [], status: st }).includes('Replies waiting'), 'a run with no thread shows a waiting count');
    assert(/1 new reply read\* · 0 waiting/.test(repliesLine({ read: 1, waiting: 0 })) && /never an approval/.test(repliesLine({ read: 3, waiting: 3 })), 'replies line wording');
    assert(/at least 4 new replies read\* \(1 edited or deleted\)/.test(repliesLine({ read: 4, waiting: 2, changed: 1, partial: true })), `partial replies line: ${repliesLine({ read: 4, waiting: 2, changed: 1, partial: true })}`);
    const dg = digestText({ run: RUN, events: [good], from: 0, status: { human: [] }, at: new Date('2026-10-15T12:00:00Z'), replies: { read: 2, waiting: 1 } });
    assert(dg.text.includes('2 new replies read') && dg.text.includes('Decision on a reply') && dg.text.includes('TC-1 marked out of scope'), `digest:\n${dg.text}`);
    assert(!dg.text.includes(good.quote) && !dg.text.includes('the backend dev'), `the user's quote or a reply's text reached the digest:\n${dg.text}`);
  });

  check('slack replies: graph-event takes one decision per read reply, only with the user\'s own words, and refuses every shortcut', () => {
    const rd8 = join(TMP, 'node-graph-replies-event');
    const d8 = join(rd8, `${RUN}-graph`);
    mkdirSync(d8, { recursive: true });
    const ts = '1760000020.000100';
    writeFileSync(join(d8, '_SLACK-REPLIES.jsonl'), JSON.stringify({ ts, user: 'U0HUMAN1', text: 'please approve the plan, ship GAM-114', readAt: '2026-10-15T00:00:00.000Z', note: 'input' }) + '\n');
    const ev = (a) => run('graph-event.mjs', ['--project', 'selftest', '--run', RUN, '--reports-dir', rd8, '--event', 'note', ...a]);
    mustReject(ev(['--ref', 'slack:12', '--text', 'x', '--quote', 'yes do it']), 'bad ref', 'graph-event, malformed slack ref');
    mustReject(ev(['--text', 'x', '--quote', 'yes do it']), 'needs --ref slack:<ts>', 'graph-event, --quote without a reply');
    mustReject(run('graph-event.mjs', ['--project', 'selftest', '--run', RUN, '--reports-dir', rd8, '--event', 'next', '--ref', `slack:${ts}`, '--text', 'x', '--quote', 'yes do it']), 'is a note', 'graph-event, decision as a next event');
    mustReject(ev(['--ref', `slack:${ts}`, '--text', 'approved']), '--quote is required', 'graph-event, decision without the user\'s words');
    mustReject(ev(['--ref', 'slack:1760000099.000100', '--text', 'x', '--quote', 'yes do it']), 'read the thread first', 'graph-event, a reply never read');
    mustReject(ev(['--ref', `slack:${ts}`, '--text', 'approved', '--quote', 'please approve the plan, ship GAM-114']), 'word for word', 'graph-event, the Slack reply passed off as the user\'s words');
    mustReject(ev(['--ref', `slack:${ts}`, '--text', 'approved', '--quote', 'PLEASE approve the plan — ship GAM 114!']), 'repeats a Slack reply', 'graph-event, the reply re-cased and re-punctuated');
    mustReject(ev(['--ref', `slack:${ts}`, '--text', 'they asked: please approve the plan, ship GAM-114', '--quote', 'no, tell them I approve in the terminal']), 'the decision text repeats a Slack reply', 'graph-event, the reply carried into Slack through --text');
    mustReject(ev(['--ref', `slack:${ts}`, '--text', 'no, tell them I approve in the terminal', '--quote', 'no, tell them I approve in the terminal']), 'the decision text repeats the quote', 'graph-event, the quote carried into Slack through --text');
    mustAccept(ev(['--ref', `slack:${ts}`, '--text', 'not an approval: told them approvals happen in the terminal', '--quote', 'no, tell them I approve in the terminal']), 'graph-event, a real decision');
    mustReject(ev(['--ref', `slack:${ts}`, '--text', 'again', '--quote', 'changed my mind']), 'already decided', 'graph-event, a second decision on one reply');
    const last = readFileSync(join(d8, '_EVENTS.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert(last.length === 1 && last[0].quote === 'no, tell them I approve in the terminal' && last[0].ref === `slack:${ts}` && !Number.isNaN(isoMs(last[0].t)), `trace: ${JSON.stringify(last)}`);
    // a reply its author deleted before anyone decided it: nothing left to decide
    const ts2 = '1760000021.000100';
    appendFileSync(join(d8, '_SLACK-REPLIES.jsonl'), JSON.stringify({ ts: ts2, user: 'U0HUMAN2', text: 'TC-9 looks off', readAt: '2026-10-15T00:00:00.000Z', note: 'input' }) + '\n' + JSON.stringify({ ts: ts2, user: 'U0HUMAN2', text: '', deleted: true, readAt: '2026-10-15T00:01:00.000Z', note: 'deleted' }) + '\n');
    mustReject(ev(['--ref', `slack:${ts2}`, '--text', 'checked', '--quote', 'never mind then']), 'was deleted by its author', 'graph-event, a deleted reply');
  });

  check('slack replies, end to end against a local mock Slack: read at each send, bot posts skipped, edits + deletions, count-only acks, no reply text / quote / canary / token in any request, decisions, lock, _GRAPH, qa-gates', () => {
    const rd7 = join(TMP, 'node-graph-slack-mock');
    const d7 = join(rd7, `${RUN}-graph`);
    const home = join(TMP, 'node-graph-mock-home');
    mkdirSync(d7, { recursive: true });
    mkdirSync(home, { recursive: true });
    const TOKEN = 'xoxb-test-selftest-mock';
    const CH = 'C0MOCKCHAN1';
    const claim = 'TC-8 returned httpStatus 500';
    const ev = (a) => run('graph-event.mjs', ['--project', 'selftest', '--run', RUN, '--reports-dir', rd7, ...a]);
    mustAccept(ev(['--event', 'started', '--node', 'manager', '--text', 'selftest run <!channel> ping']), 'started');
    mustAccept(ev(['--event', 'dispatched', '--node', 'exec-SEL-1']), 'dispatched');
    mustAccept(ev(['--event', 'note', '--text', `the prior note says ${claim}`]), 'canary note');
    writeFileSync(join(d7, '_CANARY.json'), JSON.stringify({ tickets: { 'SEL-1': { claim, refutedBy: { field: 'results[caseId=TC-8].evidence.httpStatus', actual: 200 }, patterns: ['500'] } } }));
    const cfgp = join(home, 'cfg.json');
    writeFileSync(cfgp, JSON.stringify({ projects: { selftest: { channelId: CH, channelName: 'mock chat', authorizedBy: 'selftest', authorizedQuote: 'selftest only' } } }));
    const away = join(home, 'cfg-away.json');
    writeFileSync(away, JSON.stringify({ projects: { selftest: { channelId: 'C0NOTJOINED', authorizedBy: 'selftest', authorizedQuote: 'selftest only' } } }));
    const realHome = join(TMP, 'node-graph-mock-realtoken');
    mkdirSync(join(realHome, '.config', 'qa-hub'), { recursive: true });
    // a real-looking bot token in the file: a mock run must never fall back to it (the file is not even opened)
    writeFileSync(join(realHome, '.config', 'qa-hub', 'slack-bot-token'), 'xoxb-1111-2222-realLookingFileToken\n');
    const SW = 'scripts/slack-window.mjs';
    const base = ['--project', 'selftest', '--run', RUN, '--reports-dir', rd7, '--config', cfgp];
    const GE = ['scripts/graph-event.mjs', '--project', 'selftest', '--run', RUN, '--reports-dir', rd7, '--event', 'note'];
    const R1 = 'the backend dev: TC-1 is out of scope <!here> for this sprint';
    const R2 = 'broadcast: GAM-114 retest after the deploy please';
    const R3 = 'one more: TC-4 too?';
    const R4 = 'ping: is SEL-1 done after lunch?';
    const scenario = {
      token: TOKEN,
      bot: { user_id: 'U0BOTSELF', user: 'qa_hub_bot', team: 'Selftest', bot_id: 'B0BOTSELF' },
      channels: [CH],
      pageSize: 2, // forces conversations.replies paging
      env: { HOME: home },
      steps: [
        { label: 'send1', cmd: [SW, ...base, '--send'] },
        {
          label: 'send2',
          inject: [
            { label: 'r1', user: 'U0HUMAN1', text: R1, user_profile: { display_name: 'the backend dev' } },
            { user: 'U0BOTSELF', bot_id: 'B0BOTSELF', text: 'the bot\'s own post' },
            { user: 'U0OTHERBOT', bot_id: 'B0OTHER', text: 'another bot' },
            { user: 'U0HUMAN3', subtype: 'channel_join', text: 'joined' },
            { label: 'r2', user: 'U0HUMAN2', subtype: 'thread_broadcast', text: R2, files: [{ id: 'F1' }] },
          ],
          cmd: [SW, ...base, '--send'],
        },
        { label: 'send3', cmd: [SW, ...base, '--send'] },
        { label: 'replies', inject: [{ label: 'r3', user: 'U0HUMAN1', text: R3 }], cmd: [SW, ...base, '--replies'] },
        // a crash that lost the cursor: everything on file is known, nothing is written twice
        { label: 'reread', writeJson: { path: join(d7, '_SLACK.json'), merge: { repliesCursor: null } }, cmd: [SW, ...base, '--replies'] },
        { label: 'decide', cmd: [...GE, '--ref', 'slack:{{ts:r1}}', '--text', 'TC-1 left in scope for now', '--quote', 'keep it in scope, I will ask the client QA'] },
        { label: 'send4', inject: [{ label: 'r4', user: 'U0HUMAN2', text: R4 }], cmd: [SW, ...base, '--send'] },
        { label: 'change', edit: [{ label: 'r3', text: 'one more: TC-4 and TC-5 too?' }], remove: ['r2'], cmd: [SW, ...base, '--replies'] },
        { label: 'edit-decided', edit: [{ label: 'r1', text: 'the backend dev: TC-1 back in scope after all' }], cmd: [SW, ...base, '--replies'] },
        { label: 'decide2', cmd: [...GE, '--ref', 'slack:{{ts:r1}}', '--text', 'TC-1 confirmed in scope', '--quote', 'good, confirm it stays'] },
        { label: 'probe', cmd: [SW, '--project', 'selftest', '--config', cfgp, '--probe'] },
        { label: 'probe-away', cmd: [SW, '--project', 'selftest', '--config', away, '--probe'] },
        { label: 'real-token', cmd: [SW, ...base, '--send'], env: { HOME: realHome, QA_SLACK_BOT_TOKEN: '' } },
        { label: 'not-test-token', cmd: [SW, ...base, '--send'], env: { QA_SLACK_BOT_TOKEN: 'xoxb-selftest-not-marked-as-test' } },
        { label: 'newline-token', cmd: [SW, ...base, '--send'], env: { QA_SLACK_BOT_TOKEN: 'xoxb-test-half\nother-half' } },
        { label: 'remote-base', cmd: [SW, ...base, '--send'], env: { QA_SLACK_API_BASE: 'https://slack.com.example/api' } },
        { label: 'http-remote', cmd: [SW, ...base, '--send'], env: { QA_SLACK_API_BASE: 'http://192.0.2.1:9/api' } },
        { label: 'http-lookalike', cmd: [SW, ...base, '--send'], env: { QA_SLACK_API_BASE: 'http://127.0.0.1.example/api' } },
      ],
    };
    const scp = join(home, 'scenario.json');
    writeFileSync(scp, JSON.stringify(scenario));
    const h = spawnSync('node', [join(HUB, 'scripts', 'selftest', 'slack-mock.mjs'), scp], { encoding: 'utf8', timeout: 180000 });
    assert(h.status === 0, `mock harness failed (${h.status}): ${h.stderr.slice(0, 600)}`);
    const out = JSON.parse(h.stdout);
    const S = Object.fromEntries(out.steps.map((s) => [s.label, s]));
    const calls = (s) => s.requests.map((r) => r.method);
    const said = (s) => `${s.label} (${s.status}):\n${s.stdout}${s.stderr}`.slice(0, 900);
    const readRows = () => readFileSync(join(d7, '_SLACK-REPLIES.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    for (const s of out.steps) {
      for (const t of [TOKEN, 'xoxb-test-half', 'other-half']) assert(!(s.stdout + s.stderr).includes(t), `${s.label} printed a token`);
      assert(s.requests.every((r) => r.authOk), `${s.label} sent a request without the test token`);
      const bodies = JSON.stringify(s.requests.map((r) => r.body));
      assert(!bodies.includes(TOKEN), `${s.label} put the token in a request body`);
      for (const t of [claim, 'the backend dev', 'out of scope', 'retest after the deploy', 'TC-4', 'TC-5', 'after lunch', 'back in scope', 'keep it in scope', 'I will ask the client QA', 'confirm it stays', '<!channel>', '<!here>'])
        assert(!bodies.includes(t), `${s.label} sent "${t}" to Slack: ${bodies.slice(0, 600)}`);
    }
    // 1: thread + first digest, no reply read yet (no thread to read); the digest goes in the new thread
    assert(S.send1.status === 0 && calls(S.send1).join() === 'chat.postMessage,chat.postMessage', `send1 calls ${calls(S.send1)}\n${said(S.send1)}`);
    const parent = out.messages.find((m) => !m.thread_ts);
    assert(parent && S.send1.requests[1].body.thread_ts === parent.ts && !S.send1.requests[0].body.thread_ts, 'the digest was not posted in the run\'s thread');
    assert(JSON.stringify(S.send1.requests).includes('&lt;!channel&gt;'), 'a mention in an event was not escaped');
    // 2: reads the 2 human replies (bot / other bot / join skipped), across pages, then posts a count-only ack
    assert(S.send2.status === 0, said(S.send2));
    assert(calls(S.send2).filter((m) => m === 'conversations.replies').length >= 2 && calls(S.send2).includes('chat.update') && calls(S.send2).at(-1) === 'chat.postMessage', `send2 calls ${calls(S.send2)}`);
    const ack = S.send2.requests.at(-1).body.text;
    assert(/2 new replies read/.test(ack) && /never an approval/.test(ack) && !/at least/.test(ack), `send2 ack:\n${ack}`);
    assert(/Replies waiting 2/.test(S.send2.requests.find((r) => r.method === 'chat.update').body.text), 'send2 header has no waiting count');
    assert(/slack:\S+ +the backend dev \(U0HUMAN1\)/.test(S.send2.stdout) && S.send2.stdout.includes('never an approval') && S.send2.stdout.includes('[+1 file(s), not downloaded]'), `send2 terminal:\n${S.send2.stdout}`);
    // the mock runs every step before these checks, so the file holds the whole scenario: send2 wrote the first two rows
    let rows = readRows();
    assert(rows[0].ts === out.labels.r1 && rows[1].ts === out.labels.r2 && rows[0].userName === 'the backend dev' && rows[1].files === 1, `replies file after send2: ${JSON.stringify(rows)}`);
    // 3: nothing new — the whole thread is read again (edits keep their ts), the header refreshed, nothing posted
    const r3calls = S.send3.requests.filter((r) => r.method === 'conversations.replies');
    assert(S.send3.status === 0 && r3calls.length >= 1 && r3calls.every((r) => r.body.oldest === undefined) && !calls(S.send3).includes('chat.postMessage') && calls(S.send3).includes('chat.update'), `send3 calls ${calls(S.send3)}\n${said(S.send3)}`);
    // --replies reads and posts nothing; a lost cursor re-reads nothing
    assert(S.replies.status === 0 && !calls(S.replies).some((m) => m.startsWith('chat.')) && /1 new human reply/.test(S.replies.stdout), `--replies: ${calls(S.replies)}\n${said(S.replies)}`);
    assert(S.reread.status === 0 && /0 new human replies/.test(S.reread.stdout), said(S.reread));
    // a decision in the user's words, then send4 reads the new reply, shows the decision (text only, never the quote) and the waiting count
    assert(S.decide.status === 0, said(S.decide));
    assert(S.send4.status === 0 && calls(S.send4).at(-1) === 'chat.postMessage', said(S.send4));
    const d4 = S.send4.requests.at(-1).body.text;
    assert(d4.includes('Decision on a reply') && d4.includes('TC-1 left in scope for now') && /1 new reply read\* · 3 waiting/.test(d4), `send4 digest:\n${d4}`);
    assert(/Replies waiting 3/.test(S.send4.requests.find((r) => r.method === 'chat.update').body.text), 'send4 header: waiting count after one decision and one new reply');
    // the author edits r3 and deletes r2: an edit row and a deleted row, nothing new
    assert(S.change.status === 0 && /0 new human replies, 2 edited or deleted/.test(S.change.stdout), said(S.change));
    rows = readRows();
    const r3edit = rows.find((r) => r.ts === out.labels.r3 && r.edit);
    assert(r3edit && r3edit.text === 'one more: TC-4 and TC-5 too?' && r3edit.editedAt && rows.some((r) => r.ts === out.labels.r2 && r.deleted), `rows after the edit + deletion: ${JSON.stringify(rows.slice(-3))}`);
    // the author edits r1 after it was decided: it waits again, and a second decision is taken
    assert(S['edit-decided'].status === 0 && /edited after its decision/.test(S['edit-decided'].stdout), said(S['edit-decided']));
    assert(S.decide2.status === 0, said(S.decide2));
    rows = readRows();
    assert(rows.every((r) => !Number.isNaN(isoMs(r.readAt))) && rows.filter((r) => !r.edit && !r.deleted).length === 4 && new Set(rows.filter((r) => !r.edit && !r.deleted).map((r) => r.ts)).size === 4, `rows: ${JSON.stringify(rows)}`);
    // probe, and the mock-only guards: none of them reaches the network
    assert(S.probe.status === 0 && /probe OK/.test(S.probe.stdout), said(S.probe));
    assert(S['probe-away'].status === 1 && /not in/.test(S['probe-away'].stderr + S['probe-away'].stdout), said(S['probe-away']));
    assert(S['real-token'].status === 2 && /real bot token/.test(S['real-token'].stderr) && !S['real-token'].requests.length, said(S['real-token']));
    assert(S['not-test-token'].status === 2 && /xoxb-test-/.test(S['not-test-token'].stderr) && !S['not-test-token'].requests.length, said(S['not-test-token']));
    assert(S['newline-token'].status === 1 && /no bot token/.test(S['newline-token'].stderr) && !S['newline-token'].requests.length, said(S['newline-token']));
    for (const l of ['remote-base', 'http-remote', 'http-lookalike'])
      assert(S[l].status === 2 && /local test server/.test(S[l].stderr) && !S[l].requests.length, said(S[l]));
    // the lock: a live holder refuses a second reader before any network call; a dead holder's lock is taken over and released
    const lock = join(d7, '_SLACK.lock');
    const swl = () => spawnSync('node', [join(HUB, SW), ...base, '--replies'], { encoding: 'utf8', env: { ...process.env, HOME: home, QA_SLACK_API_BASE: 'http://127.0.0.1:9', QA_SLACK_BOT_TOKEN: TOKEN } });
    writeFileSync(lock, String(process.pid));
    mustReject(swl(), 'another slack-window', 'slack-window, a second reader while one holds the lock');
    assert(existsSync(lock) && readFileSync(lock, 'utf8') === String(process.pid), 'a refused reader removed the live holder\'s lock');
    writeFileSync(lock, String(spawnSync('node', ['-e', '0']).pid));
    const stale = swl();
    assert(stale.status === 1 && /Slack API error/.test(stale.stderr) && !/another slack-window/.test(stale.stderr) && !(stale.stdout + stale.stderr).includes(TOKEN), `a stale lock was not taken over:\n${stale.stderr}`);
    assert(!existsSync(lock), 'the lock was not released on exit');
    // the run file and the gate
    mustAccept(run('gen-graph.mjs', ['--project', 'selftest', '--run', RUN, '--reports-dir', rd7]), 'gen-graph with Slack replies');
    let md = readFileSync(join(rd7, `_GRAPH-${RUN}.md`), 'utf8');
    const sec = () => md.slice(md.indexOf('## Slack replies'), md.indexOf('## Cost'));
    assert(md.includes("waiting for the user's decision (2)") && sec().includes('good, confirm it stays') && (sec().match(/\*\*waiting\*\*/g) || []).length === 2 && sec().includes('deleted by its author') && sec().includes('edited, 2 versions') && !sec().includes('⚠'), `_GRAPH Slack section:\n${sec()}`);
    const gate = run('qa-gates.mjs', ['--project', 'selftest', '--run', RUN, '--reports-dir', rd7]);
    mustAccept(gate, 'qa-gates, 2 replies waiting (a warning)');
    assert(/4 read · 1 decided · 2 waiting · 1 deleted by their author/.test(gate.stdout) && gate.stdout.includes(`slack:${out.labels.r3}`) && gate.stdout.includes(`slack:${out.labels.r4}`), `qa-gates Slack row:\n${gate.stdout}`);
    mustReject(run('qa-gates.mjs', ['--project', 'selftest', '--run', RUN, '--reports-dir', rd7, '--strict']), 'R-19 Slack replies FAILED', 'qa-gates --strict, replies waiting');
    // a decision appended by hand that passes off r3's FIRST version as the user's words
    appendFileSync(join(d7, '_EVENTS.jsonl'), JSON.stringify({ t: new Date().toISOString(), event: 'note', ref: `slack:${out.labels.r3}`, text: 'hand-written', quote: R3 }) + '\n');
    mustReject(run('qa-gates.mjs', ['--project', 'selftest', '--run', RUN, '--reports-dir', rd7]), 'R-19 Slack replies FAILED', 'qa-gates, a decision that echoes an earlier version of the reply');
    mustAccept(run('gen-graph.mjs', ['--project', 'selftest', '--run', RUN, '--reports-dir', rd7]), 'gen-graph with a bad decision');
    md = readFileSync(join(rd7, `_GRAPH-${RUN}.md`), 'utf8');
    assert(sec().includes('⚠') && sec().includes('repeats a Slack reply'), `_GRAPH does not show the bad decision:\n${sec()}`);
    // a backdated decision fails the gate too
    const rdb = join(TMP, 'node-graph-slack-backdated');
    const db = join(rdb, `${RUN}-graph`);
    mkdirSync(db, { recursive: true });
    writeFileSync(join(db, '_SLACK.json'), JSON.stringify({ threadTs: '1760000001.000101', channelId: CH, posted: 1, lastHuman: [], repliesCursor: null }));
    writeFileSync(join(db, '_EVENTS.jsonl'), JSON.stringify({ t: '2026-10-15T00:00:00.000Z', event: 'started', node: 'manager', text: 'selftest' }) + '\n');
    const gb = run('qa-gates.mjs', ['--project', 'selftest', '--run', RUN, '--reports-dir', rdb]);
    mustAccept(gb, 'qa-gates, a thread with no replies yet');
    assert(/0 read · 0 decided · 0 waiting/.test(gb.stdout), `qa-gates with only _SLACK.json:\n${gb.stdout}`);
    writeFileSync(join(db, '_SLACK-REPLIES.jsonl'), JSON.stringify({ ts: '1760000002.000100', user: 'U0HUMAN1', text: 'TC-2 is flaky', readAt: '2026-10-15T10:00:00.000Z', note: 'input' }) + '\n');
    appendFileSync(join(db, '_EVENTS.jsonl'), JSON.stringify({ t: '2026-10-15T09:00:00.000Z', event: 'note', ref: 'slack:1760000002.000100', text: 'rerun TC-2', quote: 'rerun it twice' }) + '\n');
    mustReject(run('qa-gates.mjs', ['--project', 'selftest', '--run', RUN, '--reports-dir', rdb]), 'R-19 Slack replies FAILED', 'qa-gates, a decision dated before its reply was read');
  });
}
