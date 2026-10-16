#!/usr/bin/env node
// Brain recall — puts the Obsidian brain (~/My Workflow) in front of the model when it is relevant.
//
// Why a script: until 2026-10-15 the brain reached a session only as a SessionStart preamble (vault
// path, last 5 log lines, the 3 newest failure titles). Page contents were read only if the model chose
// to run /brain-recall, the log tail was 98% "session ended" stubs (440 of 450 entries), and no QA agent
// read the brain at all. 37 recorded failures taught rules that the next run could not see. Recall is
// now done in code: cheap (one pass over ~120 small files, no model), deterministic, and testable.
//
//   node scripts/brain-recall.mjs --session-start                 SessionStart hook: preamble + active lessons
//   node scripts/brain-recall.mjs --hook-prompt                   UserPromptSubmit hook: hook JSON on stdin;
//                                                                 prints matching lessons, once per session
//   node scripts/brain-recall.mjs --query "<text>"                manual: what does the brain know about <text>
//   node scripts/brain-recall.mjs --project <slug> [--run <id>] [--out <file>]
//                                                                 QA-run dossier for the orchestrator to hand
//                                                                 to every agent (_BRAIN-RECALL-<run>.md)
//   node scripts/brain-recall.mjs --outcome <failure-slug> --helped|--missed|--wrong [--run <id>] [--note "…"]
//                                                                 record what a lesson did after it was injected
//   node scripts/brain-recall.mjs --trust [--json]                 per-lesson trust report (see "lesson trust")
//   node scripts/brain-recall.mjs --review [--json]                is the brain earning its context? (see
//                                                                 "scheduled review"); --review-done "<the QA lead's
//                                                                 words>" records his decision
//
// Lesson trust (2026-10-16, idea from vostride/agent-qa's memory curator, FSL-1.1): every time a failure's
// lessons are injected (a matched prompt or a QA dossier) one `injected` event is appended to the trust log;
// outcomes are appended by --outcome. Three outcomes, because they need different fixes:
//   helped  the lesson was applied and prevented the mistake                trust +0.02
//   wrong   following the lesson WAS the mistake / the lesson is stale      trust −0.05, flagged in recall
//   missed  injected, and the mistake happened anyway                       no trust change — the text is
//           right but text is not enough: needs a gate/script, not another bullet
// Trust starts at 0.5. The log is append-only JSONL: reports/_BRAIN-TRUST.jsonl for the real vault; when
// --vault/BRAIN_VAULT points elsewhere (selftests) it defaults to <state-dir>/_BRAIN-TRUST.jsonl instead.
// The vault itself stays read-only (the trust fields are not part of the vault contract).
//
// Options: --vault <dir> (default $BRAIN_VAULT or ~/My Workflow) · --state-dir <dir> (per-session dedupe,
// default <tmpdir>/brain-recall) · --json.
//
// Hook modes never fail a session: any error prints nothing and exits 0. Read-only on the vault.

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HUB = join(dirname(fileURLToPath(import.meta.url)), '..');

// ---------- args ----------
const argv = process.argv.slice(2);
const flags = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith('--')) continue;
  const next = argv[i + 1];
  if (next === undefined || next.startsWith('--')) flags[a.slice(2)] = true;
  else { flags[a.slice(2)] = next; i++; }
}
const HOOK_MODE = Boolean(flags['session-start'] || flags['hook-prompt']);
const VAULT = flags.vault || process.env.BRAIN_VAULT || join(homedir(), 'My Workflow');
const STATE_DIR = flags['state-dir'] || join(tmpdir(), 'brain-recall');
const DEFAULT_VAULT = !flags.vault && !process.env.BRAIN_VAULT;
const TRUST_LOG = flags['trust-log'] || process.env.BRAIN_TRUST_LOG
  || (DEFAULT_VAULT ? join(HUB, 'reports', '_BRAIN-TRUST.jsonl') : join(STATE_DIR, '_BRAIN-TRUST.jsonl'));

// ---------- limits (characters; ~4 chars per token) ----------
const PROMPT_CAP = 3200;        // per prompt injection
const SESSION_CAP = 6500;       // SessionStart preamble
const DOSSIER_CAP = 16000;      // project dossier
const LESSON_LINE = 260;        // one lesson bullet in compact views
const MIN_PROMPT = 12;          // "yes", "ok go" carry no topic

// ---------- vault parsing ----------
function parseList(v) {
  if (!v) return [];
  const s = v.trim();
  const inner = s.startsWith('[') ? s.replace(/^\[|\]$/g, '') : s;
  return inner.split(',').map((x) => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
}

function parsePage(path) {
  const text = readFileSync(path, 'utf8').replace(/\r/g, '');
  const fm = {};
  let body = text;
  if (text.startsWith('---\n')) {
    const end = text.indexOf('\n---', 4);
    if (end > 0) {
      const lines = text.slice(4, end).split('\n');
      let lastKey = null;
      for (const line of lines) {
        const m = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
        if (m) { fm[m[1]] = m[2]; lastKey = m[1]; continue; }
        const item = /^\s+-\s+(.*)$/.exec(line); // block-style YAML list
        if (item && lastKey) fm[lastKey] = (fm[lastKey] ? fm[lastKey] + ', ' : '') + item[1];
      }
      body = text.slice(end + 4).replace(/^[^\n]*\n/, '');
    }
  }
  const rel = relative(VAULT, path).split('\\').join('/');
  const folder = rel.split('/')[1] || '';
  return {
    path,
    rel,
    slug: basename(path, '.md'),
    folder,
    title: (fm.title || basename(path, '.md')).replace(/^["']|["']$/g, ''),
    type: fm.type || folder.replace(/s$/, ''),
    status: (fm.status || '').trim(),
    severity: (fm.severity || '').trim(),
    updated: (fm.updated || fm.created || '').trim(),
    keywords: parseList(fm.keywords),
    tags: parseList(fm.tags),
    aliases: parseList(fm.aliases),
    related: parseList(fm['related-pages']),
    body,
  };
}

function loadVault() {
  const wiki = join(VAULT, 'wiki');
  if (!existsSync(wiki)) return null;
  const pages = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (name.endsWith('.md') && name !== 'README.md') {
        try { pages.push(parsePage(p)); } catch { /* unreadable page: skip */ }
      }
    }
  };
  walk(wiki);
  return pages;
}

function sectionOf(body, heading) {
  const re = new RegExp(`^##\\s+${heading}\\s*$`, 'im');
  const m = re.exec(body);
  if (!m) return '';
  const rest = body.slice(m.index + m[0].length);
  const next = /^##\s+/m.exec(rest);
  return (next ? rest.slice(0, next.index) : rest).trim();
}

/** The rules a failure taught: the bullets of "What I learned" (falls back to its first paragraph). */
function lessons(page) {
  const sec = sectionOf(page.body, 'What I learned');
  if (!sec) return [];
  const bullets = [];
  for (const line of sec.split('\n')) {
    if (/^\s*[-*]\s+/.test(line)) bullets.push(line.replace(/^\s*[-*]\s+/, '').trim());
    else if (/^\s*\d+[.)]\s+/.test(line)) bullets.push(line.replace(/^\s*\d+[.)]\s+/, '').trim());
    else if (bullets.length && /^\s{2,}\S/.test(line)) bullets[bullets.length - 1] += ' ' + line.trim();
  }
  return bullets.length ? bullets : [sec.split('\n\n')[0].replace(/\s+/g, ' ')];
}

const clip = (s, n) => (s.length <= n ? s : s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…');

// ---------- lesson trust (append-only event log) ----------
const TRUST_START = 0.5;
const TRUST_DELTA = { helped: 0.02, wrong: -0.05, missed: 0 };

function logTrust(events) {
  if (!events.length) return;
  try {
    mkdirSync(dirname(TRUST_LOG), { recursive: true });
    appendFileSync(TRUST_LOG, events.map((e) => JSON.stringify({ at: new Date().toISOString(), ...e })).join('\n') + '\n');
  } catch { /* trust is advisory; never fail recall over it */ }
}

let trustCache = null;
function trustStats() {
  if (trustCache) return trustCache;
  const by = new Map();
  let lines = [];
  try { lines = readFileSync(TRUST_LOG, 'utf8').split('\n'); } catch { /* no log yet */ }
  for (const line of lines) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (!e?.page || !e.ev) continue;
    const st = by.get(e.page) || { injected: 0, helped: 0, missed: 0, wrong: 0, trust: TRUST_START, lastInjected: null };
    if (e.ev === 'injected') { st.injected++; st.lastInjected = e.at; }
    else if (e.ev in TRUST_DELTA) {
      st[e.ev]++;
      st.trust = Math.round(Math.min(1, Math.max(0, st.trust + TRUST_DELTA[e.ev])) * 1000) / 1000;
    }
    by.set(e.page, st);
  }
  return (trustCache = by);
}

/** " · trust 0.45 · injected 7× · missed 2×" — empty until the lesson has a history. */
function trustNote(page) {
  const st = trustStats().get(page.rel);
  if (!st) return '';
  const bits = [`trust ${st.trust.toFixed(2)}`, `injected ${st.injected}×`];
  if (st.helped) bits.push(`helped ${st.helped}×`);
  if (st.missed) bits.push(`missed ${st.missed}×`);
  if (st.wrong) bits.push(`wrong ${st.wrong}×`);
  return ` · ${bits.join(' · ')}`;
}

/** A warning line when the history says the lesson is stale or that text alone is not working. */
function trustWarning(page) {
  const st = trustStats().get(page.rel);
  if (!st) return null;
  if (st.trust < 0.4) return '  - ⚠ LOW TRUST — following this lesson has been the mistake before; verify it still holds before applying it';
  if (st.missed >= 2) return `  - ⚠ injected and still missed ${st.missed}× — apply it deliberately and name it in your results file`;
  return null;
}

// ---------- matching ----------
const STOP = new Set(`the a an and or of to in on for with by at from as is are was were be been being it its this that these those
not no but if then than so do does did done can could should would will just only also into over under about after before
when what which who whom how why where while all any each every some more most other such own same very too
my your our their his her you we they me us them i ok yes please now new use using used make made get got set run runs
qa hub agent agents ticket tickets test tests testing project projects file files page pages work working thing things
lets let need needs want wants like one two first last next before after again still same`.split(/\s+/));

const norm = (s) => ` ${String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
const words = (s) => norm(s).trim().split(' ').filter((w) => w.length >= 4 && !STOP.has(w));

/**
 * Score a page against normalised text. Keyword phrases are the author's own recall triggers, so they
 * weigh most: a multi-word phrase is near-certain intent, a single word less so. Title words and tags
 * corroborate. Recurring/open failures rank above resolved ones at equal evidence.
 */
function score(page, text) {
  let s = 0;
  const hits = [];
  for (const kw of page.keywords) {
    const k = norm(kw);
    if (k.trim().length < 3) continue;
    if (text.includes(k)) {
      const multi = k.trim().includes(' ');
      s += multi ? 3 : 2;
      hits.push(kw);
    }
  }
  for (const al of page.aliases) {
    const k = norm(al);
    if (k.trim().length >= 3 && text.includes(k)) { s += 3; hits.push(al); }
  }
  const tw = new Set(words(page.title));
  for (const w of tw) if (text.includes(` ${w} `)) { s += 1; hits.push(w); }
  for (const t of page.tags) {
    const k = norm(t);
    if (k.trim().length >= 4 && !STOP.has(k.trim()) && text.includes(k)) { s += 1; hits.push(`#${t}`); }
  }
  const rank = s * (page.status === 'recurring' ? 1.3 : page.status === 'open' ? 1.15 : 1);
  return { score: s, rank, hits: [...new Set(hits)] };
}

function match(pages, prompt) {
  const text = norm(prompt);
  const failures = [];
  const others = [];
  for (const p of pages) {
    const r = score(p, text);
    if (p.folder === 'failures') { if (r.score >= 3) failures.push({ p, ...r }); }
    else if (r.score >= 3) others.push({ p, ...r });
  }
  const byRank = (a, b) => b.rank - a.rank || (b.p.updated > a.p.updated ? 1 : -1);
  return { failures: failures.sort(byRank), others: others.sort(byRank) };
}

// ---------- session dedupe ----------
function seenFor(sessionId) {
  if (!sessionId) return { seen: new Set(), save: () => {} };
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    // prune state files older than 3 days, cheaply, ~1 in 20 calls
    if (Math.random() < 0.05) {
      const cutoff = Date.now() - 3 * 864e5;
      for (const f of readdirSync(STATE_DIR)) {
        const fp = join(STATE_DIR, f);
        try { if (statSync(fp).mtimeMs < cutoff) unlinkSync(fp); } catch { /* ignore */ }
      }
    }
  } catch { return { seen: new Set(), save: () => {} }; }
  const file = join(STATE_DIR, `${String(sessionId).replace(/[^\w-]/g, '')}.json`);
  let seen = new Set();
  try { seen = new Set(JSON.parse(readFileSync(file, 'utf8'))); } catch { /* first prompt */ }
  return { seen, save: () => { try { writeFileSync(file, JSON.stringify([...seen])); } catch { /* ignore */ } } };
}

// A user correction is the moment a failure is cheapest to record; nudge, never block.
const CORRECTION_RE = /^\s*(no[,.!\s]|nope\b|wrong\b|that'?s (not|wrong)|this is (not|wrong)|you (broke|missed|forgot|didn'?t)|why did you|why didn'?t you|stop\b|revert\b|undo\b|not what i)/i;

// ---------- renderers ----------
function renderFailure(m, bulletCap, maxBullets) {
  const p = m.p;
  const ls = lessons(p);
  const shown = ls.slice(0, maxBullets).map((l) => `  - ${clip(l, bulletCap)}`);
  if (ls.length > maxBullets) shown.push(`  - … ${ls.length - maxBullets} more in the page`);
  const warn = trustWarning(p);
  return [`- **${p.title}** _(${p.severity || '?'}, ${p.status || '?'}${trustNote(p)})_ → \`${p.rel}\``, ...(warn ? [warn] : []), ...shown].join('\n');
}

function capJoin(parts, cap) {
  const out = [];
  let n = 0;
  for (const part of parts) {
    if (n + part.length > cap) { out.push('- … more matches cut for length; run `node scripts/brain-recall.mjs --query "<topic>"`'); break; }
    out.push(part);
    n += part.length + 1;
  }
  return out.join('\n');
}

function hookPrompt(pages) {
  let input = {};
  try { input = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { /* no stdin */ }
  const prompt = String(input.prompt || flags.prompt || '');
  const out = [];
  if (CORRECTION_RE.test(prompt)) {
    let nudge = '**Brain:** this reads like a correction. Once it is resolved, record it with `/brain-fail` (mark an existing matching failure `recurring` instead of duplicating it).';
    const earlier = [...seenFor(input.session_id).seen].filter((rel) => rel.startsWith('wiki/failures/'));
    if (earlier.length)
      nudge += ` Lessons injected earlier this session: ${earlier.map((r) => `\`${basename(r, '.md')}\``).join(', ')} — if one of them should have prevented this, \`node scripts/brain-recall.mjs --outcome <slug> --missed\`; if following one caused it, \`--wrong\`.`;
    out.push(nudge);
  }
  if (prompt.trim().length >= MIN_PROMPT && !prompt.trim().startsWith('/')) {
    const { failures, others } = match(pages, prompt);
    const state = seenFor(input.session_id);
    const fresh = failures.filter((m) => !state.seen.has(m.p.rel)).slice(0, 3);
    const freshPages = others.filter((m) => !state.seen.has(m.p.rel)).slice(0, 3);
    if (fresh.length || freshPages.length) {
      const parts = ['## Brain recall — lessons from past failures that match this request', ''];
      for (const m of fresh) parts.push(renderFailure(m, LESSON_LINE, 4));
      if (freshPages.length) {
        parts.push('', '_Related brain pages (read if relevant):_');
        for (const m of freshPages) parts.push(`- ${m.p.title} → \`${m.p.rel}\``);
      }
      parts.push('', 'Apply these before acting; if a lesson contradicts the plan, change the plan.');
      out.push(capJoin(parts, PROMPT_CAP));
      for (const m of [...fresh, ...freshPages]) state.seen.add(m.p.rel);
      state.save();
      logTrust(fresh.map((m) => ({ ev: 'injected', page: m.p.rel, via: 'prompt', session: input.session_id || null })));
    }
  }
  if (out.length) process.stdout.write(out.join('\n\n') + '\n');
}

function sessionStart(pages) {
  try { readFileSync(0, 'utf8'); } catch { /* drain hook stdin */ }
  const L = [];
  L.push('# Obsidian Brain — auto-loaded', '');
  L.push(...reviewBanner(pages));
  L.push(`Vault: \`${VAULT}\` (contract: \`${join(VAULT, 'CLAUDE.md')}\`)`, '');
  L.push('**Auto-recall is ON.** Every prompt is matched against failure keywords and page titles; matching lessons arrive as "Brain recall" context. QA runs get a project dossier (`node scripts/brain-recall.mjs --project <slug> --run <id> --out …`). Manual: `node scripts/brain-recall.mjs --query "<topic>"`.', '');

  const logPath = join(VAULT, 'log.md');
  if (existsSync(logPath)) {
    const entries = readFileSync(logPath, 'utf8').replace(/\r/g, '').split('\n')
      .filter((l) => /^## \[/.test(l) && !/\| session ended/.test(l));
    if (entries.length) {
      L.push('**Recent activity** (last 5; session-end stubs hidden):', '');
      for (const e of entries.slice(-5)) L.push(`- ${e.replace(/^## /, '')}`);
      L.push('');
    }
  }

  const byFolder = {};
  for (const p of pages) byFolder[p.folder] = (byFolder[p.folder] || 0) + 1;
  const stubs = pages.filter((p) => p.status === 'stub').length;
  L.push(`**Vault:** ${pages.length} pages (${Object.entries(byFolder).sort().map(([k, v]) => `${v} ${k}`).join(' · ')}) · ${stubs} stubs`, '');

  const active = pages.filter((p) => p.folder === 'failures' && (p.status === 'recurring' || p.status === 'open'))
    .sort((a, b) => (a.status === b.status ? (b.updated > a.updated ? 1 : -1) : a.status === 'recurring' ? -1 : 1));
  if (active.length) {
    L.push(`**Active failures — rules they taught (${active.filter((p) => p.status === 'recurring').length} recurring, ${active.filter((p) => p.status === 'open').length} open):**`, '');
    for (const p of active) L.push(renderFailure({ p }, 200, 2));
    L.push('');
  }
  const projects = pages.filter((p) => p.folder === 'projects' && !p.rel.split('/')[2]?.includes('/'));
  if (projects.length) L.push(`**Projects in the brain:** ${projects.map((p) => p.slug).join(', ')} (\`wiki/projects/\`)`, '');

  L.push('**Ops:** `/brain-recall` · `/brain-query` · `/brain-fail` · `/brain-file` · `/brain-status` · `/brain-lint`. Invoke the `obsidian-brain` skill before writing; re-read the vault `CLAUDE.md` on every write; never touch `~/My World`. **Record a failure the moment a user correction, revert or second attempt happens.**');
  let text = L.join('\n');
  if (text.length > SESSION_CAP) text = text.slice(0, SESSION_CAP) + '\n… (cut for length)';
  process.stdout.write(text + '\n');
}

function projectAliases(slug, pages) {
  const al = new Set([slug.toLowerCase()]);
  for (const p of pages) {
    if (p.folder !== 'projects') continue;
    if (p.slug === slug || p.slug.startsWith(`${slug}-`) || p.aliases.map((a) => a.toLowerCase()).includes(slug)) {
      al.add(p.slug.toLowerCase());
      for (const a of p.aliases) al.add(a.toLowerCase());
    }
  }
  try {
    const prof = JSON.parse(readFileSync(join(HUB, 'profiles', `${slug}.json`), 'utf8'));
    const head = String(prof.name || '').split(/\s+[—(/-]\s*|\s*\(/)[0].trim().toLowerCase();
    if (head.length >= 3) al.add(head);
  } catch { /* no profile: slug + vault aliases only */ }
  return [...al].filter((a) => a.length >= 3);
}

function projectDossier(pages) {
  const slug = String(flags.project);
  const aliases = projectAliases(slug, pages);
  const hasAlias = (s) => { const t = norm(s); return aliases.some((a) => t.includes(norm(a))); };
  const mentions = (p) => {
    const meta = [p.slug, p.title, ...p.keywords, ...p.tags, ...p.aliases, ...p.related].join(' ');
    if (hasAlias(meta)) return 3;
    const body = norm(p.body);
    return aliases.reduce((n, a) => n + (body.split(norm(a)).length - 1), 0) >= 2 ? 1 : 0;
  };
  const scored = pages.map((p) => ({ p, w: mentions(p) })).filter((x) => x.w > 0);
  const failures = scored.filter((x) => x.p.folder === 'failures')
    .sort((a, b) => {
      const st = (x) => (x.p.status === 'recurring' ? 2 : x.p.status === 'open' ? 1 : 0);
      return st(b) - st(a) || b.w - a.w || (b.p.updated > a.p.updated ? 1 : -1);
    });
  // Hub-wide failures (tagged qa-hub, not project-specific) apply to every run.
  const hubWide = pages.filter((p) => p.folder === 'failures' && (p.status === 'recurring' || p.status === 'open')
    && p.tags.includes('qa-hub') && !failures.some((f) => f.p === p));
  const projPage = pages.find((p) => p.folder === 'projects' && aliases.includes(p.slug.toLowerCase()));
  const others = scored.filter((x) => x.p.folder !== 'failures' && x.p !== projPage).sort((a, b) => b.w - a.w).slice(0, 15);

  const L = [`# Brain recall — ${slug}${flags.run ? ` · ${flags.run}` : ''}`, ''];
  L.push(`Generated by \`scripts/brain-recall.mjs --project ${slug}\` from \`${VAULT}\` (aliases: ${aliases.join(', ')}). Read this before planning, executing or adjudicating. Each lesson came from a real mistake on this hub; if a step you are about to take contradicts one, change the step and say so in your results file.`, '');
  if (projPage) {
    const status = sectionOf(projPage.body, 'Status');
    L.push(`## Project page: ${projPage.title} → \`${projPage.rel}\``, '');
    if (status) L.push(clip(status, 1800), '');
  }
  if (failures.length) {
    L.push(`## Failures on this project (${failures.length})`, '');
    for (const f of failures) {
      L.push(`### ${f.p.title} _(${f.p.severity || '?'}, ${f.p.status || '?'}${trustNote(f.p)})_ → \`${f.p.rel}\``);
      const warn = trustWarning(f.p);
      if (warn) L.push(warn.trim());
      for (const l of lessons(f.p)) L.push(`- ${l}`);
      L.push('');
    }
  }
  if (hubWide.length) {
    L.push(`## Hub-wide active failures (apply to every run)`, '');
    for (const p of hubWide) L.push(renderFailure({ p }, 400, 6));
    L.push('');
  }
  if (others.length) {
    L.push('## Other brain pages that mention this project', '');
    for (const o of others) L.push(`- ${o.p.title} (${o.p.folder}) → \`${o.p.rel}\``);
    L.push('');
  }
  L.push('## Lesson outcomes', '', `When a lesson above changed what you did, or one should have and did not, list it under \`Brain outcomes\` in your hand-back as \`<failure-slug>: helped | missed | wrong — one line why\`. The main thread records each with \`node scripts/brain-recall.mjs --outcome <slug> --<outcome> --run ${flags.run || '<run>'}\`.`, '');
  let text = L.join('\n');
  if (text.length > DOSSIER_CAP) text = text.slice(0, DOSSIER_CAP) + '\n\n… (cut for length — open the linked pages)';
  logTrust([...failures.map((f) => f.p), ...hubWide].map((p) => ({ ev: 'injected', page: p.rel, via: 'dossier', project: slug, run: flags.run || null })));
  if (flags.out) {
    mkdirSync(dirname(flags.out), { recursive: true });
    writeFileSync(flags.out, text + '\n');
    process.stdout.write(`brain-recall: wrote ${flags.out} (${failures.length} project failures, ${hubWide.length} hub-wide, ${others.length} pages, ${text.length} chars)\n`);
  } else process.stdout.write(text + '\n');
}

function query(pages) {
  const { failures, others } = match(pages, String(flags.query));
  if (flags.json) {
    process.stdout.write(JSON.stringify({
      failures: failures.map((m) => ({ rel: m.p.rel, title: m.p.title, status: m.p.status, score: m.score, hits: m.hits })),
      pages: others.map((m) => ({ rel: m.p.rel, title: m.p.title, score: m.score, hits: m.hits })),
    }, null, 2) + '\n');
    return;
  }
  if (!failures.length && !others.length) { process.stdout.write('brain-recall: no matching failures or pages\n'); return; }
  const parts = [];
  for (const m of failures.slice(0, 6)) parts.push(renderFailure(m, 400, 8) + `\n  _matched: ${m.hits.join(', ')}_`);
  if (others.length) parts.push('', '_Pages:_', ...others.slice(0, 10).map((m) => `- ${m.p.title} → \`${m.p.rel}\` _(matched: ${m.hits.join(', ')})_`));
  process.stdout.write(parts.join('\n') + '\n');
}

function outcome(pages) {
  const kind = ['helped', 'missed', 'wrong'].filter((k) => flags[k]);
  if (kind.length !== 1) { process.stderr.write('brain-recall: --outcome needs exactly one of --helped | --missed | --wrong\n'); process.exit(2); }
  const want = String(flags.outcome).replace(/\.md$/, '');
  const page = pages.find((p) => p.folder === 'failures' && (p.slug === want || p.rel === `${want}.md` || p.rel === want));
  if (!page) { process.stderr.write(`brain-recall: no failure page "${want}" in ${VAULT}/wiki/failures\n`); process.exit(1); }
  logTrust([{ ev: kind[0], page: page.rel, run: flags.run || null, note: typeof flags.note === 'string' ? flags.note : null }]);
  trustCache = null;
  process.stdout.write(`brain-recall: ${kind[0]} → ${page.rel}${trustNote(page)}\n`);
}

function trustReport(pages) {
  const stats = trustStats();
  const rows = pages.filter((p) => p.folder === 'failures' && p.status !== 'archived').map((p) => {
    const st = stats.get(p.rel) || { injected: 0, helped: 0, missed: 0, wrong: 0, trust: TRUST_START, lastInjected: null };
    let action = '';
    if (st.trust < 0.4 || st.wrong >= 2) action = 'STALE? reread + rewrite or resolve the lesson';
    else if (st.missed >= 2) action = 'TEXT NOT ENOUGH: build a gate/script for it';
    else if (!st.injected && (p.status === 'open' || p.status === 'recurring')) action = 'NEVER RECALLED: keywords miss real prompts';
    return { rel: p.rel, status: p.status, ...st, action };
  });
  if (flags.json) { process.stdout.write(JSON.stringify({ log: TRUST_LOG, rows }, null, 2) + '\n'); return; }
  const w = (x, n) => String(x).padEnd(n);
  const out = [`lesson trust — ${TRUST_LOG}`, `${w('FAILURE', 58)}${w('STATUS', 10)}${w('TRUST', 7)}${w('INJ', 5)}${w('HELP', 5)}${w('MISS', 5)}${w('WRONG', 6)}ACTION`];
  for (const r of rows.sort((a, b) => (b.action ? 1 : 0) - (a.action ? 1 : 0) || a.trust - b.trust || b.injected - a.injected))
    out.push(`${w(clip(basename(r.rel, '.md'), 56), 58)}${w(r.status || '?', 10)}${w(r.trust.toFixed(2), 7)}${w(r.injected, 5)}${w(r.helped, 5)}${w(r.missed, 5)}${w(r.wrong, 6)}${r.action}`);
  process.stdout.write(out.join('\n') + '\n');
}

// ---------- scheduled review (2026-10-16) ----------
// the QA lead, 2026-10-16: "set up the 30 Oct check". Lessons had been injected 66 times and no outcome was ever
// recorded, so nobody could say whether the brain prevents mistakes or only costs context. The date, the
// rule and the QA lead's eventual decision live in reports/_BRAIN-REVIEW.json. --session-start counts down to it and
// turns into a DUE banner on the day, until --review-done records his answer. The script reports and
// recommends; it never switches recall off by itself.
const REVIEW_FILE = flags['review-file']
  || (DEFAULT_VAULT ? join(HUB, 'reports', '_BRAIN-REVIEW.json') : join(STATE_DIR, '_BRAIN-REVIEW.json'));
const PROJECTS_DIR = flags['projects-dir'] || join(HUB, 'projects');
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const today = () => (isDate(flags.today) ? flags.today : new Date().toLocaleDateString('en-CA'));
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

function readReview() {
  const cfg = JSON.parse(readFileSync(REVIEW_FILE, 'utf8'));
  if (!isDate(cfg.due) || !isDate(cfg.windowStart)) throw new Error(`${REVIEW_FILE}: "due" and "windowStart" must be YYYY-MM-DD`);
  return cfg;
}

function reviewData(pages, cfg) {
  const from = cfg.windowStart;
  const ev = { injected: 0, prompt: 0, dossier: 0, helped: [], missed: [], wrong: [] };
  let lines = [];
  try { lines = readFileSync(TRUST_LOG, 'utf8').split('\n'); } catch { /* no log yet */ }
  for (const line of lines) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (!e?.ev || String(e.at || '').slice(0, 10) < from) continue;
    if (e.ev === 'injected') {
      ev.injected++;
      if (e.via === 'prompt') ev.prompt++;
      else if (e.via === 'dossier') ev.dossier++;
    } else if (e.ev in TRUST_DELTA) ev[e.ev].push(`${basename(String(e.page || '?'), '.md')}${e.run ? ` (${e.run})` : ''}`);
  }
  // per-run lessons files: every agent of the run reads one, so their size is the brain's per-run cost
  const dossiers = [];
  try {
    for (const proj of readdirSync(PROJECTS_DIR)) {
      const dir = join(PROJECTS_DIR, proj, 'qa-reports');
      if (!existsSync(dir)) continue;
      for (const name of readdirSync(dir)) {
        if (!/^_BRAIN-RECALL-.+\.md$/.test(name)) continue;
        const st = statSync(join(dir, name));
        if (st.mtime.toLocaleDateString('en-CA') >= from) dossiers.push({ project: proj, name, chars: st.size });
      }
    }
  } catch { /* no projects dir: report zero */ }
  const log = { real: 0, stubs: 0 };
  try {
    for (const l of readFileSync(join(VAULT, 'log.md'), 'utf8').split('\n')) {
      const m = /^## \[(\d{4}-\d{2}-\d{2})\]/.exec(l);
      if (!m || m[1] < from) continue;
      if (/\| session ended/.test(l)) log.stubs++; else log.real++;
    }
  } catch { /* no log */ }
  const recurred = pages.filter((p) => p.folder === 'failures' && p.status === 'recurring' && p.updated >= from)
    .map((p) => `${p.slug} (${p.updated})`);
  const outcomes = ev.helped.length + ev.missed.length + ev.wrong.length;
  let verdict, why;
  if (ev.helped.length) { verdict = 'KEEP'; why = `${ev.helped.length} outcome(s) marked helped`; }
  else if (outcomes) { verdict = 'CUT-PROMPT'; why = `${outcomes} outcome(s) recorded, none marked helped`; }
  else { verdict = 'NO-OUTCOMES'; why = 'no outcome was ever recorded, so nothing shows a lesson helped. Under the rule that is the CUT-PROMPT branch, but it is missing data, not proof of no help'; }
  return { due: cfg.due, windowStart: from, today: today(), daysLeft: daysBetween(today(), cfg.due), decided: cfg.decided || null,
    setBy: cfg.setBy || null, rule: cfg.rule || null, ev, outcomes, dossiers, log, recurred, verdict, why };
}

/** One countdown line before the due date, a DUE banner from it on, nothing once the QA lead has decided. */
function reviewBanner(pages) {
  try {
    const cfg = readReview();
    if (cfg.decided) return [];
    const r = reviewData(pages, cfg);
    if (r.daysLeft > 0) {
      return [`**Brain review on ${r.due}** (${r.daysLeft} day${r.daysLeft === 1 ? '' : 's'} left): ${r.ev.injected} lessons injected and ${r.outcomes} outcomes recorded since ${r.windowStart}. Record outcomes from QA hand-backs with \`--outcome\`, or the review has nothing to judge.`, ''];
    }
    return [`**⏰ Brain review DUE (${r.due}).** Run \`node scripts/brain-recall.mjs --review\`, give the QA lead the report and the branch its rule points to, then record his answer with \`--review-done "<his words>"\`. Nothing changes until he decides.`, ''];
  } catch { return []; } // no review scheduled, or an unreadable file: --review says which
}

function review(pages) {
  let cfg;
  try { cfg = readReview(); } catch (e) {
    process.stderr.write(`brain-recall: no readable review at ${REVIEW_FILE} (${e.code === 'ENOENT' ? 'no review scheduled' : e.message})\n`);
    process.exit(1);
  }
  const r = reviewData(pages, cfg);
  if (flags.json) { process.stdout.write(JSON.stringify({ file: REVIEW_FILE, ...r }, null, 2) + '\n'); return; }
  const avg = r.dossiers.length ? Math.round(r.dossiers.reduce((s, d) => s + d.chars, 0) / r.dossiers.length) : 0;
  const status = r.decided ? `decided ${r.decided.at}: "${r.decided.decision}"`
    : r.daysLeft > 0 ? `preview: ${r.daysLeft} day(s) to go` : 'DUE';
  const out = [
    `Brain review, due ${r.due}${r.setBy ? ` (set by ${r.setBy})` : ''}`,
    `Status: ${status}`,
    `Window: ${r.windowStart} → ${r.today}`,
    `Lessons injected: ${r.ev.injected} (per prompt ${r.ev.prompt}, per-run file ${r.ev.dossier})`,
    `Outcomes recorded: helped ${r.ev.helped.length}, missed ${r.ev.missed.length}, wrong ${r.ev.wrong.length}`,
    ...['helped', 'missed', 'wrong'].filter((k) => r.ev[k].length).map((k) => `  ${k}: ${r.ev[k].join(', ')}`),
    `Per-run lessons files: ${r.dossiers.length}${r.dossiers.length ? ` (average ${avg} chars ≈ ${Math.round(avg / 4)} tokens, read by every agent in the run)` : ''}`,
    `Vault log: ${r.log.real} real entries, ${r.log.stubs} session-end stubs`,
    `Recurred while recall was live: ${r.recurred.length ? r.recurred.join(', ') : 'none'}`,
    `Verdict: ${r.verdict}: ${r.why}`,
  ];
  if (r.rule) out.push(`Rule: ${r.rule}`);
  if (!r.decided) out.push(`Next: give the QA lead this report; record his decision with --review-done "<his words>". Nothing changes until then.`);
  process.stdout.write(out.join('\n') + '\n');
}

function reviewDone() {
  const words = typeof flags['review-done'] === 'string' ? flags['review-done'].trim() : '';
  if (words.length < 3) { process.stderr.write('brain-recall: --review-done needs the QA lead\'s decision in his own words\n'); process.exit(2); }
  let cfg;
  try { cfg = readReview(); } catch (e) { process.stderr.write(`brain-recall: no readable review at ${REVIEW_FILE} (${e.message})\n`); process.exit(1); }
  if (cfg.decided) {
    process.stderr.write(`brain-recall: already decided ${cfg.decided.at}: "${cfg.decided.decision}". To schedule another review, edit "due" and clear "decided" in ${REVIEW_FILE}\n`);
    process.exit(1);
  }
  cfg.decided = { at: today(), decision: words };
  writeFileSync(REVIEW_FILE, JSON.stringify(cfg, null, 2) + '\n');
  process.stdout.write(`brain-recall: review decided ${cfg.decided.at}: "${words}"\n`);
}

// ---------- main ----------
try {
  const pages = loadVault();
  if (!pages) {
    if (!HOOK_MODE) { process.stderr.write(`brain-recall: no vault at ${VAULT}\n`); process.exit(1); }
    process.exit(0);
  }
  if (flags['session-start']) sessionStart(pages);
  else if (flags['hook-prompt']) hookPrompt(pages);
  else if (flags.project) projectDossier(pages);
  else if (flags.query) query(pages);
  else if (flags.outcome) outcome(pages);
  else if (flags.trust) trustReport(pages);
  else if (flags['review-done']) reviewDone();
  else if (flags.review) review(pages);
  else { process.stderr.write('usage: brain-recall.mjs --session-start | --hook-prompt | --query "<text>" | --project <slug> [--run <id>] [--out <file>] | --outcome <slug> --helped|--missed|--wrong | --trust | --review [--json] | --review-done "<words>"\n'); process.exit(2); }
} catch (e) {
  if (!HOOK_MODE) { process.stderr.write(`brain-recall: ${e.message}\n`); process.exit(1); }
  process.exit(0);
}
