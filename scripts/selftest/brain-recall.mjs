// Selftest section for scripts/brain-recall.mjs — the brain recall hooks.
//
// Recall is only worth its context if it is quiet when nothing matches and loud when something does:
// an injection on every "ok go" teaches the model to ignore it, and a missed match is the 2026-10-15
// state this replaced (lessons on disk, never shown). Every check runs against a hand-built vault under
// TMP — never ~/My Workflow — and each "it stays quiet" check has a sibling proving the match still fires.

import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const page = (fm, body) => `---\n${Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n\n${body}\n`;

export default function section(h) {
  const { check, assert, TMP, HUB } = h;
  const DIR = join(TMP, 'brain-recall');
  rmSync(DIR, { recursive: true, force: true });
  const V = join(DIR, 'vault');
  const STATE = join(DIR, 'state');
  for (const d of ['failures', 'patterns', 'projects']) mkdirSync(join(V, 'wiki', d), { recursive: true });

  writeFileSync(join(V, 'wiki/failures/emulator-dns.md'), page(
    { title: 'Android emulator shows No internet', type: 'failure', status: 'recurring', severity: 'medium', updated: '2026-10-01',
      keywords: '[android emulator, no internet, dns1]', tags: '[android, qa-hub]' },
    '# x\n\n## Description\nd\n\n## What I learned\n- Cold-restart the emulator with `-dns-server 8.8.8.8`; runtime fixes do not stick.\n- Check net.dns1 first.\n\n## Recall keywords\nx'));
  writeFileSync(join(V, 'wiki/failures/alpha-cache.md'), page(
    { title: 'Cache cannot prove a ticket is missing', type: 'failure', status: 'resolved', severity: 'high', updated: '2026-09-01',
      keywords: '[cache blind spot, gap claim]', tags: '[alpha]' },
    '## What I learned\n- Do a complete live team list before any gap claim on alpha.\n'));
  writeFileSync(join(V, 'wiki/failures/hub-gates.md'), page(
    { title: 'Gates passed vacuously', type: 'failure', status: 'open', severity: 'high', updated: '2026-10-02',
      keywords: '[vacuous gate, skipped gate]', tags: '[qa-hub, gates]' },
    '## What I learned\n- A skipped gate is not a passed gate.\n'));
  writeFileSync(join(V, 'wiki/failures/broken.md'), '---\ntitle: [unterminated\nkeywords: [\n'); // malformed: must not crash
  writeFileSync(join(V, 'wiki/patterns/slack-copy.md'), page(
    { title: 'Never post as Claude in Slack', type: 'pattern', status: 'active', tags: '[slack]' }, '## Pattern\nGive copy-paste text.'));
  writeFileSync(join(V, 'wiki/projects/alpha-store.md'), page(
    { title: 'Alpha (marketplace)', type: 'project', status: 'active', tags: '[qa-hub, alpha]', aliases: '[alpha, alphastore]' },
    '## Status\nR21 verified; staging only.\n'));
  writeFileSync(join(V, 'log.md'), [
    '# Log', '', '## [2026-10-14] note | filed from conversation — real entry ONE', '',
    '## [2026-10-15] note | session ended (2026-10-15 10:00)', 'cwd: x', '',
    '## [2026-10-15] note | session ended (2026-10-15 10:01)', ''].join('\n'));

  const SCRIPT = join(HUB, 'scripts', 'brain-recall.mjs');
  const recall = (args, stdin = '', vault = V) =>
    spawnSync(process.execPath, [SCRIPT, '--vault', vault, '--state-dir', STATE, ...args], { input: stdin, encoding: 'utf8', timeout: 15000 });
  const prompt = (text, sid = 's1') => recall(['--hook-prompt'], JSON.stringify({ session_id: sid, prompt: text }));

  console.log('\nBrain recall (scripts/brain-recall.mjs)');

  check('session start hides session-end stubs and shows real log entries', () => {
    const r = recall(['--session-start'], '{}');
    assert(r.status === 0, `exit ${r.status}: ${r.stderr}`);
    assert(/real entry ONE/.test(r.stdout), 'real log entry missing');
    assert(!/session ended/.test(r.stdout), 'session-end stub leaked into the preamble');
  });
  check('session start surfaces open + recurring lessons, not resolved ones', () => {
    const r = recall(['--session-start'], '{}');
    assert(/dns-server 8\.8\.8\.8/.test(r.stdout), 'recurring failure lesson missing');
    assert(/skipped gate is not a passed gate/.test(r.stdout), 'open failure lesson missing');
    assert(!/complete live team list/.test(r.stdout), 'resolved failure leaked into the active list');
  });
  check('a prompt matching a failure keyword injects that lesson', () => {
    const r = prompt('the android emulator has no internet again', 'match');
    assert(r.status === 0 && /dns-server 8\.8\.8\.8/.test(r.stdout), `no injection: ${r.stdout}${r.stderr}`);
  });
  check('an off-topic prompt injects nothing', () => {
    const r = prompt('what is the weather like in tashkent tomorrow', 'offtopic');
    assert(r.status === 0 && r.stdout.trim() === '', `injected on an off-topic prompt: ${r.stdout}`);
  });
  check('short prompts and slash commands inject nothing', () => {
    for (const p of ['ok go', '/brain-status android emulator no internet']) {
      const r = prompt(p, 'short');
      assert(r.stdout.trim() === '', `injected on "${p}"`);
    }
  });
  check('the same lesson is injected once per session, again in a new session', () => {
    const a = prompt('android emulator no internet', 'dedupe');
    const b = prompt('android emulator no internet still', 'dedupe');
    const c = prompt('android emulator no internet', 'dedupe-2');
    assert(/8\.8\.8\.8/.test(a.stdout), 'first prompt did not inject');
    assert(!/8\.8\.8\.8/.test(b.stdout), 're-injected within the same session');
    assert(/8\.8\.8\.8/.test(c.stdout), 'new session did not inject');
  });
  check('a correction prompt gets the /brain-fail nudge; a normal one does not', () => {
    assert(/brain-fail/.test(prompt('no, that is wrong — you missed the second listing', 'corr').stdout), 'no nudge on a correction');
    assert(!/brain-fail/.test(prompt('now continue with the second listing please', 'corr2').stdout), 'nudge on a non-correction');
  });
  check('pages match by alias and title words', () => {
    const r = recall(['--query', 'QA the alphastore tickets and post in slack', '--json']);
    const j = JSON.parse(r.stdout);
    const rels = j.pages.map((p) => p.rel);
    assert(rels.includes('wiki/projects/alpha-store.md'), `alias miss: ${rels}`);
  });
  check('project dossier: project failures + hub-wide active failures, nothing unrelated', () => {
    const out = join(DIR, 'dossier.md');
    const r = recall(['--project', 'alpha', '--run', 'R-TEST', '--out', out]);
    assert(r.status === 0 && existsSync(out), `dossier not written: ${r.stderr}`);
    const d = readFileSync(out, 'utf8');
    assert(/complete live team list/.test(d), 'project failure (by tag) missing');
    assert(/skipped gate is not a passed gate/.test(d), 'hub-wide open failure missing');
    assert(/R21 verified/.test(d), 'project page status missing');
    assert(!/dns-server/.test(d.split('## Hub-wide')[0]), 'unrelated failure listed as a project failure');
  });
  check('hook modes never fail a session: missing vault → exit 0, silent', () => {
    const r1 = recall(['--session-start'], '{}', join(DIR, 'nope'));
    const r2 = recall(['--hook-prompt'], 'not json', join(DIR, 'nope'));
    assert(r1.status === 0 && r1.stdout === '' && r2.status === 0 && r2.stdout === '', 'hook mode failed or printed without a vault');
  });
  check('manual query on a missing vault fails loudly', () => {
    const r = recall(['--query', 'x'], '', join(DIR, 'nope'));
    assert(r.status !== 0, 'manual mode exited 0 without a vault');
  });

  // Scheduled review (the QA lead 2026-10-16: "set up the 30 Oct check"). Own state dir, so the trust events the
  // checks above logged do not leak into the verdict; the review file sits next to that trust log.
  const RS = join(DIR, 'review-state');
  const RP = join(DIR, 'review-projects');
  mkdirSync(join(RP, 'alpha', 'qa-reports'), { recursive: true });
  writeFileSync(join(RP, 'alpha', 'qa-reports', '_BRAIN-RECALL-R-T1.md'), 'x'.repeat(4000));
  const REVIEW = join(RS, '_BRAIN-REVIEW.json');
  const schedule = (extra = {}) => {
    mkdirSync(RS, { recursive: true });
    writeFileSync(REVIEW, JSON.stringify({ due: '2026-10-30', windowStart: '2026-10-15', setBy: 'test', rule: 'helped=0 → cut', ...extra }));
  };
  const rv = (args, stdin = '') =>
    spawnSync(process.execPath, [SCRIPT, '--vault', V, '--state-dir', RS, '--projects-dir', RP, ...args], { input: stdin, encoding: 'utf8', timeout: 15000 });

  check('brain review: no review scheduled → --review fails loudly, session start stays quiet', () => {
    rmSync(RS, { recursive: true, force: true });
    const r = rv(['--review']);
    assert(r.status === 1 && /no review scheduled/.test(r.stderr), `exit ${r.status}: ${r.stderr}`);
    const s = rv(['--session-start'], '{}');
    assert(s.status === 0 && !/Brain review/.test(s.stdout), 'banner without a scheduled review');
  });
  check('brain review: a countdown line before the due date, the DUE banner on it', () => {
    schedule();
    const before = rv(['--session-start', '--today', '2026-10-20'], '{}');
    assert(/Brain review on 2026-10-30\*\* \(10 days left\)/.test(before.stdout) && !/DUE/.test(before.stdout), `before: ${before.stdout.slice(0, 300)}`);
    const on = rv(['--session-start', '--today', '2026-10-30'], '{}');
    assert(/Brain review DUE \(2026-10-30\)/.test(on.stdout), `due day: ${on.stdout.slice(0, 300)}`);
  });
  check('brain review: no outcomes → NO-OUTCOMES (never KEEP); missed → CUT-PROMPT; helped → KEEP', () => {
    schedule();
    rmSync(join(RS, '_BRAIN-TRUST.jsonl'), { force: true });
    rv(['--hook-prompt'], JSON.stringify({ session_id: 'rv1', prompt: 'the android emulator shows no internet again' }));
    const none = JSON.parse(rv(['--review', '--json']).stdout);
    assert(none.ev.injected >= 1 && none.outcomes === 0 && none.verdict === 'NO-OUTCOMES', `no outcomes: ${none.verdict} inj ${none.ev.injected}`);
    assert(none.dossiers.length === 1 && none.dossiers[0].chars === 4000, `dossiers: ${JSON.stringify(none.dossiers)}`);
    rv(['--outcome', 'emulator-dns', '--missed', '--run', 'R-T1']);
    const missed = JSON.parse(rv(['--review', '--json']).stdout);
    assert(missed.verdict === 'CUT-PROMPT' && missed.ev.missed[0] === 'emulator-dns (R-T1)', `missed: ${missed.verdict} ${missed.ev.missed}`);
    rv(['--outcome', 'emulator-dns', '--helped']);
    assert(JSON.parse(rv(['--review', '--json']).stdout).verdict === 'KEEP', 'helped did not give KEEP');
  });
  check('brain review: events before the window and session-end stubs do not count', () => {
    schedule({ windowStart: '2026-10-15' });
    writeFileSync(join(RS, '_BRAIN-TRUST.jsonl'), JSON.stringify({ at: '2026-10-01T00:00:00Z', ev: 'helped', page: 'wiki/failures/emulator-dns.md' }) + '\n');
    const r = JSON.parse(rv(['--review', '--json']).stdout);
    assert(r.verdict === 'NO-OUTCOMES' && r.ev.helped.length === 0, `old event counted: ${r.verdict}`);
    assert(r.log.real === 0 && r.log.stubs === 2, `log counts: ${JSON.stringify(r.log)}`);
  });
  check('brain review: --review-done needs words, records once, and silences the banner', () => {
    schedule();
    assert(rv(['--review-done']).status === 2, 'empty decision accepted');
    const ok = rv(['--review-done', 'keep it, only the run file', '--today', '2026-10-30']);
    assert(ok.status === 0, `exit ${ok.status}: ${ok.stderr}`);
    assert(JSON.parse(readFileSync(REVIEW, 'utf8')).decided.decision === 'keep it, only the run file', 'decision not stored');
    assert(rv(['--review-done', 'again']).status === 1, 'second decision overwrote the first');
    const s = rv(['--session-start', '--today', '2026-11-02'], '{}');
    assert(s.status === 0 && !/Brain review/.test(s.stdout), 'banner after the decision');
  });
  check('brain review: an unreadable review file never fails the session; --review names it', () => {
    mkdirSync(RS, { recursive: true });
    writeFileSync(REVIEW, '{ "due": "30 Oct" ');
    const s = rv(['--session-start', '--today', '2026-10-30'], '{}');
    assert(s.status === 0 && /Obsidian Brain/.test(s.stdout) && !/Brain review/.test(s.stdout), 'session start broke on a bad review file');
    const r = rv(['--review']);
    assert(r.status === 1 && /_BRAIN-REVIEW\.json/.test(r.stderr), `exit ${r.status}: ${r.stderr}`);
  });
}
