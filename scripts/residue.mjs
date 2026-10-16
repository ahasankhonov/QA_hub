#!/usr/bin/env node
// Residue — what test data has QA left on the system under test? Read-only unless --write.
//
//   node scripts/residue.mjs --project <slug> [--write] [--root <hubDir>]
//
// Reads every projects/<slug>/qa-reports/**/_RESULT-*.json (subfolders too) and folds the `created[]`
// registers that RunResult.created() writes (harness/lib/evidence.mjs): one entry per type+id, the
// latest recorded state wins, so a later run's 'deleted' closes an earlier run's 'left'. Open = the
// latest state is 'left' or 'needs-admin'. Prints the open items as a compact table.
//
// --write regenerates projects/<slug>/qa-reports/_RESIDUE.md and _RESIDUE.json WHOLE. They are
// generated files, not archives (R-15 does not apply): never hand-edit them, rerun this instead.
// --root points at another hub tree (the selftest uses a temp one); default is this hub.
//
// Why: the executor was told "restore any test data you changed; prefix created data [QA]", and
// nothing recorded what was created or whether it was cleaned up. Residue lived only in _HISTORY.md
// prose, so "what did QA leave on staging?" had no answer short of reading the archive. Only data
// registered with rec.created() since 2026-10-16 is here; older residue is still prose in _HISTORY.md.
// Idea from petrkindlmann/qa-skills (second read, 2026-10-16).
//
// Order: each state is placed at the time it was recorded (entry updatedAt, else at), falling back to
// the result file's executedAt / startedAt / finishedAt for a hand-written entry with no time. Ties
// keep result-file order (by run time, then path). A malformed entry is skipped and counted here;
// run-result-validate is the gate that rejects it.
//
// Exit: 0 = report printed (open items are a finding, not an error); 2 = usage error or unknown project.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createdProblems } from '../harness/lib/evidence.mjs';

const HUB = join(dirname(fileURLToPath(import.meta.url)), '..');
const OPEN = new Set(['left', 'needs-admin']);
const SLUG = /^[a-z0-9][a-z0-9_-]*$/i;
const CUTOFF = '2026-10-16';
const time = (s) => { const t = Date.parse(s || ''); return Number.isNaN(t) ? 0 : t; };
const day = (s) => String(s || '').slice(0, 10) || '?';

/** Every _RESULT-*.json under dir, any depth, sorted by path. */
export function findResults(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name));
      else if (/^_RESULT-.*\.json$/.test(e.name)) out.push(join(d, e.name));
    }
  };
  walk(dir);
  return out.sort();
}

/** One result file → the fold's input row, or null when it is unreadable / not a result object. */
export function resultRow(path, text, root = HUB) {
  let j;
  try { j = JSON.parse(text); } catch { return null; }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
  return {
    file: relative(root, path),
    runId: j.runId ?? null,
    ticketId: j.ticketId ?? null,
    runAt: j.executedAt || j.startedAt || j.finishedAt || null,
    created: j.created,
  };
}

/**
 * Pure fold: rows [{ file, runId, ticketId, runAt, created }] → { items, open, closed, skipped }.
 * One item per type+id; the latest recorded state wins. `first` is where it was created, `last` the
 * state that won, `history` every state in order.
 */
export function foldCreated(rows) {
  const ordered = rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => time(a.r.runAt) - time(b.r.runAt) || String(a.r.file).localeCompare(String(b.r.file)) || a.i - b.i)
    .map((x) => x.r);
  const events = [];
  const skipped = [];
  for (const r of ordered) {
    if (r.created === undefined) continue;
    if (!Array.isArray(r.created)) { skipped.push({ file: r.file, index: null, problems: ['created is not an array'] }); continue; }
    r.created.forEach((e, index) => {
      const problems = createdProblems(e);
      if (problems.length) return skipped.push({ file: r.file, index, problems });
      events.push({ e, r, when: e.updatedAt || e.at || r.runAt || null });
    });
  }
  // Array.prototype.sort is stable, so equal times keep the run order established above.
  events.sort((a, b) => time(a.when) - time(b.when));
  const byKey = new Map();
  for (const { e, r, when } of events) {
    const key = `${e.type}\u0000${String(e.id)}`;
    const prev = byKey.get(key);
    const step = { runId: r.runId, ticketId: r.ticketId, caseId: e.caseId, cleanup: e.cleanup, at: when, file: r.file };
    byKey.set(key, {
      type: e.type,
      id: String(e.id),
      label: e.label ?? prev?.label ?? null,
      cleanup: e.cleanup,
      open: OPEN.has(e.cleanup),
      surface: e.surface || prev?.surface || null,
      first: prev?.first || { runId: r.runId, ticketId: r.ticketId, caseId: e.caseId, at: e.at || when },
      last: step,
      history: [...(prev?.history || []), { runId: r.runId, ticketId: r.ticketId, cleanup: e.cleanup, at: when }],
    });
  }
  const items = [...byKey.values()];
  return { items, open: items.filter((i) => i.open), closed: items.filter((i) => !i.open), skipped };
}

/** The report the CLI prints and --write saves as _RESIDUE.json. */
export function residueReport({ slug, root = HUB }) {
  const dir = join(root, 'projects', slug, 'qa-reports');
  const files = findResults(dir);
  const rows = [];
  let unreadable = 0;
  for (const f of files) {
    const row = resultRow(f, readFileSync(f, 'utf8'), root);
    if (row) rows.push(row); else unreadable++;
  }
  const { items, open, closed, skipped } = foldCreated(rows);
  return {
    schemaVersion: 1,
    generatedBy: 'scripts/residue.mjs',
    project: slug,
    generatedAt: new Date().toISOString(),
    scanned: files.length,
    unreadable,
    withRegister: rows.filter((r) => r.created !== undefined).length,
    counts: { items: items.length, open: open.length, left: open.filter((i) => i.cleanup === 'left').length, needsAdmin: open.filter((i) => i.cleanup === 'needs-admin').length, closed: closed.length },
    open,
    closed,
    skipped,
  };
}

const runRef = (s) => [s.runId, s.ticketId, s.caseId].filter(Boolean).join(' · ');
const clip = (t, n) => { const s = String(t ?? ''); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };

export function formatTable(rep) {
  const head = `[residue] ${rep.project} · ${rep.scanned} result file(s) scanned`;
  const lines = [];
  if (!rep.counts.items) {
    const why = rep.withRegister ? `${rep.withRegister} result(s) carry a created[] register, none with a valid entry` : 'no result carries a created[] register yet';
    lines.push(`${head} — no registered test data (${why}; residue from before ${CUTOFF} lives only in _HISTORY.md)`);
  } else {
    const c = rep.counts;
    lines.push(`${head} · ${c.items} registered item(s): ${c.open} open (${c.left} left, ${c.needsAdmin} needs-admin), ${c.closed} deleted`);
    if (rep.open.length) {
      const rows = rep.open.map((i) => [i.cleanup, i.type, clip(i.id, 28), clip(i.label || '', 40), `${runRef(i.last)} · ${day(i.last.at)}`, i.surface || '']);
      const w = rows[0].map((_, k) => Math.max(...rows.map((r) => r[k].length)));
      for (const r of rows) lines.push(`  ${r.map((x, k) => (k === r.length - 1 ? x : x.padEnd(w[k]))).join('  ')}`.trimEnd());
    }
  }
  if (rep.unreadable) lines.push(`  WARN ${rep.unreadable} result file(s) are not JSON objects — not scanned`);
  for (const s of rep.skipped) lines.push(`  WARN ${s.file}${s.index != null ? ` created[${s.index}]` : ''}: ${s.problems.join('; ')} — skipped (run-result-validate rejects it)`);
  return lines.join('\n');
}

const cell = (t) => String(t ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();

export function formatMarkdown(rep) {
  const c = rep.counts;
  const md = [
    `> **Generated by \`scripts/residue.mjs\` — do not hand-edit.** Regenerate with \`node scripts/residue.mjs --project ${rep.project} --write\`. Residue from before ${CUTOFF} is not registered here; it lives only in \`_HISTORY.md\` prose.`,
    '',
    `# QA test-data residue — ${rep.project}`,
    '',
    `Generated ${rep.generatedAt} from ${rep.scanned} result file(s), ${rep.withRegister} with a \`created[]\` register.`,
    '',
  ];
  if (!c.items) {
    md.push('No registered test data.', '');
  } else {
    md.push(`**${c.open} open** (${c.left} left, ${c.needsAdmin} needs-admin) · ${c.closed} deleted · ${c.items} registered in all.`, '');
    md.push('## Open — still on the system under test', '');
    if (!rep.open.length) md.push('None.', '');
    else {
      md.push('| Cleanup | Type | Id | Label | Created (run · ticket · case) | Last state (run · ticket · case) | Surface |', '|---|---|---|---|---|---|---|');
      for (const i of rep.open)
        md.push(`| ${cell(i.cleanup)} | ${cell(i.type)} | \`${cell(i.id)}\` | ${cell(i.label)} | ${cell(`${runRef(i.first)} · ${day(i.first.at)}`)} | ${cell(`${runRef(i.last)} · ${day(i.last.at)}`)} | ${cell(i.surface)} |`);
      md.push('');
    }
    md.push('## Closed — deleted', '');
    if (!rep.closed.length) md.push('None.', '');
    else {
      md.push('| Type | Id | Label | Created (run · ticket) | Deleted (run · ticket) |', '|---|---|---|---|---|');
      for (const i of rep.closed)
        md.push(`| ${cell(i.type)} | \`${cell(i.id)}\` | ${cell(i.label)} | ${cell(`${[i.first.runId, i.first.ticketId].filter(Boolean).join(' · ')} · ${day(i.first.at)}`)} | ${cell(`${[i.last.runId, i.last.ticketId].filter(Boolean).join(' · ')} · ${day(i.last.at)}`)} |`);
      md.push('');
    }
  }
  if (rep.skipped.length) {
    md.push('## Skipped — malformed register entries', '');
    for (const s of rep.skipped) md.push(`- \`${s.file}\`${s.index != null ? ` created[${s.index}]` : ''}: ${s.problems.join('; ')}`);
    md.push('');
  }
  return md.join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { args } = await import('../lib/profile.mjs');
  const { flags } = args();
  if (typeof flags.project !== 'string' || !SLUG.test(flags.project) || flags.root === true) {
    console.error('usage: residue.mjs --project <slug> [--write] [--root <hubDir>]');
    process.exit(2);
  }
  const root = typeof flags.root === 'string' ? flags.root : HUB;
  const dir = join(root, 'projects', flags.project, 'qa-reports');
  if (!existsSync(dir)) {
    console.error(`[residue] unknown project "${flags.project}": no ${relative(process.cwd(), dir) || dir}`);
    process.exit(2);
  }
  const rep = residueReport({ slug: flags.project, root });
  console.log(formatTable(rep));
  if (flags.write) {
    writeFileSync(join(dir, '_RESIDUE.json'), JSON.stringify(rep, null, 2) + '\n');
    writeFileSync(join(dir, '_RESIDUE.md'), formatMarkdown(rep));
    console.log(`[residue] wrote ${relative(root, join(dir, '_RESIDUE.md'))} + _RESIDUE.json (generated — do not hand-edit)`);
  }
  process.exit(0);
}
