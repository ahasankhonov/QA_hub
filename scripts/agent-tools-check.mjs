#!/usr/bin/env node
// Agent tool allowlists — does every `tools:` line in .claude/agents/*.md still give the agent what it
// needs, and nothing that can write to a tracker? Read-only.
//
//   node scripts/agent-tools-check.mjs [--dir .claude/agents] [--json]
//
// Why the allowlists exist: an agent without `tools:` gets every tool and every connector's tool name,
// and each of its calls re-pays that context. Measured 2026-10-16 in a fresh `claude -p` session: a
// subagent's first call fell from 45.9k to 23.6k tokens with an allowlist. Idea from denfry/claude-skills.
//
// Why this check exists: a tool missing from an allowlist does not error. The agent just never sees it.
// A misspelled or renamed tool name is dropped the same way. So:
//   no-allowlist          a RESTRICTED agent lost its `tools:` line (the saving silently vanishes)
//   must-stay-open        qa-orchestrator / linear-writer got a `tools:` line (they dispatch and replay
//                         tracker writes; linear-writer's ops are frozen by the gate, not by this list)
//   unknown-tool          not a known built-in or catalogued connector READ tool: a typo or a rename
//   write-tool            a tracker/connector write outside linear-writer (R-01)
//   mcp-needs-toolsearch  allowlisted MCP tools stay deferred: without ToolSearch they cannot be loaded
//   named-not-listed      the prompt body names a tool (`get_issue`, mcp__…, ToolSearch) it cannot call
//   required-missing      a capability a rule depends on, e.g. R-02 "email is covered" = executor Gmail
//   duplicate             the same tool listed twice
// Allowlists take effect from the next session: Claude Code reads agent files at session start.

import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HUB = join(dirname(fileURLToPath(import.meta.url)), '..');

const RESTRICTED = ['report-writer', 'requirements-analyst', 'test-executor', 'verifier', 'ticket-intake'];
const OPEN = ['qa-orchestrator', 'linear-writer'];

export const BUILTIN = new Set([
  'Agent', 'Bash', 'Edit', 'Read', 'Write', 'Skill', 'ToolSearch', 'Monitor', 'SendMessage', 'TaskStop',
  'ListAgents', 'WebFetch', 'WebSearch', 'NotebookEdit', 'Artifact', 'ArtifactComments', 'ArtifactData',
  'AskUserQuestion', 'ReportFindings', 'CronCreate', 'CronDelete', 'CronList', 'PushNotification',
  'EnterPlanMode', 'ExitPlanMode', 'EnterWorktree', 'ExitWorktree', 'ListMcpResourcesTool',
  'ReadMcpResourceTool', 'ReadMcpResourceDirTool', 'SubagentHandback',
]);
// Built-ins distinctive enough that a mention in prose means the tool (not "Read", "Edit", "Agent").
const NAMED_BUILTIN = ['ToolSearch', 'Monitor', 'SendMessage', 'TaskStop', 'ListAgents', 'WebFetch', 'WebSearch', 'NotebookEdit'];

// READ tools per connector, from the session's tool list on 2026-10-16. Anything else from these
// servers is a write (save_/create_/update_/delete_/send/transition/…) or a name that does not exist.
const s = (str) => str.trim().split(/\s+/);
export const READ = {
  Linear: s(`extract_images get_agent_skill get_attachment get_diff get_diff_threads get_document get_initiative
    get_issue get_issue_status get_milestone get_notifications get_project get_release get_release_note
    get_status_updates get_team get_template get_triage_responsibility get_user get_workspace list_agent_skills
    list_comments list_custom_views list_cycles list_diffs list_documents list_initiative_labels list_initiatives
    list_issue_labels list_issue_statuses list_issues list_milestones list_project_labels list_projects
    list_release_notes list_release_pipelines list_releases list_teams list_templates list_users search_documentation`),
  Asana: s(`asana_get_agent asana_get_allocations asana_get_attachment asana_get_attachments_for_object asana_get_goal
    asana_get_goals asana_get_items_for_portfolio asana_get_parent_goals_for_goal asana_get_portfolio
    asana_get_portfolios asana_get_project asana_get_project_sections asana_get_project_status
    asana_get_project_statuses asana_get_project_task_counts asana_get_projects asana_get_projects_for_team
    asana_get_projects_for_workspace asana_get_stories_for_task asana_get_task asana_get_tasks asana_get_team_users
    asana_get_teams_for_user asana_get_teams_for_workspace asana_get_time_period asana_get_time_periods
    asana_get_user asana_get_workspace_agents asana_get_workspace_users asana_list_workspaces asana_search_tasks
    asana_typeahead_search`),
  Atlassian: s(`atlassianUserInfo fetch getAccessibleAtlassianResources getCompassComponent getCompassComponents
    getCompassCustomFieldDefinitions getConfluenceCommentChildren getConfluencePage getConfluencePageDescendants
    getConfluencePageFooterComments getConfluencePageInlineComments getConfluenceSpaces getContentFormatGuide
    getIssueLinkTypes getJiraIssue getJiraIssueRemoteIssueLinks getJiraIssueTypeMetaWithFields
    getJiraProjectIssueTypesMetadata getPagesInConfluenceSpace getTeamworkGraphContext getTeamworkGraphObject
    getTransitionsForJiraIssue getVisibleJiraProjects lookupJiraAccountId search searchConfluenceUsingCql
    searchJiraIssuesUsingJql`),
  Gmail: s('get_draft get_message get_thread list_drafts list_labels search_threads'),
  Slack: s(`slack_get_reactions slack_list_channel_members slack_read_canvas slack_read_channel slack_read_file
    slack_read_thread slack_read_user_profile slack_search_channels slack_search_emojis slack_search_public
    slack_search_public_and_private slack_search_users`),
  Figma: s(`get_code_connect_map get_code_connect_suggestions get_context_for_code_connect get_design_context
    get_figjam get_figma_skill get_generative_plugin get_libraries get_metadata get_motion_context get_screenshot
    get_shader get_variable_defs list_file_components_for_code_connect list_file_shaders list_generative_plugins
    list_shaders search_design_system whoami`),
};
const MCP_RE = /^mcp__claude_ai_([A-Za-z0-9]+)__([A-Za-z0-9_]+)$/;
const WRITE_RE = /(^|_)(save|create|update|delete|add|remove|set|send|reply|forward|trash|untrash|label|unlabel|mark|unmark|merge|submit|resolve|share|unshare|upload|prepare|restore|retire|schedule|apply|move|rename|copy|respond|transition|edit)(_|[A-Z]|$)/;
const ALL_READ_SUFFIX = new Set(Object.values(READ).flat());
const mcp = (server, tool) => `mcp__claude_ai_${server}__${tool}`;

// Capabilities a rule depends on. Losing one breaks the rule without an error anywhere else.
export const REQUIRED = {
  'test-executor': ['Bash', 'Read', 'Edit', 'Write', 'ToolSearch', 'Monitor',
    // R-02: "email is covered (Gmail connector + +alias)" is only true while the executor can read mail.
    mcp('Gmail', 'search_threads'), mcp('Gmail', 'get_thread'), mcp('Gmail', 'get_message')],
  verifier: ['Bash', 'Read', 'Edit', 'Write', 'ToolSearch',
    // Dedupe against the backlog on every tracker kind the hub runs (Linear, Asana, Jira).
    mcp('Linear', 'list_issues'), mcp('Linear', 'get_issue'), mcp('Asana', 'asana_search_tasks'),
    mcp('Atlassian', 'searchJiraIssuesUsingJql')],
  'ticket-intake': ['Bash', 'Read', 'Edit', 'Write', 'ToolSearch',
    mcp('Linear', 'list_issues'), mcp('Linear', 'get_issue'), mcp('Linear', 'list_comments'),
    mcp('Asana', 'asana_get_task'), mcp('Asana', 'asana_get_stories_for_task'), mcp('Asana', 'asana_get_attachments_for_object')],
  'requirements-analyst': ['Bash', 'Read', 'Edit', 'Write'],
  'report-writer': ['Bash', 'Read', 'Edit', 'Write'],
};

/** { name, tools: string[] | null, body } from an agent file. tools is null when there is no `tools:`. */
export function parseAgent(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { name: null, tools: null, body: text };
  const [, front, body] = m;
  const name = (front.match(/^name:\s*(.+)$/m) || [])[1]?.trim() ?? null;
  const lines = front.split('\n');
  const i = lines.findIndex((l) => /^tools:/.test(l));
  if (i < 0) return { name, tools: null, body };
  let tools;
  const inline = lines[i].replace(/^tools:\s*/, '').trim();
  if (inline) tools = inline.replace(/^\[|\]$/g, '').split(',').map((t) => t.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  else {
    tools = [];
    for (let j = i + 1; j < lines.length && /^\s+-\s*/.test(lines[j]); j++) tools.push(lines[j].replace(/^\s+-\s*/, '').trim());
  }
  return { name, tools, body };
}

/** Tool names the prompt body names explicitly: full mcp__ names, backticked connector tool names, distinctive built-ins. */
export function namedTools(body) {
  const named = new Set(body.match(/mcp__claude_ai_[A-Za-z0-9]+__[A-Za-z0-9_]+/g) || []);
  for (const [, tok] of body.matchAll(/`([A-Za-z][A-Za-z0-9_]*)`/g)) {
    // A plain word (`search`, `fetch`) is too generic to count as naming a tool.
    if ((tok.includes('_') || /[a-z][A-Z]/.test(tok)) && ALL_READ_SUFFIX.has(tok)) named.add(tok);
  }
  for (const b of NAMED_BUILTIN) if (new RegExp(`\\b${b}\\b`).test(body)) named.add(b);
  return [...named];
}

/** Findings for one agent file: [{ agent, code, msg }]. Empty = OK. */
export function checkAgent(fileName, text) {
  const { name: fmName, tools, body } = parseAgent(text);
  const agent = fmName || fileName.replace(/\.md$/, '');
  const out = [];
  const add = (code, msg) => out.push({ agent, code, msg });
  if (OPEN.includes(agent)) {
    if (tools) add('must-stay-open', `${agent} needs every tool (dispatch / gated tracker replay); remove its tools: line`);
    return out;
  }
  if (!tools) {
    if (RESTRICTED.includes(agent)) add('no-allowlist', `${agent} has no tools: line, so it loads every tool (~22k tokens per start)`);
    return out;
  }
  const seen = new Set();
  for (const t of tools) {
    if (seen.has(t)) add('duplicate', `${t} listed twice`);
    seen.add(t);
    const m = t.match(MCP_RE);
    if (!m) {
      if (!BUILTIN.has(t)) add('unknown-tool', `${t} is not a known built-in tool (typo or rename?)`);
      continue;
    }
    const [, server, tool] = m;
    if (READ[server]?.includes(tool)) continue;
    if (WRITE_RE.test(tool)) add('write-tool', `${t} can write (R-01: only linear-writer replays tracker writes)`);
    else add('unknown-tool', `${t} is not a catalogued ${server} READ tool (typo, rename, or an uncatalogued server)`);
  }
  if (tools.some((t) => t.startsWith('mcp__')) && !seen.has('ToolSearch'))
    add('mcp-needs-toolsearch', 'allowlisted MCP tools stay deferred; without ToolSearch the agent cannot load them');
  for (const n of namedTools(body)) {
    const ok = n.startsWith('mcp__') || BUILTIN.has(n) ? seen.has(n) : tools.some((t) => t.endsWith(`__${n}`));
    if (!ok) add('named-not-listed', `the prompt names ${n} but the allowlist does not give it`);
  }
  for (const r of REQUIRED[agent] || []) if (!seen.has(r)) add('required-missing', `${r} is required (see REQUIRED in agent-tools-check.mjs)`);
  return out;
}

export function checkDir(dir) {
  const agents = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.md')).sort()) {
    const text = readFileSync(join(dir, f), 'utf8');
    const { tools } = parseAgent(text);
    agents.push({ file: f, tools: tools ? tools.length : null, findings: checkAgent(f, text) });
  }
  const present = new Set(agents.map((a) => a.file.replace(/\.md$/, '')));
  const missing = [...RESTRICTED, ...OPEN].filter((a) => !present.has(a));
  return { dir, agents, missing, ok: agents.every((a) => !a.findings.length) && !missing.length };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const di = args.indexOf('--dir');
  const dir = di >= 0 ? args[di + 1] : join(HUB, '.claude', 'agents');
  const r = checkDir(dir);
  if (args.includes('--json')) console.log(JSON.stringify(r, null, 2));
  else {
    for (const a of r.agents) {
      const state = a.tools === null ? 'all tools' : `${a.tools} tools`;
      console.log(`${a.findings.length ? 'FAIL' : 'OK  '} ${a.file.padEnd(26)} ${state}`);
      for (const f of a.findings) console.log(`       ${f.code}: ${f.msg}`);
    }
    for (const m of r.missing) console.log(`FAIL ${m}.md missing from ${dir}`);
    console.log(r.ok ? 'AGENT TOOLS OK' : 'AGENT TOOLS FAILED');
  }
  process.exit(r.ok ? 0 : 1);
}
