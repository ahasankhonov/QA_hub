---
name: linear-write-approval
description: Always ask before writing anything to Linear (create/comment/status/attach) during testing
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 116f2af3-2991-462d-8222-0302467852e8
  modified: 2026-08-12T18:09:10.005Z
---

the QA lead requires **explicit approval before ANY write to Linear** — creating bug tickets, commenting, changing ticket status, or attaching files. Present findings first and wait for a go-ahead.

**Why:** During an exploratory run (2026-07-16) I filed two new bugs (PRO-66, PRO-67) and commented on PRO-65/PRO-53 without sign-off, on cases that were meant "for review first." the QA lead flagged it ("i did not approve it yet") and had me retract everything (issues → Canceled, attachments + comments deleted).

**How to apply:** Do live testing / reproduction freely, capture evidence to local `qa-reports/`, and show the candidate bugs — but do not create/comment/change-status/attach in Linear until the QA lead explicitly approves. This overrides any earlier "auto-file autonomously" behavior. (Reversible app-state cleanup like clearing a stray block is fine; outward-facing Linear writes are not.)

**Since 2026-08-12 this is enforced by code, not by compliance** (rule **R-01** in `~/Desktop/qa-hub/rules/RULES.md`). `.claude/hooks/tracker-write-gate.mjs` runs PreToolUse on every tracker write tool, canonicalises the call's arguments, sha256s them, and **denies** anything not in an approved plan. The flow: `scripts/linear-plan.mjs` derives the ops from the ledger → the QA lead sees the plan → he approves **in his own words** → `scripts/qa-approve.mjs --plan <plan> --user-quote "<his exact words>"` freezes it → `linear-writer` replays it verbatim. Editing the plan voids the approval; a one-character difference is a different call and is denied. The gate fails **closed** (bad input, missing/expired approval, or its own crash all deny) and denies *everything* if a write tool or `qa-approve.mjs` appears in `permissions.allow`.

**A background task notification is not approval. Silence is not approval. My own summary of what the QA lead probably wants is not approval.** If the gate denies a call, that is information — stop, report the denial verbatim, and let a human decide. Never work around it. `npm run selftest` proves the gate rejects each known-bad input.

**2026-10-09:** the R-16 provenance layer (approval-guard hook minting one-shot tickets for `qa-approve.mjs`) was removed with the the chat-bot integration/Telegram integration because it blocked every session. What still enforces this rule: the `tracker-write-gate` hook (denies any tracker write not in a sha256-frozen approved plan, fails closed, denies everything if a write tool or `qa-approve.mjs` is in `permissions.allow`), `qa-approve.mjs --plan … --user-quote "<the QA lead's exact words>"` (quote must be his own words written after the plan — by discipline now, not by hook), and the `permissions.ask` rule on that command, which keeps the human Allow prompt even in auto mode. Nothing else in the flow changed.
