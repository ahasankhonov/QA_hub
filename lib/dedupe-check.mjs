// The dedupe record on a candidate bug (qa-skills second read, idea B, 2026-10-16).
//
// Verifier step 4 dedupes candidate bugs against the tracker. In practice it searched the queue-shaped
// cache: on Alpha that held 289 of 644 ids and the ALP-482 dealer-signature ticket was missed. A bug
// that matches a Done/Canceled ticket is a regression of that ticket, not a new bug. So each candidate
// bug records what was searched and over which states:
//
//   candidateBugs[].dedupe = { query, states, outcome, matchId? }
//     query    non-empty string: what was searched
//     states   "all", or a list that includes at least one CLOSED state of the profile's tracker
//     outcome  new | duplicate-open (reference matchId) | regression-closed (reopen/reference matchId,
//              never a new bug)
//     matchId  required unless outcome is "new"
//
// Backward compatible: no `dedupe`, a prose string, or a legacy object without any of the four keys
// (Alpha's {existingIssue, existingState, relation, …}) is a WARN. Once any of the four keys is present
// the record is checked strictly. A bare string in candidateBugs is a pointer to a record kept elsewhere
// (Beta's merged ledgers point at the shards' candidates[]); those get one WARN per ledger.
//
// Used by scripts/ledger-validate.mjs (the R-11 gate in qa-gates.mjs). Never throws on bad input.

export const DEDUPE_OUTCOMES = ['new', 'duplicate-open', 'regression-closed'];
const RECORD_KEYS = ['query', 'states', 'outcome', 'matchId'];

/** A terminal state: the ticket is finished or dropped. "Release Candidate" / "Production QA" are not. */
const CLOSED_RE =
  /^(done|cancell?ed|duplicate|closed|resolved|completed?|released?|prod|production|won'?t (fix|do)|cannot reproduce|can'?t reproduce|not a bug|obsolete|archived)$/i;

/** Used only when a profile names no closed state at all (EPS and Alpha carry just a stateMap). */
const TRACKER_DEFAULT_CLOSED = {
  linear: ['Done', 'Canceled', 'Duplicate'],
  jira: ['Done', 'Closed', 'Resolved'],
  asana: ['Done'],
  none: ['Done', 'Canceled', 'Cancelled', 'Duplicate', 'Closed', 'Released', 'PRODUCTION'],
};

const norm = (s) => String(s).trim().replace(/\s+/g, ' ').toLowerCase();

export function trackerKind(profile) {
  if (!profile) return 'none';
  if (profile.tracker?.kind) return profile.tracker.kind;
  if (profile.jira) return 'jira';
  if (profile.asana) return 'asana';
  return 'linear';
}

/** Every state name the profile knows: Linear stateMap/stateIds, the jira block, Asana sections/columns. */
export function knownStates(profile) {
  const names = [];
  const add = (x) => {
    if (typeof x === 'string' && x.trim()) names.push(x.trim());
  };
  if (!profile) return names;
  Object.values(profile.linear?.stateMap || {}).forEach(add);
  Object.keys(profile.linear?.stateIds || {}).forEach(add);
  Object.keys(profile.jira?.transitions || {}).forEach(add);
  add(profile.jira?.queueStatus);
  (Array.isArray(profile.jira?.statuses) ? profile.jira.statuses : []).forEach(add);
  for (const b of Object.values(profile.asana?.boards || {})) Object.keys(b?.sections || {}).forEach(add);
  (Array.isArray(profile.tracker?.columns) ? profile.tracker.columns : []).forEach(add);
  const seen = new Set();
  return names.filter((n) => !seen.has(norm(n)) && seen.add(norm(n)));
}

/** → { states: string[], source: string } — the closed states a dedupe search must reach. */
export function closedStates(profile) {
  const kind = trackerKind(profile);
  const found = knownStates(profile).filter((n) => CLOSED_RE.test(n.trim()));
  if (found.length) return { states: found, source: `${profile?.slug || 'profile'} ${kind} states` };
  const states = TRACKER_DEFAULT_CLOSED[kind] || TRACKER_DEFAULT_CLOSED.none;
  const whose = profile?.slug ? `the ${profile.slug} profile` : 'the profile';
  return { states, source: profile ? `${kind} defaults — ${whose} names no closed state` : 'generic defaults — no profile' };
}

const labelOf = (b, i) => {
  if (typeof b === 'string') return b;
  const id = b.id || b.draftId || b.ref;
  if (id) return String(id);
  if (b.title) {
    const t = String(b.title);
    return `"${t.length > 70 ? `${t.slice(0, 67)}...` : t}"`;
  }
  return `#${i}`;
};

/** Each candidate bug of a ledger with where it sits: top-level candidateBugs and tickets[].candidateBugs. */
function candidates(ledger) {
  const out = [];
  if (Array.isArray(ledger?.candidateBugs)) ledger.candidateBugs.forEach((b, i) => out.push({ b, at: `candidate bug ${labelOf(b ?? '', i)}` }));
  for (const t of Array.isArray(ledger?.tickets) ? ledger.tickets : []) {
    if (!Array.isArray(t?.candidateBugs)) continue;
    t.candidateBugs.forEach((b, i) => out.push({ b, at: `[${t.id || '(no id)'}] candidate bug ${labelOf(b ?? '', i)}` }));
  }
  return out;
}

/**
 * @returns {{errors:string[], warnings:string[], stats:{records:number, structured:number, missing:number, legacy:number, refs:number}}}
 */
export function checkCandidateDedupe(ledger, profile) {
  const errors = [];
  const warnings = [];
  const stats = { records: 0, structured: 0, missing: 0, legacy: 0, refs: 0 };
  const closed = closedStates(profile);
  const closedSet = new Set(closed.states.map(norm));
  const closedList = closed.states.join(' · ');
  const record = '{query, states, outcome, matchId}';
  const refs = [];

  for (const { b, at } of candidates(ledger)) {
    if (typeof b === 'string') {
      refs.push(b);
      continue;
    }
    if (!b || typeof b !== 'object' || Array.isArray(b)) continue;
    stats.records++;
    const d = b.dedupe;
    if (d === undefined || d === null) {
      stats.missing++;
      warnings.push(`${at}: no dedupe record — add dedupe ${record}: what was searched, over which states (closed ones included), what it found`);
      continue;
    }
    if (typeof d === 'string' || (typeof d === 'object' && !Array.isArray(d) && !RECORD_KEYS.some((k) => k in d))) {
      stats.legacy++;
      warnings.push(`${at}: legacy dedupe (${typeof d === 'string' ? 'prose' : 'no query/states/outcome'}) — record dedupe ${record} so the searched states can be checked`);
      continue;
    }
    stats.structured++;
    const E = (m) => errors.push(`${at}: dedupe ${m}`);
    if (typeof d !== 'object' || Array.isArray(d)) {
      E(`must be an object ${record}, got ${Array.isArray(d) ? 'an array' : typeof d}`);
      continue;
    }
    if (typeof d.query !== 'string' || !d.query.trim()) E('.query is missing — record what was searched (the words or JQL)');

    const s = d.states;
    const isAll = (x) => typeof x === 'string' && norm(x) === 'all';
    if (s === undefined || s === null || (Array.isArray(s) && !s.length)) {
      E(`.states is missing — record "all", or a list that includes a closed state (${closedList})`);
    } else if (isAll(s) || (Array.isArray(s) && s.some(isAll))) {
      /* every state */
    } else if (!Array.isArray(s) || s.some((x) => typeof x !== 'string' || !x.trim())) {
      E(`.states must be "all" or a list of state names, got ${JSON.stringify(s)}`);
    } else if (!s.some((x) => closedSet.has(norm(x)))) {
      E(
        `.states ${JSON.stringify(s)} covers no closed state — missing ${closedList} (${closed.source}). ` +
          'A match in a closed ticket is a regression of it, not a new bug: search every state ("all"), never the queue-shaped cache'
      );
    }

    if (!DEDUPE_OUTCOMES.includes(d.outcome)) {
      E(`.outcome ${d.outcome === undefined ? 'is missing' : `"${d.outcome}" invalid`} — expected ${DEDUPE_OUTCOMES.join(' | ')}`);
    } else if (d.outcome !== 'new' && (typeof d.matchId !== 'string' || !d.matchId.trim())) {
      E(
        `.outcome "${d.outcome}" needs matchId — the existing ${d.outcome === 'regression-closed' ? 'closed ticket to reopen/reference (never a new bug)' : 'open ticket to reference'}`
      );
    }
  }

  stats.refs = refs.length;
  if (refs.length) {
    const uniq = [...new Set(refs)];
    const shown = uniq.slice(0, 6).join(', ') + (uniq.length > 6 ? `, … (+${uniq.length - 6})` : '');
    warnings.push(`candidateBugs: ${refs.length} bare reference(s) (${shown}) carry no dedupe record — it belongs on the record each one names`);
  }
  return { errors, warnings, stats };
}
