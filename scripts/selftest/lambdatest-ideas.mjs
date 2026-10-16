// Selftest section for the pieces taken from LambdaTest/agent-skills (MIT) on 2026-10-16 (see
// _IDEAS-FROM-REPOS.md): the three objective-shape lint warnings (plan-lint), failed backend calls in
// capture() evidence → run-result-validate, and the preflight ready check (scripts/preflight.mjs →
// qa-gates). Preflight runs against fake exec/fetch in a child process: no network, no adb, no Simulator.
//
// The bad inputs are real: the build-27 codesign flags (beta, 2026-10-08) and the emulator's
// "unknown host" ping. Every "it warns / stops" check has a sibling proving a good input stays quiet.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { lintPlan } from '../plan-lint.mjs';
import { evalCodesign, evalPing, parseAdbDevices, surfaceHosts, evalSurface } from '../preflight.mjs';

export default function section(h) {
  const { check, assert, run, TMP, HUB } = h;
  const DIR = join(TMP, 'lambdatest-ideas');
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  const put = (name, obj) => {
    const p = join(DIR, name);
    writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) + '\n');
    return p;
  };
  const out = (r) => (r.stdout || '') + (r.stderr || '');
  const node = (script) => {
    const r = spawnSync('node', [script], { encoding: 'utf8' });
    assert(r.status === 0, `child script failed: ${out(r).slice(-800)}`);
    return JSON.parse(r.stdout.trim().split('\n').pop());
  };

  console.log('\nRepo ideas (LambdaTest): objective shape lint, failed backend calls, preflight');

  // ── plan-lint: end on a look at the result ─────────────────────────────────────────────────
  check('plan-lint: asserting the trigger, a "confirm" as the check, and a check that travels each warn', () => {
    const p = { runId: 'R-SELF', steps: [
      { caseId: 'L-1', surface: 's', precond: 'p', actions: ['Fill name "Ada"', 'Click Submit'], expected: 'Submit button is visible', verifyBy: 'button' },
      { caseId: 'L-2', surface: 's', precond: 'p', actions: ['Click Delete on row "Pen"'], expected: 'Click OK to confirm', verifyBy: 'dialog' },
      { caseId: 'L-3', surface: 's', precond: 'p', actions: ['Click Delete on row "Pen"'], expected: 'Confirm the dialog', verifyBy: 'dialog' },
      { caseId: 'L-4', surface: 's', precond: 'p', actions: ['Place the order for "Pen"'], expected: 'Verify it succeeded by checking that it appears in Order History', verifyBy: 'row' },
      { caseId: 'L-5', surface: 's', precond: 'p', actions: ['Place the order for "Pen"'], expected: 'Open Order History and verify the newest order shows "Processing"', verifyBy: 'row' },
    ] };
    const want = { 'L-1': 'asserts-trigger', 'L-2': 'confirm-as-check', 'L-3': 'confirm-as-check', 'L-4': 'check-needs-navigation', 'L-5': 'check-needs-navigation' };
    const r = lintPlan(p, 'lt');
    for (const [id, code] of Object.entries(want)) assert(r.warnings.some((w) => w.caseId === id && w.code === code), `${id} should warn ${code}; got ${JSON.stringify(r.warnings.map((w) => [w.caseId, w.code]))}`);
    assert(!r.errors.length, `warnings-only plan raised errors: ${r.errors.map((e) => e.code).join(', ')}`);
  });

  check('plan-lint: a presence check, a dialog read as text, and a route kept in the actions stay quiet', () => {
    const p = { runId: 'R-SELF', steps: [
      { caseId: 'Q-1', surface: 's', precond: 'p', actions: ['Open the invoice page'], expected: 'Download button is visible', verifyBy: 'button' },
      { caseId: 'Q-2', surface: 's', precond: 'p', actions: ['Click Delete on row "Pen"'], expected: 'Confirmation dialog reads "Delete Pen?"; Cancel is a no-op', verifyBy: 'dialog text' },
      { caseId: 'Q-3', surface: 's', precond: 'p', actions: ['Place the order for "Pen"', 'Open Order History'], expected: 'Newest order row shows "Processing"', verifyBy: 'row text' },
    ] };
    const r = lintPlan(p, 'quiet');
    const mine = r.warnings.filter((w) => ['asserts-trigger', 'confirm-as-check', 'check-needs-navigation'].includes(w.code));
    assert(!mine.length, `good cases flagged: ${JSON.stringify(mine.map((w) => [w.caseId, w.code]))}`);
  });

  // ── failed backend calls: recorder → capture evidence → validator ───────────────────────────
  check('attachRecorder keeps failed API calls with their message; failedCallsSince returns 5xx first, skips telemetry and documents, and resets per capture', () => {
    const script = put('failed-calls.mjs', `
import { attachRecorder, failedCallsSince } from ${JSON.stringify(join(HUB, 'harness/lib/evidence.mjs'))};
const handlers = {};
const page = attachRecorder({ on: (ev, fn) => { handlers[ev] = fn; } });
const res = (type, method, url, status, body = '') => ({
  request: () => ({ resourceType: () => type, method: () => method }),
  url: () => url, status: () => status,
  text: () => new Promise((r) => setTimeout(() => r(body), 30)),
});
handlers.response(res('xhr', 'GET', 'https://api.example/me', 200));
handlers.response(res('fetch', 'POST', 'https://api.example/offer', 422, '{"message":"Amount must be above 0"}'));
handlers.response(res('xhr', 'PUT', 'https://api.example/listing/7', 500, '{"error":"db timeout"}'));
handlers.response(res('xhr', 'POST', 'https://www.google-analytics.com/g/collect', 400));
handlers.response(res('document', 'GET', 'https://app.example/missing', 404));
const first = await failedCallsSince(page.__qa);
const second = await failedCallsSince(page.__qa);
handlers.response(res('xhr', 'DELETE', 'https://api.example/doc/1', 403, 'forbidden'));
const third = await failedCallsSince(page.__qa);
console.log(JSON.stringify({ first, second, third }));
`);
    const r = node(script);
    assert(r.first.length === 2, `want the 422 and the 500 only: ${JSON.stringify(r.first)}`);
    assert(r.first[0].status === 500 && r.first[0].message === '{"error":"db timeout"}', `5xx not first or message missing: ${JSON.stringify(r.first)}`);
    assert(r.first[1].status === 422 && /Amount must be above 0/.test(r.first[1].message || ''), `422 message missing: ${JSON.stringify(r.first)}`);
    assert(r.second.length === 0, `calls repeated in the next capture: ${JSON.stringify(r.second)}`);
    assert(r.third.length === 1 && r.third[0].status === 403, `a later failure was not reported: ${JSON.stringify(r.third)}`);
  });

  check('run-result-validate warns on a failed backend call the case did not expect, and not on the status a negative case asserts', () => {
    const rd = join(DIR, 'fc');
    mkdirSync(rd, { recursive: true });
    const ev = (failedCalls) => ({ url: 'https://app.example/x', host: 'app.example', httpStatus: 200, statusSource: 'document', selector: '.toast', observedText: 'Saved', buildId: 'index-abc.js', screenshot: null, ...(failedCalls ? { failedCalls } : {}) });
    const res = (caseId, expected, failedCalls) => ({ caseId, plannedSurface: 'app.example', expected, actual: null, ranOk: true, error: null, evidence: ev(failedCalls), startedAt: '2026-10-16T00:00:00Z', finishedAt: '2026-10-16T00:00:01Z' });
    writeFileSync(join(rd, '_RESULT-R-SELFFC-T-1.json'), JSON.stringify({ schemaVersion: 1, ticketId: 'T-1', project: 'x', runId: 'R-SELFFC', buildId: 'index-abc.js', startedAt: '2026-10-16T00:00:00Z', finishedAt: '2026-10-16T00:00:01Z', results: [
      res('C-1', 'Toast "Saved"', [{ method: 'PUT', url: 'https://api.example/listing/7?x=1', status: 500, message: '{"error":"db timeout"}' }]),
      res('C-2', 'Inline error "Amount must be above 0"; POST /offer returns 422', [{ method: 'POST', url: 'https://api.example/offer', status: 422, message: 'Amount must be above 0' }]),
      res('C-3', 'Toast "Saved"', null),
    ] }));
    const o = out(run('run-result-validate.mjs', ['--dir', rd, '--run', 'R-SELFFC']));
    assert(/C-1[^\n]*1 backend call\(s\) failed[^\n]*PUT \/listing\/7 → 500 "\{"error":"db timeout"\}"/.test(o), `no failed-call warning for C-1:\n${o}`);
    assert(!/C-2[^\n]*backend call/.test(o), `the 422 a negative case asserts warned:\n${o}`);
    assert(!/C-3[^\n]*backend call/.test(o), `a case with no failed calls warned:\n${o}`);
  });

  // ── preflight: pure evaluators with the real bad strings ─────────────────────────────────────
  check('preflight evaluators: build-27 linker-signed and unsigned builds STOP, build-32 adhoc passes; "unknown host" STOPs, a resolved ping passes', () => {
    const bad = evalCodesign('ios', 'Beta.app', { status: 0, stderr: 'Executable=/x/Beta.app/Beta\nCodeDirectory v=20400 size=1234 flags=0x20002(adhoc,linker-signed) hashes=10+0 location=embedded\nSignature=adhoc' });
    assert(bad.level === 'stop' && /linker-signed/.test(bad.msg), `linker-signed passed: ${JSON.stringify(bad)}`);
    const unsigned = evalCodesign('ios', 'Beta.app', { status: 1, stderr: 'Beta.app: code object is not signed at all' });
    assert(unsigned.level === 'stop', `unsigned build passed: ${JSON.stringify(unsigned)}`);
    const good = evalCodesign('ios', 'Beta.app', { status: 0, stderr: 'CodeDirectory v=20400 size=1234 flags=0x2(adhoc) hashes=3+7 location=embedded\nSignature=adhoc' });
    assert(good.level === 'ok', `adhoc build stopped: ${JSON.stringify(good)}`);
    const dns = evalPing('emulator-5556', { status: 2, stdout: '', stderr: 'ping: unknown host google.com' });
    assert(dns.level === 'stop' && /dns-server 8\.8\.8\.8/.test(dns.fix || ''), `unknown host passed: ${JSON.stringify(dns)}`);
    const lossOnly = evalPing('emulator-5556', { status: 1, stdout: 'PING google.com (64.233.162.139) 56(84) bytes of data.\n1 packets transmitted, 0 received, 100% packet loss' });
    assert(lossOnly.level === 'ok', `packet loss with DNS resolved stopped: ${JSON.stringify(lossOnly)}`);
    const devs = parseAdbDevices('List of devices attached\nemulator-5554\tdevice\nemulator-5556\toffline\n\n');
    assert(devs.length === 2 && devs[0].state === 'device' && devs[1].state === 'offline', `adb devices parse: ${JSON.stringify(devs)}`);
  });

  check('preflight surfaces: forbidden hosts, app ids and notes are never requested; 5xx STOPs; a redirect into a forbidden host warns', () => {
    const profile = { surfaces: { web: 'app.example', admin: 'https://admin.example/login', android: 'com.example.app', webNote: 'see app.example docs', dup: 'app.example', bad: 'prod.example', forbidden: ['prod.example'] } };
    const { hosts, clashes, forbidden } = surfaceHosts(profile);
    assert(JSON.stringify(hosts.map((x) => x.host)) === '["app.example","admin.example"]', `hosts: ${JSON.stringify(hosts)}`);
    assert(clashes.length === 1 && clashes[0].host === 'prod.example', `forbidden surface not flagged: ${JSON.stringify(clashes)}`);
    assert(evalSurface(hosts[0], { status: 502 }, forbidden).level === 'stop', '502 did not stop');
    assert(evalSurface(hosts[0], { status: 404 }, forbidden).level === 'ok', 'a 404 root (API host) stopped');
    assert(evalSurface(hosts[0], { status: 301, location: 'https://prod.example/' }, forbidden).level === 'warn', 'redirect into a forbidden host did not warn');
    assert(evalSurface(hosts[0], { error: 'does not resolve in DNS (ENOTFOUND)' }, forbidden).level === 'stop', 'DNS failure did not stop');
  });

  // ── preflight end to end with fake exec/fetch ───────────────────────────────────────────────
  check('preflight end to end: every broken prerequisite STOPs, nothing forbidden is fetched, redirects are not followed, and the Jira token never reaches the output', () => {
    const app = join(DIR, 'Beta.app');
    mkdirSync(app, { recursive: true });
    const tok = put('jira-token.md', '- **Email:** qa@example.com\n- **Token:** `SECRET-TOKEN-1234567890`\n');
    const script = put('preflight-e2e.mjs', `
import { runPreflight } from ${JSON.stringify(join(HUB, 'scripts/preflight.mjs'))};
const profile = {
  platform: ['web', 'android', 'ios'],
  surfaces: { web: 'app.example', admin: 'admin.example', android: 'com.example.app', ios: 'com.example.ios', forbidden: ['prod.example'] },
  buildProbe: { probes: [{ name: 'ios', kind: 'ios-app', path: ${JSON.stringify(app)} }] },
  jira: { site: 'https://jira.example', tokenFile: ${JSON.stringify(tok)} },
};
const scenario = process.argv[2] || 'broken';
const fetched = [];
const fetch = async (url, init) => {
  fetched.push({ url, redirect: init.redirect, auth: !!(init.headers || {}).Authorization });
  if (url.includes('/rest/api/3/myself')) return { status: scenario === 'broken' ? 401 : 200, headers: { get: () => null } };
  if (scenario === 'broken' && url.includes('admin.example')) { const e = new Error('fetch failed'); e.cause = { code: 'ENOTFOUND' }; throw e; }
  if (url.includes('app.example')) return { status: 301, headers: { get: (h) => (h === 'location' ? 'https://prod.example/' : null) } };
  return { status: 200, headers: { get: () => null } };
};
const exec = (cmd, args) => {
  const a = args.join(' ');
  if (a === 'devices') return { status: 0, stdout: 'List of devices attached\\nemulator-5556\\tdevice\\n' };
  if (a.includes('ping')) return scenario === 'broken' ? { status: 2, stdout: '', stderr: 'ping: unknown host google.com' } : { status: 0, stdout: 'PING google.com (64.233.162.139) 56(84) bytes' };
  if (a.includes('pm path')) return { status: 0, stdout: 'package:/data/app/base.apk' };
  if (cmd === 'xcrun' && a.startsWith('simctl list')) return { status: 0, stdout: JSON.stringify({ devices: { r: [{ udid: 'U1', name: 'qa-sim', state: 'Booted' }] } }) };
  if (cmd === 'xcrun') return { status: 0, stdout: '/x' };
  if (cmd === 'codesign') return { status: 0, stderr: scenario === 'broken' ? 'CodeDirectory v=20400 flags=0x20002(adhoc,linker-signed) hashes=10+0' : 'CodeDirectory v=20400 flags=0x2(adhoc) hashes=3+7' };
  return { status: 127, stdout: '', stderr: 'unexpected ' + cmd + ' ' + a };
};
const r = await runPreflight({ profile, slug: 'selftest', onlyChecks: ['gate', 'surfaces', 'android', 'ios', 'tracker'], reportsDir: '/nonexistent' },
  { exec, fetch, configProblem: () => (scenario === 'broken' ? 'R-01 CONFIG UNSAFE: a write tool is in permissions.allow' : null) });
console.log(JSON.stringify({ r, fetched, raw: JSON.stringify(r) }));
`);
    const broken = spawnSync('node', [script, 'broken'], { encoding: 'utf8' });
    assert(broken.status === 0, `child failed: ${out(broken).slice(-800)}`);
    const b = JSON.parse(broken.stdout.trim().split('\n').pop());
    const stops = b.r.checks.filter((c) => c.level === 'stop').map((c) => c.check).sort();
    assert(JSON.stringify(stops) === '["android","gate","ios","surfaces"]', `want stops on gate, surfaces, android, ios: ${JSON.stringify(b.r.checks)}`);
    assert(b.r.ready === false, 'ready with stops');
    assert(b.r.checks.some((c) => c.check === 'tracker' && c.level === 'warn' && /rejected \(401\)/.test(c.msg)), `Jira 401 not a warning: ${JSON.stringify(b.r.checks)}`);
    assert(b.r.checks.some((c) => c.check === 'surfaces' && c.level === 'warn' && /prod\.example/.test(c.msg)), 'redirect into forbidden host not reported');
    assert(!b.fetched.some((x) => /prod\.example/.test(x.url)), `a forbidden host was fetched: ${JSON.stringify(b.fetched)}`);
    assert(b.fetched.every((x) => x.redirect === 'manual'), `a request followed redirects: ${JSON.stringify(b.fetched)}`);
    assert(!/SECRET-TOKEN/.test(b.raw) && !/SECRET-TOKEN/.test(out(broken)), 'the Jira token reached the output');
    const fine = spawnSync('node', [script, 'fine'], { encoding: 'utf8' });
    const g = JSON.parse(fine.stdout.trim().split('\n').pop());
    assert(g.r.ready === true && !g.r.checks.some((c) => c.level === 'stop'), `a healthy environment stopped: ${JSON.stringify(g.r.checks)}`);
  });

  check('preflight CLI refuses a missing --project and --write without --run; qa-gates fails while a STOP is on record and adds no row without the file', () => {
    assert(run('preflight.mjs', []).status === 2, 'no --project accepted');
    assert(run('preflight.mjs', ['--project', 'alpha', '--write']).status === 2, '--write without --run accepted');
    assert(run('preflight.mjs', ['--project', 'alpha', '--only', 'bogus']).status === 2, 'unknown check accepted');
    const rd = join(DIR, 'gates');
    mkdirSync(rd, { recursive: true });
    const none = run('qa-gates.mjs', ['--project', 'selftest', '--run', 'R-SELFPF', '--reports-dir', rd]);
    assert(!/preflight/.test(out(none)), `preflight row without a file:\n${out(none).slice(-400)}`);
    const pf = (level) => JSON.stringify({ schemaVersion: 1, project: 'selftest', runId: 'R-SELFPF', at: '2026-10-16T00:00:00Z', platforms: ['web'], checks: [{ check: 'gate', level: 'ok', msg: 'safe' }, { check: 'surfaces', level, msg: 'admin (admin.example) answers 502' }], next: [], ready: level !== 'stop' });
    writeFileSync(join(rd, '_PREFLIGHT-R-SELFPF.json'), pf('stop'));
    const bad = run('qa-gates.mjs', ['--project', 'selftest', '--run', 'R-SELFPF', '--reports-dir', rd]);
    assert(bad.status !== 0 && /preflight STOP/.test(out(bad)), `a STOP on record passed qa-gates (exit ${bad.status}):\n${out(bad).slice(-600)}`);
    writeFileSync(join(rd, '_PREFLIGHT-R-SELFPF.json'), pf('warn'));
    const ok = run('qa-gates.mjs', ['--project', 'selftest', '--run', 'R-SELFPF', '--reports-dir', rd]);
    assert(ok.status === 0 && /preflight/.test(out(ok)), `a clean preflight failed qa-gates (exit ${ok.status}):\n${out(ok).slice(-600)}`);
  });
}
