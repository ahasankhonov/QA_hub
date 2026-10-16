---
name: linear-connector-session-registry
description: claude.ai Linear connector authorized ≠ Linear MCP tools registered in a Claude Code session; how to detect and what does NOT work around it (2026-09-17)
metadata: 
  node_type: memory
  type: project
  originSessionId: 6841ed2a-e825-43c6-8a41-6cf86dd6255e
  modified: 2026-09-17T07:49:00.223Z
---

Twice on the Alpha meeting-coverage work (2026-09-17, two sessions) the user authorized the claude.ai Linear
connector, yet `mcp__claude_ai_Linear__*` never registered in the Claude Code session: ToolSearch "linear" → no
tools, session banner lists "claude.ai Linear" under *requires authentication*. `claude mcp list` at the same
moment said **"claude.ai Linear: ✔ Connected"** — the CLI health check and the in-session OAuth state can disagree.

Things that do NOT get the tools: spawning subagents (they inherit the parent registry); a fresh headless child
(`echo "<prompt>" | claude -p --output-format stream-json --allowedTools mcp__claude_ai_Linear__get_issue`) —
it reported the same "not authorized in this session". The hub has no API-key/GraphQL fallback (no `lin_api_`,
no `api.linear.app` anywhere), so the connector is the only Linear path.

**Why:** the tool registry is built at session start from the OAuth state Claude Code sees, not from claude.ai
settings; a live pull attempted in the wrong session burns tokens and stalls the run.

Resolved 2026-09-17 (third session): after the user re-authorized, the FIRST ToolSearch in a new session was still
empty, but a second ToolSearch moments later (user: "try again") found all `mcp__claude_ai_Linear__*` tools and
`list_teams` worked. The registry can refresh mid-session shortly after a re-auth.

**How to apply:** at the start of any Linear-dependent run, ToolSearch "linear" FIRST; if empty, retry once
after a short pause; if still empty, stop and tell the user to re-authorize from an interactive `claude` session
via `/mcp` (not only claude.ai connector settings), then start a fresh session. Record the probe (R-02 style) in `_SESSION-STATE`. Prepared tooling for the pending
Alpha live re-check: `projects/alpha/qa-reports/_MEETING-COVERAGE-EVIDENCE/LIVE-PULL-SPEC.md`.
Gotcha: `--allowedTools` is variadic and swallows a trailing positional prompt — pass the prompt on stdin.
Related: [[linear-write-approval]], [[linear-intake-verbatim-pull]], [[alpha-prod-safety]].
