// Jira call construction — the Jira half of what lib/routing.mjs + lib/tracker-ops.mjs already do
// for Linear. R-01/R-04.
//
// beta (Beta) tracks in Jira, not Linear, so the plan generator has to emit
// `transitionJiraIssue` / `addCommentToJiraIssue` calls instead of `save_issue` / `save_comment`.
// The write gate is already tracker-agnostic (it hashes whatever call it is handed); only the
// *shape* of the call is tracker-specific, and that shape lives here so exactly one file knows it.
//
// Two things Jira forces on us that Linear does not:
//
//  1. A status change is not a field write. Jira moves an issue by applying a *transition id*, and
//     those ids are per-project and per-workflow. So "STAGING" means nothing to the API — the id
//     `2` does. profile.jira.transitions is the board's own map, read once; a state name that is
//     not in it throws rather than guessing, because guessing an id moves the ticket somewhere
//     nobody approved.
//
//  2. The Jira site sits behind Cloudflare, and its WAF rejects comment bodies that *look* like a
//     payload — shell snippets, auth headers, markup, JSON, SQL/HTTP keywords in caps. The request
//     comes back 403 with no useful body, which reads like a broken tool rather than a rejected
//     comment. `wafViolations` catches that at plan time so the prose gets rewritten before the
//     user is asked to approve it (a comment that cannot be posted must never be silently dropped:
//     the developer would get a status change with no explanation — R-04/R-10).

/**
 * The project's Jira block, fully checked.
 * @param {object} profile
 * @returns {object} profile.jira
 * @throws {Error} naming the missing key
 */
export function jiraConfig(profile) {
  const j = profile?.jira;
  if (!j || typeof j !== 'object') throw new Error('profile has no "jira" block');
  const need = (path, value) => {
    if (value === undefined || value === null || value === '') throw new Error(`profile.${path} is missing`);
  };
  need('jira.cloudId', j.cloudId);
  need('jira.projectKey', j.projectKey);
  if (!j.transitions || typeof j.transitions !== 'object' || Object.keys(j.transitions).length === 0)
    throw new Error('profile.jira.transitions is missing');
  need('jira.tools.transition', j.tools?.transition);
  need('jira.tools.comment', j.tools?.comment);
  return j;
}

/**
 * Jira status name → the workflow transition id that reaches it. No fallback: an unknown state
 * name is a profile that has not been read off the real board, not a state to improvise.
 */
export function transitionIdFor(stateName, jira) {
  const id = jira?.transitions?.[stateName];
  if (id === undefined || id === null || id === '')
    throw new Error(`no Jira transition id for state "${stateName}" in profile.jira.transitions`);
  return String(id);
}

/** The `addCommentToJiraIssue` call for one issue. */
export function commentOp(issueKey, body, jira) {
  return {
    tool: jira.tools.comment,
    args: {
      cloudId: jira.cloudId,
      issueIdOrKey: issueKey,
      commentBody: body,
      contentFormat: jira.commentFormat || 'markdown',
    },
  };
}

/** The `transitionJiraIssue` call that moves one issue to `stateName`. */
export function transitionOp(issueKey, stateName, jira) {
  return {
    tool: jira.tools.transition,
    args: {
      cloudId: jira.cloudId,
      issueIdOrKey: issueKey,
      transition: { id: transitionIdFor(stateName, jira) },
    },
  };
}

/**
 * Cloudflare WAF tripwires. Named so the refusal can tell the writer *what* to rewrite.
 * The SQL and HTTP-verb rules are CAPS-only on purpose: "Get" and "update" are ordinary English
 * (and ordinary Uzbek transliteration), while "GET" and "UPDATE" are what a payload looks like.
 */
const WAF_PATTERNS = [
  ['curl', /\bcurl\b/i],
  ['auth-header', /\b(authorization|bearer)\b/i],
  ['angle-or-brace', /[<>{}]/],
  ['json-payload-start', /^\s*[[{]/m],
  ['sql-keyword', /\b(SELECT|INSERT|UPDATE|DELETE|DROP|UNION|WHERE)\b/],
  ['http-verb', /\b(GET|POST|PUT|PATCH|DELETE)\b/],
];

/**
 * @param {string} text
 * @returns {string[]} names of the tripped patterns, in declaration order. Empty = safe to post.
 */
export function wafViolations(text) {
  const s = String(text ?? '');
  return WAF_PATTERNS.filter(([, re]) => re.test(s)).map(([name]) => name);
}

/** The MCP tool that creates an issue; the profile may pin it, this is the Atlassian connector's name. */
export const DEFAULT_CREATE_TOOL = 'mcp__claude_ai_Atlassian__createJiraIssue';

/**
 * The `createJiraIssue` call for one new bug. Type is always Bug: this path exists only for defects
 * QA observed outside a ticket's acceptance criteria; anything else is a PM's ticket to write.
 * @param {{summary:string, description:string, priority:string, labels:string[]}} fields
 */
export function createIssueOp(fields, jira) {
  return {
    tool: jira.tools?.create || DEFAULT_CREATE_TOOL,
    args: {
      cloudId: jira.cloudId,
      projectKey: jira.projectKey,
      issueTypeName: 'Bug',
      summary: fields.summary,
      description: fields.description,
      contentFormat: jira.commentFormat || 'markdown',
      additional_fields: {
        labels: fields.labels,
        priority: { name: fields.priority },
      },
    },
  };
}

/**
 * Internal QA artefacts must never reach a dev-facing body (R-10). Named so the refusal can say
 * which fragment leaked.
 */
const INTERNAL_ARTEFACT_PATTERNS = [
  ['result-file', /_RESULT-|_LEDGER|_INTAKE|_PLAN-/],
  ['file-extension', /\.(json|png|jpg|jpeg|docx|md)\b/i],
  ['results-dir', /-results\/|_attachments|qa-reports/],
  // Hub-internal ids a developer cannot look up: parity cases (PAR-AUTH-1), synthesis root causes
  // (RC-22), run ids (R-20261006-EXP), bug/comment draft ids (EXP-B06, EXP-C01), journeys (EJ-10).
  // Tracker keys (BET-61, ALP-482) are digits-only after the dash, so they never match.
  ['internal-qa-id', /\bPAR-[A-Z]|\bRC-\d|\bR-20\d{6}|\b[A-Z]{2,4}-[BC]\d{2,}\b|\bEJ-\d{2}\b/],
];
export function internalArtefactLeaks(text) {
  const s = String(text ?? '');
  return INTERNAL_ARTEFACT_PATTERNS.filter(([, re]) => re.test(s)).map(([name]) => name);
}
