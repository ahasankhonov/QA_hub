---
name: auto-mode-classifier-denials
description: "Auto-mode classifier denials are final (stop, report, never retry — it classifies Agent dispatches too). 2026-10-09: the QA lead wants auto mode everywhere with NO prompts; the VS Code initialPermissionMode=acceptEdits override (cause of the Allow-this-bash-command prompts) was removed so sessions fall back to global defaultMode auto."
metadata:
  node_type: memory
  type: project
  originSessionId: 1bdd731e-cf06-4cf6-81b7-c0b08d535321
  modified: 2026-10-08T11:45:27.559Z
---

**What happened (2026-10-08).** The Alpha R19 session was stopped three times by the Claude Code auto-mode
classifier ("Security Weaken" ×6, "Modify Shared Resources" ×3) when it added a DNS-verified staging host to
`profiles/alpha.json` and ran against it, even after the QA lead's explicit instruction; the workflow-builder session
got "Auto-Mode Bypass" ×4; this session's self-proving guard path for R-13 was refused the same way. None of
these were hub hooks. The VS Code sessions were in auto mode (the extension remembers the last mode picked;
`globalStorage/anthropic.claude-code/session-permission-modes/*.json` = `{"mode":"auto"}`), where a
classifier denies with no override instead of prompting. `agent/PLAN.md` Decision 5 (the QA lead, 2026-10-08)
intends auto mode only for the Telegram agent: "VS Code sessions keep the Allow click."

**Why:** the QA lead: "before I set up chatbot it was not blocking anything … I don't want to have this kind of
blockers, it is making steps more and wasting my time." Before, a non-allow-listed command prompted and he
clicked Allow; a prompt is not a blocker to him, a classifier denial is.

**How to apply:** A classifier denial is final for that session — stop and report, never retry it in
pieces or from another session. Docs facts (verified 2026-10-08): Bash allow rules resolve before the
classifier (unless `autoMode.classifyAllShell`); rules evaluate deny → ask → allow; a compound command must
match per subcommand (`cd x && node y` needs both); a leading env assignment is stripped for allow rules;
the VS Code extension takes its starting mode from `claudeCode.initialPermissionMode`, never from project
settings. Fix handed to the QA lead: `claudeCode.initialPermissionMode: "acceptEdits"` (VS Code) +
`permissions.defaultMode: "acceptEdits"` (`~/.claude/settings.json`) + allow rules for `node harness/`,
the read-only/plan scripts, `cd` to the hub root and `dig`/`host`. When the Telegram agent is built, its
`run.sh` must pass `--permission-mode auto` itself. Related: [[qa-hub-gates-and-rules]],
[[alpha-prod-safety]], [[telegram-qa-agent-plan]], [[workflow-builder-lessons]].

**Applied + verified (2026-10-08, later the same day).** the QA lead applied all three pastes himself: VS Code
`claudeCode.initialPermissionMode: "acceptEdits"`, `~/.claude/settings.json` `permissions.defaultMode:
"acceptEdits"`, 33 Bash allow rules in `.claude/settings.local.json` (no write tool, no qa-approve in
`allow`), `surfaces.storefrontCustomer` in `profiles/alpha.json`, and the CLAUDE.md / RULES.md R-13 Alpha
wording. `harness/alpha/config.mjs` now honours `storefrontCustomer` (HOSTS, `assertStaging`, `isProdHost`);
`npm run selftest` 620/620. **Lesson:** the session that did this work (3a4b641f) had started in auto mode
and stayed there — the classifier then denied the *Agent* dispatch of the R19 stage-3 executor ("Security
Weaken"), i.e. it evaluates sub-agent prompts too, regardless of allow rules. A denial is final for that
session: do the rest, write the handoff, and let the QA lead start a fresh session (which now opens in acceptEdits).

**2026-10-09 — reversal of the 2026-10-08 fix.** the QA lead: "i am getting this kind of questions a lot for other chats even i have auto mode, it was not like this before, when i leave my work station it stops waiting me" (screenshot: "Allow this bash command?" for a `cd …/projects/gamma; jq … | head` one-liner). Root cause: the VS Code setting `claudeCode.initialPermissionMode: "acceptEdits"` overrides the global `permissions.defaultMode: "auto"` for every VS Code session, and in acceptEdits any Bash command that matches no allow rule prompts (the `cd <dir>;` prefix matched none). Both hub hooks returned allow for that exact command, so the hub was not the cause of that prompt. Fix: the override line was deleted from `~/Library/Application Support/Code/User/settings.json` (backup in `.chatbot-removal-backup-2026-10-09/home/vscode/`). Per the docs the extension picks, in order: `initialPermissionMode` → the mode last chosen in the UI → `permissions.defaultMode` from `~/.claude/settings.json` → built-in default; `auto` is NOT an accepted value for `initialPermissionMode` (only default/plan/acceptEdits/bypassPermissions), so leaving it unset is the way to get auto. What still prompts in auto mode: `permissions.ask` rules (only `qa-approve.mjs` now), protected-path writes, the first read outside working directories, and classifier fallbacks (after 3 blocks in a row or 20 total, prompts resume until one is approved). **How to apply:** the QA lead wants no blocking prompts; keep the 33 Bash allow rules, never add `ask` rules or broad-matcher hooks, and if he reports prompts again check the VS Code setting first, then `/permissions` → Recently denied.
