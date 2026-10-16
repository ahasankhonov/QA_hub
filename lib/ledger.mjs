// The verdict ledger — R-11. JSON is the record; _SUMMARY.md, the counts and the .docx are
// generated from it. Nothing downstream re-classifies or re-counts.
//
// This validator is the enforcement point for R-02 (probe required), R-04 (routing + PARTIAL
// sub-reason), R-05 (surface + build), R-09 (typed evidence) and R-10 (self-contained comments).

import { readFileSync } from 'node:fs';
import { route, stateFor, bucketOf, VERDICTS, PARTIAL_REASONS } from './routing.mjs';

export const CASE_VERDICTS = ['PASS', 'FAIL', 'NEEDS_MANUAL', 'NOT_TESTED'];

/**
 * Category names that are NOT reasons. R-02: a deferral must name the specific missing capability,
 * proved by a probe that actually failed. "payment" and "email" are additionally false today —
 * both are covered (PAYGW UAT cards; the Gmail connector).
 */
const BANNED_CAPABILITY_REASONS = [
  /^payments?$/i,
  /^emails?$/i,
  /^inbox$/i,
  /^missing inbox$/i,
  /^no inbox$/i,
  /^real[- ]device$/i,
  /^physical device$/i,
  /^manual$/i,
  /^needs? manual$/i,
  /^not testable$/i,
  /^untestable$/i,
  /^sensors?$/i,
  /^oauth$/i,
  /^captcha$/i,
  /^credentials?$/i,
  /^creds$/i,
];

/** R-10: dev-facing prose must not leak internal QA artefacts. */
const INTERNAL_ARTEFACT_PATTERNS = [
  /\.docx\b/i,
  /\.png\b/i,
  /\.jpe?g\b/i,
  /_LEDGER\b/i,
  /_SUMMARY\b/i,
  /_RUN-/i,
  /_INTAKE-/i,
  /_NEEDS-MANUAL/i,
  /_PARTS-PLAN/i,
  /_attachments\b/i,
  /qa-reports\//i,
  /_RESULT-/i,
  /_BUILD-/i,
  /_LINEAR-PLAN/i,
  /_JIRA-PLAN/i,
  /\.qa-approvals/i,
  /\/Users\/\S*qa-hub/i,
  /\bP\d+[A-Z]?\b(?=\s*(run|part|batch))/i,
];

export function loadLedger(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * @param {object} ledger
 * @param {{profile?:object, currentBuildId?:string|null, strict?:boolean}} opts
 * @returns {{errors:string[], warnings:string[], counts:object}}
 */
export function validateLedger(ledger, opts = {}) {
  const errors = [];
  const warnings = [];
  const E = (m) => errors.push(m);
  const W = (m) => warnings.push(m);

  const stateMap = opts.profile?.linear?.stateMap || {};
  // R-04: a profile without its board's own state names silently inherits DEFAULT_STATE_MAP (Alpha's
  // names). Counting is still possible; planning tracker writes is not (linear-plan refuses).
  if (opts.profile && !opts.profile.linear?.stateMap && opts.profile.linear?.noTracker !== true)
    W("profile has no linear.stateMap — proposedState falls back to DEFAULT_STATE_MAP (another project's state names); tracker writes are refused until the profile carries the board's own names (R-04)");
  const mention = opts.profile?.linear?.commentMentionSuffix || null;
  const currentBuildId = opts.currentBuildId ?? ledger?.build?.buildId ?? null;

  for (const f of ['schemaVersion', 'runId', 'project', 'generatedAt']) {
    if (!ledger?.[f]) E(`ledger.${f} is required`);
  }
  if (!ledger?.build?.buildId) E('ledger.build.buildId is required (R-06) — capture it with scripts/build-id.mjs');
  if (!Array.isArray(ledger?.tickets)) {
    E('ledger.tickets must be an array');
    return { errors, warnings, counts: {} };
  }
  if (ledger.tickets.length === 0) E('ledger.tickets is empty — an empty run must not read as a clean run (R-07)');

  const seen = new Set();
  for (const t of ledger.tickets) {
    const at = (m) => `[${t.id || '(no id)'}] ${m}`;

    if (!t.id) E('a ticket has no id');
    else if (seen.has(t.id)) E(at('duplicate ticket entry — each ticket appears exactly once (R-11)'));
    else seen.add(t.id);

    if (!VERDICTS.includes(t.verdict)) {
      E(at(`verdict "${t.verdict}" invalid — expected ${VERDICTS.join(' | ')}`));
      continue; // everything below depends on a valid verdict
    }

    // ---- R-04 routing -------------------------------------------------------------------
    let r;
    try {
      r = route(t);
    } catch (e) {
      E(at(`R-04: ${e.message}`));
      continue;
    }
    if (t.verdict === 'PARTIAL' && !PARTIAL_REASONS[t.partialReason]) {
      E(at(`R-04: PARTIAL needs a sub-reason (${Object.keys(PARTIAL_REASONS).join(' | ')})`));
    }
    const derived = stateFor(r.route, stateMap);
    if (t.proposedState && t.proposedState !== derived) {
      if (!t.overrideReason) {
        E(
          at(
            `R-04: proposedState "${t.proposedState}" contradicts the routing table (${t.verdict}` +
              `${t.partialReason ? `/${t.partialReason}` : ''} → "${derived}"). ` +
              `State is derived, not authored. Add overrideReason only if a human decided otherwise.`
          )
        );
      } else {
        W(at(`proposedState overridden to "${t.proposedState}" (derived "${derived}"): ${t.overrideReason}`));
      }
    }

    // ---- R-05 surface + build ----------------------------------------------------------
    if (t.carriedForward) {
      if (!t.carriedFrom?.runId || !t.carriedFrom?.buildId) {
        E(at('R-06: carriedForward requires carriedFrom.runId and carriedFrom.buildId'));
      } else if (currentBuildId && t.carriedFrom.buildId !== currentBuildId) {
        E(
          at(
            `R-06: verdict was taken on build ${t.carriedFrom.buildId} but the run is on ${currentBuildId}. ` +
              `A redeploy invalidates carry-forwards — re-test it. Nobody investigates a stale pass.`
          )
        );
      }
    } else {
      if (!t.surface) E(at('R-05: surface is required — the host/app the verdict was taken on'));
      if (!t.buildId) E(at('R-05: buildId is required on every freshly tested ticket'));
      else if (currentBuildId && t.buildId !== currentBuildId) {
        E(at(`R-05: tested on build ${t.buildId}, run build is ${currentBuildId} — re-test or carry forward explicitly`));
      }
    }

    // ---- cases + R-09 evidence ---------------------------------------------------------
    const cases = Array.isArray(t.cases) ? t.cases : [];
    if (cases.length === 0) E(at('no cases recorded — a verdict with no case-level record is not auditable'));
    let anyFail = false;
    let anyNotTested = false;
    let anyNeedsManual = false;
    for (const c of cases) {
      const ac = (m) => at(`case ${c.caseId || '(no id)'}: ${m}`);
      if (!c.caseId) E(at('a case has no caseId (AC-n / TC-N.x)'));
      if (!CASE_VERDICTS.includes(c.verdict)) {
        E(ac(`verdict "${c.verdict}" invalid — expected ${CASE_VERDICTS.join(' | ')}`));
        continue;
      }
      if (c.verdict === 'FAIL') {
        anyFail = true;
        const ev = c.evidence || {};
        if (!ev.url) E(ac('R-09: a FAIL needs evidence.url (the surface it was observed on)'));
        if (!ev.observedText && ev.httpStatus === undefined)
          E(ac('R-09: a FAIL needs evidence.observedText or evidence.httpStatus — prose alone is not evidence'));
        if (!ev.buildId) E(ac('R-09: a FAIL needs evidence.buildId'));
      }
      if (c.verdict === 'NOT_TESTED') anyNotTested = true;
      if (c.verdict === 'NEEDS_MANUAL') anyNeedsManual = true;
    }

    // A pass may not sit on top of an unexecuted case — that is the silent false pass (H-1).
    if ((t.verdict === 'PASS' || t.verdict === 'PASS_SCOPE') && (anyFail || anyNotTested)) {
      E(
        at(
          `${t.verdict} contradicts its own cases (${anyFail ? 'a FAIL' : ''}${anyFail && anyNotTested ? ' and ' : ''}` +
            `${anyNotTested ? 'a NOT_TESTED' : ''} present). An unexecuted case is never a pass — ` +
            `use PARTIAL/coverage-gap, or run it.`
        )
      );
    }
    if (anyNotTested && !(t.verdict === 'PARTIAL' && t.partialReason === 'coverage-gap') && t.verdict !== 'NEEDS_MANUAL' && t.verdict !== 'BLOCKED') {
      W(at('has NOT_TESTED cases — confirm the ticket verdict reflects incomplete coverage'));
    }
    if (t.verdict === 'FAIL' && !anyFail) E(at('FAIL but no case is FAIL — the ticket verdict must follow its cases'));
    // A case nobody could run is not a pass either (H-1, second form).
    if ((t.verdict === 'PASS' || t.verdict === 'PASS_SCOPE') && anyNeedsManual)
      E(at(`${t.verdict} contradicts its own cases (a NEEDS_MANUAL is present). A case nobody could run is not a pass — use NEEDS_MANUAL or PARTIAL/coverage-gap.`));
    if (t.verdict === 'PARTIAL' && t.partialReason === 'mixed' && !anyFail)
      E(at('PARTIAL/mixed requires at least one FAIL case — "mixed" means some ACs genuinely fail; otherwise it is coverage-gap or a PASS'));
    if (t.verdict === 'BLOCKED' && anyFail)
      W(at('BLOCKED with a FAIL case — if the failure is a defect the ticket is FAIL or PARTIAL/mixed and routes to the dev, not to Blocked'));
    if (t.verdict === 'NEEDS_MANUAL' && cases.length && !anyNeedsManual && !anyNotTested)
      W(at('NEEDS_MANUAL but every case ran — the ticket verdict must follow its cases'));

    // ---- R-02 capability probe ---------------------------------------------------------
    const nm = Array.isArray(t.needsManual) ? t.needsManual : [];
    if (t.verdict === 'NEEDS_MANUAL' && nm.length === 0)
      E(at('R-02: NEEDS_MANUAL requires at least one needsManual entry with a failed probe'));
    if (anyNeedsManual && nm.length === 0)
      E(at('R-02: a NEEDS_MANUAL case requires a matching needsManual entry with a probe'));
    for (const n of nm) {
      const an = (m) => at(`needsManual ${n.caseId || '(no case)'}: ${m}`);
      const p = n.probe || {};
      if (!p.attempted) E(an('R-02: probe.attempted is required — the URL/endpoint/command actually tried'));
      if (!p.failureMode) E(an('R-02: probe.failureMode is required — what came back (status, error, consent screen)'));
      if (!p.missingCapability) E(an('R-02: probe.missingCapability is required'));
      else if (BANNED_CAPABILITY_REASONS.some((re) => re.test(String(p.missingCapability).trim())))
        E(
          an(
            `R-02: "${p.missingCapability}" is a category, not a reason. Name the specific missing thing ` +
              `("SMS inbox for +1555…", "device microphone on a physical handset"). ` +
              `10 of 18 deferrals on 2026-08-12 were fully runnable.`
          )
        );
      if (!p.evidence) E(an('R-02: probe.evidence is required — a path or the recorded response'));
      if (!Array.isArray(n.manualRepro) || n.manualRepro.length === 0)
        E(an('R-02: manualRepro[] is required — numbered steps a human can follow (build + account + device)'));
    }

    // ---- comments: R-04 presence, R-10 self-contained ----------------------------------
    if (r.requiresComment) {
      if (!t.comment || !String(t.comment).trim()) {
        E(at(`R-04: ${t.verdict} routes to "${derived}" and requires a comment explaining why`));
      } else {
        const leaks = INTERNAL_ARTEFACT_PATTERNS.filter((re) => re.test(t.comment));
        if (leaks.length)
          E(
            at(
              `R-10: comment references internal QA artefacts (${leaks.map((l) => l.source).join(', ')}). ` +
                `Dev-facing text explains the bug in prose and stands on its own.`
            )
          );
        if (mention && (r.route === 'reopen' || r.route === 'blocked') && !t.comment.trimEnd().endsWith(mention))
          E(at(`comment must end with "${mention}" (profile.linear.commentMentionSuffix)`));
      }
    }
    if (r.requiresScopeQuestion && !t.scopeQuestion)
      E(at('PASS_SCOPE requires scopeQuestion — the thing PM has to decide about the deferred remainder'));

    // ---- user rulings: a human decision, recorded append-only ----------------------------
    // A ruling is the user's own verbatim words (date + who + quote). It is the only thing that may
    // take a case out of scope (descopedCases keeps the original case record intact) or ask for a
    // comment on a ticket whose route would not otherwise carry one (postComment, e.g. a PASS).
    const rulings = t.rulings === undefined ? [] : t.rulings;
    if (!Array.isArray(rulings)) E(at('rulings must be an array'));
    else {
      for (const [i, ru] of rulings.entries()) {
        const ar = (m) => at(`ruling ${i + 1}: ${m}`);
        if (!ru?.date) E(ar('date is required'));
        if (!ru?.decidedBy) E(ar('decidedBy is required — the human who ruled'));
        if (!ru?.userQuote || !String(ru.userQuote).trim())
          E(ar("userQuote is required — the user's verbatim words; an agent's summary is not a ruling"));
        if (ru?.postComment === true && !r.requiresComment) {
          if (!t.comment || !String(t.comment).trim()) E(ar('postComment requires a ticket comment'));
          else {
            const leaks = INTERNAL_ARTEFACT_PATTERNS.filter((re) => re.test(t.comment));
            if (leaks.length)
              E(ar(`R-10: comment references internal QA artefacts (${leaks.map((l) => l.source).join(', ')})`));
          }
        }
      }
      const descoped = Array.isArray(t.descopedCases) ? t.descopedCases : [];
      if (descoped.length && rulings.length === 0)
        E(at('descopedCases requires a recorded ruling — only the user can take a case out of scope'));
      for (const c of descoped)
        if (!c?.descopedByRuling) E(at(`descoped case ${c?.caseId || '(no id)'}: descopedByRuling is required (the ruling date + quote it rests on)`));
    }
  }

  const counts = computeCounts(ledger, { stateMap });
  // (A "buckets sum to tickets" check used to live here. Every ticket lands in exactly one bucket by
  // construction, so it could never fire. What CAN go wrong is a ticket that classifies as nothing.)
  if (counts.buckets.INVALID)
    E(`R-11: ${counts.buckets.INVALID} ticket(s) could not be bucketed — a verdict that does not classify is a misfiled verdict`);
  if (counts.byProposedState.INVALID)
    E(`R-11: ${counts.byProposedState.INVALID} ticket(s) route to no state`);

  return { errors, warnings, counts };
}

/**
 * All counts in the system come from here. R-11.
 * @param {object} ledger
 * @param {{stateMap?:object}} opts — the profile's linear.stateMap; without it byProposedState carries
 *   DEFAULT_STATE_MAP names, which are only right for the project they were copied from.
 */
export function computeCounts(ledger, opts = {}) {
  const buckets = {};
  const byState = {};
  const stateMap = opts.stateMap || {};
  let carried = 0;
  for (const t of ledger.tickets || []) {
    const b = (() => {
      try {
        return bucketOf(t);
      } catch {
        return 'INVALID';
      }
    })();
    buckets[b] = (buckets[b] || 0) + 1;
    if (t.carriedForward) carried++;
    let st = 'INVALID';
    try {
      st = stateFor(route(t).route, stateMap);
    } catch { /* already reported by the validator */ }
    byState[st] = (byState[st] || 0) + 1;
  }
  return {
    total: (ledger.tickets || []).length,
    tested: (ledger.tickets || []).length - carried,
    carriedForward: carried,
    buckets,
    byProposedState: byState,
  };
}

/**
 * Case-level counts, derived (R-11): per ticket and for the whole run, one key per CASE_VERDICTS entry.
 * descopedCases stay outside t.cases, so a case the user took out of scope is never counted. A case
 * verdict outside CASE_VERDICTS counts under INVALID (the validator already reports it).
 * @returns {{perTicket: Object<string, Object<string, number>>, run: Object<string, number>}}
 */
export function ticketCaseCounts(t) {
  const n = Object.fromEntries(CASE_VERDICTS.map((v) => [v, 0]));
  for (const c of t?.cases || []) {
    if (CASE_VERDICTS.includes(c?.verdict)) n[c.verdict]++;
    else n.INVALID = (n.INVALID || 0) + 1;
  }
  return n;
}
export function caseCounts(ledger) {
  const perTicket = {};
  const run = Object.fromEntries(CASE_VERDICTS.map((v) => [v, 0]));
  for (const t of ledger?.tickets || []) {
    const n = ticketCaseCounts(t);
    perTicket[t.id] = n;
    for (const [k, v] of Object.entries(n)) run[k] = (run[k] || 0) + v;
  }
  return { perTicket, run };
}
