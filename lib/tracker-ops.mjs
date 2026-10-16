// Canonicalisation of tracker write calls (Linear / Jira / Asana) — shared by the PreToolUse gate and the plan generator.
// Both sides MUST derive the hash the same way, so this file is the only place that knows how.
// R-01.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, openSync, fstatSync, closeSync, writeSync, constants as FS } from 'node:fs';
import { join } from 'node:path';

// ─── hook I/O shared by the gates (FS-01 / FIFO handoff) ────────────────────────────────────────

/** Longest permissionDecisionReason a gate prints: the whole JSON stays far below a 16 KB pipe buffer. */
export const MAX_REASON = 4000;

/** Clip a string for a decision reason or a one-line description. */
export function clip(s, n = MAX_REASON) {
  s = String(s ?? '');
  return s.length <= n ? s : `${s.slice(0, Math.max(0, n - 40))}… [${s.length - n + 40} more chars]`;
}

/**
 * Write a hook's JSON answer to fd 1 completely, synchronously. process.stdout on a pipe is async, and
 * process.exit() right after write() cut a 70 KB reason at 64 KB — truncated JSON at exit 0 is "no
 * decision", i.e. fail-open (FS-01). Retries EAGAIN (a non-blocking pipe) for up to 5 s.
 */
export function writeHookOutput(obj) {
  const b = Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj));
  const until = Date.now() + 5000;
  for (let o = 0; o < b.length;) {
    try {
      o += writeSync(1, b, o);
    } catch (e) {
      if (e && e.code === 'EAGAIN' && Date.now() < until) continue;
      throw e;
    }
  }
}

/**
 * Read a file only if it is a regular file, without ever blocking: O_NONBLOCK open, then fstat.
 * A FIFO (or device) planted where a plan, approval, transcript or settings file is expected would
 * otherwise hang the hook until its timeout — and a timed-out PreToolUse hook does not block.
 * Throws (callers fail closed) when the path is not a regular file.
 */
export function readRegularFile(path, enc = 'utf8') {
  const fd = openSync(path, FS.O_RDONLY | (FS.O_NONBLOCK || 0));
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`${path} is not a regular file (FIFO, device or directory) — refusing to read it`);
    return readFileSync(fd, enc);
  } finally {
    closeSync(fd);
  }
}

/**
 * Tracker calls that mutate outward-facing state. Anything matching here is denied by
 * `.claude/hooks/tracker-write-gate.mjs` unless it appears in an approval file.
 *
 * Deliberately over-inclusive: a read tool wrongly listed here costs one approval line, a write
 * tool wrongly omitted costs an unapproved write. Fail toward the annoying side.
 */
export const WRITE_TOOL_PATTERNS = [
  // Linear — creates/updates
  /^mcp__claude_ai_Linear__save_/,
  /^mcp__claude_ai_Linear__create_/,
  /^mcp__claude_ai_Linear__delete_/,
  /^mcp__claude_ai_Linear__prepare_attachment_upload$/,
  /^mcp__claude_ai_Linear__merge_diff$/,
  /^mcp__claude_ai_Linear__resolve_diff_thread$/,
  /^mcp__claude_ai_Linear__submit_diff_review$/,
  /^mcp__claude_ai_Linear__(share|unshare)_issue$/,
  /^mcp__claude_ai_Linear__(update|archive|unarchive|upload|add|remove|set|move)_/,
  // Slack + Gmail — an outward send is exactly the deliverable this gate holds back (R-01). Reads
  // (search, list, get) stay open: the Gmail inbox is how email-gated flows are tested.
  /^mcp__claude_ai_Slack__.*(send|post|reply|update|delete|react|upload|create|invite|schedule|set_)/i,
  /^mcp__claude_ai_Gmail__.*(send|reply|forward|draft|trash|delete|archive|label|modify|create|move|batch)/i,
  // Jira / Confluence — the same rule, a different tracker (beta runs on Jira)
  /^mcp__claude_ai_Atlassian__create/,
  /^mcp__claude_ai_Atlassian__edit/,
  /^mcp__claude_ai_Atlassian__update/,
  /^mcp__claude_ai_Atlassian__add/,
  /^mcp__claude_ai_Atlassian__transitionJiraIssue$/,
  // Jira REST attachment upload (scripts/jira-attach-apply.mjs) — no MCP tool exists, so the gate hook
  // never sees it; the apply script verifies the frozen approval itself. Approved by the QA lead 2026-10-07.
  /^jira-rest-attach$/,
  // Asana (gamma) — inverted on purpose: EVERY Asana tool is a write unless its verb is an explicit
  // read. The connector's tool names were not known when this was written (not yet authorized), so an
  // allowlist of writes would miss whatever it actually ships; a read wrongly gated costs one prompt.
  /^mcp__claude_ai_Asana__(?!(?:asana_)?(?:get|list|search|typeahead)_)/i,
];

export function isTrackerWrite(toolName) {
  return WRITE_TOOL_PATTERNS.some((re) => re.test(toolName || ''));
}

/**
 * A permissions.allow entry that would let the agent pre-approve its own tracker write or run
 * qa-approve without the human seeing a prompt: a write tool, the approve script, a wildcard or bare
 * Bash rule (which covers `node scripts/qa-approve.mjs …`), or a server-wide MCP allow.
 */
export function isUnsafeAllowEntry(entry) {
  const e = String(entry);
  const tool = e.replace(/\(.*$/, '');
  if (isTrackerWrite(tool)) return true;
  if (/qa-approve/.test(e)) return true;
  const bash = /^Bash(?:\((.*)\))?$/.exec(e);
  if (bash) {
    const cmd = (bash[1] ?? '*').trim();
    if (cmd === '' || cmd === '*' || cmd === '*:*') return true; // any command, no prompt
    if (/^node(\s*:\s*\*|\s+\*|\s+scripts\/\*\S*)?$/.test(cmd)) return true; // node <anything> covers qa-approve
  }
  if (/^mcp__claude_ai_(Linear|Atlassian|Slack|Gmail|Asana)$/.test(tool)) return true;
  if (/^mcp__claude_ai_(Linear|Atlassian|Slack|Gmail|Asana)__.*\*/.test(e)) return true;
  return false;
}

/** A create is not idempotent: one approval, one issue. Comments likewise. Transitions may be retried. */
export function defaultMaxApplies(kind) {
  return { 'new-bug': 1, comment: 1, attachment: 1 }[kind] ?? 3;
}

/**
 * Fields that cannot be known when the plan is written because the server produces them at
 * runtime. They are excluded from the hash; the remaining fields still pin the call to one
 * issue and one artefact.
 */
const RUNTIME_FIELDS = {
  'mcp__claude_ai_Linear__create_attachment_from_upload': ['assetUrl', 'subtitle'],
  'mcp__claude_ai_Linear__prepare_attachment_upload': ['subtitle'],
};

function normalizeString(s) {
  // Markdown round-trips through editors and MCP; whitespace-only differences must not break a
  // match, but content differences must.
  return s.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trim();
}

function normalizeValue(v) {
  if (typeof v === 'string') return normalizeString(v);
  if (Array.isArray(v)) return v.map(normalizeValue);
  if (v && typeof v === 'object') return canonicalObject(v);
  return v;
}

function canonicalObject(obj) {
  const out = {};
  for (const k of Object.keys(obj).sort()) {
    const v = obj[k];
    if (v === undefined) continue;
    out[k] = normalizeValue(v);
  }
  return out;
}

/**
 * Canonical form of a tracker write call. Stable across key order, trailing whitespace and CRLF.
 * @returns {{tool:string, canonical:string, hash:string}}
 */
export function canonicalOp(toolName, args) {
  const drop = new Set(RUNTIME_FIELDS[toolName] || []);
  const filtered = {};
  for (const [k, v] of Object.entries(args || {})) {
    if (drop.has(k)) continue;
    // null is a value (it clears a field on the server) — only undefined is "not sent". Dropping
    // nulls let an approved {id,state} also authorise {id,state,assignee:null}.
    if (v === undefined) continue;
    filtered[k] = v;
  }
  const canonical = JSON.stringify({ tool: toolName, args: canonicalObject(filtered) });
  return { tool: toolName, canonical, hash: sha256(canonical) };
}

export function sha256(s) {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

export function sha256File(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/** One-line human description of an op, for the approval prompt and the audit log. */
export function describeOp(toolName, args) {
  const a = args || {};
  const short = (s, n = 70) =>
    typeof s === 'string' ? (s.length > n ? s.slice(0, n).replace(/\n/g, ' ') + '…' : s.replace(/\n/g, ' ')) : s;
  // Every interpolated field is clipped (FS-01): an id/state/team/title/key of 70 KB used to make the
  // gate's reason longer than the pipe buffer. Short real values are unchanged.
  const f = (v, n = 100) => (v && typeof v === 'object' ? short(JSON.stringify(v), n) : typeof v === 'string' ? short(v, n) : v);
  switch (toolName) {
    case 'mcp__claude_ai_Linear__save_issue':
      return a.id
        ? `update ${f(a.id)}${a.state ? ` → state "${f(a.state)}"` : ''}${a.priority !== undefined ? ` prio ${f(a.priority)}` : ''}`
        : `CREATE issue "${short(a.title)}" in ${f(a.team)}`;
    case 'mcp__claude_ai_Linear__save_comment':
      return `comment on ${f(a.issueId || a.projectId || a.parentId)} (${(a.body || '').length} chars): ${short(a.body, 60)}`;
    // A delete carries only the comment id, which tells an approver nothing on its own. The plan's
    // `ticket` field is what makes it legible, so keep this line short and let the approval prompt
    // pair the two.
    case 'mcp__claude_ai_Linear__delete_comment':
      return `DELETE comment ${short(a.id, 12)}`;
    case 'mcp__claude_ai_Linear__prepare_attachment_upload':
      return `prepare upload ${f(a.filename)} → ${f(a.issue)} (${f(a.size)} bytes)`;
    case 'mcp__claude_ai_Linear__create_attachment_from_upload':
      return `attach "${f(a.title) || '(untitled)'}" → ${f(a.issue)}`;
    case 'mcp__claude_ai_Atlassian__transitionJiraIssue':
      return `transition ${f(a.issueIdOrKey)} → ${f(a.transition?.id || a.transition)}`;
    case 'mcp__claude_ai_Atlassian__createJiraIssue':
      return `create ${f(a.issueTypeName) || 'issue'} in ${f(a.projectKey)} [${f(a.additional_fields?.priority?.name) || '-'}]: ${short(a.summary, 100)}`;
    case 'mcp__claude_ai_Atlassian__addCommentToJiraIssue':
      return `comment on ${f(a.issueIdOrKey)} (${(a.commentBody || '').length} chars): ${short(a.commentBody, 60)}`;
    default:
      return `${f(toolName, 120)} ${short(JSON.stringify(a), 90)}`;
  }
}

// ─── R-01 config safety — shared by the write gate and qa-approve ─────────────────────────────
//
// The allowlist check used to read only .claude/settings.local.json, so the same unsafe entry in
// any other settings file Claude Code merges (project settings.json, ~/.claude/settings*.json, the
// always-on agent's own settings, managed settings) waived the gate. And the Telegram channel
// plugin sends Allow/Deny permission prompts to EVERY user on its DM allowlist, so a dev bot or a
// stranger on that list could approve a tracker write. Both checks fail closed.

/** macOS managed settings; Claude Code merges it above every other file. */
export const MANAGED_SETTINGS = '/Library/Application Support/ClaudeCode/managed-settings.json';

/** Every settings file Claude Code may merge, that exists right now. */
export function settingsFilesToScan({ hub, home, managed = MANAGED_SETTINGS }) {
  const all = [
    join(hub, '.claude', 'settings.json'),
    join(hub, '.claude', 'settings.local.json'),
    join(home, '.claude', 'settings.json'),
    join(home, '.claude', 'settings.local.json'),
    managed,
  ];
  return all.filter((f) => f && existsSync(f));
}

/**
 * Scan permissions.allow of every settings file. Returns null when clean, else a reason naming
 * the file (and the entries) that make the gate unsafe.
 */
export function settingsProblem({ hub, home, managed }) {
  for (const f of settingsFilesToScan({ hub, home, managed })) {
    let cfg;
    try {
      cfg = JSON.parse(readFileSync(f, 'utf8'));
    } catch (e) {
      return `R-01 CONFIG UNSAFE: ${f} is unparseable (${e.message}). Claude Code may still merge part of it, so the ` +
        `gate cannot prove it does not pre-approve a tracker write. Fix the JSON; until then every tracker write is denied.`;
    }
    const allow = Array.isArray(cfg?.permissions?.allow) ? cfg.permissions.allow : [];
    const offenders = allow.filter(isUnsafeAllowEntry);
    if (offenders.length) {
      return `R-01 CONFIG UNSAFE: permissions.allow in ${f} pre-approves ${offenders.join(', ')}. ` +
        `That bypasses the approval gate entirely. Remove those entries from ${f}. ` +
        `All tracker writes are denied until it is clean.`;
    }
  }
  return null;
}

/** The config check the write gate and qa-approve run. Returns null or a reason. */
export function configProblem({ hub, home, managed }) {
  return settingsProblem({ hub, home, managed });
}
