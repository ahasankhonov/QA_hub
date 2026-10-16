// Archive policy (R-15): which hub files are protected, how, and the snapshot store behind them.
//
// On 2026-10-01 a report-writer subagent used Write on projects/alpha/qa-reports/_NEEDS-MANUAL.md and
// replaced a ~71 KB, two-month archive with 20 lines. No copy survived. Prose ("archives are
// append-only") did not stop it, so this module is the shared truth for the (retired 2026-10-09) archive-guard hook,
// scripts/prune-backups.mjs and the selftest:
//
//   APPEND-ONLY    projects/**/_HISTORY.md, _NEEDS-MANUAL.md, _INTAKE-*.md — a change must be a pure append.
//   LEDGER         projects/**/_LEDGER-*.json — rewritten as JSON, so the rule is semantic: every ticket id
//                  in the current ledger must still be in the new one (verdicts may change).
//   SNAPSHOT-ONLY  run state, rules, prompts, profiles, agent plans, the hub memory dir — never blocked,
//                  always backed up before a change.
//
// Every protected file is snapshotted to HUB/.qa-backups/<rel>/<UTC stamp>-<sha8><ext> before it changes,
// so any loss is one `cp` from recoverable. Nothing here throws on bad input: callers decide fail-open or
// fail-closed. Paths compare case-insensitively (APFS) after resolving symlinks.

import {
  readFileSync, writeFileSync, statSync, lstatSync, readdirSync, mkdirSync, renameSync,
  appendFileSync, existsSync, realpathSync, copyFileSync, openSync, fstatSync, closeSync, constants as FS,
} from 'node:fs';
import { dirname, join, resolve, basename, extname, sep, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import os from 'node:os';

export const DEFAULT_HUB = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const KIND = { APPEND: 'append-only', LEDGER: 'ledger', SNAPSHOT: 'snapshot-only' };

const APPEND_NAME_RE = /^(_history\.md|_needs-manual\.md|_intake-.*\.md)$/i;
const LEDGER_NAME_RE = /^_ledger-.*\.json$/i;
const PLEDGER_NAME_RE = /^_p.*-ledger-.*\.md$/i;
const SESSION_NAME_RE = /^_session-state.*\.md$/i;
const TOP_SNAPSHOT = new Set(['claude.md', 'qa-agent-master-prompt.md', 'readme.md']);

/** Text that names an append-only archive (for opaque commands): _HISTORY, _NEEDS-MANUAL, _INTAKE-….md
 *  `_NEEDS-MANUAL-<run>.md` (the per-run file agents are told to use) is deliberately not a match.
 *  An _INTAKE- name matches only when it ends in .md or is a bare prefix (`'_INTAKE-' + run`): the
 *  append-only class is _INTAKE-*.md, and _INTAKE-*.json / -raw.json are ordinary files (RP-01). */
export const APPEND_MENTION_RE =
  /(?<![A-Za-z0-9])_(history|needs-manual)(?![\w-])|(?<![A-Za-z0-9])_intake-(?:[^\s'"`/;|&<>()]*\.md(?![A-Za-z0-9])|[^\s'"`/;|&<>().]*(?![^\s'"`/;|&<>()]))/i;
/** Text that names a ledger. */
export const LEDGER_MENTION_RE = /(?<![A-Za-z0-9])_ledger-/i;
/** Representative protected basenames, used to test whether a glob could match one. */
export const SAMPLE_APPEND_NAMES = ['_HISTORY.md', '_NEEDS-MANUAL.md', '_INTAKE-R1.md'];
export const SAMPLE_LEDGER_NAMES = ['_LEDGER-R1.json'];

// ─── context ─────────────────────────────────────────────────────────────────────────────────

export function memoryDirFor(hub) {
  if (process.env.QA_HUB_MEMORY_DIR) return resolve(process.env.QA_HUB_MEMORY_DIR);
  return join(os.homedir(), '.claude', 'projects', hub.replace(/[^a-zA-Z0-9]/g, '-'), 'memory');
}

/** realpath of p, or of its nearest existing parent with the missing segments appended. */
export function realish(p) {
  let cur = resolve(p);
  const tail = [];
  for (let i = 0; i < 4096; i++) {
    try {
      const r = realpathSync.native(cur);
      return tail.length ? join(r, ...tail.reverse()) : r;
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return resolve(p);
      tail.push(basename(cur));
      cur = parent;
    }
  }
  return resolve(p);
}

const ctxCache = new Map();
export function makeContext(hub = DEFAULT_HUB) {
  const key = hub + '\0' + (process.env.QA_HUB_MEMORY_DIR || '') + '\0' + os.homedir();
  if (ctxCache.has(key)) return ctxCache.get(key);
  const memoryDir = memoryDirFor(hub);
  const ctx = {
    hub: resolve(hub),
    hubReal: realish(hub),
    memoryDir,
    memoryReal: realish(memoryDir),
    backups: join(resolve(hub), '.qa-backups'),
  };
  ctxCache.set(key, ctx);
  return ctx;
}

const lc = (s) => s.toLowerCase();
const toSlash = (s) => s.split(sep).join('/');

/** Path of abs relative to base (case-insensitive), or null when abs is not under base. */
function relUnder(abs, base) {
  const a = lc(abs);
  const b = lc(base).replace(/\/+$/, '');
  if (a === b) return '';
  if (!a.startsWith(b + '/')) return null;
  return abs.slice(b.length + 1);
}

/** Classify a hub-relative path (forward slashes). Returns a KIND or null. */
export function classifyRel(rel) {
  const r = lc(rel);
  const parts = r.split('/');
  const name = parts[parts.length - 1];
  if (parts[0] === '.qa-backups') return null;
  if (parts[0] === 'projects' && parts.length >= 3) {
    if (APPEND_NAME_RE.test(name)) return KIND.APPEND;
    if (LEDGER_NAME_RE.test(name)) return KIND.LEDGER;
    if (PLEDGER_NAME_RE.test(name) || SESSION_NAME_RE.test(name)) return KIND.SNAPSHOT;
    return null;
  }
  if (r === 'reports/_portfolio.md') return KIND.SNAPSHOT;
  if (parts.length === 1 && TOP_SNAPSHOT.has(name)) return KIND.SNAPSHOT;
  if (parts.length === 2 && parts[0] === 'rules' && name.endsWith('.md')) return KIND.SNAPSHOT;
  if (parts.length === 2 && parts[0] === 'profiles' && name.endsWith('.json')) return KIND.SNAPSHOT;
  if (parts.length === 3 && parts[0] === '.claude' && parts[1] === 'agents' && name.endsWith('.md')) return KIND.SNAPSHOT;
  if (parts[0] === 'agent' && parts.length >= 2 && /\.(md|json)$/.test(name)) return KIND.SNAPSHOT;
  return null;
}

/**
 * classify(absPath) → { kind, rel, abs } | null.
 * rel is the store key (hub-relative, or `_memory/<name>`); abs is the resolved real file.
 * Both the lexical and the symlink-resolved path are tried, so a link INTO an archive is protected.
 */
export function classify(absPath, ctx = makeContext()) {
  try {
    if (!absPath || typeof absPath !== 'string') return null;
    const lexical = resolve(absPath);
    const real = realish(lexical);
    for (const p of real === lexical ? [real] : [real, lexical]) {
      for (const base of [ctx.hubReal, ctx.hub]) {
        const rel = relUnder(p, base);
        if (rel == null || rel === '') continue;
        const kind = classifyRel(toSlash(rel));
        if (kind) return { kind, rel: toSlash(rel), abs: join(ctx.hub, rel) };
      }
      for (const base of [ctx.memoryReal, ctx.memoryDir]) {
        const rel = relUnder(p, base);
        if (rel && !rel.includes('/') && lc(rel).endsWith('.md'))
          return { kind: KIND.SNAPSHOT, rel: `_memory/${rel}`, abs: join(ctx.memoryDir, rel) };
      }
    }
  } catch {
    /* fall through */
  }
  return null;
}

// ─── enumeration (fast: directory mtimes are cached so an unchanged tree costs one stat per dir) ──

const SKIP_DIRS = new Set(['node_modules', '.git']);

function walkCached(absDir, relDir, dirCache, seen, out) {
  let st;
  try {
    st = statSync(absDir);
  } catch {
    return;
  }
  if (!st.isDirectory()) return;
  seen.add(relDir);
  let entry = dirCache[relDir];
  if (!entry || entry.m !== st.mtimeMs) {
    entry = { m: st.mtimeMs, f: [], d: [] };
    let ents = [];
    try {
      ents = readdirSync(absDir, { withFileTypes: true });
    } catch {
      /* unreadable dir */
    }
    for (const e of ents) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) entry.d.push(e.name);
      } else if (e.isFile() || e.isSymbolicLink()) {
        if (classifyRel(`${relDir}/${e.name}`)) entry.f.push(e.name);
      }
    }
    dirCache[relDir] = entry;
    dirCache.__dirty = true;
  }
  for (const f of entry.f) out.push(`${relDir}/${f}`);
  for (const d of entry.d) walkCached(join(absDir, d), `${relDir}/${d}`, dirCache, seen, out);
}

function listFlat(absDir, relDir, filter, out) {
  let ents = [];
  try {
    ents = readdirSync(absDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of ents) {
    const rel = relDir ? `${relDir}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (filter === 'recurse') listFlat(join(absDir, e.name), rel, filter, out);
    } else if (classifyRel(rel)) out.push(rel);
  }
}

/** Every protected file that exists now: [{ kind, rel, abs }]. dirCache is mutated (see loadDirCache). */
export function listProtected(ctx = makeContext(), dirCache = {}) {
  const rels = [];
  const seen = new Set();
  walkCached(join(ctx.hub, 'projects'), 'projects', dirCache, seen, rels);
  for (const k of Object.keys(dirCache)) {
    if (k !== '__dirty' && !seen.has(k)) {
      delete dirCache[k];
      dirCache.__dirty = true;
    }
  }
  for (const name of ['CLAUDE.md', 'QA-AGENT-MASTER-PROMPT.md', 'README.md']) {
    if (existsSync(join(ctx.hub, name))) rels.push(name);
  }
  if (existsSync(join(ctx.hub, 'reports', '_PORTFOLIO.md'))) rels.push('reports/_PORTFOLIO.md');
  listFlat(join(ctx.hub, 'rules'), 'rules', 'flat', rels);
  listFlat(join(ctx.hub, 'profiles'), 'profiles', 'flat', rels);
  listFlat(join(ctx.hub, '.claude', 'agents'), '.claude/agents', 'flat', rels);
  listFlat(join(ctx.hub, 'agent'), 'agent', 'recurse', rels);
  const out = rels.map((rel) => ({ kind: classifyRel(rel), rel, abs: join(ctx.hub, ...rel.split('/')) }));
  try {
    for (const e of readdirSync(ctx.memoryDir, { withFileTypes: true })) {
      if (e.isFile() && lc(e.name).endsWith('.md'))
        out.push({ kind: KIND.SNAPSHOT, rel: `_memory/${e.name}`, abs: join(ctx.memoryDir, e.name) });
    }
  } catch {
    /* no memory dir — never create it */
  }
  return out;
}

// ─── content rules ─────────────────────────────────────────────────────────────────────────

/** A pure append: the result starts with the current content (trailing whitespace trimmed). */
export function isPureAppend(current, result) {
  if (typeof current !== 'string' || typeof result !== 'string') return false;
  return result.startsWith(current.replace(/\s+$/, ''));
}

function replaceOnce(content, oldS, newS, all) {
  if (typeof oldS !== 'string' || typeof newS !== 'string') return { error: 'old_string/new_string missing' };
  if (oldS === '') return { error: 'old_string is empty on an existing file' };
  const idx = content.indexOf(oldS);
  if (idx < 0) return { error: 'old_string does not occur in the file exactly as given' };
  if (all) return { result: content.split(oldS).join(newS) };
  if (content.indexOf(oldS, idx + 1) >= 0) return { error: 'old_string occurs more than once and replace_all is not set' };
  return { result: content.slice(0, idx) + newS + content.slice(idx + oldS.length) };
}

/**
 * Simulate a Write / Edit / MultiEdit against `current` (null when the file does not exist).
 * Returns { result } or { error } — an error means the tool would fail or we cannot predict it.
 */
export function simulateEdit(toolName, input, current) {
  try {
    if (toolName === 'Write') {
      if (typeof input?.content !== 'string') return { error: 'Write without string content' };
      return { result: input.content };
    }
    const base = current ?? '';
    if (toolName === 'Edit') {
      if (current == null && input?.old_string === '') return { result: input.new_string ?? '' };
      return replaceOnce(base, input?.old_string, input?.new_string, !!input?.replace_all);
    }
    if (toolName === 'MultiEdit') {
      if (!Array.isArray(input?.edits) || !input.edits.length) return { error: 'MultiEdit without edits' };
      let acc = base;
      for (const [i, e] of input.edits.entries()) {
        if (current == null && i === 0 && e?.old_string === '') {
          acc = e.new_string ?? '';
          continue;
        }
        const r = replaceOnce(acc, e?.old_string, e?.new_string, !!e?.replace_all);
        if (r.error) return { error: `edit ${i + 1}: ${r.error}` };
        acc = r.result;
      }
      return { result: acc };
    }
    return { error: `unsupported tool ${toolName}` };
  } catch (e) {
    return { error: String(e?.message || e) };
  }
}

function idOf(x) {
  if (typeof x === 'string' && x.trim()) return x.trim();
  if (!x || typeof x !== 'object') return null;
  for (const k of ['id', 'ticketId', 'ticket', 'key', 'identifier', 'draftId', 'ref', 'tempId']) {
    if (typeof x[k] === 'string' && x[k].trim()) return x[k].trim();
    if (typeof x[k] === 'number') return String(x[k]);
  }
  if (typeof x.title === 'string' && x.title.trim()) return `title:${x.title.trim()}`;
  return null;
}

function collect(list, prefix, into) {
  if (Array.isArray(list)) {
    for (const x of list) {
      const id = idOf(x);
      if (id) into.add(prefix + id);
    }
  } else if (list && typeof list === 'object') {
    for (const k of Object.keys(list)) into.add(prefix + k);
  }
}

/**
 * Ticket ids of a ledger. Never throws.
 * → { valid: boolean (parsed as JSON), ids: string[] }
 * Primary ids are tickets[].id. A ledger with no tickets (bug-hunt / candidate shapes) falls back to its
 * candidates / candidateBugs (id, draftId, ref, else `title:<title>`) so it is still protected.
 */
export function ledgerIds(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return { valid: false, ids: [] };
  }
  const ids = new Set();
  try {
    if (Array.isArray(doc)) collect(doc, '', ids);
    else if (doc && typeof doc === 'object') {
      collect(doc.tickets, '', ids);
      if (!ids.size) {
        collect(doc.candidates, '', ids);
        collect(doc.candidateBugs, '', ids);
      }
    }
  } catch {
    /* partial ids are still useful */
  }
  return { valid: true, ids: [...ids] };
}

/** Ids present in `before` and missing from `after`. */
export function droppedIds(beforeText, afterText) {
  const b = ledgerIds(beforeText);
  const a = ledgerIds(afterText);
  if (!b.valid) return { invalidAfter: false, missing: [] };
  if (!a.valid) return { invalidAfter: true, missing: [] };
  const have = new Set(a.ids);
  return { invalidAfter: false, missing: b.ids.filter((x) => !have.has(x)) };
}

/** Is a change from `before` to `after` legitimate for this kind? → { ok, why } */
export function judgeChange(kind, before, after) {
  if (kind === KIND.APPEND) {
    if (after == null) return { ok: false, why: 'the file was deleted' };
    if (isPureAppend(before, after)) return { ok: true };
    const n = Buffer.byteLength(before), m = Buffer.byteLength(after);
    return { ok: false, why: m < n ? `it shrank from ${n} to ${m} bytes` : 'its earlier content was changed' };
  }
  if (kind === KIND.LEDGER) {
    if (after == null) return { ok: false, why: 'the ledger was deleted' };
    const d = droppedIds(before, after);
    if (d.invalidAfter) return { ok: false, why: 'it is no longer valid JSON' };
    if (d.missing.length)
      return { ok: false, why: `ticket ids dropped: ${d.missing.slice(0, 10).join(', ')}${d.missing.length > 10 ? ` (+${d.missing.length - 10} more)` : ''}`, missing: d.missing };
    return { ok: true };
  }
  return { ok: true };
}

// ─── globs (for shell targets we cannot resolve) ───────────────────────────────────────────

export function braceExpand(s, depth = 0) {
  const m = depth < 6 && /\{([^{}]*,[^{}]*)\}/.exec(s);
  if (!m) return [s];
  return m[1].split(',').flatMap((alt) => braceExpand(s.slice(0, m.index) + alt + s.slice(m.index + m[0].length), depth + 1));
}

export function globToRegex(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') re += '.*';
    else if (c === '?') re += '.';
    else if (c === '[') {
      const end = glob.indexOf(']', i + 2);
      if (end < 0) re += '\\[';
      else {
        let cls = glob.slice(i + 1, end).replace(/\\/g, '\\\\');
        if (cls[0] === '!') cls = '^' + cls.slice(1);
        re += `[${cls}]`;
        i = end;
      }
    } else re += c.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}

/** Could the basename glob of `pattern` match a protected name? → { append, ledger } */
export function globCouldMatch(pattern) {
  const res = { append: false, ledger: false };
  try {
    for (const p of braceExpand(String(pattern))) {
      const last = p.split('/').filter(Boolean).pop() || '';
      // Any expansion inside the basename could be anything.
      if (/[$`]/.test(last)) return { append: true, ledger: true };
      const re = globToRegex(last);
      if (SAMPLE_APPEND_NAMES.some((n) => re.test(n))) res.append = true;
      if (SAMPLE_LEDGER_NAMES.some((n) => re.test(n))) res.ledger = true;
    }
  } catch {
    return { append: true, ledger: true };
  }
  return res;
}

// ─── store ───────────────────────────────────────────────────────────────────────────────────

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

export function utcStamp(d = new Date()) {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

/**
 * What is at p (following links)? → 'missing' | 'file' | 'other' (FIFO, device, socket, directory).
 * FS-03: a FIFO or a /dev/zero link where the guard reads would hang it, and a hung PreToolUse hook does
 * not block, so nothing on the decision path reads a file that is not a regular file.
 */
export function fileKind(p) {
  try {
    return statSync(p).isFile() ? 'file' : 'other';
  } catch {
    return 'missing';
  }
}

/**
 * Read p only if it is a regular file. The open is non-blocking (a FIFO opens at once instead of waiting
 * for a writer) and the type is checked on the open descriptor, so a swap between check and read cannot
 * make it block. → Buffer | null.
 */
export function readRegular(p) {
  let fd;
  try {
    fd = openSync(p, FS.O_RDONLY | FS.O_NONBLOCK);
    if (!fstatSync(fd).isFile()) return null;
    return readFileSync(fd);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* already closed */ }
  }
}

function readJson(p) {
  try {
    const buf = readRegular(p);
    if (buf == null) return null;
    const v = JSON.parse(buf.toString('utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/** Write JSON atomically: unique tmp + rename. A lost race costs one extra snapshot later. */
export function writeJsonAtomic(p, obj) {
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj));
  renameSync(tmp, p);
}

/**
 * _index.json → { relpath: {size, mtimeMs, sha256, latest, damaged?} }. Corrupt / missing → {} (rebuilt by
 * the sweep from the newest good snapshot of each file, see refreshOne). A present but unusable index is
 * recorded on ctx.indexProblem so SessionStart can say so (FS-05).
 */
export function loadIndex(ctx) {
  const p = join(ctx.backups, '_index.json');
  const kind = fileKind(p);
  if (kind === 'missing') return {};
  const v = readJson(p);
  if (v) return v;
  const problem = kind === 'other' ? 'is not a regular file' : 'is corrupt or not a JSON object';
  if (ctx.indexProblem !== problem) {
    ctx.indexProblem = problem;
    logEvent(ctx, { event: 'index-unusable', problem });
  }
  return {};
}
export function saveIndex(ctx, index) {
  writeJsonAtomic(join(ctx.backups, '_index.json'), index);
}
export function loadDirCache(ctx) {
  return readJson(join(ctx.backups, '_dircache.json')) || {};
}
export function saveDirCache(ctx, cache) {
  if (!cache.__dirty) return;
  delete cache.__dirty;
  writeJsonAtomic(join(ctx.backups, '_dircache.json'), cache);
}

export function logEvent(ctx, ev) {
  try {
    mkdirSync(ctx.backups, { recursive: true });
    if (fileKind(join(ctx.backups, '_log.jsonl')) === 'other') return; // FS-03: appending to a FIFO blocks
    appendFileSync(join(ctx.backups, '_log.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...ev }) + '\n');
  } catch {
    /* logging never breaks the guard */
  }
}

/** Write a content-addressed snapshot of `buf` for `rel`. Returns its absolute path. */
export function writeSnapshot(ctx, rel, buf) {
  const hash = sha256(buf);
  const dir = join(ctx.backups, ...rel.split('/'));
  mkdirSync(dir, { recursive: true });
  const ext = extname(rel);
  try {
    for (const n of readdirSync(dir)) if (n.endsWith(`-${hash.slice(0, 8)}${ext}`)) {
      const p = join(dir, n);
      try {
        const old = readRegular(p);
        if (old && sha256(old) === hash) return { path: p, hash, reused: true };
      } catch { /* unreadable, write a new one */ }
    }
  } catch { /* new dir */ }
  const p = join(dir, `${utcStamp()}-${hash.slice(0, 8)}${ext}`);
  const tmp = `${p}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, buf);
  renameSync(tmp, p);
  return { path: p, hash, reused: false };
}

const readOrNull = readRegular;

/** Snapshot paths the log recorded as the BAD copy of a damage (never a rebuild baseline). */
function badSnapshots(ctx) {
  if (ctx._bad) return ctx._bad;
  const bad = new Set();
  const buf = readRegular(join(ctx.backups, '_log.jsonl'));
  if (buf) {
    for (const line of buf.toString('utf8').split('\n')) {
      if (!line.includes('"damage"')) continue;
      try {
        const e = JSON.parse(line);
        if (e.event === 'damage' && typeof e.bad === 'string') bad.add(e.bad.toLowerCase());
      } catch { /* torn line */ }
    }
  }
  ctx._bad = bad;
  return bad;
}

/**
 * FS-05: the newest good snapshot of rel on disk (by its UTC-stamp name), for when the index has no entry
 * (index lost, corrupt or wrong shape). Without this the sweep would take the current — possibly damaged —
 * content as the new baseline and never report the damage. → { path, buf } | null
 */
export function newestSnapshot(ctx, rel) {
  const dir = join(ctx.backups, ...rel.split('/'));
  let names = [];
  try {
    names = readdirSync(dir).filter((n) => /^\d{8}T\d{6}Z-[0-9a-f]{8}(\.[^.]*)?$/i.test(n));
  } catch {
    return null;
  }
  const bad = badSnapshots(ctx);
  names.sort().reverse();
  for (const n of names.slice(0, 50)) {
    const p = join(dir, n);
    if (bad.has(p.toLowerCase())) continue;
    const buf = readRegular(p);
    if (buf && sha256(buf).startsWith(n.split('-')[1].slice(0, 8).toLowerCase())) return { path: p, buf };
  }
  return null;
}

/**
 * Bring one protected file's index entry up to date. Snapshots the file if it changed.
 * The baseline (size/mtimeMs/sha256/latest) only advances when the change is legitimate for its kind;
 * an illegitimate change is snapshotted too, recorded under `damaged`, and returned.
 * → null (clean) | { rel, abs, kind, why, snapshot (the last good copy), size, prevSize, damaged }
 */
export function refreshOne(ctx, index, file) {
  const { rel, abs, kind } = file;
  let e = index[rel];
  let st = null;
  try {
    st = statSync(abs);
  } catch {
    st = null;
  }
  if (st && !st.isFile()) {
    // FS-03: a FIFO / device / directory under a protected name. Never read it (that can hang); log it.
    logEvent(ctx, { event: 'skip-not-regular', rel });
    return null;
  }
  if (!e && kind !== KIND.SNAPSHOT) {
    // FS-05: no index entry. If an earlier snapshot exists, judge the current content against it.
    const prev = newestSnapshot(ctx, rel);
    if (prev) {
      e = index[rel] = { size: prev.buf.length, mtimeMs: -1, sha256: sha256(prev.buf), latest: prev.path, rebuilt: true };
      logEvent(ctx, { event: 'index-rebuilt', rel, from: prev.path });
    }
  }
  if (!st) {
    if (!e || kind === KIND.SNAPSHOT) return null;
    // A protected archive vanished.
    if (e.damaged?.missing) return { ...file, why: 'the file was deleted', snapshot: e.latest, prevSize: e.size, size: 0, damaged: e.damaged };
    e.damaged = { missing: true, at: new Date().toISOString() };
    return { ...file, why: 'the file was deleted', snapshot: e.latest, prevSize: e.size, size: 0, damaged: e.damaged };
  }
  if (e && e.size === st.size && e.mtimeMs === st.mtimeMs && !e.damaged) return null;
  if (e?.damaged && e.damaged.size === st.size && e.damaged.mtimeMs === st.mtimeMs)
    return { ...file, why: e.damaged.why, snapshot: e.latest, prevSize: e.size, size: st.size, damaged: e.damaged };
  const buf = readOrNull(abs);
  if (buf == null) return null;
  const hash = sha256(buf);
  if (e && e.sha256 === hash) {
    Object.assign(e, { size: st.size, mtimeMs: st.mtimeMs });
    delete e.damaged;
    return null;
  }
  if (e && kind !== KIND.SNAPSHOT && e.latest) {
    const before = readOrNull(e.latest);
    if (before != null && sha256(before) === e.sha256) {
      const verdict = judgeChange(kind, before.toString('utf8'), buf.toString('utf8'));
      if (!verdict.ok) {
        const snap = writeSnapshot(ctx, rel, buf);
        if (!e.damaged || e.damaged.sha256 !== hash) {
          e.damaged = { sha256: hash, size: st.size, mtimeMs: st.mtimeMs, why: verdict.why, snapshot: snap.path, at: new Date().toISOString() };
          logEvent(ctx, { event: 'damage', rel, why: verdict.why, good: e.latest, bad: snap.path });
        } else Object.assign(e.damaged, { size: st.size, mtimeMs: st.mtimeMs });
        return { ...file, why: verdict.why, snapshot: e.latest, prevSize: e.size, size: st.size, damaged: e.damaged };
      }
    }
  }
  const snap = writeSnapshot(ctx, rel, buf);
  index[rel] = { size: st.size, mtimeMs: st.mtimeMs, sha256: hash, latest: snap.path };
  if (!snap.reused) logEvent(ctx, { event: 'snapshot', rel, kind, size: st.size, path: snap.path });
  return null;
}

/** Sweep every protected file. → { index, damages: [...], files } (index already saved). */
export function sweep(ctx = makeContext()) {
  const dirCache = loadDirCache(ctx);
  const files = listProtected(ctx, dirCache);
  const index = loadIndex(ctx);
  const before = JSON.stringify(index);
  const damages = [];
  const present = new Set(files.map((f) => f.rel));
  // Archives that were in the index but are gone now.
  for (const rel of Object.keys(index)) {
    if (present.has(rel)) continue;
    const kind = rel.startsWith('_memory/') ? KIND.SNAPSHOT : classifyRel(rel);
    if (kind === KIND.APPEND || kind === KIND.LEDGER) files.push({ kind, rel, abs: join(ctx.hub, ...rel.split('/')) });
  }
  for (const f of files) {
    try {
      const d = refreshOne(ctx, index, f);
      if (d) damages.push(d);
    } catch (err) {
      logEvent(ctx, { event: 'error', rel: f.rel, error: String(err?.message || err) });
    }
  }
  if (JSON.stringify(index) !== before) saveIndex(ctx, index);
  saveDirCache(ctx, dirCache);
  return { index, damages, files };
}

/** The restore instruction for a damage record. */
export function restoreHint(d) {
  if (!d.snapshot) return `No earlier snapshot exists for ${d.abs}.`;
  return `Restore with: cp '${d.snapshot}' '${d.abs}' and then append your new text with cat >>.`;
}

export { isAbsolute };
