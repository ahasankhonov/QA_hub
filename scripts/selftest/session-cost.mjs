// Selftest section for scripts/session-cost.mjs — the session cost meter.
//
// The meter is only useful if its numbers are exact: a double-counted streaming line inflates calls
// and output, a skipped subagent hides where the context went, and a fuzzy threshold share makes the
// "68% above 400k" lesson unmeasurable. Every check here asserts exact numbers on hand-built
// transcripts, and every "it rejects X" check has a sibling proving the legitimate case still works.

import { mkdirSync, rmSync, writeFileSync, utimesSync, openSync, writeSync, closeSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const SID_A = 'aaaa1111-0000-4000-8000-000000000001';
const SID_B = 'aaab2222-0000-4000-8000-000000000002';
const PROMPT_A = 'Please QA the Alpha dealer tickets on staging and   write the results to the hub folder today';

const ts = (min) => new Date(Date.UTC(2026, 9, 7, 4, min, 0)).toISOString();

/** One assistant transcript line. ctx is split into input / cacheWrite / cacheRead. */
function call(id, { input = 0, cw = 0, cr = 0, out = 0, model = 'claude-opus-5-5', min = 0, block = 'text' } = {}) {
  return JSON.stringify({
    type: 'assistant',
    timestamp: ts(min),
    message: {
      id,
      model,
      role: 'assistant',
      content: [{ type: block }],
      usage: { input_tokens: input, cache_creation_input_tokens: cw, cache_read_input_tokens: cr, output_tokens: out },
    },
  });
}
const human = (text, min) => JSON.stringify({ type: 'user', origin: { kind: 'human' }, timestamp: ts(min), message: { role: 'user', content: [{ type: 'text', text }] } });
const peer = (text, min) => JSON.stringify({ type: 'user', origin: { kind: 'peer' }, timestamp: ts(min), message: { role: 'user', content: text } });
const synthetic = (min) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: ts(min),
    isApiErrorMessage: true,
    message: { id: 'synthetic-1', model: '<synthetic>', content: [{ type: 'text', text: "You've hit your session limit" }], usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
  });

function buildFixtures(DIR) {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  // Session A main: 4 distinct calls (100k, 500k, 300k, exactly 400k), m1 streamed over two lines.
  const mainA = [
    JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: ts(0) }),
    peer('a subagent hand-back, not the human', 0),
    human(PROMPT_A, 1),
    call('m1', { input: 10, cw: 1000, cr: 98990, out: 5, min: 2, block: 'thinking' }),
    call('m1', { input: 10, cw: 1000, cr: 98990, out: 50, min: 2, block: 'tool_use' }),
    JSON.stringify({ type: 'user', timestamp: ts(3), message: { content: [{ type: 'tool_result', content: 'ok' }] } }),
    call('m2', { input: 100, cw: 99900, cr: 400000, out: 200, min: 4 }),
    '{not json at all',
    synthetic(5),
    call('m3', { input: 0, cw: 20000, cr: 280000, out: 30, min: 6 }),
    '{"type":"assistant","message":{"id":"m9","usage":{"input_tokens":5', // truncated: malformed
    '',
    human('a second human prompt that must not replace the first', 7),
    call('m4', { input: 0, cw: 0, cr: 400000, out: 40, min: 10 }),
  ];
  writeFileSync(join(DIR, `${SID_A}.jsonl`), mainA.join('\n') + '\n');

  const subDir = join(DIR, SID_A, 'subagents');
  mkdirSync(join(subDir, 'workflows', 'wf_test-1'), { recursive: true });
  writeFileSync(
    join(subDir, 'agent-x1.jsonl'),
    [peer('task text', 3), call('s1', { cr: 450000, out: 10, model: 'claude-sonnet-5-5', min: 3 }), call('s2', { cw: 50000, out: 5, model: 'claude-sonnet-5-5', min: 4 })].join('\n') + '\n'
  );
  writeFileSync(join(subDir, 'agent-x1.meta.json'), JSON.stringify({ agentType: 'test-executor', description: 'Execute group A1' }));
  writeFileSync(join(subDir, 'workflows', 'wf_test-1', 'agent-w1.jsonl'), call('s3', { input: 20000, out: 1, model: 'claude-haiku-4-5-20251001', min: 5 }) + '\n');
  writeFileSync(join(subDir, 'workflows', 'wf_test-1', 'agent-w1.meta.json'), JSON.stringify({ agentType: 'workflow-subagent', description: 'build:cost' }));
  writeFileSync(join(subDir, 'workflows', 'wf_test-1', 'journal.jsonl'), '{"type":"launched"}\n');

  // Session B: one small call; its files are made 10 days old so the 7-day default drops it.
  writeFileSync(join(DIR, `${SID_B}.jsonl`), [human('old session', 0), call('b1', { input: 1000, out: 1, min: 1 })].join('\n') + '\n');
  setAge(DIR, SID_B, 10 * 86_400_000);
  setAge(DIR, SID_A, 60_000);
}

function setAge(DIR, sid, ageMs) {
  const t = new Date(Date.now() - ageMs);
  utimesSync(join(DIR, `${sid}.jsonl`), t, t);
  if (sid === SID_A) {
    for (const f of ['agent-x1.jsonl', join('workflows', 'wf_test-1', 'agent-w1.jsonl')]) utimesSync(join(DIR, SID_A, 'subagents', f), t, t);
  }
}

export default function section(h) {
  const { check, assert } = h;
  console.log('\nsession-cost — the context × calls meter');

  const DIR = join(h.TMP, 'session-cost', 'projects');
  buildFixtures(DIR);
  const SCRIPT = join(h.HUB, 'scripts', 'session-cost.mjs');
  const cost = (...argv) => spawnSync('node', [SCRIPT, '--dir', DIR, ...argv], { encoding: 'utf8' });
  const json = (...argv) => {
    const r = cost(...argv, '--json');
    assert(r.status === 0, `session-cost ${argv.join(' ')} exited ${r.status}: ${(r.stderr || r.stdout).slice(0, 400)}`);
    return JSON.parse(r.stdout);
  };
  const eq = (actual, expected, what) => assert(actual === expected, `${what}: expected ${expected}, got ${actual}`);
  // The runner calls sections synchronously, so the exported defaultThreshold is exercised in a child.
  const mod = {
    defaultThreshold(list) {
      const code = `import { defaultThreshold } from ${JSON.stringify(pathToFileURL(SCRIPT).href)}; console.log(JSON.stringify(defaultThreshold(JSON.parse(process.argv[1]))));`;
      const r = spawnSync('node', ['--input-type=module', '-e', code, JSON.stringify(list)], { encoding: 'utf8' });
      assert(r.status === 0, `defaultThreshold child failed: ${r.stderr}`);
      return JSON.parse(r.stdout);
    },
  };
  const hubSettings = ['settings.local.json', 'settings.json'].flatMap((n) => {
    try {
      return [JSON.parse(readFileSync(join(h.HUB, '.claude', n), 'utf8'))];
    } catch {
      return [];
    }
  });
  const DEFAULT_T = mod.defaultThreshold(hubSettings);

  // FS-10: the default threshold now follows autoCompactWindow, so the 400k fixture numbers pass it explicitly.
  const detail = json('--session', SID_A, '--threshold', '400000');
  const main = detail.main;

  check('a call streamed over two lines with one message.id is counted once, with the final output count', () => {
    eq(main.calls, 4, 'main calls');
    eq(main.output, 50 + 200 + 30 + 40, 'main output (m1 = 50, not 5 or 55)');
  });
  check('Σ context, peak, nearest-rank median and p90 of the main thread are exact', () => {
    eq(main.sumContext, 1_300_000, 'Σ context');
    eq(main.peak, 500_000, 'peak');
    eq(main.median, 300_000, 'median');
    eq(main.p90, 500_000, 'p90');
    eq(main.cacheRead, 98_990 + 400_000 + 280_000 + 400_000, 'cache read');
    eq(main.cacheWrite, 1000 + 99_900 + 20_000, 'cache write');
    eq(main.input, 110, 'uncached input');
  });
  check('a call exactly AT the threshold is not above it; the share above is exact', () => {
    eq(main.aboveCalls, 1, 'calls above 400k (500k only; 400k is not above)');
    eq(main.aboveContext, 500_000, 'context above');
    eq(main.aboveShare, 500_000 / 1_300_000, 'share above');
  });
  check('--threshold moves the line: at 250k three main calls count, share 1.2M / 1.3M', () => {
    const m = json('--session', SID_A, '--threshold', '250000').main;
    eq(m.aboveCalls, 3, 'calls above 250k');
    eq(m.aboveShare, 1_200_000 / 1_300_000, 'share above 250k');
  });
  check('a malformed and a truncated line are counted and skipped, not fatal', () => {
    eq(main.malformed, 2, 'malformed lines in main');
    eq(detail.malformed, 2, 'malformed lines in session');
  });
  check('a <synthetic> zero-usage entry is skipped, not counted as a call', () => {
    eq(main.synthetic, 1, 'synthetic entries skipped');
    assert(!('<synthetic>' in main.models), `models include <synthetic>: ${JSON.stringify(main.models)}`);
    eq(main.models['claude-opus-5-5'], 4, 'opus calls');
  });
  check('subagent files (plain and workflow) are found, labelled from .meta.json, sorted by Σ context', () => {
    eq(detail.subagents.length, 2, 'subagents (journal.jsonl must not count)');
    const [x1, w1] = detail.subagents;
    eq(x1.agentId, 'x1', 'first subagent (largest Σ)');
    eq(x1.agentType, 'test-executor', 'agentType from meta');
    eq(x1.description, 'Execute group A1', 'description from meta');
    eq(x1.calls, 2, 'x1 calls');
    eq(x1.sumContext, 500_000, 'x1 Σ');
    eq(x1.aboveCalls, 1, 'x1 calls above');
    eq(w1.agentId, 'w1', 'workflow subagent');
    eq(w1.workflow, 'wf_test-1', 'workflow id');
    eq(w1.sumContext, 20_000, 'w1 Σ');
  });
  check('session totals pool main + subagents: 7 calls, 1.82M, share 950k / 1.82M', () => {
    const t = detail.totals;
    eq(t.calls, 7, 'total calls');
    eq(t.sumContext, 1_820_000, 'total Σ');
    eq(t.peak, 500_000, 'total peak');
    eq(t.aboveCalls, 2, 'total calls above');
    eq(t.aboveContext, 950_000, 'total context above');
    eq(t.aboveShare, 950_000 / 1_820_000, 'total share above');
    eq(t.output, 320 + 15 + 1, 'total output');
    eq(t.models['claude-sonnet-5-5'], 2, 'sonnet calls');
    eq(t.models['claude-haiku-4-5-20251001'], 1, 'haiku calls');
  });
  check('first human prompt: origin.kind human only, first 60 chars, whitespace collapsed', () => {
    eq(detail.firstPrompt, PROMPT_A.replace(/\s+/g, ' ').slice(0, 60), 'firstPrompt');
    eq(detail.first, ts(1), 'first timestamp (the human prompt)');
    eq(detail.last, ts(10), 'last timestamp (m4)');
    eq(detail.durationMs, 9 * 60_000, 'duration');
  });
  check('a queued_command attachment with origin.kind human counts as the human prompt', () => {
    const D2 = join(h.TMP, 'session-cost', 'queued');
    rmSync(D2, { recursive: true, force: true });
    mkdirSync(D2, { recursive: true });
    const q = JSON.stringify({ type: 'attachment', timestamp: ts(0), attachment: { type: 'queued_command', prompt: 'queued from the human', origin: { kind: 'human' } } });
    const p = JSON.stringify({ type: 'attachment', timestamp: ts(0), attachment: { type: 'queued_command', prompt: 'peer hand-back', origin: { kind: 'peer' } } });
    writeFileSync(join(D2, 'cccc.jsonl'), [p, q, call('c1', { input: 1, min: 1 })].join('\n') + '\n');
    const r = spawnSync('node', [SCRIPT, '--dir', D2, '--session', 'cccc', '--json'], { encoding: 'utf8' });
    eq(JSON.parse(r.stdout).firstPrompt, 'queued from the human', 'queued prompt');
  });

  check('--json list shape: sessions[] with totals/main/subagents, plus pooled totals', () => {
    const r = json();
    for (const k of ['mode', 'dir', 'since', 'threshold', 'sessionCount', 'shown', 'malformed', 'totals', 'sessions']) assert(k in r, `list JSON lacks "${k}"`);
    eq(r.mode, 'list', 'mode');
    eq(r.threshold, DEFAULT_T, 'default threshold (0.75 × autoCompactWindow of the hub settings)');
    const s = r.sessions[0];
    for (const k of ['sessionId', 'firstPrompt', 'first', 'last', 'durationMs', 'totals', 'main', 'subagents', 'malformed', 'synthetic']) assert(k in s, `session JSON lacks "${k}"`);
    for (const k of ['calls', 'sumContext', 'peak', 'median', 'p90', 'aboveCalls', 'aboveContext', 'aboveShare', 'baselineContext', 'baseShare', 'output', 'cacheRead', 'cacheWrite', 'models', 'first', 'last', 'durationMs'])
      assert(k in s.totals, `stats JSON lacks "${k}"`);
    assert(!('_calls' in s), 'internal _calls leaked into JSON');
  });
  check('the 7-day default drops a 10-day-old session; --since 30d and --since <date> keep it', () => {
    const def = json();
    eq(def.sessionCount, 1, 'sessions in last 7 days');
    eq(def.sessions[0].sessionId, SID_A, 'the recent session');
    eq(def.totals.calls, 7, 'list totals calls');
    const wide = json('--since', '30d');
    eq(wide.sessionCount, 2, 'sessions in last 30 days');
    eq(wide.sessions[0].sessionId, SID_A, 'newest first');
    eq(wide.totals.calls, 8, 'pooled calls across sessions');
    const d = new Date(Date.now() - 30 * 86_400_000);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    eq(json('--since', iso).sessionCount, 2, `sessions since ${iso}`);
  });
  check('--top 1 limits the rows but TOTAL still covers every session', () => {
    const r = json('--since', '30d', '--top', '1');
    eq(r.sessions.length, 1, 'rows shown');
    eq(r.sessionCount, 2, 'sessions counted');
    eq(r.totals.calls, 8, 'totals over all');
  });
  check('the plain-text list renders one line per session plus TOTAL, with k/M units', () => {
    const r = cost('--since', '30d');
    assert(r.status === 0, r.stderr);
    const lines = r.stdout.trim().split('\n');
    assert(lines.some((l) => l.startsWith('aaaa1111') && l.includes('1.8M') && l.includes('500k')), `no aaaa1111 row with 1.8M/500k:\n${r.stdout}`);
    assert(lines.some((l) => l.startsWith('aaab2222')), `no aaab2222 row:\n${r.stdout}`);
    assert(lines.some((l) => l.startsWith('TOTAL')), `no TOTAL row:\n${r.stdout}`);
  });

  check('--session resolves a unique prefix', () => {
    eq(json('--session', 'aaaa').sessionId, SID_A, 'prefix aaaa');
    eq(json('--session', 'aaab').sessionId, SID_B, 'prefix aaab');
  });
  check('--session REJECTS an ambiguous prefix and an unknown id (exit 2, says why)', () => {
    const amb = cost('--session', 'aaa');
    eq(amb.status, 2, 'ambiguous prefix exit');
    assert(amb.stderr.includes('ambiguous'), `no "ambiguous" in: ${amb.stderr}`);
    const none = cost('--session', 'zzzz');
    eq(none.status, 2, 'unknown id exit');
    assert(none.stderr.includes('no session matches'), `no "no session matches" in: ${none.stderr}`);
  });
  check('bad arguments are rejected with usage (exit 2); --help is accepted (exit 0)', () => {
    eq(cost('--since', 'yesterday').status, 2, 'bad --since');
    eq(cost('--threshold', '-5').status, 2, 'bad --threshold');
    eq(cost('--bogus').status, 2, 'unknown flag');
    eq(cost('--help').status, 0, '--help');
  });

  check('--live picks the session whose main transcript changed last', () => {
    setAge(DIR, SID_A, 3_600_000);
    setAge(DIR, SID_B, 1000);
    let r = json('--live');
    eq(r.sessionId, SID_B, 'newest main transcript (B touched last)');
    eq(r.current, 1000, 'current context of B');
    setAge(DIR, SID_B, 2 * 3_600_000);
    r = json('--live');
    eq(r.sessionId, SID_A, 'newest main transcript (A touched last)');
    eq(r.calls, 4, 'calls so far');
    eq(r.peak, 500_000, 'peak so far');
    eq(r.current, 400_000, 'current context = the last call (m4)');
  });
  check('--live does NOT warn when the last call is at (not above) the threshold', () => {
    const r = cost('--live', '--threshold', '400000');
    assert(r.status === 0, r.stderr);
    assert(!r.stdout.includes('WARNING'), `warned at exactly 400k:\n${r.stdout}`);
    eq(json('--live', '--threshold', '400000').warning, null, 'warning field');
  });
  check('--live WARNS in one line when the last call is above the threshold', () => {
    const r = cost('--live', '--threshold', '350000');
    assert(r.status === 0, r.stderr);
    const warn = r.stdout.split('\n').filter((l) => l.startsWith('WARNING'));
    eq(warn.length, 1, 'warning lines');
    assert(warn[0].includes('400k') && warn[0].includes('350k'), `warning lacks the numbers: ${warn[0]}`);
  });

  check('a large --json (300 subagents, >64 KB) reaches a pipe whole', () => {
    const D4 = join(h.TMP, 'session-cost', 'many');
    rmSync(D4, { recursive: true, force: true });
    mkdirSync(join(D4, 'eeee', 'subagents'), { recursive: true });
    writeFileSync(join(D4, 'eeee.jsonl'), call('e0', { input: 1, min: 1 }) + '\n');
    for (let i = 0; i < 300; i++) writeFileSync(join(D4, 'eeee', 'subagents', `agent-n${i}.jsonl`), call(`n${i}`, { input: 100, min: 2 }) + '\n');
    const r = spawnSync('node', [SCRIPT, '--dir', D4, '--session', 'eeee', '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    assert(r.stdout.length > 65_536, `output only ${r.stdout.length} bytes — fixture too small to test the pipe`);
    let parsed;
    try {
      parsed = JSON.parse(r.stdout);
    } catch (e) {
      throw new Error(`--json output was cut off at ${r.stdout.length} bytes: ${e.message}`);
    }
    eq(parsed.subagents.length, 300, 'subagents in JSON');
    eq(parsed.totals.sumContext, 30_001, 'pooled Σ');
  });

  check('a ~50 MB transcript is measured in under 5 s', () => {
    const D3 = join(h.TMP, 'session-cost', 'big');
    rmSync(D3, { recursive: true, force: true });
    mkdirSync(D3, { recursive: true });
    const path = join(D3, 'dddd.jsonl');
    const filler = JSON.stringify({ type: 'user', timestamp: ts(0), message: { content: [{ type: 'tool_result', content: 'x'.repeat(4000) }] } });
    const fd = openSync(path, 'w');
    let bytes = 0;
    let n = 0;
    while (bytes < 50 * 1024 * 1024) {
      const lines = [filler, filler, call(`big${n}`, { cr: 150_000, out: 10, min: 1 }), call(`big${n}`, { cr: 150_000, out: 20, min: 1 })].join('\n') + '\n';
      bytes += writeSync(fd, lines);
      n++;
    }
    closeSync(fd);
    const t0 = Date.now();
    const r = spawnSync('node', [SCRIPT, '--dir', D3, '--session', 'dddd', '--json'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    const ms = Date.now() - t0;
    rmSync(D3, { recursive: true, force: true });
    assert(r.status === 0, r.stderr);
    const m = JSON.parse(r.stdout).main;
    eq(m.calls, n, 'calls in big file');
    eq(m.output, 20 * n, 'output in big file');
    assert(ms < 5000, `took ${ms} ms for ${Math.round(bytes / 1e6)} MB`);
  });

  check('FS-10/KG-05: defaultThreshold = 0.75 × autoCompactWindow (local before shared), else 150000', () => {
    eq(mod.defaultThreshold([{ autoCompactWindow: 200000 }]), 150_000, '200k pin');
    eq(mod.defaultThreshold([{}, { autoCompactWindow: 1_000_000 }]), 750_000, 'falls through to settings.json');
    eq(mod.defaultThreshold([{ autoCompactWindow: 100000 }, { autoCompactWindow: 1_000_000 }]), 75_000, 'local wins');
    eq(mod.defaultThreshold([{ autoCompactWindow: 'abc' }, { autoCompactWindow: -1 }, { autoCompactWindow: null }, { autoCompactWindow: '1e999' }]), 150_000, 'garbage ignored');
    eq(mod.defaultThreshold([]), 150_000, 'no settings');
    // The hub itself pins a 200k window: a default above it could never fire (the 400k bug).
    const pin = Number(hubSettings.find((x) => Number.isFinite(Number(x?.autoCompactWindow)) && Number(x.autoCompactWindow) > 0)?.autoCompactWindow);
    if (Number.isFinite(pin)) assert(DEFAULT_T < pin, `default ${DEFAULT_T} is not below the ${pin} auto-compact pin`);
  });

  check('KG-05: --live with NO --threshold warns at 160k and stays silent at 140k under the 200k pin', () => {
    assert(DEFAULT_T === 150_000, `this check assumes the hub's 200k pin; default is ${DEFAULT_T}`);
    const D5 = join(h.TMP, 'session-cost', 'live-default');
    for (const [ctx, warn] of [[160_000, true], [140_000, false]]) {
      rmSync(D5, { recursive: true, force: true });
      mkdirSync(D5, { recursive: true });
      writeFileSync(join(D5, 'ffff.jsonl'), [human('live default', 0), call('f1', { input: 1000, min: 1 }), call('f2', { cr: ctx, min: 2 })].join('\n') + '\n');
      const r = spawnSync('node', [SCRIPT, '--dir', D5, '--live'], { encoding: 'utf8' });
      assert(r.status === 0, r.stderr);
      const lines = r.stdout.split('\n').filter((l) => l.startsWith('WARNING'));
      eq(lines.length, warn ? 1 : 0, `WARNING lines at ${ctx}`);
    }
    rmSync(D5, { recursive: true, force: true });
  });

  check('FS-10: garbage usage (string, negative, Infinity-ish, object) never yields NaN/Infinity; a numeric string counts', () => {
    const D6 = join(h.TMP, 'session-cost', 'garbage');
    rmSync(D6, { recursive: true, force: true });
    mkdirSync(D6, { recursive: true });
    const odd = (id, usage, min) => JSON.stringify({ type: 'assistant', timestamp: ts(min), message: { id, model: 'claude-opus-5-5', content: [{ type: 'text' }], usage } });
    writeFileSync(
      join(D6, 'gggg.jsonl'),
      [
        human('garbage usage', 0),
        call('g1', { input: 1000, out: 5, min: 1 }),
        odd('g2', { input_tokens: 'abc', output_tokens: 1 }, 2),
        odd('g3', { input_tokens: -5, output_tokens: 1 }, 3),
        odd('g4', { input_tokens: '1e999', output_tokens: 1 }, 4),
        odd('g5', { input_tokens: { n: 1 }, output_tokens: 1 }, 5),
        odd('g6', { input_tokens: '2000', cache_read_input_tokens: null, output_tokens: '3' }, 6),
      ].join('\n') + '\n',
    );
    for (const argv of [['--session', 'gggg', '--json'], ['--live', '--json'], ['--since', '3650d', '--json']]) {
      const r = spawnSync('node', [SCRIPT, '--dir', D6, ...argv], { encoding: 'utf8' });
      assert(r.status === 0, `${argv.join(' ')} exited ${r.status}: ${r.stderr}`);
      assert(!/NaN|Infinity|null,\s*"(sumContext|peak)/.test(r.stdout), `${argv.join(' ')} leaked NaN/Infinity:\n${r.stdout.slice(0, 600)}`);
    }
    const d = JSON.parse(spawnSync('node', [SCRIPT, '--dir', D6, '--session', 'gggg', '--json'], { encoding: 'utf8' }).stdout);
    eq(d.main.calls, 2, 'g1 + the numeric-string g6 are calls; g2..g5 are skipped');
    eq(d.main.sumContext, 3000, 'Σ context');
    eq(d.main.output, 8, 'output');
    rmSync(D6, { recursive: true, force: true });
  });

  // ── start-up baseline (denfry/claude-skills context_budget idea, 2026-10-16)
  check('START is each thread\'s first-call context; BASE = Σ min(START, ctx) / Σ ctx per thread and pooled', () => {
    eq(main.start, 100_000, 'main START (m1)');
    eq(main.baselineContext, 400_000, 'main baseline (100k × 4 calls)');
    eq(main.baseShare, 400_000 / 1_300_000, 'main BASE');
    const [x1, w1] = detail.subagents;
    eq(x1.start, 450_000, 'x1 START (s1)');
    eq(w1.start, 20_000, 'w1 START');
    eq(detail.totals.baselineContext, 920_000, 'pooled baseline: each call counts its OWN thread\'s START');
    eq(detail.totals.baseShare, 920_000 / 1_820_000, 'pooled BASE');
  });
  check('a call smaller than its thread\'s START is capped at its own context, so BASE never exceeds 100%', () => {
    const x1 = detail.subagents[0];
    eq(x1.baselineContext, 500_000, 'x1 baseline (450k + min(450k, 50k)), not 900k');
    eq(x1.baseShare, 1, 'x1 BASE');
  });
  check('START/BASE reach the text: list row, detail main row, the live line', () => {
    const list = cost('--since', '30d', '--threshold', '400000');
    const row = list.stdout.split('\n').find((l) => l.startsWith('aaaa1111')) || '';
    assert(row.includes('100k') && row.includes('51%'), `list row lacks START 100k / BASE 51%: ${row}`);
    const det = cost('--session', SID_A, '--threshold', '400000');
    const mainRow = det.stdout.split('\n').find((l) => l.startsWith('main')) || '';
    assert(mainRow.includes('100k') && mainRow.includes('31%'), `detail main row lacks START 100k / BASE 31%: ${mainRow}`);
    const live = json('--live', '--session', SID_A);
    eq(live.start, 100_000, 'live START');
    eq(live.baselineContext, 400_000, 'live baseline');
    const lt = cost('--live', '--session', SID_A);
    assert(lt.stdout.includes('start 100k (base 31%)'), `live line lacks "start 100k (base 31%)": ${lt.stdout}`);
  });

  const sidN = (i) => `b${String(i).padStart(7, '0')}-0000-4000-8000-000000000000`;
  /** A main thread whose first call is `start` context, then one call 50k bigger. */
  const mainAt = (D, i, start, prompt = `fresh session ${i}`) =>
    writeFileSync(join(D, `${sidN(i)}.jsonl`), [human(prompt, i), call(`${sidN(i)}-1`, { cr: start, min: i }), call(`${sidN(i)}-2`, { cr: start + 50_000, min: i })].join('\n') + '\n');
  const CONT = 'This session is being continued from a previous conversation that ran out of context.';
  function baselineDir(name, fresh, continued = []) {
    const D = join(h.TMP, 'session-cost', name);
    rmSync(D, { recursive: true, force: true });
    mkdirSync(join(D, 'memory'), { recursive: true });
    writeFileSync(join(D, 'memory', 'MEMORY.md'), 'x'.repeat(4000));
    fresh.forEach((start, i) => mainAt(D, i + 1, start));
    continued.forEach((start, i) => mainAt(D, 30 + i, start, CONT));
    return D;
  }
  const baseline = (D, ...argv) => spawnSync('node', [SCRIPT, '--dir', D, '--baseline', ...argv], { encoding: 'utf8' });
  const baselineJson = (D) => {
    const r = baseline(D, '--json');
    assert(r.status === 0, `--baseline exited ${r.status}: ${r.stderr}`);
    return JSON.parse(r.stdout);
  };

  check('--baseline DRIFT fires when the newest fresh starts grew >10% over the oldest (50k → 60k)', () => {
    const D = baselineDir('baseline-grew', [50_000, 50_000, 50_000, 50_000, 60_000, 60_000, 60_000, 60_000]);
    const r = baselineJson(D);
    eq(r.drift.k, 4, 'k = min(5, 8 / 2)');
    eq(r.drift.oldMedian, 50_000, 'old median');
    eq(r.drift.newMedian, 60_000, 'new median');
    eq(r.drift.grew, true, 'grew');
    const t = baseline(D);
    eq(t.stdout.split('\n').filter((l) => l.startsWith('DRIFT')).length, 1, 'DRIFT lines');
  });
  check('--baseline stays quiet on flat starts, and a continued session (*) is left out of the drift', () => {
    // Counted, the three 150k continued sessions would make the newest-5 median 150k and fire DRIFT.
    const D = baselineDir('baseline-flat', Array(8).fill(50_000), [150_000, 150_000, 150_000]);
    const r = baselineJson(D);
    eq(r.main.length, 11, 'main threads listed (continued ones too)');
    eq(r.main.filter((m) => m.continued).length, 3, 'continued sessions detected');
    eq(r.drift.newMedian, 50_000, 'newest fresh median');
    eq(r.drift.grew, false, 'grew');
    const t = baseline(D);
    assert(!t.stdout.split('\n').some((l) => l.startsWith('DRIFT')), `DRIFT on flat starts:\n${t.stdout}`);
    assert(t.stdout.split('\n').some((l) => l.startsWith(`${sidN(30).slice(0, 8)}*`)), `continued row not marked *:\n${t.stdout}`);
  });
  check('--baseline groups subagents by type; a zero-call subagent does not drag MIN to 0', () => {
    const D = baselineDir('baseline-agents', [50_000, 50_000]);
    const sub = join(D, sidN(1), 'subagents');
    mkdirSync(sub, { recursive: true });
    const agent = (id, start, type) => {
      writeFileSync(join(sub, `agent-${id}.jsonl`), start === null ? peer('hand-back only', 1) + '\n' : [call(`${id}-1`, { cr: start, min: 1 }), call(`${id}-2`, { cr: start + 1000, min: 2 })].join('\n') + '\n');
      if (type) writeFileSync(join(sub, `agent-${id}.meta.json`), JSON.stringify({ agentType: type }));
    };
    agent('v1', 40_000, 'verifier');
    agent('v2', 44_000, 'verifier');
    agent('v0', null, 'verifier');
    agent('n1', 30_000, null);
    const r = baselineJson(D);
    eq(r.sessionCount, 2, 'sessions (memory/ is not a session)');
    const v = r.agents.find((a) => a.agentType === 'verifier');
    eq(v.threads, 2, 'verifier threads (the zero-call one is skipped)');
    eq(v.avg, 42_000, 'verifier avg');
    eq(v.min, 40_000, 'verifier min');
    eq(v.max, 44_000, 'verifier max');
    eq(r.agents[1].agentType, '(no meta)', 'agent without .meta.json');
    eq(r.drift, null, 'no drift from 2 fresh threads');
    assert(r.driftNote.includes('found 2'), `driftNote: ${r.driftNote}`);
    const mem = r.files.find((f) => f.path.endsWith('MEMORY.md'));
    assert(mem, `MEMORY.md missing from files: ${JSON.stringify(r.files)}`);
    eq(mem.bytes, 4000, 'MEMORY.md bytes');
    eq(mem.approxTokens, 1000, 'MEMORY.md ≈ tokens');
  });
  check('--baseline REJECTS --live and --session (exit 2)', () => {
    const D = join(h.TMP, 'session-cost', 'baseline-agents');
    eq(baseline(D, '--live').status, 2, '--baseline --live');
    eq(baseline(D, '--session', sidN(1)).status, 2, '--baseline --session');
    eq(baseline(D).status, 0, '--baseline alone');
  });

}
