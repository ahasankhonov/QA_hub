#!/usr/bin/env node
// Measure what a Claude Code session actually cost, using the hub's measured cost model (CLAUDE.md,
// "Token discipline"): spend ≈ context size × number of API calls, and 68% of a 14-day burn came from
// calls made above 400k context. A single number per session ("tokens used") hides exactly that, so
// this reports, per thread: the number of calls, Σ context, peak / median / p90 context, and how much
// of Σ context was spent on calls above the threshold.
//
//   node scripts/session-cost.mjs                        last 7 days, one line per session, newest first
//   node scripts/session-cost.mjs --since 2026-10-01     (or --since 3d / 12h)
//   node scripts/session-cost.mjs --session <id|prefix>  main thread + every subagent, sorted by Σ context
//   node scripts/session-cost.mjs --live                 newest session: current context, calls, peak, warning
//   node scripts/session-cost.mjs --baseline             start-up cost per session and per agent type, plus its drift
//   options: --json  --threshold N  --top N  --dir <transcripts dir>
//   --threshold default: 0.75 × autoCompactWindow from the hub's .claude/settings.local.json (or settings.json),
//   else 150000. The 400k of the 14-day audit can never fire under the hub's 200k auto-compact pin (FS-10).
//
// Read-only. It never writes anything, anywhere.
//
// Where the data is (checked 2026-10-07 on this machine, Claude Code 2.1.x):
//   <dir>/<sessionId>.jsonl                                   main thread
//   <dir>/<sessionId>/subagents/agent-<id>.jsonl (+ .meta.json)              Task/Agent subagents
//   <dir>/<sessionId>/subagents/workflows/<wf>/agent-<id>.jsonl (+ .meta.json) workflow subagents
//   <dir>/<sessionId>/subagents/workflows/<wf>/journal.jsonl  workflow bookkeeping, no API calls (skipped)
//   <dir>/<sessionId>/workflows/*.json|scripts/*.js, tool-results/*.txt   not transcripts (ignored)
// The .meta.json holds {agentType, description, model?, workflowPhase?, spawnDepth, ...}. Every
// agent-*.jsonl under <sessionId>/subagents/ is found by a recursive walk, so a deeper layout still counts.
// <dir> defaults to $CLAUDE_CONFIG_DIR (or ~/.claude) /projects/<hub path, non-alphanumerics → '->.
//
// How a call is counted:
//   - One API call is written as several `type:"assistant"` lines sharing message.id (one per content
//     block). Calls are deduped by message.id within a transcript. On 25,739 multi-line ids in this
//     hub's transcripts, input_tokens / cache_creation_input_tokens / cache_read_input_tokens were
//     identical on every line, and output_tokens differed on 11,632 of them — always growing, the last
//     line carrying the final count. So: input-side fields from the first line, output_tokens = the max.
//   - Skipped: message.model === '<synthetic>' (client-made "session limit" notices, all-zero usage),
//     and any entry with no usage or with zero context and zero output.
//   - context of a call = input_tokens + cache_creation_input_tokens + cache_read_input_tokens.
//   - "above the threshold" is strictly greater than it. median / p90 use the nearest-rank method.
//   - Threads (main, each subagent) are separate transcripts; session totals pool all their calls.
//
// Start-up baseline (idea from denfry/claude-skills context_budget.py, 2026-10-16):
//   - START of a thread = the context of its first call: system prompt, tool definitions, CLAUDE.md, the
//     memory index, SessionStart hook output and the first prompt. Every later call re-pays it, so it is
//     an upper bound on the fixed cost (the first prompt is in it too).
//   - BASE = Σ min(START, context) over the calls / Σ context: the share of Σ context that was start-up.
//     The min() caps a call smaller than the first one (after a compaction) at what it actually carried.
//   - --baseline lists START per main thread and per subagent type, and compares the median START of the
//     oldest and newest fresh main threads (up to 5 each). A session continued from a compaction starts
//     with the summary in its first prompt, so it is marked * and left out of the drift.
//
// Speed: each file is read synchronously in 4 MB chunks and split on '\n'; only lines containing
// '"type":"assistant"' or '"kind":"human"' are JSON.parsed. A malformed line is counted and skipped:
// a parsed candidate that fails JSON.parse, or any other non-blank line not shaped like {...}.
// First/last timestamps come from the parsed entries (calls and human prompts), not from every line.
// --since / the 7-day default filter on the newest file mtime in the session.

import { openSync, readSync, closeSync, readdirSync, statSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const HUB = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FALLBACK_THRESHOLD = 150_000;

/**
 * Default --threshold: 0.75 × autoCompactWindow of the first settings object that sets a positive finite
 * one (settings.local.json before settings.json), else 150000. Exported for the selftest.
 */
export function defaultThreshold(settingsList) {
  for (const st of settingsList || []) {
    const w = Number(st?.autoCompactWindow);
    if (Number.isFinite(w) && w > 0) return Math.round(0.75 * w);
  }
  return FALLBACK_THRESHOLD;
}
function hubSettings() {
  const out = [];
  for (const n of ['settings.local.json', 'settings.json']) {
    try { out.push(JSON.parse(readFileSync(join(HUB, '.claude', n), 'utf8'))); } catch { /* absent or unreadable */ }
  }
  return out;
}
const DEFAULT_THRESHOLD = defaultThreshold(hubSettings());
const DEFAULT_DAYS = 7;
const CHUNK = 4 * 1024 * 1024;
const PROMPT_CHARS = 60;
const CONTINUED = /^This session is being continued/;
const DRIFT_K = 5; // fresh main threads per end of the drift comparison
const DRIFT_GROWTH = 0.1; // median START growth above which --baseline prints a DRIFT line

// ───────────────────────────────────────────── arguments

const USAGE = `usage: node scripts/session-cost.mjs [--since YYYY-MM-DD|Nd|Nh] [--session <id|prefix>] [--live] [--baseline]
                                   [--json] [--threshold N] [--top N] [--dir <transcripts dir>]
  --threshold default: ${DEFAULT_THRESHOLD} (0.75 × autoCompactWindow, else 150000)`;

class UsageError extends Error {}

function parseArgs(argv) {
  const opts = { threshold: DEFAULT_THRESHOLD, json: false, live: false, top: 0, since: null, session: null, dir: null };
  const needValue = (i, flag) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new UsageError(`${flag} needs a value.`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--live') opts.live = true;
    else if (a === '--baseline') opts.baseline = true;
    else if (a === '--since') opts.since = parseSince(needValue(i++, a));
    else if (a === '--session') opts.session = needValue(i++, a);
    else if (a === '--dir') opts.dir = resolve(needValue(i++, a));
    else if (a === '--threshold') opts.threshold = positiveInt(needValue(i++, a), a);
    else if (a === '--top') opts.top = positiveInt(needValue(i++, a), a);
    else if (a === '-h' || a === '--help') opts.help = true;
    else throw new UsageError(`unknown argument "${a}".`);
  }
  if (opts.baseline && (opts.live || opts.session)) throw new UsageError('--baseline cannot be combined with --live or --session.');
  return opts;
}

function positiveInt(v, flag) {
  if (!/^\d+$/.test(v) || Number(v) <= 0) throw new UsageError(`${flag} must be a positive integer, got "${v}".`);
  return Number(v);
}

/** "2026-10-01" (local midnight), "3d", "12h" → epoch ms. */
function parseSince(v) {
  let m = /^(\d+)([dh])$/.exec(v);
  if (m) return Date.now() - Number(m[1]) * (m[2] === 'd' ? 86_400_000 : 3_600_000);
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (m) {
    const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
    if (!Number.isNaN(t)) return t;
  }
  throw new UsageError(`--since takes YYYY-MM-DD, Nd or Nh, got "${v}".`);
}

export function defaultTranscriptDir(hub = HUB) {
  const base = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  return join(base, 'projects', hub.replace(/[^a-zA-Z0-9]/g, '-'));
}

// ───────────────────────────────────────────── reading a transcript

/** Calls fn(line) for every line of a file, reading it in fixed chunks (never the whole file at once). */
function forEachLine(path, fn) {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.allocUnsafe(CHUNK);
    let rest = Buffer.alloc(0);
    for (;;) {
      const n = readSync(fd, buf, 0, CHUNK, null);
      if (n === 0) break;
      const data = rest.length ? Buffer.concat([rest, buf.subarray(0, n)]) : buf.subarray(0, n);
      const cut = data.lastIndexOf(10); // '\n' never occurs inside a UTF-8 multi-byte sequence
      if (cut === -1) {
        rest = Buffer.from(data);
        continue;
      }
      for (const line of data.toString('utf8', 0, cut).split('\n')) fn(line);
      rest = Buffer.from(data.subarray(cut + 1));
    }
    if (rest.length) fn(rest.toString('utf8'));
  } finally {
    closeSync(fd);
  }
}

/** Text of a message content (string, or the first text block of an array), whitespace collapsed. */
function promptText(content) {
  let t = '';
  if (typeof content === 'string') t = content;
  else if (Array.isArray(content)) t = content.find((b) => b && b.type === 'text' && typeof b.text === 'string')?.text || '';
  return t.replace(/\s+/g, ' ').trim();
}

function humanPrompt(o) {
  if (o.type === 'user' && o.origin?.kind === 'human') return { text: promptText(o.message?.content), ts: o.timestamp };
  if (o.type === 'attachment' && o.attachment?.type === 'queued_command' && o.attachment?.origin?.kind === 'human')
    return { text: promptText(o.attachment.prompt), ts: o.timestamp || o.attachment.timestamp };
  return null;
}

/**
 * One transcript → its distinct API calls in order of first appearance, plus the first human prompt.
 * @returns {{calls: {id, model, ts, input, cacheWrite, cacheRead, context, output}[], prompt, promptTs, malformed, synthetic}}
 */
export function readTranscript(path) {
  const byId = new Map();
  let malformed = 0;
  let synthetic = 0;
  let prompt = null;
  let promptTs = null;
  let lineNo = 0;
  forEachLine(path, (line) => {
    lineNo++;
    const isCall = line.includes('"type":"assistant"');
    const isHuman = prompt === null && line.includes('"kind":"human"');
    if (!isCall && !isHuman) {
      const t = line.trim();
      if (t && !(t.startsWith('{') && t.endsWith('}'))) malformed++;
      return;
    }
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      malformed++;
      return;
    }
    if (isHuman) {
      const h = humanPrompt(o);
      if (h) {
        prompt = h.text;
        promptTs = h.ts || null;
      }
    }
    if (o.type !== 'assistant') return;
    const msg = o.message || {};
    const u = msg.usage;
    if (msg.model === '<synthetic>' || !u) {
      synthetic++;
      return;
    }
    // FS-10: usage fields are coerced with Number(); an entry with a non-finite or negative field is
    // skipped (counted with the synthetic ones) instead of turning every total into NaN / Infinity.
    const num = (v) => (v == null ? 0 : typeof v === 'number' || typeof v === 'string' ? Number(v) : NaN);
    const input = num(u.input_tokens);
    const cacheWrite = num(u.cache_creation_input_tokens);
    const cacheRead = num(u.cache_read_input_tokens);
    const output = num(u.output_tokens);
    if (![input, cacheWrite, cacheRead, output].every((n) => Number.isFinite(n) && n >= 0)) {
      synthetic++;
      return;
    }
    const context = input + cacheWrite + cacheRead;
    if (context === 0 && output === 0) {
      synthetic++;
      return;
    }
    const id = msg.id || `noid:${lineNo}`;
    const seen = byId.get(id);
    if (seen) {
      if (output > seen.output) seen.output = output; // earlier lines carry a partial output count
      return;
    }
    byId.set(id, { id, model: msg.model || '?', ts: o.timestamp || null, input, cacheWrite, cacheRead, context, output });
  });
  return { calls: [...byId.values()], prompt, promptTs, malformed, synthetic };
}

// ───────────────────────────────────────────── statistics

/** Nearest-rank percentile of an ascending array (p in (0,1]). */
function percentile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
}

/** Stamp every call of ONE thread with that thread's START (its first call's context); returns START. */
function annotateStart(calls) {
  const start = calls[0]?.context ?? 0;
  for (const c of calls) c.start = start;
  return start;
}

/** Pool calls into the stats every output mode shows. extra.timestamps widens first/last. */
export function summarize(calls, threshold, extra = {}) {
  const ctx = calls.map((c) => c.context).sort((a, b) => a - b);
  const sum = (f) => calls.reduce((s, c) => s + f(c), 0);
  const above = calls.filter((c) => c.context > threshold);
  const sumContext = sum((c) => c.context);
  // Each call carries its own thread's START, so pooled totals across threads stay right.
  const baselineContext = sum((c) => Math.min(c.start ?? 0, c.context));
  const aboveContext = above.reduce((s, c) => s + c.context, 0);
  const models = {};
  for (const c of calls) models[c.model] = (models[c.model] || 0) + 1;
  const times = [...calls.map((c) => c.ts), ...(extra.timestamps || [])].filter(Boolean).map(Date.parse).filter((t) => !Number.isNaN(t));
  const first = times.length ? Math.min(...times) : null;
  const last = times.length ? Math.max(...times) : null;
  return {
    calls: calls.length,
    sumContext,
    peak: ctx.length ? ctx[ctx.length - 1] : 0,
    median: percentile(ctx, 0.5),
    p90: percentile(ctx, 0.9),
    threshold,
    aboveCalls: above.length,
    aboveContext,
    aboveShare: sumContext ? aboveContext / sumContext : 0,
    baselineContext,
    baseShare: sumContext ? baselineContext / sumContext : 0,
    output: sum((c) => c.output),
    input: sum((c) => c.input),
    cacheRead: sum((c) => c.cacheRead),
    cacheWrite: sum((c) => c.cacheWrite),
    models,
    first: first === null ? null : new Date(first).toISOString(),
    last: last === null ? null : new Date(last).toISOString(),
    durationMs: first === null ? 0 : last - first,
  };
}

// ───────────────────────────────────────────── discovering sessions

function walkAgents(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkAgents(p, out);
    else if (/^agent-.+\.jsonl$/.test(e.name)) out.push(p);
  }
  return out;
}

function mtimeOf(p) {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

/** Every session in the transcripts dir: {sessionId, main|null, agents[], mtime} — nothing parsed yet. */
export function listSessions(dir) {
  const ids = new Set();
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isFile() && e.name.endsWith('.jsonl')) ids.add(e.name.slice(0, -'.jsonl'.length));
    else if (e.isDirectory() && existsSync(join(dir, e.name, 'subagents'))) ids.add(e.name);
  }
  return [...ids].map((sessionId) => {
    const mainPath = join(dir, `${sessionId}.jsonl`);
    const main = existsSync(mainPath) ? mainPath : null;
    const agents = walkAgents(join(dir, sessionId, 'subagents'));
    const mainMtime = main ? mtimeOf(main) : 0;
    const mtime = Math.max(mainMtime, ...agents.map(mtimeOf));
    return { sessionId, main, agents, mtime, mainMtime };
  });
}

function readMeta(agentPath) {
  try {
    return JSON.parse(readFileSync(agentPath.replace(/\.jsonl$/, '.meta.json'), 'utf8'));
  } catch {
    return {};
  }
}

/** Parse one session fully: the main thread, every subagent, and pooled totals. */
export function analyzeSession(s, threshold) {
  const threads = [];
  let prompt = null;
  const promptTimes = [];
  if (s.main) {
    const t = readTranscript(s.main);
    prompt = t.prompt;
    if (t.promptTs) promptTimes.push(t.promptTs);
    threads.push({ kind: 'main', label: 'main', file: s.main, malformed: t.malformed, synthetic: t.synthetic, start: annotateStart(t.calls), calls: t.calls, timestamps: t.promptTs ? [t.promptTs] : [] });
  }
  for (const a of s.agents) {
    const t = readTranscript(a);
    const meta = readMeta(a);
    const agentId = basename(a, '.jsonl').replace(/^agent-/, '');
    const workflow = /[\\/]workflows[\\/]([^\\/]+)[\\/]/.exec(a)?.[1] || null;
    threads.push({
      kind: 'subagent',
      agentId,
      agentType: meta.agentType || null,
      description: meta.description || null,
      workflow,
      label: [meta.description || agentId, meta.agentType ? `(${meta.agentType})` : ''].filter(Boolean).join(' '),
      file: a,
      malformed: t.malformed,
      synthetic: t.synthetic,
      start: annotateStart(t.calls),
      calls: t.calls,
      timestamps: [],
    });
  }
  const all = threads.flatMap((t) => t.calls);
  const totals = summarize(all, threshold, { timestamps: promptTimes });
  const result = {
    sessionId: s.sessionId,
    firstPrompt: prompt === null ? null : prompt.slice(0, PROMPT_CHARS),
    first: totals.first,
    last: totals.last,
    durationMs: totals.durationMs,
    malformed: threads.reduce((n, t) => n + t.malformed, 0),
    synthetic: threads.reduce((n, t) => n + t.synthetic, 0),
    totals,
    main: null,
    subagents: [],
    _calls: all,
  };
  for (const t of threads) {
    const { calls, timestamps, ...rest } = t;
    const stats = { ...rest, ...summarize(calls, threshold, { timestamps }) };
    if (t.kind === 'main') result.main = stats;
    else result.subagents.push(stats);
  }
  result.subagents.sort((a, b) => b.sumContext - a.sumContext);
  return result;
}

function resolveSession(sessions, idOrPrefix) {
  const exact = sessions.find((s) => s.sessionId === idOrPrefix);
  if (exact) return exact;
  const hits = sessions.filter((s) => s.sessionId.startsWith(idOrPrefix));
  if (hits.length === 1) return hits[0];
  if (!hits.length) throw new UsageError(`no session matches "${idOrPrefix}". Run without --session to list recent sessions.`);
  throw new UsageError(`"${idOrPrefix}" is ambiguous — it matches ${hits.map((s) => s.sessionId).join(', ')}. Give more characters.`);
}

// ───────────────────────────────────────────── formatting

export function fmtTok(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e4) return `${Math.round(n / 1e3)}k`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

function fmtDur(ms) {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h${String(m % 60).padStart(2, '0')}m` : `${Math.floor(h / 24)}d${h % 24}h`;
}

const fmtPct = (x) => `${Math.round(x * 100)}%`;
const fmtWhen = (iso) => (iso ? iso.slice(0, 16).replace('T', ' ') : '-');
const shortModel = (m) => m.replace(/^claude-/, '').replace(/-\d{8}$/, '');
const fmtModels = (models) =>
  Object.entries(models)
    .sort((a, b) => b[1] - a[1])
    .map(([m, n]) => `${shortModel(m)}×${n}`)
    .join(',');

/** Render rows (arrays of strings) as aligned columns; the columns listed in `left` are left-aligned. */
function table(rows, left = []) {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
  return rows
    .map((r) =>
      r
        .map((c, i) => (i === r.length - 1 ? String(c) : left.includes(i) ? String(c).padEnd(widths[i]) : String(c).padStart(widths[i])))
        .join('  ')
        .trimEnd()
    )
    .join('\n');
}

/** start: the thread's START, or null for a row that pools threads (shown as '-'). */
function statCols(s, start) {
  return [
    s.calls,
    fmtTok(s.sumContext),
    start == null ? '-' : fmtTok(start),
    fmtPct(s.baseShare),
    fmtTok(s.peak),
    fmtTok(s.median),
    fmtTok(s.p90),
    s.aboveCalls,
    fmtPct(s.aboveShare),
    fmtTok(s.output),
    `${fmtTok(s.cacheRead)}/${fmtTok(s.cacheWrite)}`,
  ];
}

const statHead = (threshold) => ['CALLS', 'ΣCTX', 'START', 'BASE', 'PEAK', 'MED', 'P90', `>${fmtTok(threshold)}`, 'SHARE', 'OUT', 'C-RD/WR'];

function renderList(report) {
  const head = ['SESSION', 'LAST', 'DUR', ...statHead(report.threshold), 'SUB', 'FIRST PROMPT', 'MODELS'];
  const rows = report.sessions.map((s) => [
    s.sessionId.slice(0, 8),
    fmtWhen(s.last),
    fmtDur(s.durationMs),
    ...statCols(s.totals, s.main?.start ?? null),
    s.subagents.length,
    s.firstPrompt === null ? '(no human prompt)' : JSON.stringify(s.firstPrompt),
    fmtModels(s.totals.models),
  ]);
  const t = report.totals;
  rows.push(['TOTAL', '', '', ...statCols(t, null), report.sessions.reduce((n, s) => n + s.subagents.length, 0), `${report.sessionCount} sessions`, fmtModels(t.models)]);
  const lines = [
    `Sessions active since ${fmtWhen(new Date(report.since).toISOString())} — ${report.dir}`,
    table([head, ...rows], [0, 1, head.length - 2]),
  ];
  if (report.shown < report.sessionCount) lines.push(`(top ${report.shown} of ${report.sessionCount} shown; TOTAL covers all)`);
  if (report.malformed) lines.push(`${report.malformed} malformed line(s) skipped.`);
  return lines.join('\n');
}

function renderDetail(s, threshold, top) {
  const threads = [s.main, ...s.subagents].filter(Boolean).sort((a, b) => b.sumContext - a.sumContext);
  const shown = top ? threads.slice(0, top) : threads;
  const head = ['THREAD', ...statHead(threshold), 'MODELS'];
  const rows = shown.map((t) => [t.kind === 'main' ? 'main' : `sub ${t.label}`.slice(0, 60), ...statCols(t, t.start), fmtModels(t.models)]);
  rows.push(['TOTAL', ...statCols(s.totals, null), fmtModels(s.totals.models)]);
  const lines = [
    `Session ${s.sessionId}  ${s.firstPrompt === null ? '(no human prompt)' : JSON.stringify(s.firstPrompt)}`,
    `${fmtWhen(s.first)} → ${fmtWhen(s.last)} (${fmtDur(s.durationMs)}), ${s.subagents.length} subagent(s)`,
    table([head, ...rows], [0]),
  ];
  if (shown.length < threads.length) lines.push(`(top ${shown.length} of ${threads.length} threads shown; TOTAL covers all)`);
  if (s.malformed) lines.push(`${s.malformed} malformed line(s) skipped.`);
  return lines.join('\n');
}

function renderLive(l) {
  const lines = [
    `live ${l.sessionId.slice(0, 8)} main: ctx ${fmtTok(l.current)} (last call ${fmtWhen(l.lastCallAt)})  calls ${l.calls}  peak ${fmtTok(l.peak)}  Σctx ${fmtTok(l.sumContext)}  start ${fmtTok(l.start)} (base ${fmtPct(l.baseShare)})  >${fmtTok(l.threshold)} ${l.aboveCalls} (${fmtPct(l.aboveShare)})`,
  ];
  if (l.warning) lines.push(l.warning);
  return lines.join('\n');
}

const signed = (n) => `${n < 0 ? '-' : '+'}${fmtTok(Math.abs(n))}`;

function renderBaseline(r, top) {
  const shown = top ? r.main.slice(0, top) : r.main;
  const lines = [
    `Start-up baseline since ${fmtWhen(r.since)} — ${r.dir}`,
    `START = context of a thread's first call (system prompt, tools, CLAUDE.md, memory index, hook output, first prompt). BASE = its share of Σ context.`,
    '',
    `main threads, newest first (* = continued from a compaction, left out of the drift)`,
  ];
  if (shown.length) {
    const head = ['SESSION', 'STARTED', 'START', 'BASE', 'CALLS', 'FIRST PROMPT'];
    const rows = shown.map((m) => [m.sessionId.slice(0, 8) + (m.continued ? '*' : ''), fmtWhen(m.at), fmtTok(m.start), fmtPct(m.baseShare), m.calls, m.firstPrompt === null ? '(no human prompt)' : JSON.stringify(m.firstPrompt)]);
    lines.push(table([head, ...rows], [0, 1, 5]));
    if (shown.length < r.main.length) lines.push(`(top ${shown.length} of ${r.main.length} shown)`);
  } else lines.push('(none)');
  lines.push('', 'subagents by type');
  if (r.agents.length) {
    const head = ['AGENT TYPE', 'THREADS', 'AVG', 'MIN', 'MAX'];
    lines.push(table([head, ...r.agents.map((a) => [a.agentType, a.threads, fmtTok(a.avg), fmtTok(a.min), fmtTok(a.max)])], [0]));
  } else lines.push('(none)');
  lines.push('');
  const d = r.drift;
  if (d) {
    lines.push(`drift: median START of the oldest ${d.k} fresh main threads ${fmtTok(d.oldMedian)} → newest ${d.k} ${fmtTok(d.newMedian)} (${signed(d.delta)}, ${d.growth < 0 ? '' : '+'}${fmtPct(d.growth)})`);
    if (d.grew)
      lines.push(`DRIFT: start-up context grew more than ${fmtPct(DRIFT_GROWTH)} — every call of every session re-pays it. Check CLAUDE.md, MEMORY.md, SessionStart hook output and agent/tool definitions.`);
  } else lines.push(`drift: ${r.driftNote}`);
  lines.push(`baseline share of Σ context, all threads in the window: ${fmtPct(r.totals.baseShare)} (${fmtTok(r.totals.baselineContext)} of ${fmtTok(r.totals.sumContext)})`);
  if (r.files.length) lines.push(`hub-controlled files in every start (≈ bytes/4): ${r.files.map((f) => `${basename(f.path)} ${fmtTok(f.bytes)}B ≈ ${fmtTok(f.approxTokens)}`).join(' · ')}`);
  return lines.join('\n');
}

// ───────────────────────────────────────────── modes

function stripInternal(s) {
  const { _calls, ...rest } = s;
  return rest;
}

function listMode(dir, opts) {
  const since = opts.since ?? Date.now() - DEFAULT_DAYS * 86_400_000;
  const sessions = listSessions(dir)
    .filter((s) => s.mtime >= since)
    .map((s) => analyzeSession(s, opts.threshold))
    .sort((a, b) => (Date.parse(b.last || 0) || 0) - (Date.parse(a.last || 0) || 0));
  const shownSessions = opts.top ? sessions.slice(0, opts.top) : sessions;
  return {
    mode: 'list',
    dir,
    since: new Date(since).toISOString(),
    threshold: opts.threshold,
    sessionCount: sessions.length,
    shown: shownSessions.length,
    malformed: sessions.reduce((n, s) => n + s.malformed, 0),
    totals: summarize(sessions.flatMap((s) => s._calls), opts.threshold),
    sessions: shownSessions.map(stripInternal),
  };
}

function detailMode(dir, opts) {
  const s = resolveSession(listSessions(dir), opts.session);
  return { mode: 'session', dir, threshold: opts.threshold, ...stripInternal(analyzeSession(s, opts.threshold)) };
}

/** The session whose main transcript changed last (or the one named by --session): where it stands now. */
function liveMode(dir, opts) {
  const sessions = listSessions(dir).filter((s) => s.main);
  if (!sessions.length) throw new UsageError(`no main transcripts in ${dir}.`);
  const s = opts.session ? resolveSession(sessions, opts.session) : sessions.reduce((a, b) => (b.mainMtime > a.mainMtime ? b : a));
  const t = readTranscript(s.main);
  const start = annotateStart(t.calls);
  const stats = summarize(t.calls, opts.threshold);
  const lastCall = t.calls[t.calls.length - 1] || null;
  const current = lastCall ? lastCall.context : 0;
  const warning =
    current > opts.threshold
      ? `WARNING: the last call ran at ${fmtTok(current)} context, above the ${fmtTok(opts.threshold)} threshold — every further call re-pays it. Write state to disk (_SESSION-STATE.md) and continue in a fresh session.`
      : null;
  return {
    mode: 'live',
    dir,
    sessionId: s.sessionId,
    file: s.main,
    current,
    lastCallAt: lastCall?.ts || null,
    malformed: t.malformed,
    start,
    ...stats,
    warning,
  };
}

/** Files the hub controls that are loaded into every main-thread start; missing ones are left out. */
function startFiles(dir) {
  const userDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  return [join(userDir, 'CLAUDE.md'), join(HUB, 'CLAUDE.md'), join(dir, 'memory', 'MEMORY.md')].flatMap((path) => {
    try {
      const bytes = statSync(path).size;
      return [{ path, bytes, approxTokens: Math.round(bytes / 4) }];
    } catch {
      return [];
    }
  });
}

/** START per main thread and per subagent type in the window, and the drift of the main-thread START. */
function baselineMode(dir, opts) {
  const since = opts.since ?? Date.now() - DEFAULT_DAYS * 86_400_000;
  const sessions = listSessions(dir)
    .filter((s) => s.mtime >= since)
    .map((s) => analyzeSession(s, opts.threshold));
  const main = sessions
    .filter((s) => s.main?.calls)
    .map((s) => ({
      sessionId: s.sessionId,
      at: s.main.first,
      start: s.main.start,
      baseShare: s.main.baseShare,
      calls: s.main.calls,
      continued: CONTINUED.test(s.firstPrompt || ''),
      firstPrompt: s.firstPrompt,
    }))
    .sort((a, b) => (Date.parse(b.at || 0) || 0) - (Date.parse(a.at || 0) || 0));

  const byType = new Map();
  for (const s of sessions)
    for (const a of s.subagents) {
      if (!a.calls) continue;
      const k = a.agentType || '(no meta)';
      if (!byType.has(k)) byType.set(k, []);
      byType.get(k).push(a.start);
    }
  const agents = [...byType]
    .map(([agentType, starts]) => ({
      agentType,
      threads: starts.length,
      avg: Math.round(starts.reduce((x, y) => x + y, 0) / starts.length),
      min: Math.min(...starts),
      max: Math.max(...starts),
    }))
    .sort((a, b) => b.threads - a.threads || a.agentType.localeCompare(b.agentType));

  const fresh = main.filter((m) => !m.continued).reverse(); // oldest first
  const k = Math.min(DRIFT_K, Math.floor(fresh.length / 2));
  let drift = null;
  if (k >= 2) {
    const med = (ms) => percentile(ms.map((m) => m.start).sort((x, y) => x - y), 0.5);
    const oldMedian = med(fresh.slice(0, k));
    const newMedian = med(fresh.slice(-k));
    const growth = oldMedian ? (newMedian - oldMedian) / oldMedian : 0;
    drift = { k, oldMedian, newMedian, delta: newMedian - oldMedian, growth, grew: growth > DRIFT_GROWTH };
  }
  const { sumContext, baselineContext, baseShare } = summarize(sessions.flatMap((s) => s._calls), opts.threshold);
  return {
    mode: 'baseline',
    dir,
    since: new Date(since).toISOString(),
    sessionCount: sessions.length,
    main,
    agents,
    drift,
    driftNote: drift ? null : `needs at least 4 fresh main threads, found ${fresh.length} — widen --since.`,
    totals: { sumContext, baselineContext, baseShare },
    files: startFiles(dir),
  };
}

export function main(argv = process.argv.slice(2)) {
  let opts;
  try {
    opts = parseArgs(argv);
    if (opts.help) {
      console.log(USAGE);
      return 0;
    }
    const dir = opts.dir || defaultTranscriptDir();
    if (!existsSync(dir)) throw new UsageError(`transcripts dir not found: ${dir}. Pass --dir <path>.`);
    if (opts.baseline) {
      const r = baselineMode(dir, opts);
      console.log(opts.json ? JSON.stringify(r, null, 2) : renderBaseline(r, opts.top));
    } else if (opts.live) {
      const r = liveMode(dir, opts);
      console.log(opts.json ? JSON.stringify(r, null, 2) : renderLive(r));
    } else if (opts.session) {
      const r = detailMode(dir, opts);
      console.log(opts.json ? JSON.stringify(r, null, 2) : renderDetail(r, opts.threshold, opts.top));
    } else {
      const r = listMode(dir, opts);
      console.log(opts.json ? JSON.stringify(r, null, 2) : renderList(r));
    }
    return 0;
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(`session-cost: ${e.message}`);
      console.error(USAGE);
      return 2;
    }
    throw e;
  }
}

// exitCode, not process.exit(): exiting would cut off a large --json still being flushed to a pipe.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
