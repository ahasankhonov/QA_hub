#!/usr/bin/env node
// R-09 + R-05 gate — a run-result is rejected if its evidence is untyped, if the host it actually
// hit disagrees with the surface the plan named, or if planned cases are simply missing.
//
// Testing the wrong surface was the single largest cause of false fails in the 2026-07-23 audit
// (~45 of ~84 FAIL verdicts flipped). It is not a judgement call — it is a string comparison
// nobody was making.
//
//   node scripts/run-result-validate.mjs --result _RESULT-R4-ALP-537.json [--plan _PLAN-ALP-537.json] [--build <id>]
//   node scripts/run-result-validate.mjs --dir projects/alpha/qa-reports --run R4 --build <id>

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { args, fail } from '../lib/profile.mjs';
import { createdProblems } from '../harness/lib/evidence.mjs';

const { flags } = args();
if (!flags.result && !flags.dir) {
  fail('usage: run-result-validate.mjs (--result <f.json> | --dir <dir> --run <runId>) [--plan <f.json>] [--build <id>]', 2);
}

const files = [];
if (flags.result) files.push(flags.result);
if (flags.dir) {
  const pat = flags.run ? new RegExp(`^_RESULT-${escapeRegExp(flags.run)}-.*\\.json$`) : /^_RESULT-.*\.json$/;
  for (const f of readdirSync(flags.dir)) if (pat.test(f)) files.push(join(flags.dir, f));
  if (files.length === 0)
    fail(`[run-result-validate] no _RESULT-*.json in ${flags.dir}${flags.run ? ` for run ${flags.run}` : ''} — R-08 says every phase writes its file as it goes`);
}

const host = (u) => {
  try {
    return new URL(u).host;
  } catch {
    return null;
  }
};
/** staging-dealer.alpha.example and https://staging-dealer.alpha.example/x are the same surface. */
const normSurface = (s) => String(s || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase();
function escapeRegExp(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// --- R-06: composite run ids vs the bare id a page exposes ------------------------------------
// A multi-surface run is keyed on "customer=index-A.js dealer=index-B.js admin=index-C.js" while a
// page can only show its own bundle ("index-A.js"). Byte-comparing the two rejected every real
// Alpha case; accept a per-case id that is one of the run's surface ids (or a sub-composite of them).
const buildParts = (id) => String(id || '').split(/\s+/).filter((p) => p.includes('=')).map((p) => p.slice(p.indexOf('=') + 1));
const buildMatches = (actual, expected) => {
  if (!actual || !expected || actual === expected) return true;
  const parts = buildParts(expected);
  if (!parts.length) return false;
  if (parts.includes(actual)) return true;
  const ap = buildParts(actual);
  return ap.length > 0 && ap.every((a) => parts.includes(a));
};

// --- R-12 size limits ---------------------------------------------------------------------
// A result file is a summary of what happened, not a copy of the wire. On 2026-08-17 an executor
// wrote a 2.74MB result — a 120-deal raw census inside one evidence field — and this validator
// passed it with "0 errors", because it checked structure and never looked at scale. Three
// executors that run reported clean validation on bloated files; the bloat was caught by eye.
// Cost is context × calls (R-12), so a megabyte written once is re-paid by the verifier, the
// synthesis pass and every agent that opens the file afterwards.
const WARN_BYTES = 128 * 1024;
const MAX_BYTES = 512 * 1024;
const MAX_FIELD_BYTES = 16 * 1024;

const fmt = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(2)}MB` : `${Math.round(n / 1024)}KB`);
const jsonSize = (v) => {
  try {
    return Buffer.byteLength(JSON.stringify(v) ?? '');
  } catch {
    return 0;
  }
};

// "The file is too big" is not actionable; "results[3].evidence.deals is 2.6MB" is. Descend while
// exactly one child exceeds the threshold, and report the deepest node that does — that is the
// container actually holding the dump, not the ancestors that merely contain it.
//
// Stopping when *several* children are guilty is the point: a 120-element census whose every entry
// is oversized is one mistake, not 120. Reporting each element buries the finding it should make
// obvious, which is the same failure — volume drowning signal — that this check exists to catch.
const oversizedFields = (node, path, skipped = 0) => {
  if (jsonSize(node) <= MAX_FIELD_BYTES) return null;
  const kids = node && typeof node === 'object' ? Object.entries(node) : [];
  const guilty = kids.filter(([, v]) => jsonSize(v) > MAX_FIELD_BYTES).sort((a, b) => jsonSize(b[1]) - jsonSize(a[1]));
  if (!guilty.length) return { path: path || '(whole file)', size: jsonSize(node), skipped };
  const [k, v] = guilty[0];
  const step = Array.isArray(node) ? `[${k}]` : path ? `.${k}` : k;
  return oversizedFields(v, `${path}${step}`, skipped + guilty.length - 1);
};

// --- R-14 failed backend calls (capture() → evidence.failedCalls, 2026-10-16) --------------------
// A status the case expects (a negative case asserting 422) is its oracle, not a problem: a call is
// "unexplained" only when its status appears in neither the result's nor the plan's expected text.
const planExpected = new Map();
if (flags.plan && existsSync(flags.plan)) {
  try {
    for (const s of JSON.parse(readFileSync(flags.plan, 'utf8')).steps || [])
      if (s && s.caseId) planExpected.set(s.caseId, typeof s.expected === 'string' ? s.expected : JSON.stringify(s.expected ?? ''));
  } catch { /* the coverage block below reports a bad plan */ }
}
const pathOf = (u) => { try { const x = new URL(u); return x.pathname; } catch { return String(u).slice(0, 80); } };
const oneLine = (t) => String(t || '').replace(/\s+/g, ' ').trim();

let errorCount = 0;
let caseCount = 0;

for (const file of files) {
  const raw = readFileSync(file, 'utf8');
  const r = JSON.parse(raw);
  const errors = [];
  const warnings = [];
  const tag = r.ticketId || file;

  const bytes = Buffer.byteLength(raw);
  if (bytes > MAX_BYTES)
    errors.push(
      `R-12: result file is ${fmt(bytes)}, over the ${fmt(MAX_BYTES)} ceiling. Evidence is the typed ` +
        `fields you needed, not the response that carried them — keep the count, the query and the ids that matter.`
    );
  else if (bytes > WARN_BYTES)
    warnings.push(`result file is ${fmt(bytes)} — a run's median is under 20KB; check for a raw body in an evidence field`);
  // A file whose bulk is spread evenly across its cases has no single offending field — the locator
  // just points back at the root, which the size line above already said. Only speak when there is
  // an actual culprit to name.
  const big = oversizedFields(r, '');
  if (big && big.path !== '(whole file)' && big.path !== 'results')
    warnings.push(
      `biggest single field is ${big.path} at ${fmt(big.size)}` +
        (big.skipped ? `, and ${big.skipped} other field(s) are also over ${fmt(MAX_FIELD_BYTES)}` : '') +
        ' — extract the typed fields and drop the raw payload'
    );

  if (!r.ticketId) errors.push('ticketId is required');
  if (!r.buildId) errors.push('R-06: buildId is required — which deploy produced this evidence');
  const expectBuild = flags.build || r.buildId;
  if (flags.build && r.buildId && !buildMatches(r.buildId, flags.build))
    errors.push(`R-06: result was taken on build ${r.buildId} but the run is on ${flags.build}`);

  const results = r.results || [];
  if (results.length === 0) errors.push('no cases recorded');

  // created[] — the register of test data the run made (RunResult.created(), 2026-10-16). Optional: a
  // result without it is checked exactly as before. scripts/residue.mjs folds it into _RESIDUE.md, so a
  // malformed entry would silently drop out of the residue list.
  if (r.created !== undefined) {
    if (!Array.isArray(r.created)) errors.push('created must be an array of { caseId, type, id, label, cleanup, at }');
    else r.created.forEach((e, i) => { for (const p of createdProblems(e)) errors.push(`created[${i}]: ${p}`); });
  }

  for (const c of results) {
    caseCount++;
    const at = (m) => `${c.caseId || '(no caseId)'}: ${m}`;
    if (!c.caseId) errors.push('a result has no caseId');
    if (!c.plannedSurface) errors.push(at('R-05: plannedSurface is required — sourced from the ticket/dev comment'));

    if (c.ranOk === false) {
      if (!c.skippedReason && !c.error) errors.push(at('a case that did not run must record skippedReason or error'));
      if (c.skippedReason === 'needs-manual') {
        const p = c.probe || {};
        for (const f of ['attempted', 'failureMode', 'missingCapability', 'evidence'])
          if (!p[f]) errors.push(at(`R-02: needs-manual requires probe.${f}`));
        if (!Array.isArray(c.manualRepro) || !c.manualRepro.length)
          errors.push(at('R-02: needs-manual requires manualRepro[] — numbered steps for a human'));
      }
      // failureClass is set by RunResult.case() when the script threw (harness/lib/evidence.mjs).
      // Only an assertion is evidence about the app; the rest are setup failures to rerun, not bugs.
      if (c.error && c.failureClass === 'guard_refused')
        warnings.push(at('R-13 guard refused a navigation — report the link as a finding (assert its href, do not click it)'));
      else if (c.error && c.failureClass && c.failureClass !== 'assertion_failure')
        warnings.push(at(`did not run (${c.failureClass}) — a harness/browser/network failure, not evidence of a bug: rerun before adjudicating`));
      continue;
    }

    const ev = c.evidence;
    if (!ev) {
      errors.push(at('R-09: no typed evidence. Prose is commentary; url/httpStatus/selector/observedText/buildId is evidence.'));
      continue;
    }
    if (!ev.url) errors.push(at('R-09: evidence.url is required'));
    if (ev.observedText == null && ev.httpStatus == null)
      errors.push(at('R-09: evidence needs observedText or httpStatus'));
    // 'network' alone is normal for a SPA with a websocket; a visible loader or a running animation is not.
    const stillLoading = (ev.pageReady?.pending || []).filter((p) => p !== 'network');
    if (stillLoading.length)
      warnings.push(at(`captured while the page was still loading (${stillLoading.join(', ')} after ${ev.pageReady.ms} ms) — a FAIL here is a timing suspect: re-capture before adjudicating`));
    if (!ev.buildId) warnings.push(at('evidence.buildId is null — the page exposed no bundle id; confirm the surface is the app'));
    else if (expectBuild && !buildMatches(ev.buildId, expectBuild))
      errors.push(at(`R-06: evidence was captured on build ${ev.buildId}, run build is ${expectBuild}`));

    // --- Q1: the mechanical surface check -------------------------------------------------
    // The URL is the record. A typed evidence.host is only used when there is no URL to read a host
    // from, and it may never contradict the URL — that is how a wrong-host run passes as planned.
    const planned = normSurface(c.plannedSurface);
    const urlHost = host(ev.url);
    if (urlHost && ev.host && urlHost.toLowerCase() !== String(ev.host).toLowerCase())
      errors.push(at(`R-05: evidence.host "${ev.host}" contradicts evidence.url (host ${urlHost}) — the URL is the record`));
    const actual = urlHost || (ev.host ? String(ev.host) : null);
    if (!actual && planned.includes('.'))
      warnings.push(at('R-05: evidence.url is not a URL and no evidence.host was captured — the surface cannot be checked mechanically'));
    if (planned && actual && actual.toLowerCase() !== planned) {
      errors.push(
        at(
          `R-05: plan says this case lives on "${planned}" but the evidence was taken on "${actual}". ` +
            `Either the plan's surface is wrong or the test drove the wrong host — do not adjudicate this case.`
        )
      );
    }
    if (typeof ev.observedText === 'string' && ev.observedText.startsWith('«selector did not resolve'))
      warnings.push(at(`selector "${ev.selector}" did not resolve — absence of an element is not evidence of absence of the feature`));
    if (typeof ev.matchCount === 'number' && ev.matchCount > 1)
      warnings.push(at(`selector "${ev.selector}" matched ${ev.matchCount} visible elements — observedText came from the first; confirm it is the right one (a duplicate chip, another listing) before adjudicating`));
    if (Array.isArray(ev.failedCalls) && ev.failedCalls.length) {
      const said = `${typeof c.expected === 'string' ? c.expected : JSON.stringify(c.expected ?? '')} ${planExpected.get(c.caseId) || ''}`;
      const unexplained = ev.failedCalls.filter((k) => k && !new RegExp(`\\b${Number(k.status)}\\b`).test(said));
      if (unexplained.length)
        warnings.push(at(`${unexplained.length} backend call(s) failed during this case (${unexplained.slice(0, 3).map((k) => `${k.method || '?'} ${pathOf(k.url)} → ${k.status}${k.message ? ` "${oneLine(k.message).slice(0, 80)}"` : ''}`).join('; ')}) — the screen may say it worked while the save did not; read them before adjudicating a PASS (R-14)`));
    }
  }

  // --- coverage: a planned case that silently vanished is the H-1 failure, one stage later ---
  if (flags.plan && existsSync(flags.plan)) {
    const plan = JSON.parse(readFileSync(flags.plan, 'utf8'));
    const planned = (plan.steps || []).map((s) => s.caseId);
    const ran = new Set(results.map((c) => c.caseId));
    const missing = planned.filter((id) => !ran.has(id));
    if (missing.length) errors.push(`planned cases with no result at all: ${missing.join(', ')}`);
    for (const s of plan.steps || []) {
      if (!s.surface) errors.push(`R-05: plan step ${s.caseId} has no surface — every step must name its host`);
    }
  }

  errorCount += errors.length;
  console.log(`${errors.length ? '✗' : '✓'} ${tag} — ${results.length} case(s)${errors.length ? `, ${errors.length} error(s)` : ''}`);
  for (const w of warnings) console.log(`    WARN ${w}`);
  for (const e of errors) console.log(`    ✗ ${e}`);
}

if (flags.dir && !flags.build) console.log('WARN no --build given — build ids are checked for self-consistency only, not against the run build (R-06)');
console.log(`\n${files.length} result file(s), ${caseCount} case(s), ${errorCount} error(s)`);
if (errorCount) {
  console.error('[run-result-validate] FAILED — these results must not be adjudicated as they stand.');
  process.exit(1);
}
