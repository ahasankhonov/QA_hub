#!/usr/bin/env node
// New-bug edition of scripts/jira-plan.mjs — turn the verifier's bug DRAFTS (defects observed
// outside a ticket's acceptance criteria) into the exact createJiraIssue calls, in the plan shape
// that scripts/qa-approve.mjs freezes and the write gate enforces (R-01).
//
// Deterministic: same drafts in, same calls out. Nothing here decides *whether* something is a
// bug — that is the verifier's job and is recorded in the drafts file with its evidence. This
// script only refuses drafts that cannot be posted as written:
//   · a body the Cloudflare WAF would 403 (same rules as comments);
//   · a body that leaks an internal QA artefact — a result file, a screenshot, a ledger (R-10);
//   · a draft marked duplicateOf an existing key — noted, never created;
//   · a surface that is not one of the project's own (R-13).
// The plan's runId is "<run>-NB" so its approval file never collides with the run's own plan.
//
//   node scripts/jira-newbugs-plan.mjs --drafts _NEW-BUGS-R1.json --out _JIRA-NEWBUGS-PLAN-R1.json [--only B-1,B-2]

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { args, fail, loadProfile } from '../lib/profile.mjs';
import { canonicalOp, describeOp, sha256, defaultMaxApplies } from '../lib/tracker-ops.mjs';
import { jiraConfig, createIssueOp, wafViolations, internalArtefactLeaks } from '../lib/jira-ops.mjs';

const { flags } = args();
if (!flags.drafts) fail('usage: jira-newbugs-plan.mjs --drafts <drafts.json> [--project <slug>] [--out <plan.json>] [--only B-1,B-2]', 2);

const draftsPath = resolve(flags.drafts);
const draftsRaw = readFileSync(draftsPath, 'utf8');
const drafts = JSON.parse(draftsRaw);
const slug = flags.project || drafts.project;
if (!slug) fail('[jira-newbugs-plan] no project: pass --project or put "project" in the drafts file');
const profile = loadProfile(slug);

let jira;
try {
  jira = jiraConfig(profile);
} catch (e) {
  fail(`[jira-newbugs-plan] ${slug} cannot be planned for Jira: ${e.message}`);
}
if (!jira.tools?.create) fail(`[jira-newbugs-plan] profile.jira.tools.create is missing — name the create-issue MCP tool in profiles/${slug}.json`);
if (!drafts.runId || !Array.isArray(drafts.drafts)) fail('[jira-newbugs-plan] drafts file needs { runId, drafts: [] }');

// Surfaces the project owns (host[:port]); anything else is not ours to file against (R-13).
const SURFACES = new Set(Object.entries(profile.surfaces || {}).filter(([k]) => k !== 'forbidden').map(([, v]) => v));
const ADMIN_SURFACE = profile.surfaces?.admin;
const LABEL = jira.newBugLabel || 'qa-found';
const PREFIX = jira.newBugTitlePrefix || `[Web] ${jira.projectKey}`;
// Per-platform title prefix + extra label (mobile plan: one BET bug per platform-scope, `[Mobile]`
// when the shared KMP code fails on both). A draft without `platform` keeps the single prefix.
const PREFIXES = jira.newBugTitlePrefixes || {};
const MOBILE_PLATFORMS = new Set(['android', 'ios', 'mobile']);
const MOBILE_SURFACES = new Set([profile.surfaces?.android, profile.surfaces?.ios].filter(Boolean));
// Severity → the project's P-level in the title and Jira's priority name. Low-Medium rounds DOWN:
// a filing QA is unsure about should not outrank one it is sure about. Low is P4 (since
// R-20261006-EXP; before that it was titled P3) — Jira has no level below Low, so P3 and P4 share it.
const SEVERITY = {
  High: { p: 'P1', priority: 'High' },
  Medium: { p: 'P2', priority: 'Medium' },
  'Low-Medium': { p: 'P3', priority: 'Low' },
  Low: { p: 'P4', priority: 'Low' },
};
// A draft may pin its P-level explicitly (`pLevel: "P1".."P4"`); it wins over the severity map.
const P_LEVEL = { P1: 'High', P2: 'Medium', P3: 'Low', P4: 'Low' };
const KEY_RE = new RegExp(`^${jira.projectKey}-\\d+$`);
const HEADINGS = ['## Takrorlash qadamlari', '## Kutilgan natija', '## Haqiqiy natija'];

let selected = drafts.drafts;
if (flags.only) {
  const sel = new Set(String(flags.only).split(',').map((s) => s.trim()));
  selected = selected.filter((d) => sel.has(d.draftId));
  if (selected.length !== sel.size) fail(`[jira-newbugs-plan] --only names a draft that is not in the file: ${[...sel].filter((id) => !selected.some((d) => d.draftId === id)).join(', ')}`);
}

const errors = [];
const notes = [];
const ops = [];
let n = 0;

for (const d of selected) {
  const where = `draft ${d.draftId || '(no id)'}`;
  if (!d.draftId) errors.push(`${where}: draftId is missing`);
  if (!KEY_RE.test(d.relatedTo || '')) errors.push(`${where}: relatedTo must be a ${jira.projectKey} key, got "${d.relatedTo}"`);
  if (typeof d.title !== 'string' || d.title.trim().length < 10) errors.push(`${where}: title is missing or too short`);
  if (typeof d.area !== 'string' || !d.area.trim()) errors.push(`${where}: area is missing (the title convention needs a screen/area segment)`);
  if (typeof d.descriptionMd !== 'string') errors.push(`${where}: descriptionMd is missing`);
  else for (const h of HEADINGS) if (!d.descriptionMd.includes(h)) errors.push(`${where}: body lacks the "${h}" section of the project's bug template`);
  if (!SURFACES.has(d.surface)) errors.push(`${where}: surface "${d.surface}" is not one of the project's surfaces (${[...SURFACES].join(', ')}) (R-13)`);
  if (d.platform != null) {
    if (!PREFIXES[d.platform]) errors.push(`${where}: platform "${d.platform}" has no title prefix in profile.jira.newBugTitlePrefixes (${Object.keys(PREFIXES).join('/') || 'none'})`);
    else if (MOBILE_PLATFORMS.has(d.platform) !== MOBILE_SURFACES.has(d.surface)) errors.push(`${where}: platform "${d.platform}" does not match surface "${d.surface}" (a mobile platform needs an app surface, web needs a web one)`);
  }
  if (!SEVERITY[d.severity]) errors.push(`${where}: severity "${d.severity}" is not one of ${Object.keys(SEVERITY).join('/')}`);
  if (d.pLevel != null && !P_LEVEL[d.pLevel]) errors.push(`${where}: pLevel "${d.pLevel}" is not one of ${Object.keys(P_LEVEL).join('/')}`);
  if (d.duplicateOf != null && !KEY_RE.test(d.duplicateOf)) errors.push(`${where}: duplicateOf must be a ${jira.projectKey} key or null`);
  for (const [field, text] of [['title', d.title], ['descriptionMd', d.descriptionMd]]) {
    const waf = wafViolations(text);
    if (waf.length) errors.push(`${where}: ${field} would be blocked by the Cloudflare WAF (${waf.join(', ')}) — rewrite as plain prose`);
    const leaks = internalArtefactLeaks(text);
    if (leaks.length) errors.push(`${where}: ${field} leaks an internal QA artefact (${leaks.join(', ')}) — dev-facing text must stand alone (R-10)`);
  }
  if (errors.length) continue;

  if (d.duplicateOf) {
    notes.push(`${d.draftId}: duplicate of ${d.duplicateOf} — not created (from ${d.relatedTo})`);
    continue;
  }

  const role = d.surface === ADMIN_SURFACE ? 'Admin' : 'Talaba';
  const text = d.title.replace(/^(Talaba|Admin)\s*:\s*/i, '').trim();
  const sev = d.pLevel != null ? { p: d.pLevel, priority: P_LEVEL[d.pLevel] } : SEVERITY[d.severity];
  const summary = `${(d.platform && PREFIXES[d.platform]) || PREFIX} – ${sev.p} – ${role} – ${d.area.trim()} – ${text}`;
  if (summary.length > 255) {
    errors.push(`${where}: composed summary is ${summary.length} chars, Jira allows 255`);
    continue;
  }
  const description = `${d.descriptionMd.trim()}\n\nManba: QA tekshiruvi, bog'liq chipta ${d.relatedTo}.`;
  const call = createIssueOp({ summary, description, priority: sev.priority, labels: [LABEL, ...(MOBILE_PLATFORMS.has(d.platform) && jira.mobileLabel ? [jira.mobileLabel] : [])] }, jira);
  const opId = `op-${String(++n).padStart(3, '0')}`;
  ops.push({
    opId,
    tool: call.tool,
    args: call.args,
    summary: describeOp(call.tool, call.args),
    maxApplies: defaultMaxApplies('new-bug'),
    kind: 'new-bug',
    ticket: d.draftId,
    relatedTo: d.relatedTo,
  });
}

if (errors.length) {
  console.error(`[jira-newbugs-plan] REFUSED — ${errors.length} problem(s):`);
  for (const e of errors) console.error('  · ' + e);
  process.exit(1);
}
if (!ops.length) fail('[jira-newbugs-plan] nothing to plan: every selected draft is a duplicate or the selection is empty');

const plan = {
  schemaVersion: 1,
  project: slug,
  runId: `${drafts.runId}-NB`,
  sourceRunId: drafts.runId,
  generatedAt: new Date().toISOString(),
  ledgerFile: basename(draftsPath),
  ledgerSha256: sha256(draftsRaw),
  build: drafts.build || null,
  ops: ops.map((o) => ({ ...o, hash: canonicalOp(o.tool, o.args).hash })),
  notes,
};

const out = flags.out ? resolve(flags.out) : resolve(dirname(draftsPath), `_JIRA-NEWBUGS-PLAN-${drafts.runId}.json`);
if (!existsSync(dirname(out))) mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(plan, null, 2) + '\n');
console.log(`[jira-newbugs-plan] ${ops.length} create op(s) from ${selected.length} draft(s) (${notes.length} duplicate(s) skipped) → ${out}`);
for (const o of plan.ops) console.log(`  ${o.opId} ${o.ticket} (${o.relatedTo}) ${o.summary}`);
for (const nline of notes) console.log(`  note: ${nline}`);
