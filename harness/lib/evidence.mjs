// R-09 / H-2 — typed evidence, emitted by the harness rather than typed out by the model.
//
// The verifier opens an image only when a case fails. That means a false FAIL is catchable by
// evidence and a false PASS structurally is not: a passing case is judged purely on a sentence the
// executor wrote. Typing the evidence — url, httpStatus, selector, observedText, buildId, captured
// from the live page — is what makes a pass auditable at all.
//
// Usage inside a per-ticket script:
//   const rec = new RunResult({ ticketId: 'ALP-537', project: 'alpha', runId: 'R4', buildId });
//   const page = await attachRecorder(await ctx.newPage());
//   await rec.case('AC-1', { surface: 'staging-dealer.alpha.example', expected: '…' },
//                  () => capture(page, { selector: '[data-task-title]' }));
//   rec.created('AC-1', { type: 'listing', id: listing.id, label: '[QA] AC-1 listing', cleanup: 'left' });
//   rec.write();
//
// capture() also records `failedCalls`: the 4xx/5xx API calls since the previous capture, with the start
// of each response body. Take one assertion capture per case so that list belongs to that case.

import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { waitForPageReady, pageOutline, visibleMatches } from './page.mjs';

/**
 * Attach recorders for the signals a verdict may rest on. Idempotent per page.
 * @returns the same page, with `page.__qa` populated.
 */
export function attachRecorder(page) {
  if (page.__qa) return page;
  const state = {
    consoleErrors: [],
    pageErrors: [],
    network: [],
    lastDocumentStatus: null,
    lastDocumentUrl: null,
    seq: 0, // response counter: capture() reports only the calls made since the previous capture
    lastCaptureSeq: 0,
    pendingBodies: new Set(),
  };
  page.__qa = state;

  page.on('console', (m) => {
    if (m.type() === 'error') state.consoleErrors.push(m.text().slice(0, 500));
  });
  page.on('pageerror', (e) => state.pageErrors.push(String(e.message).slice(0, 500)));
  page.on('response', (res) => {
    const req = res.request();
    const type = req.resourceType();
    if (type === 'document') {
      state.lastDocumentStatus = res.status();
      state.lastDocumentUrl = res.url();
    }
    // Keep API traffic — it is usually the real proof, and it is ~5 tokens where a screenshot is ~1600.
    if (type === 'xhr' || type === 'fetch' || type === 'document') {
      const rec = { method: req.method(), url: res.url(), status: res.status(), type, seq: ++state.seq };
      state.network.push(rec);
      if (state.network.length > 400) state.network.shift();
      // R-14 (2026-10-05, R17-E5): the brief wants the response MESSAGE for failing calls, not just the
      // status. Attach a short body snippet to 4xx/5xx xhr/fetch records (best-effort, never throws).
      if (rec.status >= 400 && type !== 'document') {
        const p = res.text().then((t) => { rec.message = String(t || '').slice(0, 300); }).catch(() => {})
          .finally(() => state.pendingBodies.delete(p));
        state.pendingBodies.add(p);
      }
    }
  });
  return page;
}

// Third-party beacons fail all the time and say nothing about the app under test.
const TELEMETRY = /google-analytics|googletagmanager|doubleclick|sentry|segment\.(io|com)|hotjar|mixpanel|amplitude|intercom|clarity\.ms|facebook|datadoghq|posthog|fullstory|newrelic|nr-data/i;

/**
 * The backend calls that failed (4xx/5xx xhr/fetch) since the previous capture, 5xx first, at most 5,
 * each with the start of its response body. A screen can say "Saved" while the PUT behind it returned
 * 500; without this the verifier only sees the screen. (Idea from LambdaTest/agent-skills, MIT: their
 * DevTools network checkpoint records failed requests with the response message; R-14.)
 */
export async function failedCallsSince(st) {
  if (!st || !Array.isArray(st.network)) return [];
  if (st.pendingBodies?.size)
    await Promise.race([Promise.allSettled([...st.pendingBodies]), new Promise((r) => setTimeout(r, 1500))]);
  const since = st.lastCaptureSeq || 0;
  const calls = st.network
    .filter((n) => (n.seq || 0) > since && n.type !== 'document' && n.status >= 400 && !TELEMETRY.test(safeHost(n.url) || ''))
    .sort((a, b) => (b.status >= 500) - (a.status >= 500))
    .slice(0, 5)
    .map((n) => ({ method: n.method, url: String(n.url).slice(0, 200), status: n.status, ...(n.message ? { message: n.message } : {}) }));
  st.lastCaptureSeq = st.seq || 0;
  return calls;
}

/** Read the deployed bundle id out of the live page — R-06, recorded per case, not per run. */
export async function readBuildId(page, pattern = /assets\/(index-[A-Za-z0-9_-]+\.js)/) {
  try {
    const srcs = await page.evaluate(() => Array.from(document.scripts).map((s) => s.src || ''));
    for (const s of srcs) {
      const m = pattern.exec(s);
      if (m) return m[1];
    }
  } catch { /* page may be closed or cross-origin */ }
  return null;
}

/**
 * Capture one typed evidence record from the live page.
 *   ready:   true | {timeout} — waitForPageReady() first and record what never cleared (evidence.pageReady).
 *            Use it on every assertion capture: a FAIL taken under a spinner is a timing suspect.
 *   outline: true — record a compact visible-text outline (evidence.outline, ≤3000 chars). Recorded
 *            automatically when `selector` does not resolve, so the verifier sees what WAS on screen.
 * @param {import('playwright').Page} page
 * @param {{selector?:string, screenshot?:string, apiUrlIncludes?:string, fullPage?:boolean,
 *          ready?:boolean|{timeout?:number}, outline?:boolean}} opts
 */
export async function capture(page, opts = {}) {
  const st = page.__qa || { consoleErrors: [], pageErrors: [], network: [] };
  const pageReady = opts.ready ? await waitForPageReady(page, typeof opts.ready === 'object' ? opts.ready : {}) : null;
  const url = page.url();

  let observedText = null;
  let selector = opts.selector || null;
  let selectorMissed = false;
  let matchCount = null;
  if (selector) {
    try {
      const loc = page.locator(selector).first();
      observedText = (await loc.innerText({ timeout: 5000 })).trim().slice(0, 2000);
      // More than one visible match = the text above came from whichever was first (a hidden duplicate
      // chip, a second listing). Recorded so run-result-validate can say so (qa-skills selector-drift).
      matchCount = await visibleMatches(page, selector);
    } catch (e) {
      observedText = `«selector did not resolve: ${String(e.message).split('\n')[0]}»`;
      selectorMissed = true;
    }
  } else {
    try {
      observedText = (await page.locator('body').innerText({ timeout: 5000 })).replace(/\n{2,}/g, '\n').trim().slice(0, 2000);
      selector = 'body';
    } catch { /* leave null */ }
  }

  // The API call that actually backs the assertion, when the caller names it.
  let apiCall = null;
  if (opts.apiUrlIncludes) {
    const hits = st.network.filter((n) => n.url.includes(opts.apiUrlIncludes));
    apiCall = hits[hits.length - 1] || null;
  }

  const failedCalls = await failedCallsSince(page.__qa);

  let screenshot = null;
  if (opts.screenshot) {
    mkdirSync(dirname(opts.screenshot), { recursive: true });
    // Viewport by default: full-page web captures come out 4000px+ tall and rarely add proof.
    await page.screenshot({ path: opts.screenshot, fullPage: !!opts.fullPage, timeout: 30000 }).catch(() => {});
    screenshot = opts.screenshot;
  }

  return {
    url,
    host: safeHost(url),
    httpStatus: apiCall ? apiCall.status : st.lastDocumentStatus,
    statusSource: apiCall ? `api ${apiCall.method} ${apiCall.url}` : 'document',
    selector,
    ...(matchCount != null ? { matchCount } : {}),
    observedText,
    buildId: await readBuildId(page),
    screenshot,
    ...(pageReady ? { pageReady } : {}),
    ...(opts.outline || selectorMissed ? { outline: await pageOutline(page) } : {}),
    ...(failedCalls.length ? { failedCalls } : {}),
    consoleErrors: st.consoleErrors.slice(-10),
    pageErrors: st.pageErrors.slice(-10),
    capturedAt: new Date().toISOString(),
  };
}

/** Typed evidence for a raw HTTP assertion (no browser). */
export async function captureFetch(url, init = {}, opts = {}) {
  const res = await fetch(url, init);
  const text = await res.text();
  return {
    url,
    host: safeHost(url),
    httpStatus: res.status,
    statusSource: `fetch ${init.method || 'GET'}`,
    selector: opts.jsonPath || null,
    observedText: text.slice(0, 2000),
    buildId: opts.buildId || null,
    screenshot: null,
    consoleErrors: [],
    pageErrors: [],
    capturedAt: new Date().toISOString(),
  };
}

/**
 * Why a case's script threw, as one word the verifier can route on. Only `assertion_failure` can be
 * evidence of an app bug; every other class means the harness, the browser or the network failed and
 * the case is rerun before anyone adjudicates it. (Taxonomy from vostride/agent-qa's result-triage
 * skill, adapted: guard_refused is our R-13 tripwire, harness_bug is our own script throwing.)
 */
export function classifyFailure(message) {
  const m = String(message || '');
  if (/R-13 BLOCKED|assertStaging|assertSurface|is PRODUCTION|not a known staging surface/i.test(m)) return 'guard_refused';
  if (/\bexpect\(|toHave[A-Z]\w*|toBe[A-Z]?\w*\(|AssertionError|assert(ion)? failed/i.test(m)) return 'assertion_failure';
  if (/Target (page, context or browser )?(has been )?closed|browser has (been )?(closed|disconnected)|Browser closed|Session closed|Execution context was destroyed|frame was detached/i.test(m)) return 'browser_disconnect';
  if (/waiting for (locator|selector|getBy)|strict mode violation|resolved to 0 elements|element is not (attached|visible|enabled)|No node found|unable to find element/i.test(m)) return 'element_not_found';
  if (/Timeout \d+ ?ms exceeded|timed out|ETIMEDOUT/i.test(m)) return 'timeout';
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|EHOSTUNREACH|net::ERR_|socket hang up|fetch failed|device (offline|not found)|no devices|adb: |emulator|status code 5\d\d/i.test(m)) return 'infrastructure';
  if (/\b(TypeError|ReferenceError|SyntaxError|RangeError)\b|is not a function|Cannot read propert/i.test(m)) return 'harness_bug';
  return 'unknown_failure';
}

function safeHost(u) {
  try {
    return new URL(u).host;
  } catch {
    return null;
  }
}

// --- test data a run created (rec.created, 2026-10-16) ------------------------------------------
// "Restore any test data you changed; prefix created data [QA]" was prose only: nothing recorded what
// a run created or whether it was removed, so "what did QA leave on staging?" had no answer outside
// _HISTORY.md prose. Idea from petrkindlmann/qa-skills (second read). scripts/residue.mjs folds these
// registers across runs; run-result-validate rejects a malformed entry. One definition, three users.
export const CREATED_CLEANUP = ['deleted', 'left', 'needs-admin'];

/** Problems with one `created[]` entry, as strings. Empty = well-formed. */
export function createdProblems(e) {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return ['entry is not an object'];
  const p = [];
  const blank = (v) => v == null || String(v).trim() === '';
  if (blank(e.caseId)) p.push('caseId is required');
  if (blank(e.type)) p.push('type is required (listing, offer, account, upload, …)');
  if (blank(e.id)) p.push('id is required — the id the system under test gave it, so it can be found again');
  if (!CREATED_CLEANUP.includes(e.cleanup))
    p.push(`cleanup ${JSON.stringify(e.cleanup ?? null)} is not one of ${CREATED_CLEANUP.join(' | ')}`);
  return p;
}

/**
 * The run-result file for one ticket. R-08: it is written as cases complete, not at the end —
 * two parts of the 2026-08-12 run were cancelled mid-flight and lost everything because they
 * batched their write-up.
 */
export class RunResult {
  // resume:true — R-08/R-14 fix (2026-09-29, Beta Android run R-20260929-AND). Every batch in
  // this run drives web steps and app steps for the SAME case into ONE result file (parity
  // comparison needs both phases side by side), but the two phases run in separate process
  // invocations (web phase must fully log out before the app phase logs in — one refresh token per
  // user). Without resume, the second phase's `new RunResult` would blow away the first phase's
  // write-through file. With resume:true, if outPath already exists on disk, its prior `results` and
  // original `startedAt` are loaded and the new phase's case() calls are appended to it.
  //
  // overwrite (2026-10-16, after the Gamma run-id env-default incident): a script rerun with no
  // QA_RUN wrote _RESULT-undefined-… or clobbered the previous run's file. Now a missing runId/ticketId
  // throws, and an existing file is refused unless resume:true, overwrite:true or QA_OVERWRITE_RESULT=1.
  constructor({ ticketId, project, runId, buildId, outPath, reportsDir, resume, overwrite }) {
    const unset = (v) => v == null || v === '' || v === 'undefined' || v === 'null';
    if (unset(runId) || unset(ticketId))
      throw new Error(`RunResult: runId and ticketId are required (got runId=${runId}, ticketId=${ticketId}) — export QA_RUN in the same shell command; never default to an earlier run`);
    this.outPath =
      outPath || join(reportsDir || process.cwd(), `_RESULT-${runId}-${ticketId}.json`);
    if (!resume && !overwrite && process.env.QA_OVERWRITE_RESULT !== '1' && existsSync(this.outPath))
      throw new Error(`RunResult: ${this.outPath} already exists — pass resume:true to append to it, or set QA_OVERWRITE_RESULT=1 if this really is a rerun of this run's own script`);
    let prior = null;
    if (resume && existsSync(this.outPath)) {
      try {
        prior = JSON.parse(readFileSync(this.outPath, 'utf8'));
      } catch { /* corrupt or partial — start fresh below */ }
    }
    this.data = prior || {
      schemaVersion: 1,
      ticketId,
      project,
      runId,
      buildId,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      results: [],
    };
    // Keep the file's buildId current even on resume (app phase build id differs from web's).
    if (prior && buildId) this.data.buildId = buildId;
  }

  /**
   * Run one case and record it. `surface` is mandatory (R-05) — the host the plan says this case
   * belongs on. The recorded evidence host is compared against it by run-result-validate.
   */
  async case(caseId, { surface, expected, notes }, fn) {
    if (!surface) throw new Error(`case ${caseId}: surface is required (R-05) — name the host this case belongs on`);
    const started = new Date().toISOString();
    let evidence = null;
    let ranOk = true;
    let error = null;
    try {
      evidence = await fn();
    } catch (e) {
      ranOk = false;
      error = String(e && e.message).slice(0, 800);
    }
    this.data.results.push({
      caseId,
      plannedSurface: surface,
      expected: expected ?? null,
      actual: notes ?? null,
      ranOk,
      error,
      ...(ranOk ? {} : { failureClass: classifyFailure(error) }),
      evidence,
      startedAt: started,
      finishedAt: new Date().toISOString(),
    });
    this.write(); // write-through, R-08
    return evidence;
  }

  /**
   * R-14 (2026-09-30, R12 cluster C) — a case the BRIEF explicitly took out of the run envelope
   * (not a missing capability — e.g. "bulk 50-photo upload: awaiting prod-reflection decision on
   * shared S3 bucket writes"). This is deliberately NOT skippedReason:'needs-manual' — that value
   * triggers run-result-validate's R-02 probe-field requirement (attempted/failureMode/
   * missingCapability/evidence), which doesn't fit a scope decision the executor was told to make
   * (there is nothing to "probe": the step was never attempted by instruction, not by failure).
   * Any other skippedReason string only needs to be present (see run-result-validate.mjs line
   * ~137) so this records cleanly as a distinct, greppable reason. Used by ALP-552 (552-1/2/3/4/6)
   * and ALP-608 (case 5).
   */
  held(caseId, { surface, expected, reason }) {
    this.data.results.push({
      caseId,
      plannedSurface: surface,
      expected: expected ?? null,
      ranOk: false,
      skippedReason: reason || 'held: awaiting prod-reflection decision',
      evidence: null,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    });
    this.write();
  }

  /** R-02 — a deferral is only valid with a probe that was actually attempted and failed. */
  probe(caseId, { surface, attempted, failureMode, missingCapability, evidence, manualRepro }) {
    this.data.results.push({
      caseId,
      plannedSurface: surface,
      ranOk: false,
      skippedReason: 'needs-manual',
      probe: { attempted, failureMode, missingCapability, evidence, at: new Date().toISOString() },
      manualRepro: manualRepro || [],
    });
    this.write();
  }

  /**
   * Register test data a case created on the system under test — a listing, an offer, an account, an
   * upload — and what became of it. cleanup: 'deleted' (removed) | 'left' (must stay; the label says
   * why) | 'needs-admin' (only an admin can remove it). Written through at once, like case(): a run
   * cancelled between create and teardown still says what it left behind.
   *
   * The same type+id again updates that entry instead of adding one: register 'left' right after the
   * create, then 'deleted' once teardown removed it. May be called before the case is recorded (setup
   * runs first); `surface` defaults to that case's plannedSurface when the case already exists.
   * scripts/residue.mjs folds these across runs into _RESIDUE.md.
   */
  created(caseId, { type, id, label, cleanup, surface } = {}) {
    const problems = createdProblems({ caseId, type, id, cleanup });
    if (problems.length) throw new Error(`created ${caseId || '(no caseId)'}: ${problems.join('; ')}`);
    const key = String(id);
    const host = surface || (this.data.results || []).filter((c) => c.caseId === caseId).pop()?.plannedSurface || null;
    if (!Array.isArray(this.data.created)) this.data.created = [];
    const list = this.data.created;
    const now = new Date().toISOString();
    let entry = list.find((e) => e.type === type && String(e.id) === key);
    if (entry) {
      entry.cleanup = cleanup;
      if (label != null) entry.label = label;
      if (host && !entry.surface) entry.surface = host;
      entry.updatedAt = now;
    } else {
      entry = { caseId, type, id: key, label: label ?? null, cleanup, ...(host ? { surface: host } : {}), at: now };
      list.push(entry);
    }
    this.write(); // write-through, R-08
    return { ...entry };
  }

  write() {
    this.data.finishedAt = new Date().toISOString();
    mkdirSync(dirname(this.outPath), { recursive: true });
    writeFileSync(this.outPath, JSON.stringify(this.data, null, 2) + '\n');
    return this.outPath;
  }
}
