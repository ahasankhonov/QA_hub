// R-04 — the verdict → status routing table, in code, once.
// `proposedState` is DERIVED here. No agent authors it; the ledger validator rejects any authored
// value that disagrees with this function.

export const VERDICTS = ['PASS', 'PASS_SCOPE', 'FAIL', 'PARTIAL', 'NEEDS_MANUAL', 'BLOCKED'];

/** A bare PARTIAL is invalid — it was flattening three unrelated states (see R-04). */
export const PARTIAL_REASONS = {
  'mixed': {
    means: 'some ACs genuinely fail while others pass',
    route: 'reopen',
    devFacing: true,
  },
  'coverage-gap': {
    means: 'QA did not finish this ticket — no claim is being made about the product',
    route: 'stagingQaHold',
    devFacing: false,
  },
  'blocked-on-definition': {
    means: 'nobody knows the intended behaviour; needs a product decision',
    route: 'blocked',
    devFacing: false,
  },
};

/**
 * Logical routes, resolved to project-specific state names via profile.linear.stateMap.
 * `stagingQaHold` means "leave the ticket where it is and comment" — not a transition.
 */
export const DEFAULT_STATE_MAP = {
  pass: 'Release Candidate',
  reopen: 'Reopen',
  blocked: 'Blocked',
  stagingQaHold: 'Staging QA',
  newBug: 'Ready for Dev',
};

/**
 * Ticket-less entries (Beta mobile parity/mobile cases, R-20260929-AND) are keyed on a
 * generated id — `PAR-<AREA>-<n>` / `MOB-<n>` — not a tracker ticket. There is nothing for a
 * tracker write to transition, so `transition` must never be true for one of these, and a genuine
 * defect routes to `newBug` (a new ticket would have to be filed) rather than `reopen` (which
 * presumes an existing ticket to move).
 * @param {{id?:string}} t
 */
export function isTicketless(t) {
  return /^(?:PAR|MOB)-/.test(String(t?.id || ''));
}

/**
 * @param {{verdict:string, partialReason?:string|null, id?:string}} t
 * @returns {{route:string, devFacing:boolean, requiresComment:boolean, requiresScopeQuestion:boolean, transition:boolean}}
 */
export function route(t) {
  const v = t.verdict;
  const ticketless = isTicketless(t);
  switch (v) {
    case 'PASS':
      return mk('pass', { devFacing: false, requiresComment: false, transition: !ticketless });
    case 'PASS_SCOPE':
      // A delivered fix plus a deferred remainder is a pass with a question, NOT a Reopen.
      return mk('pass', {
        devFacing: false,
        requiresComment: false,
        transition: !ticketless,
        requiresScopeQuestion: true,
      });
    case 'FAIL':
      // A ticket-less FAIL has no existing ticket to reopen — it is a newly discovered defect,
      // which routes the same way a missing-feature PARTIAL/mixed does: newBug (create), not
      // reopen (transition something that was never filed).
      return mk(ticketless ? 'newBug' : 'reopen', { devFacing: true, requiresComment: true, transition: !ticketless });
    case 'PARTIAL': {
      const r = PARTIAL_REASONS[t.partialReason];
      if (!r) throw new Error(`PARTIAL requires partialReason ∈ ${Object.keys(PARTIAL_REASONS).join('|')}`);
      const routeName = ticketless && r.route === 'reopen' ? 'newBug' : r.route;
      return mk(routeName, {
        devFacing: r.devFacing,
        requiresComment: true,
        transition: r.route !== 'stagingQaHold' && !ticketless,
      });
    }
    case 'NEEDS_MANUAL':
      return mk('stagingQaHold', { devFacing: false, requiresComment: true, transition: false });
    case 'BLOCKED':
      return mk('blocked', { devFacing: true, requiresComment: true, transition: !ticketless });
    default:
      throw new Error(`unknown verdict "${v}" (expected ${VERDICTS.join('|')})`);
  }
}

function mk(route, o) {
  return {
    route,
    devFacing: !!o.devFacing,
    requiresComment: !!o.requiresComment,
    requiresScopeQuestion: !!o.requiresScopeQuestion,
    transition: !!o.transition,
  };
}

/** Resolve a logical route to the project's state name. */
export function stateFor(routeName, stateMap = {}) {
  const merged = { ...DEFAULT_STATE_MAP, ...stateMap };
  const s = merged[routeName];
  if (!s) throw new Error(`no state configured for route "${routeName}"`);
  return s;
}

/** The buckets a run is counted in. Derived — never authored. R-11. */
export function bucketOf(t) {
  if (t.verdict === 'PARTIAL') return `PARTIAL:${t.partialReason}`;
  return t.verdict;
}
