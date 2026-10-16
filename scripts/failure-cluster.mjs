#!/usr/bin/env node
// Failure clusters — which cases, across tickets, share one recorded error? Read-only over the results.
//
//   node scripts/failure-cluster.mjs --project <slug> --run <runId> [--results <dir>] [--out <file>]
//
// Why: orchestrator step 6 (cross-ticket synthesis) was a model reading result files by eye. One backend
// 500 behind five tickets got filed as five bugs, or missed. This fingerprints every error signal the
// executor recorded and groups the cases that share one, so the model starts from the shared causes.
// Idea from petrkindlmann/qa-skills (second read, 2026-10-16).
//
// Where the results are: every _RESULT-<run>-*.json under projects/<slug>/qa-reports, subfolders included
// (<run>-P1-results/ …), whose runId is <run>. _stale-* folders are skipped (superseded builds).
// --results <dir> reads every _RESULT-*.json under <dir> with that runId instead.
//
// Signals per case (evidence is an object or an array of them; list entries are strings or objects):
//   call       evidence.failedCalls[] {method,url,status,message} (web harness, since 2026-10-16), and
//              evidence.chucker.errors[] {method,host,path,status} (Android network inspector, beta)
//   page       evidence.httpStatus >= 400, with evidence.url
//   console    evidence.consoleErrors[]. A "Failed to load resource" line is dropped when the same evidence
//              has failedCalls: it is the same event without the URL.
//   pageerror  evidence.pageErrors[] (uncaught exceptions)
// Normalised before hashing:
//   URL        host + path. The query and fragment are DROPPED (their values are ids and filters, and which
//              keys are sent varies with UI state); a trailing slash is dropped. A path segment, or a -_.~
//              part of one, that is numeric, a UUID, 10+ hex with a digit, or a letter+digit token (2+ digits
//              and 6+ chars, or 12+ chars) becomes :id. v1, oauth2 stay.
//   message    first non-empty line (stack frames carry build hashes and line numbers); a JSON body is
//              reduced to its message/detail/error field; URLs → their template; quoted strings → <STR>,
//              UUIDs → <UUID>, ISO timestamps → <TS>, 8+ char letter+digit tokens → <ID>, numbers → <NUM>;
//              whitespace collapsed, capped at 160 chars. A console "status of 404" keeps 404 as the status.
//   fingerprint = sha256(kind|method|pathTemplate|status|messageTemplate), first 16 hex.
// Failing: the case verdict in _LEDGER-<run>.json, read only (FAIL… = failing, any other verdict = not).
// No ledger entry: matchesExpected false = failing, true = passing, anything else = unknown.
// Labels: shared = 2+ tickets with a failing case · single = one ticket with a failing case · background =
// no case failed (a poll that 401s on every page). Unknown counts as possibly failing, so a run without
// verdicts never hides a cluster as background.
// failRate per cluster vs the run's baseFailRate: a shared cluster that fails no more often than the run as a
// whole is ambient (it is on every page), not a cause. The spec's "background" only catches it on all-pass runs.
// Tickets are the tracker key in ticketId (ALP-734-S734 → ALP-734): one ticket's scenario files are not "shared".
//
// Output: _CLUSTERS-<run>.json in qa-reports (or the --results dir); --out overrides. stdout lists the
// clusters spanning 2+ tickets. Exit 0 = report written, 1 = no result files for the run, 2 = usage.

import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve, relative, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HUB = join(dirname(fileURLToPath(import.meta.url)), '..');
const MSG_CAP = 160;
const SKIP_DIR = /^(_stale|\.|node_modules$|_md$)|_attachments$|shots$/;
// Archives are append-only (R-15) and the ledger belongs to the verifier: never a place to write clusters.
const PROTECTED = /^_(LEDGER|HISTORY|NEEDS-MANUAL|INTAKE)/;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const KEY = /[A-Z][A-Z0-9]*-\d+/g;

const list = (v) => (Array.isArray(v) ? v : []);
const textOf = (e) => (typeof e === 'string' ? e : e?.text ?? e?.message ?? e?.msg ?? e?.description ?? JSON.stringify(e ?? ''));

/** A path token that is an id: numeric, 10+ hex with a digit, or letter+digit (2+ digits and 6+ chars, or 12+). */
function isIdToken(t) {
  if (/^\d+$/.test(t)) return true;
  if (/^[0-9a-f]{10,}$/i.test(t) && /\d/.test(t)) return true;
  if (!/^[A-Za-z0-9]+$/.test(t) || !/\d/.test(t) || !/[A-Za-z]/.test(t) || /^v\d+$/i.test(t)) return false;
  return t.length >= 12 || (t.length >= 6 && t.replace(/\D/g, '').length >= 2);
}

function templateSegment(seg) {
  if (!seg) return seg;
  let s = seg;
  try { s = decodeURIComponent(seg); } catch { /* keep it encoded */ }
  s = s.replace(UUID, ':id');
  if (s === ':id' || isIdToken(s)) return ':id';
  return s.split(/([-_.~])/).map((t) => (isIdToken(t) ? ':id' : t)).join('');
}

/** host + templated path, no query/fragment: https://h/api/v1/offers/123/?a=1 → h/api/v1/offers/:id */
export function templateUrl(raw) {
  const s = String(raw ?? '').trim();
  let host = '';
  let path = s.replace(/[?#].*$/, '');
  try {
    const u = new URL(s);
    host = u.host.toLowerCase();
    path = u.pathname;
  } catch { /* a bare path */ }
  const out = path.split('/').map(templateSegment).join('/');
  return host + (out.length > 1 ? out.replace(/\/$/, '') : out);
}

/** A JSON error body → its message field; anything else unchanged. */
function bodyText(raw) {
  let v = raw;
  if (typeof v === 'string' && /^\s*[[{]/.test(v)) {
    try { v = JSON.parse(v); } catch { return raw; }
  }
  if (v === null || typeof v !== 'object') return String(v ?? '');
  const flat = (x) => (Array.isArray(x) ? x.map(textOf).join('; ') : typeof x === 'object' && x ? JSON.stringify(x) : String(x));
  if (Array.isArray(v)) return flat(v);
  for (const k of ['message', 'detail', 'error_description', 'error', 'title', 'msg', 'errors'])
    if (v[k] != null && v[k] !== '') return flat(v[k]);
  return Object.entries(v).map(([k, x]) => `${k}: ${flat(x)}`).join('; ');
}

/** The message template: ids, quoted values, timestamps and numbers replaced; one line, capped. */
export function normaliseMessage(raw, cap = MSG_CAP) {
  const line = String(raw ?? '').split('\n').find((l) => l.trim()) ?? '';
  return line
    .replace(/\bhttps?:\/\/[^\s'"`<>()]+/g, (u) => templateUrl(u))
    .replace(/"[^"\n]*"|`[^`\n]*`|(?<!\w)'[^'\n]*'(?!\w)/g, '<STR>')
    .replace(UUID, '<UUID>')
    .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g, '<TS>')
    .replace(/\b(?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{8,}\b/g, '<ID>')
    .replace(/\b\d+(?:\.\d+)?\b/g, '<NUM>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, cap);
}

/** sha256(kind|method|pathTemplate|status|messageTemplate), first 16 hex. Takes normalised parts. */
export function fingerprint({ kind, method = '', path = '', status = '', message = '' }) {
  return createHash('sha256').update([kind, method, path, status, message].join('|')).digest('hex').slice(0, 16);
}

/** One raw signal → its normalised parts, fingerprint and human-readable signature. */
export function makeSignal(kind, { method = '', url = '', status = '', message = '' } = {}) {
  const parts = {
    kind,
    method: String(method || '').toUpperCase(),
    path: url ? templateUrl(url) : '',
    status: status === '' || status == null ? '' : String(status).trim(),
    message: normaliseMessage(kind === 'call' ? bodyText(message) : message),
  };
  const signature = [kind, parts.method, parts.path, parts.status, parts.message && `"${parts.message}"`].filter(Boolean).join(' ');
  const example = [parts.method, url, parts.status, String(textOf(message ?? '')).split('\n')[0]].filter(Boolean).join(' ').slice(0, 300);
  return { ...parts, fingerprint: fingerprint(parts), signature, example };
}

/** Every error signal in one case's evidence (object, array of objects, or nothing). */
export function signalsOf(evidence) {
  const out = [];
  for (const ev of [].concat(evidence ?? [])) {
    if (!ev || typeof ev !== 'object') continue;
    const calls = list(ev.failedCalls);
    // A call that got no response carries the exception instead (chucker: status null, error "SocketTimeoutException").
    for (const c of calls) out.push(makeSignal('call', { method: c?.method, url: c?.url, status: c?.status, message: c?.message ?? c?.error }));
    for (const c of list(ev.chucker?.errors)) {
      const url = c?.url ?? (c?.host ? `https://${c.host}${c.path || ''}` : c?.path);
      out.push(makeSignal('call', { method: c?.method, url, status: c?.status, message: c?.message ?? c?.error }));
    }
    if (Number(ev.httpStatus) >= 400 && ev.url) out.push(makeSignal('page', { url: ev.url, status: Number(ev.httpStatus) }));
    for (const e of list(ev.consoleErrors)) {
      const text = textOf(e);
      if (calls.length && /^\s*Failed to load resource/i.test(text)) continue;
      out.push(makeSignal('console', { status: (text.match(/status of (\d{3})\b/) || [])[1] ?? '', message: text }));
    }
    for (const e of list(ev.pageErrors)) out.push(makeSignal('pageerror', { message: textOf(e) }));
  }
  return out;
}

/** shared / single / background. failing is true, false or null (unknown = possibly failing). */
export function labelOf({ tickets, cases }) {
  if (!cases.some((c) => c.failing !== false)) return 'background';
  return tickets.length >= 2 ? 'shared' : 'single';
}

const rankFailing = (f) => (f === true ? 2 : f === false ? 1 : 0);
const rate = (n, d) => (d > 0 ? Math.round((n / d) * 100) / 100 : null);

/** Failing share of the run's cases with a verdict (each ticket+case once). A shared cluster whose failRate
 *  is no higher than this rides along on every page (ambient noise), it does not explain the failures. */
export function baseFailRate(cases) {
  const best = new Map();
  for (const c of cases) {
    const k = `${c.ticket}\u0000${c.caseId}`;
    if (!best.has(k) || rankFailing(c.failing) > rankFailing(best.get(k))) best.set(k, c.failing ?? null);
  }
  const known = [...best.values()].filter((f) => f != null);
  return rate(known.filter((f) => f === true).length, known.length);
}

/** cases: [{ticket, caseId, failing, signals}] → clusters, widest first. One membership per case. */
export function clusterCases(cases) {
  const byFp = new Map();
  for (const c of cases) {
    for (const s of c.signals) {
      let cl = byFp.get(s.fingerprint);
      if (!cl) byFp.set(s.fingerprint, (cl = { fingerprint: s.fingerprint, kind: s.kind, signature: s.signature, example: s.example, hits: 0, members: new Map() }));
      cl.hits++;
      const key = `${c.ticket}\u0000${c.caseId}`;
      const prev = cl.members.get(key);
      // The same case in two result files (a rerun): FAIL beats PASS beats unknown.
      if (!prev || rankFailing(c.failing) > rankFailing(prev.failing)) cl.members.set(key, { ticket: c.ticket, caseId: c.caseId, failing: c.failing ?? null });
    }
  }
  const clusters = [...byFp.values()].map(({ members, ...cl }) => {
    const memberCases = [...members.values()].sort((a, b) => a.ticket.localeCompare(b.ticket) || String(a.caseId).localeCompare(String(b.caseId)));
    const tickets = [...new Set(memberCases.map((m) => m.ticket))].sort();
    const failing = memberCases.filter((m) => m.failing === true).length;
    const unknown = memberCases.filter((m) => m.failing == null).length;
    const out = { fingerprint: cl.fingerprint, kind: cl.kind, label: null, signature: cl.signature, tickets, count: memberCases.length,
      failing, unknown, failRate: rate(failing, memberCases.length - unknown), hits: cl.hits, example: cl.example, cases: memberCases };
    out.label = labelOf(out);
    return out;
  });
  return clusters.sort((a, b) => b.tickets.length - a.tickets.length || b.failing - a.failing || b.count - a.count || a.fingerprint.localeCompare(b.fingerprint));
}

/** The run's result files. Default mode pre-filters on the _RESULT-<run> name; anyName reads every _RESULT-*. */
export function findResultFiles(root, run, { anyName = false } = {}) {
  const files = [];
  const unreadable = [];
  const walk = (dir) => {
    let ents;
    try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP_DIR.test(e.name)) walk(p); continue; }
      if (!/^_RESULT-.*\.json$/.test(e.name)) continue;
      const named = e.name === `_RESULT-${run}.json` || e.name.startsWith(`_RESULT-${run}-`);
      if (!anyName && !named) continue;
      let doc;
      try { doc = JSON.parse(readFileSync(p, 'utf8')); } catch { unreadable.push(p); continue; }
      const runId = Array.isArray(doc) ? null : doc?.runId;
      if (runId ? runId === run : named) files.push({ file: p, doc });
    }
  };
  walk(root);
  files.sort((a, b) => a.file.localeCompare(b.file));
  return { files, unreadable };
}

/** (ticket, caseId) → true (FAIL…) / false (any other verdict) / undefined (not in the ledger). */
export function ledgerVerdicts(ledger) {
  const byKey = new Map();
  const byCase = new Map();
  for (const t of list(ledger?.tickets)) for (const c of list(t?.cases)) {
    if (!c?.caseId) continue;
    const failing = /^FAIL/i.test(String(c.verdict || ''));
    byKey.set(`${t.id}\u0000${c.caseId}`, failing);
    byCase.set(c.caseId, byCase.has(c.caseId) && byCase.get(c.caseId) !== failing ? 'ambiguous' : failing);
  }
  return (ticket, caseId) => {
    const k = `${ticket}\u0000${caseId}`;
    if (byKey.has(k)) return byKey.get(k);
    const v = byCase.get(caseId);
    return typeof v === 'boolean' ? v : undefined;
  };
}

/** The tracker key: first KEY in ticketId (ALP-734-S734 → ALP-734), else the last one in the file name. */
export function ticketOf(doc, row, file, run) {
  const id = row?.ticketId ?? (Array.isArray(doc) ? null : doc?.ticketId);
  if (id) return (String(id).match(KEY) || [String(id)])[0];
  const stem = basename(file, '.json').replace(`_RESULT-${run}`, '').replace(/^-/, '');
  return (stem.match(KEY) || []).pop() || stem || '?';
}

/** Result files + optional ledger → case records with signals and a failing flag. */
export function casesFrom(files, run, verdictOf = null) {
  const cases = [];
  const source = { ledger: 0, matchesExpected: 0, unknown: 0 };
  for (const { file, doc } of files) {
    const rows = Array.isArray(doc) ? doc : list(doc?.results).length ? doc.results : list(doc?.cases);
    rows.forEach((row, i) => {
      const ticket = ticketOf(doc, row, file, run);
      const caseId = row?.caseId ?? row?.id ?? `#${i + 1}`;
      let failing = verdictOf ? verdictOf(ticket, caseId) : undefined;
      if (failing !== undefined) source.ledger++;
      else if (row?.matchesExpected === false || row?.matchesExpected === true) { failing = row.matchesExpected === false; source.matchesExpected++; }
      else { failing = null; source.unknown++; }
      cases.push({ ticket, caseId, failing, signals: signalsOf(row?.evidence), file });
    });
  }
  return { cases, source };
}

const USAGE = 'usage: node scripts/failure-cluster.mjs --project <slug> --run <runId> [--results <dir>] [--out <file>]';

export function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const m = argv[i].match(/^--(project|run|results|out)$/);
    if (!m) return { error: `unknown argument ${argv[i]}` };
    const v = argv[i + 1];
    if (!v || v.startsWith('--')) return { error: `--${m[1]} needs a value` };
    flags[m[1]] = v;
    i++;
  }
  if (!flags.project || !flags.run) return { error: 'both --project and --run are required' };
  if (!/^[\w.-]+$/.test(flags.project) || !/^[\w.-]+$/.test(flags.run)) return { error: '--project and --run take a plain name' };
  return { flags };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { flags, error } = parseArgs(process.argv.slice(2));
  if (error) { console.error(`[failure-cluster] ${error}\n${USAGE}`); process.exit(2); }
  const { project, run } = flags;
  const reports = join(HUB, 'projects', project, 'qa-reports');
  const root = flags.results ? resolve(flags.results) : reports;
  const rel = (p) => relative(process.cwd(), p) || '.';
  if (!existsSync(root)) { console.error(`[failure-cluster] ${rel(root)} does not exist: no result files for ${run}`); process.exit(1); }

  const { files, unreadable } = findResultFiles(root, run, { anyName: Boolean(flags.results) });
  for (const p of unreadable) console.error(`[failure-cluster] WARN unreadable JSON skipped: ${rel(p)}`);
  if (!files.length) {
    console.error(`[failure-cluster] no _RESULT files with runId ${run} under ${rel(root)}: nothing to cluster (not "no clusters")`);
    process.exit(1);
  }

  // The ledger normally sits in qa-reports; with --results, one next to the results wins.
  const ledgerPath = [flags.results && join(root, `_LEDGER-${run}.json`), join(reports, `_LEDGER-${run}.json`)].find((p) => p && existsSync(p)) || null;
  let verdictOf = null;
  if (ledgerPath) {
    try { verdictOf = ledgerVerdicts(JSON.parse(readFileSync(ledgerPath, 'utf8'))); }
    catch (e) { console.error(`[failure-cluster] WARN ledger unreadable, using matchesExpected: ${e.message}`); }
  }

  const { cases, source } = casesFrom(files, run, verdictOf);
  const clusters = clusterCases(cases);
  const base = baseFailRate(cases);
  const signals = { call: 0, page: 0, console: 0, pageerror: 0 };
  for (const c of cases) for (const k of new Set(c.signals.map((s) => s.kind))) signals[k]++;
  const labels = { shared: 0, background: 0, single: 0 };
  for (const c of clusters) labels[c.label]++;

  const out = resolve(flags.out || join(root, `_CLUSTERS-${run}.json`));
  if (PROTECTED.test(basename(out))) { console.error(`[failure-cluster] refusing to write ${basename(out)}: archives and ledgers are not outputs (R-15)`); process.exit(2); }
  const report = {
    schemaVersion: 1, project, runId: run, generatedAt: new Date().toISOString(),
    resultFiles: files.map((f) => relative(HUB, f.file)), ledger: ledgerPath && relative(HUB, ledgerPath),
    cases: cases.length, verdicts: source, baseFailRate: base, casesWithSignal: signals,
    normalisation: 'query dropped; numeric/UUID/hex/letter+digit path segments → :id; message: first line, <STR> <UUID> <TS> <ID> <NUM>',
    labels, clusters,
  };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(report, null, 2) + '\n');

  console.log(`[failure-cluster] ${project} ${run}: ${files.length} result files, ${cases.length} cases ` +
    `(verdicts: ledger ${source.ledger} · matchesExpected ${source.matchesExpected} · unknown ${source.unknown})`);
  console.log(`  cases with a signal: call ${signals.call} · page ${signals.page} · console ${signals.console} · pageerror ${signals.pageerror}`);
  console.log(`  clusters: ${clusters.length} (${labels.shared} shared · ${labels.background} background · ${labels.single} single)` +
    `; run fail rate ${base == null ? 'n/a (no verdicts)' : `${Math.round(base * 100)}%`}`);
  if (!cases.some((c) => c.signals.length)) console.log('  no error signal recorded in any case (failedCalls / chucker / httpStatus / consoleErrors / pageErrors)');
  const wide = clusters.filter((c) => c.tickets.length >= 2);
  if (!wide.length) console.log('  no cluster spans 2+ tickets');
  for (const c of wide.slice(0, 20)) {
    const t = c.tickets.length > 6 ? `${c.tickets.slice(0, 6).join(' ')} +${c.tickets.length - 6}` : c.tickets.join(' ');
    const pct = c.failRate == null ? '' : ` (${Math.round(c.failRate * 100)}%)`;
    const unk = c.unknown ? ` ${c.unknown} no verdict` : '';
    console.log(`  ${c.label.padEnd(10)} ${String(c.tickets.length).padStart(3)} tickets ${String(c.count).padStart(3)} cases ` +
      `${String(c.failing).padStart(3)} failing${pct}${unk}  ${c.signature.slice(0, 140)}  [${t}]  ${c.fingerprint}`);
  }
  if (wide.length > 20) console.log(`  … ${wide.length - 20} more spanning 2+ tickets in the file`);
  console.log(`  wrote ${rel(out)}`);
  process.exit(0);
}
