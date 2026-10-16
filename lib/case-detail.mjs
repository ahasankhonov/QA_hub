// The per-case detail of a run — which plan case and which plain-language explanation belong to a ledger
// case, and the steps to reproduce it. Shared by scripts/gen-docx.mjs (the dev-facing .docx) and
// scripts/slack-report.mjs (the per-ticket Slack replies), so both say the same thing about a failing case.
// Moved out of gen-docx.mjs on 2026-10-16 with its behaviour unchanged (the .docx is byte-identical):
//
//   · planLookup(dir, { planRun })  the analyst's plan case for (ticket, caseId): the NEWEST _PLAN-*-<ticket>.json
//                                   in dir, or only plans whose name carries -<planRun>- when planRun is given
//   · readPlain(dir, runId, opts)   the verifier's _PLAIN-<runId>.json sidecar { cases: { ticket: { caseId:
//                                   {problem, ac, expected, actual, why, steps[]} } } }; `shards: true` also merges
//                                   _PLAIN-<runId>-G<n>.json (gen-docx reads the merged file only)
//   · reproSteps(c, p, labels, o)   the ledger's own repro, else precondition + actions + check from the plan
//   · failDetail(t, c, ctx)         one failing case as { title, ac, expected, actual, why, steps, url, plain }
//
// A ledger field always wins over the plan; the plain sidecar wins over both (it is the explanation, the
// ledger keeps the evidence).

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** Plan-case lookup over one reports dir. `planCase(ticket, '')` primes the plan title for that ticket. */
export function planLookup(dir, { planRun = null } = {}) {
  const planCache = new Map();
  const planTitles = new Map();
  const plans = new Map();
  function planCase(ticketId, caseId) {
    if (!dir || !ticketId) return null;
    if (!planCache.has(ticketId)) {
      let cases = {};
      try {
        const files = readdirSync(dir)
          .filter((n) => /^_PLAN-.*-/.test(n) && n.endsWith(`-${ticketId}.json`))
          .filter((n) => !planRun || n.includes(`-${planRun}-`))
          .map((n) => ({ n, m: statSync(join(dir, n)).mtimeMs }))
          .sort((a, b) => b.m - a.m);
        if (files.length) {
          const plan = JSON.parse(readFileSync(join(dir, files[0].n), 'utf8'));
          plans.set(ticketId, plan);
          if (typeof plan.title === 'string') planTitles.set(ticketId, plan.title);
          const walk = (v) => {
            if (Array.isArray(v)) v.forEach(walk);
            else if (v && typeof v === 'object') {
              if (typeof v.caseId === 'string' && (v.actions || v.expected)) cases[v.caseId] = v;
              Object.values(v).forEach(walk);
            }
          };
          walk(plan);
        }
      } catch { cases = {}; }
      planCache.set(ticketId, cases);
    }
    return planCache.get(ticketId)[caseId] || null;
  }
  return {
    planCase,
    planTitle: (ticketId) => planTitles.get(ticketId),
    /** the whole plan object for a ticket (its scopeQuestions, title), or null */
    plan: (ticketId) => { planCase(ticketId, ''); return plans.get(ticketId) || null; },
  };
}

/** Thrown when a plain sidecar names another run; gen-docx turns it into its own exit-2 message. */
export class PlainRunMismatch extends Error {}

/**
 * The plain-language sidecar for a run. `plainPath` overrides the default _PLAIN-<runId>.json; `shards` also
 * merges every _PLAIN-<runId>-G<n>.json (case by case, the merged file first). A JSON error is thrown as is.
 */
export function readPlain(dir, runId, { plainPath = null, shards = false } = {}) {
  const main = plainPath || (dir ? join(dir, `_PLAIN-${runId}.json`) : null);
  let PLAIN = { cases: {} };
  const take = (p) => {
    const j = JSON.parse(readFileSync(p, 'utf8'));
    if (j.runId && j.runId !== runId) throw new PlainRunMismatch(`${p} is for run ${j.runId}, ledger is ${runId}`);
    return j;
  };
  if (main && existsSync(main)) PLAIN = take(main);
  if (shards && dir && existsSync(dir)) {
    const re = new RegExp(`^_PLAIN-${runId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-G\\d+\\.json$`);
    const merged = { ...PLAIN, cases: { ...(PLAIN.cases || {}) } };
    for (const n of readdirSync(dir).filter((x) => re.test(x)).sort()) {
      const s = take(join(dir, n));
      for (const [tid, byCase] of Object.entries(s.cases || {}))
        merged.cases[tid] = { ...(byCase || {}), ...(merged.cases[tid] || {}) };
    }
    PLAIN = merged;
  }
  return PLAIN;
}
export const plainCaseOf = (PLAIN) => (ticketId, caseId) => PLAIN.cases?.[ticketId]?.[caseId] || null;

/**
 * Steps to reproduce: the ledger's own `repro`, else the plan's precondition, actions and check. `actionText`
 * also takes a plan's single `action` string (some plans have no actions[]); gen-docx leaves it off.
 */
export function reproSteps(c, p, labels = { precond: 'Precondition', check: 'Check' }, { actionText = false } = {}) {
  if (Array.isArray(c.repro) && c.repro.length) return c.repro;
  if (!p) return [];
  const steps = [];
  if (p.precond) steps.push(`${labels.precond}: ${p.precond}`);
  if (actionText && typeof p.action === 'string' && p.action.trim() && !(p.actions || []).length) steps.push(p.action);
  for (const a of p.actions || []) steps.push(a);
  if (p.verifyBy) steps.push(`${labels.check}: ${p.verifyBy}`);
  return steps;
}

/**
 * One failing case, in the order a developer reads it. Same precedence as the .docx: the plain sidecar first;
 * else the ledger (acRef / expected / observedText / whyNotMet) and the plan for what the ledger lacks.
 */
export function failDetail(t, c, { planCase, plainCase, labels } = {}) {
  const p = planCase ? planCase(t.id, c.caseId) : null;
  const pl = plainCase ? plainCase(t.id, c.caseId) : null;
  const url = c.evidence?.url || null;
  if (pl) {
    return {
      caseId: c.caseId, plain: true, url,
      title: pl.problem || c.tcText || null,
      ac: pl.ac || c.acRef || p?.acRef || null,
      expected: pl.expected || null,
      actual: pl.actual || null,
      why: pl.why || null,
      steps: Array.isArray(pl.steps) && pl.steps.length ? pl.steps : reproSteps(c, p, labels, { actionText: true }),
    };
  }
  return {
    caseId: c.caseId, plain: false, url,
    title: c.tcText || p?.title || null,
    ac: c.acRef || p?.acRef || null,
    expected: c.expected || p?.expected || null,
    actual: c.evidence?.observedText || c.actual || null,
    why: c.whyNotMet || c.reason || c.note || null,
    steps: reproSteps(c, p, labels, { actionText: true }),
  };
}
