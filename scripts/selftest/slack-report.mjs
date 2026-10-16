// Selftest section for scripts/slack-report.mjs (the QA lead, 2026-10-16: results to each project's Slack channel,
// automatically; same day: "it is posting very small details — repro steps, why it is a bug, scope, and ask
// questions"). A fake reports dir + a fake profile (slug "selftest", prefix SEL, an account with an email and a
// password, a staging surface and a forbidden production host) + a valid ledger with PASS / FAIL / BLOCKED /
// NEEDS_MANUAL tickets + an analyst plan for the failing case. The checks cover the per-ticket thread replies
// (Expected / Actual / Why / numbered steps from the plan, scope, not-tested reasons), the questions reply, the
// leak guard on every raw value, and the v2 state (one message per reply, edited in place, surplus deleted).
// The review fixture (SEL-5/6/7) covers question grouping and coverage, the cases that ask nothing, link clean-up,
// masking, jargon, fail tags and stable question numbers; the mock covers a deleted reply / parent and --reset.
// Live checks run against the local mock Slack (scripts/selftest/slack-mock.mjs) with a test token; the
// dry-run and refusal checks need no network at all. HOME points into the sandbox.

import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const RUN = 'R-SELFTEST-SR';
const BUILD = 'web=index-SELFTEST-SR.js';
const EMAIL = 'qa+sel-owner@example.com';
const PASSWORD = 'Hunter2-SEL-pw-7731';
const NOTE = `verifier note: logged in as ${EMAIL} <!channel> ping`;
const TOKEN = 'xoxb-test-selftest-report';
const CH = 'C0REPORTCH1';

const COMBO_SECRET = 'Sup3rS3cretZ9';
const STATE_MAP = { pass: 'Release Candidate', reopen: 'Reopen', blocked: 'Blocked', stagingQaHold: 'Staging QA', newBug: 'Ready for Dev' };
// roles/tier/notes/hosts are not secrets (a title may name a role); combo is a combined "email / password" value
const PROFILE = {
  name: 'Selftest', linear: { prefix: 'SEL', stateMap: STATE_MAP },
  surfaces: { web: 'https://sel-staging.example.net', forbidden: ['sel-prod.example.org'] },
  accounts: { owner: { email: EMAIL, password: PASSWORD, note: 'fixture only; temp code Zq7!xT9-mm', role: 'administrator' }, combo: `ops@example.com / ${COMBO_SECRET}`, roles: ['viewer', 'programmer'], free: { tier: 'premium' } },
};
const PROFILE_NO_STATEMAP = { ...PROFILE, linear: { prefix: 'SEL' } };
const AUTH = { authorizedBy: 'selftest', authorizedQuote: 'selftest only', resultsAuthorizedBy: 'selftest', resultsAuthorizedQuote: 'selftest results only', resultsAuthorizedAt: '2026-10-16' };

const ticket = (id, verdict, cases, extra = {}) => ({ id, verdict, surface: 'web', buildId: BUILD, observedAt: '2026-10-16T00:00:00Z', cases, verifierNotes: NOTE, ...extra });
const pc = (caseId) => ({ caseId, verdict: 'PASS', note: NOTE, evidence: { url: 'https://sel.example/ok', observedText: 'ok', buildId: BUILD } });
const fc = (caseId) => ({ caseId, verdict: 'FAIL', note: NOTE, expected: 'saved', evidence: { url: 'https://sel.example/fail', observedText: `500 for ${EMAIL}`, buildId: BUILD } });
const STAGING_URL = 'https://sel-staging.example.net/settings/profile';
// the failing case the plan describes: the ledger has the evidence, the plan has the AC, expected and steps
const fcPlan = () => ({
  caseId: 'TC-2', verdict: 'FAIL', note: NOTE,
  whyNotMet: `Saving while signed in as ${EMAIL} returns HTTP 500 and no confirmation appears`,
  evidence: { url: STAGING_URL, observedText: 'An "Error 500" toast; screenshot /home/someone/qa/shots/SEL-2_TC-2_fail.png (also SEL-2_TC-2.png); the same call from https://thirdparty.example/hook', buildId: BUILD },
});
const PLAN_SEL2 = {
  ticket: 'SEL-2', title: 'Profile save shows a confirmation',
  cases: [{ caseId: 'TC-2', title: 'Saving the profile shows "Profile saved"', acRef: 'AC-1 saving the profile shows a confirmation', expected: 'A "Profile saved" message appears and the new display name is still there after a reload', precond: 'Signed in on the staging web app', actions: ['Open Settings, then Profile', 'Change the display name', 'Press Save'], verifyBy: 'the confirmation message and the name after a reload' }],
};
const SEL3_QUESTIONS = [
  { id: 'Q1', to: 'Backend team', question: 'Is the staging payment sandbox expected back this week?' },
  { id: 'Q2', to: 'the QA lead', question: 'Should QA keep holding this ticket for the internal review?' },
];
const TICKETS = () => [
  ticket('SEL-1', 'PASS', [pc('TC-1'), pc('TC-2')]),
  ticket('SEL-2', 'FAIL', [pc('TC-1'), fcPlan(), fc('TC-3')], { comment: 'Saving the profile returns a server error instead of a confirmation.' }),
  ticket('SEL-3', 'BLOCKED', [{ caseId: 'TC-1', verdict: 'NOT_TESTED', blockedOn: 'the staging payment sandbox (down since Monday)' }, { caseId: 'TC-2', verdict: 'NOT_TESTED' }], { comment: 'The staging service is down, so nothing past login could be run.', questions: SEL3_QUESTIONS }),
  ticket('SEL-4', 'NEEDS_MANUAL', [{ caseId: 'TC-1', verdict: 'NEEDS_MANUAL', note: NOTE }], {
    comment: 'The code arrives by SMS on a real handset, which the agent cannot read; manual steps are listed.',
    needsManual: [{ caseId: 'TC-1', probe: { attempted: 'POST /sms/verify', failureMode: 'OTP goes to a real handset', missingCapability: 'SMS inbox for the test number', evidence: 'HTTP 202 recorded' }, manualRepro: ['Install build', 'Sign up with a real number', 'Enter the SMS code'] }],
  }),
];
const LEDGER = (over = {}) => ({
  schemaVersion: 1,
  runId: RUN,
  project: 'selftest',
  generatedAt: '2026-10-16T08:00:00.000Z',
  build: { buildId: BUILD },
  tickets: TICKETS(),
  ...over,
});
/** the ledger with one ticket's fields (or one case of it) replaced */
const withTicket = (id, patch) => TICKETS().map((t) => (t.id === id ? { ...t, ...patch(t) } : t));
const withCase = (id, caseId, patch) => withTicket(id, (t) => ({ cases: t.cases.map((c) => (c.caseId === caseId ? { ...c, ...patch } : c)) }));
const gid = (ticketId, label) => `G-${createHash('sha256').update(['selftest', ticketId, label].join('|')).digest('hex').slice(0, 8)}`;
const INTAKE = [
  { id: 'SEL-1', title: 'Save <!channel> button keeps the form' },
  { id: 'SEL-2', title: 'Profile save shows a confirmation' },
  { id: 'SEL-3', title: 'Login reaches the dashboard' },
  { id: 'SEL-4', title: 'SMS code verifies the number [SEL-4]' },
];

/** The dry run's messages: [{ key: 'parent' | reply key, len, text }] (the "  │ " prefix removed). */
const messagesOf = (stdout) => {
  const out = [];
  let cur = null;
  for (const line of stdout.split('\n')) {
    const m = line.match(/^── (?:(parent)|reply \d+\/\d+ · (\S+)) \((\d+) chars\) ──$/);
    if (m) { cur = { key: m[1] || m[2], len: Number(m[3]), lines: [] }; out.push(cur); continue; }
    if (/^── /.test(line)) { cur = null; continue; }
    if (cur && line.startsWith('  │')) cur.lines.push(line.replace(/^ {2}│ ?/, ''));
  }
  return out.map(({ lines, ...m }) => ({ ...m, text: lines.join('\n') }));
};

export default function slackReportSection({ check, assert, mustReject, mustAccept, TMP, HUB }) {
  console.log('\nSlack results poster — scripts/slack-report.mjs (per-ticket replies + questions, leak guard, gates, edit/post/delete in place)');
  const root = join(TMP, 'slack-report');
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  const profileFile = join(root, 'profile-selftest.json');
  writeFileSync(profileFile, JSON.stringify(PROFILE));
  const profileNoMap = join(root, 'profile-selftest-nomap.json');
  writeFileSync(profileNoMap, JSON.stringify(PROFILE_NO_STATEMAP));
  const cfgp = join(home, 'cfg.json');
  writeFileSync(cfgp, JSON.stringify({ projects: { selftest: { channelId: CH, channelName: 'mock results', ...AUTH } } }));
  const cfgNoResults = join(home, 'cfg-noresults.json');
  writeFileSync(cfgNoResults, JSON.stringify({ projects: { selftest: { channelId: CH, authorizedBy: 'selftest', authorizedQuote: 'slack-window only' } } }));
  const cfgNull = join(home, 'cfg-null.json');
  writeFileSync(cfgNull, JSON.stringify({ projects: { selftest: null } }));
  const cfgOther = join(home, 'cfg-other.json');
  writeFileSync(cfgOther, JSON.stringify({ projects: { other: { channelId: 'C0OTHERCH1', authorizedBy: 'selftest', authorizedQuote: 'selftest only' } } }));
  const cfgBad = join(home, 'cfg-bad.json');
  writeFileSync(cfgBad, '{ not json');

  const mkdir = (name, ledger, intake = INTAKE, extra = {}) => {
    const d = join(root, name);
    mkdirSync(d, { recursive: true });
    if (ledger) writeFileSync(join(d, `_LEDGER-${RUN}.json`), JSON.stringify(ledger, null, 2));
    if (intake) writeFileSync(join(d, `_INTAKE-${RUN}.json`), JSON.stringify(intake));
    if (ledger) writeFileSync(join(d, `_PLAN-${RUN}-SEL-2.json`), JSON.stringify(PLAN_SEL2, null, 2));
    for (const [f, v] of Object.entries(extra)) writeFileSync(join(d, f), typeof v === 'string' ? v : JSON.stringify(v));
    return d;
  };
  const rd = mkdir('rd', LEDGER());
  const rdGates = mkdir('rd-gates', LEDGER(), INTAKE, { [`_BUILD-${RUN}.json`]: { note: 'no buildId: R-06 fails closed' } });
  const rdForeign = mkdir('rd-foreign', LEDGER({ tickets: [{ ...TICKETS()[0], id: 'XYZ-1' }] }));
  const rdOtherProj = mkdir('rd-otherproj', LEDGER({ project: 'other' }));
  const rdLeak = mkdir('rd-leak', LEDGER(), [{ id: 'SEL-1', title: 'Invite flow for qa+leak@example.com' }]);
  const rdShard = mkdir('rd-shard', null, INTAKE, { [`_LEDGER-${RUN}-G1.json`]: { ...LEDGER(), shard: 'G1' } });
  const rdCrash = mkdir('rd-crash', LEDGER());
  const rdRl = mkdir('rd-ratelimit', LEDGER());
  const rdMig = mkdir('rd-migrate', LEDGER());
  const rdGone = mkdir('rd-gone', LEDGER());
  const rdFresh = mkdir('rd-fresh', LEDGER());
  // leak-guard bypasses found in review: each must be refused (hard) or have its title dropped (soft)
  const pad = 'x'.repeat(70);
  const withTitle = (name, title) => mkdir(name, LEDGER(), [{ id: 'SEL-1', title }, ...INTAKE.slice(1)]);
  const HARD_TITLES = {
    'a password past the 80-character clip': `${pad} Login works with ${PASSWORD} only`,
    'an email past the 80-character clip': `${pad} Invite flow for ${EMAIL} bounces`,
    'the secret half of a combined account value': `Reset to ${COMBO_SECRET} does not stick`,
    'a password split by a soft hyphen': 'Login with Hunter2-SEL­pw-7731 fails',
    'a password split by a zero-width space': 'Login with Hunter2-SEL-pw-​7731 fails',
    'a fullwidth email': 'Invite qa+sel-owner＠example．com bounces',
  };
  const hardDirs = Object.entries(HARD_TITLES).map(([what, title], i) => [what, withTitle(`rd-hard-${i}`, title)]);
  // the same guard on the case text that the replies now carry (reason, actual result, steps)
  const HARD_CASES = {
    'an email that is not an account (in the reason of a failing case)': withCase('SEL-2', 'TC-3', { whyNotMet: 'The invite went to dev.person@example.org instead of the owner' }),
    'the account password (in the note of a failing case)': withCase('SEL-2', 'TC-3', { note: `logged in with ${PASSWORD}`, whyNotMet: undefined }),
    'a forbidden production link (in the actual result)': withCase('SEL-2', 'TC-3', { evidence: { url: 'https://sel-staging.example.net/x', observedText: 'redirected to https://sel-prod.example.org/login', buildId: BUILD } }),
    'a forbidden production host name (in a step)': withCase('SEL-2', 'TC-3', { repro: ['Open sel-prod.example.org in a browser', 'Press Save'] }),
    'the account password (in a not-tested reason)': withCase('SEL-3', 'TC-2', { note: `the login ${PASSWORD} was rejected` }),
  };
  const hardCaseDirs = Object.entries(HARD_CASES).map(([what, tickets], i) => [what, mkdir(`rd-hardcase-${i}`, LEDGER({ tickets }))]);
  const rdRole = withTitle('rd-role', 'Viewer role can open the export menu; Programmer and administrator too (premium)');
  const rdPwWord = withTitle('rd-pwword', 'Password Reset – link works');
  const rdHost = withTitle('rd-host', 'Login on staging.thirdparty.example/admin loops');
  const rdPath = withTitle('rd-path', 'Export saved to /home/someone/dist/out.json');
  const rdOwnHost = withTitle('rd-ownhost', 'Opens on sel-prod.example.org only');
  const rdBuildPath = mkdir('rd-buildpath', JSON.parse(JSON.stringify(LEDGER()).split(BUILD).join('web=/home/someone/dist/index.js')));
  const rdIds = mkdir('rd-ids', LEDGER({ tickets: [{ ...TICKETS()[1], id: 'SEL-2 EPS-77' }] }));
  const rdTraversal = mkdir('rd-traversal', LEDGER({ tickets: [{ ...TICKETS()[0], id: 'SEL-1/../../leak' }] }), []);
  writeFileSync(join(root, 'leak.json'), JSON.stringify({ title: 'TITLE READ FROM OUTSIDE THE REPORTS DIR' }));
  // an intake sidecar whose .tickets is an object map (real gamma runs have _INTAKE-<run>-comments.json)
  const rdSidecar = mkdir('rd-sidecar', LEDGER(), INTAKE, { [`_INTAKE-${RUN}-comments.json`]: { tickets: { 'SEL-1': { comments: 3 } } }, [`_INTAKE-${RUN}-dump.json`]: [{ id: 'SEL-1', title: 'dump title must not win' }] });
  // a ticket with 30 failing cases: its reply goes out in parts, nothing dropped
  const longWhy = (i) => `Case ${i}: ${'the saved value is lost after a reload and the list shows the old value again; '.repeat(4)}`;
  const LONG = Array.from({ length: 30 }, (_, k) => ({ caseId: `TC-${k + 10}`, verdict: 'FAIL', whyNotMet: longWhy(k + 10), evidence: { url: STAGING_URL, observedText: `The list shows the old value (case ${k + 10})`, buildId: BUILD }, repro: ['Open Settings, then Profile', `Change field ${k + 10}`, 'Press Save', 'Reload the page'] }));
  const rdLong = mkdir('rd-long', LEDGER({ tickets: withTicket('SEL-2', (t) => ({ cases: [...t.cases, ...LONG] })) }));
  // answered questions are skipped: a recorded one (answered on the question) and a generated one (the registry)
  const rdAns = mkdir('rd-answered', LEDGER({ tickets: withTicket('SEL-3', () => ({ questions: [{ ...SEL3_QUESTIONS[0], answered: true }, SEL3_QUESTIONS[1]] })) }), INTAKE, {
    '_QUESTIONS-ANSWERED.jsonl': `${JSON.stringify({ id: gid('SEL-3', 'No reason was recorded'), status: 'answered' })}\n{ not json\n`,
  });

  // review findings (2026-10-16): questions grouped by need and covered by recorded ones, QA-side and placeholder
  // cases ask nothing, hardware cases are left out, Q ids dropped from reasons, links cut, phones / prose passwords
  // described, jargon and hub paths out, fail tags, "fixed since the last round", a ticket built elsewhere
  const SEL5 = ticket('SEL-5', 'BLOCKED', [
    { caseId: 'TC-1', verdict: 'NOT_TESTED', blockedOn: 'the read-only database password' },
    { caseId: 'TC-2', verdict: 'NOT_TESTED', blockedOn: 'the read-only database password' },
    { caseId: 'TC-3', verdict: 'NOT_TESTED', blockedOn: 'the staging mail relay (see Q-MAIL)' },
    { caseId: 'TC-4', verdict: 'NOT_TESTED', blockedOn: 'the staging mail relay' },
    { caseId: 'TC-5', verdict: 'NOT_TESTED', note: 'Held per Q-REFUND: Dana must refund in Stripe test mode before this half can be observed.' },
    { caseId: 'TC-6', verdict: 'NOT_TESTED', note: 'Payment tests were not allowed this round.' },
    { caseId: 'TC-7', verdict: 'NOT_TESTED', note: 'Placeholder so the ticket has a case.' },
    { caseId: 'TC-8', verdict: 'NOT_TESTED', blockedOn: 'a real handset for the SMS code' },
    { caseId: 'TC-9', verdict: 'NOT_TESTED', notTestedReason: 'no-ui-surface', blockedOn: 'the export screen not built yet' },
  ], { comment: 'Most cases wait on access.', questions: [{ id: 'Q1', to: 'the backend dev', question: 'Can QA have the read-only database password for the staging database?' }] });
  const SEL6 = ticket('SEL-6', 'FAIL', [
    { caseId: 'TC-1', verdict: 'NOT_TESTED', blockedOn: 'the staging mail relay' },
    { caseId: 'TC-2', verdict: 'FAIL', priorVerdict: 'PASS', expected: 'the reset page opens',
      whyNotMet: 'The Verifier saw the reset link fail (see harness/sel/login.mjs and run.log); the password is Qa-temp-881 and was rejected; the support line +1 (415) 555-0134 is shown; SEL-5/TC-8 is unrelated',
      evidence: { url: 'https://sel-staging.example.net/reset?token=abcdef123456&mode=edit', observedText: 'Checkout session cs_test_a19dopbezxHn1DtoeH6q1evrgFo8x7Y6dMr81Z11vKQrRjnsQzK0XfgfJr shows an error', buildId: BUILD } },
    { caseId: 'TC-3', verdict: 'FAIL', priorVerdict: 'FAIL', expected: 'saved', whyNotMet: 'Still returns 500', evidence: { url: STAGING_URL, observedText: '500', buildId: BUILD } },
    { caseId: 'TC-4', verdict: 'PASS', priorVerdict: 'FAIL', evidence: { url: STAGING_URL, observedText: 'ok', buildId: BUILD } },
  ], { comment: 'The reset link is broken.', scopeQuestion: 'TC-2: if the reset link opens the old page, is TC-2 a FAIL? The plan accepts either.' });
  const SEL7 = ticket('SEL-7', 'PARTIAL', [{ caseId: 'TC-1', verdict: 'NOT_TESTED', notTestedReason: 'out-of-scope' }], { partialReason: 'coverage-gap', comment: 'Not re-tested this round.' });
  const REV_INTAKE = [...INTAKE, { id: 'SEL-5', title: 'Export needs database access' }, { id: 'SEL-6', title: 'Password reset link opens the form' }, { id: 'SEL-7', title: 'Old filter still works' }];
  const REV_TICKETS = () => [...TICKETS(), SEL5, SEL6, SEL7];
  const rdRev = mkdir('rd-review', LEDGER({ tickets: REV_TICKETS() }), REV_INTAKE);
  const revCase = (patch) => LEDGER({ tickets: REV_TICKETS().map((t) => (t.id === 'SEL-6' ? { ...t, cases: t.cases.map((c) => (c.caseId === 'TC-3' ? { ...c, ...patch } : c)) } : t)) });
  const REV_HARD = {
    'an encoded email in a link path': { evidence: { url: 'https://sel-staging.example.net/u/dev.person%40example.org', observedText: 'x', buildId: BUILD } },
    'a Stripe secret key': { whyNotMet: 'the page printed sk_test_ABCDEFGHIJ1234567890' },
    'a bearer token': { whyNotMet: 'sent Authorization: Bearer abcdefghijklmnopqrstuvwx1234' },
    'a JWT': { whyNotMet: 'the cookie held eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N' },
    'a code-shaped token from an account note': { whyNotMet: 'the code Zq7!xT9-mm was accepted twice' },
  };
  const revHardDirs = Object.entries(REV_HARD).map(([what, patch], i) => [what, mkdir(`rd-revhard-${i}`, revCase(patch), REV_INTAKE)]);
  // stable numbers: a state whose qNumbers already numbered the questions (one of them answered since)
  const rdQnum = mkdir('rd-qnum', LEDGER({ tickets: withTicket('SEL-3', () => ({ questions: [{ ...SEL3_QUESTIONS[0], answered: true }, SEL3_QUESTIONS[1]] })) }), INTAKE, {
    '_QUESTIONS-ANSWERED.jsonl': `${JSON.stringify({ id: gid('SEL-3', 'No reason was recorded'), status: 'answered' })}\n`,
    [`_SLACK-REPORT-${RUN}.json`]: { channelId: CH, threadTs: '1760000001.000101', parentHash: '0'.repeat(64), replies: [], contentHash: '0'.repeat(64), qNumbers: { 'SEL-3/Q1': 4, [gid('SEL-3', 'No reason was recorded')]: 2 } },
  });

  const SR = 'scripts/slack-report.mjs';
  const base = (d, cfg = cfgp, prof = profileFile) => ['--project', 'selftest', '--run', RUN, '--reports-dir', d, '--config', cfg, '--profile-file', prof];
  const direct = (a, env = {}) => spawnSync('node', [join(HUB, SR), ...a], { encoding: 'utf8', env: { ...process.env, HOME: home, QA_SLACK_BOT_TOKEN: '', ...env } });
  const NEVER = [NOTE, EMAIL, PASSWORD, '<!channel>', 'sel.example', 'verifier', '/Users/', '.png', 'thirdparty', 'SEL-4', 'SMS code', 'Should QA keep holding'];

  check('slack-report: a dry run prints every message in full and writes nothing; no free-text flags; the counts equal gen-counts; no note, email, password, path, file name or raw mention; NEEDS_MANUAL is left out', () => {
    const before = readdirSync(rd).sort().join();
    const dry = direct(base(rd));
    mustAccept(dry, 'slack-report dry run');
    assert(/DRY RUN/.test(dry.stdout) && /thread would be created \(parent \+ 4 replies\)/.test(dry.stdout), `dry run:\n${dry.stdout.slice(0, 600)}`);
    assert(readdirSync(rd).sort().join() === before, `a dry run wrote files: ${readdirSync(rd).join(', ')}`);
    for (const bad of NEVER) assert(!dry.stdout.includes(bad), `the dry run would post "${bad}":\n${dry.stdout}`);
    assert(dry.stdout.includes('&lt;!channel&gt;'), 'the mention in a title was not escaped');
    const msgs = messagesOf(dry.stdout);
    // order: parent, FAIL, BLOCKED, the passed tickets, the questions
    assert(msgs.map((m) => m.key).join() === 'parent,SEL-2,SEL-3,passed,questions', `messages: ${msgs.map((m) => m.key)}`);
    assert(msgs.every((m) => m.len === m.text.length && m.len <= 3500), `a message length is off: ${msgs.map((m) => `${m.key}=${m.len}/${m.text.length}`)}`);
    const [p] = msgs;
    assert(/Details per ticket in the thread ↓ · 2 questions for the team/.test(p.text), `parent pointer:\n${p.text}`);
    assert(/QA checks: 2 passed, 3 skipped \(build id · intake · run results\)/.test(p.text) && /Tracker not changed/.test(p.text) && !/\bR-\d\d\b|\bH-1\b/.test(p.text), `header gates / tracker line:\n${p.text}`);
    // R-02: a NEEDS-MANUAL item is never Slack — no reply, no id, no count
    assert(!/NEEDS[_ -]?MANUAL|needs manual/i.test(dry.stdout), `a needs-manual item would be posted:\n${dry.stdout}`);
    // counts: the same numbers gen-counts derives from the same ledger (over the posted tickets, R-02)
    const postedLedger = join(root, 'posted-ledger.json');
    writeFileSync(postedLedger, JSON.stringify(LEDGER({ tickets: TICKETS().filter((t) => t.verdict !== 'NEEDS_MANUAL') })));
    const gc = spawnSync('node', [join(HUB, 'scripts', 'gen-counts.mjs'), '--ledger', postedLedger, '--json'], { encoding: 'utf8' });
    assert(gc.status === 0, `gen-counts failed: ${gc.stderr}`);
    const c = JSON.parse(gc.stdout);
    const j3 = (o) => Object.entries(o).map(([k, v]) => `${k} ${v}`).join(' · ');
    const SHORT = { PASS: 'pass', FAIL: 'fail', BLOCKED: 'blocked', 'PARTIAL:mixed': 'partial (some fail)', 'PARTIAL:coverage-gap': 'partial (not all tested)', PASS_SCOPE: 'pass (scoped)' };
    const jb = (o) => Object.entries(o).map(([k, v]) => `${v} ${SHORT[k] || k}`).join(' · ');
    assert(p.text.includes(`*Tickets* ${c.total} — ${jb(c.buckets)}`), `ticket counts differ from gen-counts (${jb(c.buckets)}):\n${p.text}`);
    assert(p.text.includes(`*Proposed states* ${j3(c.byProposedState)}`), `proposed states differ from gen-counts (${j3(c.byProposedState)}):\n${p.text}`);
    assert(p.text.includes('*Cases* PASS 3 · FAIL 2 · NOT-TESTED 2 (blocked tickets: 1)'), `case counts:\n${p.text}`);
    assert(/Q1 = SEL-3\/Q1/.test(dry.stdout) && /Q2 = G-[0-9a-f]{8} \(generated/.test(dry.stdout), `the question id map is missing:\n${dry.stdout.slice(-600)}`);
    mustReject(direct([...base(rd), '--text', 'hello']), '--text is not accepted', 'slack-report --text');
    mustReject(direct([...base(rd), '--channel', 'C0OTHERCH1']), '--channel is not accepted', 'slack-report --channel');
    mustReject(direct([...base(rd), '--send', '--replies']), 'separate calls', 'slack-report --send --replies');
    mustReject(direct(['--project', 'gamma', '--run', RUN, '--reports-dir', rd, '--profile-file', profileFile]), 'for the selftest only', 'slack-report --profile-file over a real profile');
  });

  check('slack-report: a FAIL reply carries the case title, AC, Expected, Actual, Why and numbered steps from the plan; the account email reads as its role, a screenshot path and file name are stripped, a staging link is kept, another link is left out; the scope names the surface, build, counts and why a case was not tested', () => {
    const dry = direct(base(rd));
    mustAccept(dry, 'slack-report dry run');
    const m = Object.fromEntries(messagesOf(dry.stdout).map((x) => [x.key, x.text]));
    const f = m['SEL-2'] || '';
    const want = [
      '*SEL-2 · Profile save shows a confirmation* — FAIL → Reopen',
      '*Scope:* web\n*Cases:* 1 pass · 2 fail · 0 not tested\n*Passed (1):*\n• TC-1',
      '*Failing cases (2):*',
      '*TC-2 — Saving the profile shows "Profile saved"*',
      '_Acceptance criterion:_ AC-1 saving the profile shows a confirmation',
      '*Expected:* A "Profile saved" message appears and the new display name is still there after a reload',
      '*Actual:* An "Error 500" toast; the same call from [link left out]',
      "*Why it's a bug:* Saving while signed in as the administrator test account returns HTTP 500 and no confirmation appears",
      `*Seen at:* ${STAGING_URL}`,
      '*Steps to reproduce:*\n1. Precondition: Signed in on the staging web app\n2. Open Settings, then Profile\n3. Change the display name\n4. Press Save\n5. Check: the confirmation message and the name after a reload',
      '*TC-3*\n*Expected:* saved\n*Actual:* 500 for the administrator test account',
    ];
    for (const w of want) assert(f.includes(w), `the SEL-2 reply lacks:\n${w}\n--- got:\n${f}`);
    assert(/replaced link\(s\)\/host name\(s\)/.test(dry.stderr), `no stderr note for the left-out link:\n${dry.stderr}`);
    const b = m['SEL-3'] || '';
    for (const w of ['*SEL-3 · Login reaches the dashboard* — BLOCKED', '→ Blocked', '*Cases:* 0 pass · 0 fail · 2 not tested', '*Not tested, and why:*', '• Waiting on: the staging payment sandbox (down since Monday) — TC-1 (see question Q1 below)', '• No reason was recorded — TC-2 (see question Q2 below)'])
      assert(b.includes(w), `the SEL-3 reply lacks "${w}":\n${b}`);
    assert(/^\*Passed\* · 1 ticket\n\n• \*SEL-1 · Save &lt;!channel&gt; button keeps the form\* — PASS → Release Candidate · both cases passed · web$/.test(m.passed || ''), `passed reply:\n${m.passed}`);
  });

  check('slack-report: the questions reply lists the recorded question to a team member and one generated question per not-tested reason, skips questions to the QA side, and closes with the reply note; answered ones (on the question, or in _QUESTIONS-ANSWERED.jsonl) are skipped', () => {
    const q = messagesOf(direct(base(rd)).stdout).find((x) => x.key === 'questions')?.text || '';
    const want = [
      '*Questions for the team* · `R-SELFTEST-SR` · 2 open',
      '*Q1 · SEL-3* (for Backend team): Is the staging payment sandbox expected back this week?',
      '*Q2 · SEL-3 TC-2*: No reason was recorded why this case could not be tested — is anything needed from the team to test it?',
      '_Reply in this thread — answers are read by the QA lead; a reply does not change any ticket._',
    ];
    for (const w of want) assert(q.includes(w), `the questions reply lacks:\n${w}\n--- got:\n${q}`);
    assert(!/keep holding|internal review/.test(q), `a question to the QA side was posted:\n${q}`);
    const ans = direct(base(rdAns));
    mustAccept(ans, 'slack-report dry run, answered questions');
    const am = messagesOf(ans.stdout);
    const aq = am.find((x) => x.key === 'questions')?.text || '';
    assert(/· 1 open$/m.test(aq.split('\n')[0]) && aq.includes('*Q1 · SEL-3 TC-1*: QA needs the staging payment sandbox (down since Monday) to test this case — when can QA have it?') && !/expected back this week|No reason was recorded/.test(aq), `answered questions were posted:\n${aq}`);
    const ab = am.find((x) => x.key === 'SEL-3')?.text || '';
    assert(ab.includes('• Waiting on: the staging payment sandbox (down since Monday) — TC-1 (see question Q1 below)') && /• No reason was recorded — TC-2$/m.test(ab), `answered: the not-tested lines and their cites:\n${ab}`);
    assert(/Details per ticket in the thread ↓ · 1 question for the team$/m.test(am[0].text), `parent pointer with one question:\n${am[0].text}`);
  });

  check('slack-report: a reply longer than one Slack message goes out in consecutive "(continued)" parts — every part fits, every case is in one of them, nothing is cut', () => {
    const r = direct(base(rdLong));
    mustAccept(r, 'slack-report dry run, a 32-case failing ticket');
    const parts = messagesOf(r.stdout).filter((x) => /^SEL-2(#\d+)?$/.test(x.key));
    assert(parts.length >= 3 && parts.map((x) => x.key).join() === ['SEL-2', ...parts.slice(1).map((_, i) => `SEL-2#${i + 2}`)].join(), `parts: ${parts.map((x) => x.key)}`);
    assert(parts.every((x) => x.len <= 3500), `a part is over 3500 chars: ${parts.map((x) => x.len)}`);
    assert(parts.slice(1).every((x) => x.text.startsWith('*SEL-2 · Profile save shows a confirmation* (continued)')), 'a continuation part is not marked "(continued)"');
    const all = parts.map((x) => x.text).join('\n');
    for (let k = 10; k < 40; k++) assert(all.includes(`*TC-${k}*`) && all.includes(`Case ${k}: the saved value`) && all.includes(`Change field ${k}`), `case TC-${k} is missing from the parts`);
    assert(/\*Failing cases \(32\):\*/.test(all) && !/…/.test(all.replace(/\*Steps[^]*?$/m, '')), 'the parts dropped or clipped content');
    assert(new RegExp(`${parts.length + 4} message\\(s\\)`).test(r.stdout), `the message count does not count the parts:\n${r.stdout.slice(0, 400)}`);
  });

  check('slack-report: refusals before any network call — leak guard (an email in a title), foreign ticket prefix, another project\'s ledger, shard-only ledgers, failed gates, malformed config; unconfigured project skips with exit 0', () => {
    // a dead local base + a test token: a refusal that slipped through would end on "Slack API error" instead
    const env = { QA_SLACK_API_BASE: 'http://127.0.0.1:9', QA_SLACK_BOT_TOKEN: TOKEN };
    const leak = direct([...base(rdLeak), '--send'], env);
    mustReject(leak, 'leak guard', 'slack-report, an email in a ticket title');
    assert(!(leak.stdout + leak.stderr).includes('qa+leak@example.com'), 'the leak guard printed what it matched');
    mustReject(direct(base(rdLeak)), 'leak guard', 'slack-report dry run, an email in a ticket title');
    mustReject(direct([...base(rdForeign), '--send'], env), 'not SEL-', 'slack-report, a foreign ticket prefix');
    mustReject(direct([...base(rdOtherProj), '--send'], env), 'ledger is for other', 'slack-report, another project\'s ledger');
    mustReject(direct([...base(rdShard), '--send'], env), 'only shard ledgers', 'slack-report, shard ledgers never added up');
    mustReject(direct([...base(rdGates), '--send'], env), 'gates FAILED', 'slack-report, a failed gate');
    mustReject(direct([...base(rd, cfgBad), '--send'], env), 'malformed', 'slack-report, malformed config');
    const skip = direct([...base(rd, cfgOther), '--send'], env);
    mustAccept(skip, 'slack-report, an unconfigured project');
    assert(/no Slack channel configured for selftest — skipped/.test(skip.stdout), `skip:\n${skip.stdout}${skip.stderr}`);
    const skipR = direct([...base(rd, cfgOther), '--replies'], env);
    mustAccept(skipR, 'slack-report --replies, an unconfigured project');
    assert(!existsSync(join(rd, `_SLACK-REPORT-${RUN}.json`)), 'a refused or skipped send wrote report state');
  });

  check('slack-report: the leak guard runs on raw values — clipped, combined, zero-width, soft-hyphen, fullwidth and production-host leaks in a title, and an unknown email, the password or a production host in the case text, are refused without printing them; roles/tiers and the word "password" are not secrets; a host name or a path drops only the title', () => {
    for (const [what, d] of [...hardDirs, ...hardCaseDirs]) {
      const r = direct(base(d));
      mustReject(r, 'leak guard', `slack-report, ${what}`);
      const said = r.stdout + r.stderr;
      for (const x of [PASSWORD, COMBO_SECRET, 'dev.person@', 'sel-prod.example.org/login', 'Open sel-prod']) assert(!said.includes(x), `${what}: the guard printed what it matched`);
    }
    const role = direct(base(rdRole));
    mustAccept(role, 'slack-report, a role name / tier in a title');
    assert(/\*SEL-1 · Viewer role can open/.test(role.stdout), `role title:\n${role.stdout}`);
    const pw = direct(base(rdPwWord));
    mustAccept(pw, 'slack-report, the word "password" in a title');
    assert(/Password Reset/.test(pw.stdout), `password-word title:\n${pw.stdout}`);
    // the profile's forbidden (production) host is refused anywhere, a title included; a staging host may be posted
    const own = direct(base(rdOwnHost));
    mustReject(own, 'a forbidden (production) host', 'slack-report, the production host in a title');
    assert(!(own.stdout + own.stderr).includes('sel-prod'), 'the guard printed the production host');
    for (const [d, what] of [[rdHost, 'a host name'], [rdPath, 'a file path']]) {
      const r = direct(base(d));
      mustAccept(r, `slack-report, ${what} in a title`);
      assert(/left out: the title of SEL-1/.test(r.stderr) && /• \*SEL-1\* — PASS → /.test(r.stdout) && !/thirdparty|\/Users\/|sel-prod/.test(r.stdout), `${what}:\n${r.stdout}${r.stderr}`);
    }
    const bp = direct(base(rdBuildPath));
    mustAccept(bp, 'slack-report, a path in the build id');
    assert(!/\/Users\//.test(bp.stdout) && !/Build `/.test(bp.stdout) && /left out: the build id/.test(bp.stderr), `build path:\n${bp.stdout}${bp.stderr}`);
  });

  check('slack-report: ids must be exactly <prefix>-<digits> (no rider id, no path traversal); an object-shaped intake sidecar does not crash and the canonical intake wins; a null config entry, a missing stateMap or a missing results authorisation is refused', () => {
    const env = { QA_SLACK_API_BASE: 'http://127.0.0.1:9', QA_SLACK_BOT_TOKEN: TOKEN };
    mustReject(direct(base(rdIds)), 'not SEL-', 'slack-report, "SEL-2 EPS-77"');
    const tr = direct(base(rdTraversal));
    mustReject(tr, 'not SEL-', 'slack-report, "SEL-1/../../leak"');
    assert(!(tr.stdout + tr.stderr).includes('OUTSIDE THE REPORTS DIR'), 'a title was read from outside the reports dir');
    const sc = direct(base(rdSidecar));
    mustAccept(sc, 'slack-report, an object-shaped _INTAKE-<run>-comments.json');
    assert(/\*SEL-1 · Save &lt;!channel&gt; button keeps the form\*/.test(sc.stdout) && !sc.stdout.includes('dump title'), `sidecar titles:\n${sc.stdout}`);
    mustReject(direct([...base(rd, cfgNull), '--send'], env), 'malformed entry for selftest', 'slack-report, a null config entry');
    const nomap = direct(base(rd, cfgp, profileNoMap));
    mustAccept(nomap, 'slack-report dry run, no stateMap');
    assert(/no linear\.stateMap/.test(nomap.stderr), `no WARN without a stateMap:\n${nomap.stderr}`);
    mustReject(direct([...base(rd, cfgp, profileNoMap), '--send'], env), 'no linear.stateMap', 'slack-report --send, no stateMap');
    mustReject(direct([...base(rd, cfgNoResults), '--send'], env), 'resultsAuthorizedQuote', 'slack-report --send, only the slack-window authorisation');
    mustReject(direct([...base(rd), '--replies'], env), 'no results thread yet', 'slack-report --replies before anything was posted');
    assert(!existsSync(join(rd, `_SLACK-REPORT-${RUN}.json`)), 'a refused send wrote report state');
  });

  check('slack-report review findings: questions grouped by need (two cases, one question; across tickets, one question), a need a recorded question covers asks nothing, QA-side / placeholder / hardware cases ask nothing (a hardware case gets no line and its id reads "another case"), a held case is a request to the named person, Q ids are dropped from reasons, a verdict question is never posted, "Not built yet", fail tags, "fixed since the last round", a ticket built elsewhere names its build, PARTIAL with nothing tested says so; links are cut to origin + path (+ mode), cs_test ids kept, phones and prose passwords described, jargon and hub paths out', () => {
    const r = direct(base(rdRev));
    mustAccept(r, 'slack-report dry run, the review fixture');
    const m = Object.fromEntries(messagesOf(r.stdout).map((x) => [x.key, x.text]));
    const all = Object.values(m).join('\n');
    const q = m.questions || '';
    const s5 = m['SEL-5'] || '';
    const s6 = m['SEL-6'] || '';
    // the DB password: covered by the backend dev's recorded question — asked once, both cases cite it
    assert((q.match(/database password/g) || []).length === 1 && /\(for the backend dev\): Can QA have the read-only database password/.test(q), `the database password is asked more (or less) than once:\n${q}`);
    const qn = (re) => (q.match(re) || [])[1];
    const dbN = qn(/\*Q(\d+) · SEL-5\* \(for the backend dev\)/);
    assert(dbN && s5.includes(`• Waiting on: the read-only database password — TC-1, TC-2 (see question Q${dbN} below)`), `SEL-5 database line (Q${dbN}):\n${s5}`);
    // the mail relay: one question for SEL-5 TC-3, TC-4 and SEL-6 TC-1, no question id left in the reason
    const relay = q.split('\n').filter((l) => /staging mail relay/.test(l));
    assert(relay.length === 1 && /these cases — when can QA have it\?/.test(relay[0]) && /SEL-5/.test(relay[0]) && /SEL-6/.test(relay[0]), `the mail relay questions:\n${relay.join('\n')}\n--- all:\n${q}`);
    assert(s5.includes('• Waiting on: the staging mail relay — TC-3, TC-4 (see question Q') && !/Q-MAIL|Q-REFUND/.test(all), `SEL-5 relay line / Q ids:\n${s5}`);
    // held: a request to Dana, no unrecorded question id
    assert(/\(for Dana\): Please refund the test payment of this case in Stripe test mode so that the rest of this case can be observed\./.test(q), `the held request:\n${q}`);
    assert(s5.includes('• Waiting on Dana to refund the test payment of this case in Stripe test mode before the rest of this case can be observed — TC-5 (see question Q'), `SEL-5 held line:\n${s5}`);
    // QA-side restriction: a line, no question; placeholder: nothing; hardware: nothing, its id reads "another case"
    assert(s5.includes('• Payment tests were not allowed this round — TC-6') && !/Payment tests/.test(q), `QA-side restriction:\n${s5}\n${q}`);
    assert(!/Placeholder|TC-7|TC-8|handset|SMS/.test(s5 + q), `a placeholder or hardware case was posted:\n${s5}\n${q}`);
    assert(s5.includes('• Not built yet: the export screen — TC-9') && !/export screen/.test(q), `not built yet:\n${s5}`);
    assert(!/build `/.test(s5 + (m['SEL-2'] || '')), `the run's own build is repeated in a reply:\n${s5}`);
    assert(/another case is unrelated/.test(s6) && !/SEL-5\/TC-8/.test(s6), `a hardware case id in the reason:\n${s6}`);
    // the verdict question is never re-asked
    assert(!/is TC-2 a FAIL|The plan accepts|reset link opens the old page/.test(all), `a verdict question was posted:\n${q}`);
    // fail tags, fixed since the last round
    assert(/\*TC-2\* _\(regression: passed in an earlier round\)_/.test(s6) && /\*TC-3\* _\(still failing since an earlier round\)_/.test(s6), `fail tags:\n${s6}`);
    assert(/\*Passed \(1\):\*\n• TC-4 _\(fixed since the last round\)_/.test(s6), `fixed since the last round:\n${s6}`);
    // the link: origin + path (+ mode), the token gone; cs_test kept whole; phone and prose password described; jargon out
    assert(s6.includes('*Seen at:* https://sel-staging.example.net/reset?mode=edit') && !/abcdef123456|token=/.test(all), `the link was not cut:\n${s6}`);
    assert(s6.includes('cs_test_a19dopbezxHn1DtoeH6q1evrgFo8x7Y6dMr81Z11vKQrRjnsQzK0XfgfJr'), `the Checkout session id was cut:\n${s6}`);
    assert(!/415|555-0134|Qa-temp-881/.test(all) && /a test phone number/.test(s6) && /the password is \[not posted\] and was rejected/.test(s6), `phone / prose password:\n${s6}`);
    assert(!/Verifier|harness|login\.mjs|run\.log/i.test(all) && /QA saw the reset link fail/.test(s6), `jargon / hub paths:\n${s6}`);
    // PARTIAL with nothing tested
    assert(/\*SEL-7 · Old filter still works\* — PARTIAL \(nothing could be tested this round\)/.test(m['SEL-7'] || all), `SEL-7:\n${m['SEL-7'] || ''}`);
    // the hard leaks of the review: refused, never printed
    for (const [what, d] of revHardDirs) {
      const h = direct(base(d));
      mustReject(h, 'leak guard', `slack-report, ${what}`);
      for (const x of ['dev.person', 'sk_test_ABC', 'abcdefghijklmnopqrstuvwx1234', 'eyJhbGci', 'Zq7!xT9-mm']) assert(!(h.stdout + h.stderr).includes(x), `${what}: the guard printed what it matched`);
    }
  });

  check('slack-report: question numbers are stable — state.qNumbers keeps each question\'s number, a new one gets max+1, an answered one with a number shows as "~Qn~ answered"', () => {
    const r = direct(base(rdQnum));
    mustAccept(r, 'slack-report dry run with stored question numbers');
    const q = messagesOf(r.stdout).find((x) => x.key === 'questions')?.text || '';
    assert(/^~Q2~ answered$/m.test(q) && /^~Q4~ answered$/m.test(q) && /\*Q5 · SEL-3 TC-1\*: QA needs the staging payment sandbox/.test(q) && !/\*Q[1-3] · /.test(q), `numbers:\n${q}`);
    assert(/Q5 = G-[0-9a-f]{8}/.test(r.stdout) && /Q2 = G-[0-9a-f]{8} \(answered/.test(r.stdout) && /Q4 = SEL-3\/Q1 \(answered/.test(r.stdout), `the dry run's id map:\n${r.stdout.slice(-700)}`);
  });

  // ── one mock-Slack scenario, judged by the two checks below ──────────────────────────────
  const ledgerPath = (d) => join(d, `_LEDGER-${RUN}.json`);
  const statePath = (d) => join(d, `_SLACK-REPORT-${RUN}.json`);
  const changedTc3 = withCase('SEL-2', 'TC-3', { expected: 'saved, with a confirmation' });
  const scenario = {
    token: TOKEN,
    bot: { user_id: 'U0BOTSELF', user: 'qa_hub_bot', team: 'Selftest', bot_id: 'B0BOTSELF' },
    channels: [CH],
    env: { HOME: home },
    steps: [
      { label: 'send1', cmd: [SR, ...base(rd), '--send'] },
      { label: 'send2', cmd: [SR, ...base(rd), '--send'] },
      { label: 'send3', writeJson: { path: ledgerPath(rd), merge: { generatedAt: '2026-10-17T08:00:00.000Z' } }, cmd: [SR, ...base(rd), '--send'] },
      { label: 'send4', writeJson: { path: ledgerPath(rd), merge: { tickets: changedTc3 } }, cmd: [SR, ...base(rd), '--send'] },
      { label: 'replies', inject: [{ label: 'h1', user: 'U0HUMAN01', text: 'TC-2 is fixed on the next build' }], cmd: [SR, ...base(rd), '--replies'] },
      { label: 'replies2', cmd: [SR, ...base(rd), '--replies'] },
      { label: 'send5', cmd: [SR, ...base(rd), '--send'] },
      // the ticket set shrinks (SEL-3 drops out, and with it the questions): surplus replies are deleted
      { label: 'shrink', writeJson: { path: ledgerPath(rd), merge: { tickets: changedTc3.filter((t) => t.id !== 'SEL-3') } }, cmd: [SR, ...base(rd), '--send'] },
      { label: 'send6', cmd: [SR, ...base(rd), '--send'] },
      { label: 'unconfigured', cmd: [SR, ...base(rd, cfgOther), '--send'] },
      { label: 'gates', cmd: [SR, ...base(rdGates), '--send'] },
      { label: 'foreign', cmd: [SR, ...base(rdForeign), '--send'] },
      { label: 'leak', cmd: [SR, ...base(rdLeak), '--send'] },
      { label: 'remote-base', cmd: [SR, ...base(rd), '--send'], env: { QA_SLACK_API_BASE: 'https://slack.com.example/api' } },
      { label: 'real-token', cmd: [SR, ...base(rdCrash), '--send'], env: { QA_SLACK_BOT_TOKEN: 'xoxb-1234-not-a-test-token' } },
      // 429: the first chat.postMessage is rate-limited once; Retry-After is honoured and the post retried
      { label: 'ratelimit', rateLimitOnce: 'chat.postMessage', cmd: [SR, ...base(rdRl), '--send'] },
      // crash mid-sequence: the parent and reply 1 are posted, reply 2 fails; the re-run posts only the rest
      { label: 'crash1', failReplyOnce: 2, cmd: [SR, ...base(rdCrash), '--send'] },
      { label: 'crash2', cmd: [SR, ...base(rdCrash), '--send'] },
      { label: 'crash3', cmd: [SR, ...base(rdCrash), '--send'] },
      // migration: what the first poster left (a parent + ONE reply, state { replyTs }) is edited in place
      { label: 'mig-seed', cmd: null, seed: [{ label: 'old-parent', text: 'QA results (first format)' }, { label: 'old-reply', thread: 'old-parent', text: 'Per ticket (first format)' }],
        writeJson: { path: statePath(rdMig), merge: { channelId: CH, threadTs: '{{ts:old-parent}}', replyTs: '{{ts:old-reply}}', contentHash: '0'.repeat(64), postedAt: '2026-10-15T12:00:00.000Z' } } },
      { label: 'mig', cmd: [SR, ...base(rdMig), '--send'] },
      { label: 'mig2', cmd: [SR, ...base(rdMig), '--send'] },
      // someone deletes a reply in Slack: the next --send re-posts it into its slot; the parent deleted: refused
      // ("thread deleted"), then --send --reset starts a fresh thread with the same question numbers
      { label: 'gone1', cmd: [SR, ...base(rdGone), '--send'] },
      { label: 'gone-reply', removeFromState: { path: statePath(rdGone), reply: 0 }, writeJson: { path: ledgerPath(rdGone), merge: { tickets: changedTc3 } }, cmd: [SR, ...base(rdGone), '--send'] },
      { label: 'gone-reply2', cmd: [SR, ...base(rdGone), '--send'] },
      { label: 'gone-parent', removeFromState: { path: statePath(rdGone), reply: 'parent' }, writeJson: { path: ledgerPath(rdGone), merge: { generatedAt: '2026-10-18T08:00:00.000Z' } }, cmd: [SR, ...base(rdGone), '--send'] },
      { label: 'gone-reset', cmd: [SR, ...base(rdGone), '--send', '--reset'] },
      { label: 'gone-reset2', cmd: [SR, ...base(rdGone), '--send'] },
      // a fresh thread whose first reply fails: the parent is saved before anything else, the re-run posts no second parent
      { label: 'fresh1', failReplyOnce: 1, writeJson: { path: ledgerPath(rdFresh), merge: { generatedAt: '2026-10-19T08:00:00.000Z' } }, cmd: [SR, ...base(rdFresh), '--send'] },
      { label: 'fresh2', cmd: [SR, ...base(rdFresh), '--send'] },
    ],
  };
  let mock = null;
  const runMock = () => {
    if (mock) return mock;
    const scp = join(home, 'scenario.json');
    writeFileSync(scp, JSON.stringify(scenario));
    const h = spawnSync('node', [join(HUB, 'scripts', 'selftest', 'slack-mock.mjs'), scp], { encoding: 'utf8', timeout: 240000 });
    assert(h.status === 0, `mock harness failed (${h.status}): ${h.stderr.slice(0, 600)}`);
    const out = JSON.parse(h.stdout);
    mock = { out, S: Object.fromEntries(out.steps.map((s) => [s.label, s])) };
    return mock;
  };
  const calls = (s) => s.requests.filter((r) => !r.rateLimited).map((r) => r.method).filter((m) => m !== 'auth.test');
  const said = (s) => `${s.label} (${s.status}): ${calls(s).join(',')}\n${s.stdout}${s.stderr}`.slice(0, 1200);
  const writes = (s) => s.requests.filter((r) => /^chat\./.test(r.method));

  check('slack-report, end to end against a local mock Slack: parent + one reply per ticket in its thread; unchanged → zero calls; a changed parent or reply → only that one edited; --replies writes the jsonl and posts nothing; a shrinking ticket set deletes the surplus replies; refusals send nothing; nothing secret in any request', () => {
    const { out, S } = runMock();
    for (const s of out.steps) {
      assert(!(s.stdout + s.stderr).includes(TOKEN), `${s.label} printed the token`);
      assert(s.requests.every((r) => r.authOk), `${s.label} sent a request without the test token`);
      const bodies = JSON.stringify(s.requests.map((r) => r.body));
      for (const t of [TOKEN, ...NEVER, 'qa+leak', 'NEEDS_MANUAL']) assert(!bodies.includes(t), `${s.label} sent "${t}" to Slack: ${bodies.slice(0, 600)}`);
    }
    // 1: the parent, then 4 replies in its thread, in order
    assert(S.send1.status === 0 && calls(S.send1).join() === Array(5).fill('chat.postMessage').join(), said(S.send1));
    const b1 = S.send1.requests.map((r) => r.body);
    const parent = out.messages.find((m) => !m.thread_ts && /QA results/.test(m.text) && m.text.includes('2026-10-17'));
    assert(parent && !b1[0].thread_ts && b1.slice(1).every((b) => b.thread_ts === parent.ts && b.channel === CH && b.unfurl_links === false), 'the replies were not posted in the run\'s thread');
    assert(/^\*SEL-2 · /.test(b1[1].text) && /Steps to reproduce/.test(b1[1].text) && /^\*SEL-3 · /.test(b1[2].text) && /^\*Passed\*/.test(b1[3].text) && /^\*Questions for the team\*/.test(b1[4].text), `send1 reply order:\n${b1.map((b) => b.text.split('\n')[0]).join('\n')}`);
    const st1Replies = b1.slice(1).map((b) => b.text.split('\n')[0]);
    // 2: nothing changed — no Slack call at all
    assert(S.send2.status === 0 && S.send2.requests.length === 0 && /already posted, unchanged/.test(S.send2.stdout), said(S.send2));
    // 3: only the parent changed (the date) — one chat.update, on the parent
    assert(S.send3.status === 0 && calls(S.send3).join() === 'chat.update' && S.send3.requests.find((r) => r.method === 'chat.update').body.ts === parent.ts, said(S.send3));
    // 4: one case of SEL-2 changed — one chat.update, on the SEL-2 reply only
    const sel2 = out.messages.find((m) => m.thread_ts === parent.ts && /^\*SEL-2 · /.test(m.text));
    assert(S.send4.status === 0 && calls(S.send4).join() === 'chat.update' && writes(S.send4)[0].body.ts === sel2.ts && /saved, with a confirmation/.test(writes(S.send4)[0].body.text), said(S.send4));
    // --replies: the human reply lands in the jsonl, nothing is posted; a second read adds nothing
    const jl = join(rd, `_SLACK-REPORT-REPLIES-${RUN}.jsonl`);
    assert(S.replies.status === 0 && writes(S.replies).length === 0 && calls(S.replies).every((m) => m === 'conversations.replies'), said(S.replies));
    const rows = existsSync(jl) ? readFileSync(jl, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
    assert(rows.length === 1 && rows[0].ts === out.labels.h1 && rows[0].text === 'TC-2 is fixed on the next build' && rows[0].user === 'U0HUMAN01', `jsonl rows: ${JSON.stringify(rows)}`);
    assert(/1 new human reply/.test(S.replies.stdout) && /TC-2 is fixed on the next build/.test(S.replies.stdout) && /NOT an approval/.test(S.replies.stdout), said(S.replies));
    assert(S.replies2.status === 0 && /0 new human replies/.test(S.replies2.stdout) && readFileSync(jl, 'utf8').trim().split('\n').length === 1, said(S.replies2));
    // 5: a person's reply in the thread changes nothing for the poster
    assert(S.send5.status === 0 && S.send5.requests.length === 0, said(S.send5));
    // shrink: SEL-3 and the questions drop out — the parent and reply 2 are edited, the last two deleted
    const del = writes(S.shrink).filter((r) => r.method === 'chat.delete');
    const upd = writes(S.shrink).filter((r) => r.method === 'chat.update');
    assert(S.shrink.status === 0 && del.length === 2 && upd.length === 2 && !writes(S.shrink).some((r) => r.method === 'chat.postMessage'), said(S.shrink));
    assert(upd[0].body.ts === parent.ts && /^\*Passed\*/.test(upd[1].body.text) && /deleted 2/.test(S.shrink.stdout), said(S.shrink));
    const thread = out.messages.filter((m) => m.thread_ts === parent.ts);
    assert(thread.length === 3 && thread.filter((m) => m.bot_id).length === 2 && thread.some((m) => m.ts === out.labels.h1), `after the shrink the thread has: ${thread.map((m) => `${m.bot_id ? 'bot' : 'human'}:${m.text.split('\n')[0]}`).join(' | ')}`);
    assert(!thread.some((m) => /SEL-3|Questions for the team/.test(m.text)), 'a deleted reply is still in the thread');
    const st = JSON.parse(readFileSync(statePath(rd), 'utf8'));
    assert(st.channelId === CH && st.threadTs === parent.ts && st.replies.length === 2 && st.replies.map((r) => r.key).join() === 'SEL-2,passed' && st.replies.every((r) => /^[0-9a-f]{64}$/.test(r.hash) && r.ts) && /^[0-9a-f]{64}$/.test(st.contentHash) && /^[0-9a-f]{64}$/.test(st.parentHash) && !('replyTs' in st), `state: ${JSON.stringify(st)}`);
    assert(S.send6.status === 0 && S.send6.requests.length === 0, said(S.send6));
    assert(st1Replies.length === 4, 'send1 posted the wrong number of replies');
    // refusals and skips: no request reaches Slack
    assert(S.unconfigured.status === 0 && /skipped/.test(S.unconfigured.stdout) && !S.unconfigured.requests.length, said(S.unconfigured));
    assert(S.gates.status === 1 && /gates FAILED/.test(S.gates.stderr) && !S.gates.requests.length, said(S.gates));
    assert(S.foreign.status === 1 && /not SEL-/.test(S.foreign.stderr) && !S.foreign.requests.length, said(S.foreign));
    assert(S.leak.status === 1 && /leak guard/.test(S.leak.stderr) && !S.leak.requests.length, said(S.leak));
    assert(S['remote-base'].status === 2 && /local test server/.test(S['remote-base'].stderr) && !S['remote-base'].requests.length, said(S['remote-base']));
    assert(S['real-token'].status === 2 && /only ever gets a test token/.test(S['real-token'].stderr) && !S['real-token'].requests.length, said(S['real-token']));
    // the lock is released when a poster exits (no leftover for the next run to take over)
    for (const d of [rd, rdCrash, rdRl, rdMig, rdGone, rdFresh]) assert(!existsSync(join(d, `_SLACK-REPORT-${RUN}.lock`)), `a poster left its lock file behind in ${d}`);
    // a channel change after posting: refused, never a second thread in another channel
    const moved = join(home, 'cfg-moved.json');
    writeFileSync(moved, JSON.stringify({ projects: { selftest: { channelId: 'C0MOVEDCH1', ...AUTH } } }));
    const env = { QA_SLACK_API_BASE: 'http://127.0.0.1:9', QA_SLACK_BOT_TOKEN: TOKEN };
    mustReject(direct([...base(rd, moved), '--send'], env), 'refusing to cross channels', 'slack-report, a channel change after posting');
    mustReject(direct([...base(rd, moved), '--replies'], env), 'refusing to cross channels', 'slack-report --replies, a channel change after posting');
    // the lock: a live holder refuses a second poster before any network call
    writeFileSync(ledgerPath(rd), JSON.stringify(LEDGER({ generatedAt: '2026-10-18T08:00:00.000Z' })));
    const lock = join(rd, `_SLACK-REPORT-${RUN}.lock`);
    writeFileSync(lock, String(process.pid));
    mustReject(direct([...base(rd), '--send'], env), 'another slack-report', 'slack-report, a second poster while one holds the lock');
    mustReject(direct([...base(rd), '--replies'], env), 'another slack-report', 'slack-report --replies while a poster holds the lock');
    assert(readFileSync(lock, 'utf8') === String(process.pid), 'a refused poster removed the live holder\'s lock');
  });

  check('slack-report against the mock: a 429 is retried after Retry-After (one parent, no duplicate); a crash mid-sequence converges on the re-run (only the missing replies posted, no second thread); the first state shape { replyTs } is migrated — its parent and reply edited in place, the rest posted, no new parent', () => {
    const { out, S } = runMock();
    // 429
    const rl = S.ratelimit;
    assert(rl.status === 0 && rl.requests.filter((r) => r.rateLimited).length === 1 && rl.requests[0].rateLimited && rl.requests[0].method === 'chat.postMessage', said(rl));
    assert(calls(rl).join() === Array(5).fill('chat.postMessage').join(), `after the 429: ${calls(rl)}`);
    const rst = JSON.parse(readFileSync(statePath(rdRl), 'utf8'));
    assert(out.messages.filter((m) => !m.thread_ts && m.ts === rst.threadTs).length === 1 && out.messages.filter((m) => m.thread_ts === rst.threadTs).length === 4 && rst.replies.length === 4, `429 run: state ${JSON.stringify(rst)}`);
    // crash
    assert(S.crash1.status === 1 && /Slack API error/.test(S.crash1.stderr) && /the next --send finishes the rest/.test(S.crash1.stderr) && calls(S.crash1).join() === 'chat.postMessage,chat.postMessage,chat.postMessage', said(S.crash1));
    const cst = JSON.parse(readFileSync(statePath(rdCrash), 'utf8'));
    const cParent = out.messages.filter((m) => !m.thread_ts && m.ts === cst.threadTs);
    assert(cParent.length === 1, 'the crash run has no saved parent');
    assert(S.crash2.status === 0 && calls(S.crash2).join() === 'chat.postMessage,chat.postMessage,chat.postMessage' && writes(S.crash2).every((r) => r.body.thread_ts === cst.threadTs), `crash2 must post only the 3 missing replies in the same thread: ${said(S.crash2)}`);
    assert(out.messages.filter((m) => m.thread_ts === cst.threadTs).length === 4 && cst.replies.length === 4 && /^[0-9a-f]{64}$/.test(cst.contentHash), `crash run: ${out.messages.filter((m) => m.thread_ts === cst.threadTs).length} replies, state ${JSON.stringify(cst)}`);
    assert(S.crash3.status === 0 && S.crash3.requests.length === 0, said(S.crash3));
    // migration from { replyTs }
    const oldP = out.labels['old-parent'];
    const oldR = out.labels['old-reply'];
    const mw = writes(S.mig);
    assert(S.mig.status === 0 && calls(S.mig).join() === 'chat.update,chat.update,chat.postMessage,chat.postMessage,chat.postMessage', said(S.mig));
    assert(mw[0].body.ts === oldP && /QA results/.test(mw[0].body.text) && mw[1].body.ts === oldR && /^\*SEL-2 · /.test(mw[1].body.text) && mw.slice(2).every((r) => r.body.thread_ts === oldP), `migration edits: ${JSON.stringify(mw.map((r) => [r.method, r.body.ts || r.body.thread_ts]))}`);
    const mst = JSON.parse(readFileSync(statePath(rdMig), 'utf8'));
    assert(mst.threadTs === oldP && mst.replies.length === 4 && mst.replies[0].ts === oldR && mst.replies[0].key === 'SEL-2' && !('replyTs' in mst), `migrated state: ${JSON.stringify(mst)}`);
    assert(out.messages.filter((m) => m.thread_ts === oldP).length === 4 && !out.messages.some((m) => m.text === 'Per ticket (first format)' || m.text === 'QA results (first format)'), 'the migration left the first-format messages or posted a new parent');
    assert(S.mig2.status === 0 && S.mig2.requests.length === 0, said(S.mig2));
  });

  check('slack-report against the mock: a reply deleted in Slack is re-posted into its slot; a deleted parent is refused ("thread deleted", nothing more sent) and --send --reset starts a fresh thread keeping the question numbers; a fresh thread whose first reply fails never gets a second parent', () => {
    const { out, S } = runMock();
    const top = (s) => writes(s).filter((r) => r.method === 'chat.postMessage' && !r.body.thread_ts);
    assert(S.gone1.status === 0 && calls(S.gone1).join() === Array(5).fill('chat.postMessage').join(), said(S.gone1));
    const p1 = top(S.gone1).length === 1 ? S.gone1.requests.find((r) => r.method === 'chat.postMessage').body : null;
    const g = writes(S['gone-reply']);
    assert(S['gone-reply'].status === 0 && calls(S['gone-reply']).join() === 'chat.update,chat.postMessage' && g[1].body.thread_ts && /^\*SEL-2 · /.test(g[1].body.text) && /saved, with a confirmation/.test(g[1].body.text), `the deleted reply was not re-posted: ${said(S['gone-reply'])}`);
    assert(p1 && S['gone-reply2'].status === 0 && S['gone-reply2'].requests.length === 0, said(S['gone-reply2']));
    const gp = S['gone-parent'];
    assert(gp.status === 1 && /thread deleted/.test(gp.stderr) && /--send --reset/.test(gp.stderr) && calls(gp).join() === 'chat.update', `a deleted parent: ${said(gp)}`);
    const gr = S['gone-reset'];
    assert(gr.status === 0 && calls(gr).join() === Array(5).fill('chat.postMessage').join() && top(gr).length === 1 && writes(gr).slice(1).every((r) => r.body.thread_ts), `--send --reset: ${said(gr)}`);
    const gst = JSON.parse(readFileSync(statePath(rdGone), 'utf8'));
    const newParent = out.messages.find((m) => !m.thread_ts && m.ts === gst.threadTs);
    assert(newParent && /2026-10-18/.test(newParent.text) && gst.previousThreadTs && gst.previousThreadTs !== gst.threadTs && gst.replies.length === 4, `state after the reset: ${JSON.stringify(gst)}`);
    assert(JSON.stringify(gst.qNumbers) === JSON.stringify({ 'SEL-3/Q1': 1, [gid('SEL-3', 'No reason was recorded')]: 2 }), `the question numbers changed on the reset: ${JSON.stringify(gst.qNumbers)}`);
    assert(S['gone-reset2'].status === 0 && S['gone-reset2'].requests.length === 0, said(S['gone-reset2']));
    // fresh thread, first reply fails
    assert(S.fresh1.status === 1 && calls(S.fresh1).join() === 'chat.postMessage,chat.postMessage' && top(S.fresh1).length === 1, said(S.fresh1));
    assert(S.fresh2.status === 0 && top(S.fresh2).length === 0 && calls(S.fresh2).filter((m) => m === 'chat.postMessage').length === 4, `the re-run posted a second parent: ${said(S.fresh2)}`);
    assert(out.messages.filter((m) => !m.thread_ts && m.text.includes('2026-10-19')).length === 1, 'the fresh run has more (or fewer) than one parent');
  });
}
