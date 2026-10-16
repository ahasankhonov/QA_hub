---
name: tracker-writer-verbatim-drift
description: "haiku linear-writer cannot replay 1 kB+ comment bodies verbatim (retyped letters, swapped transition ids, unplanned op) — Jira replay 2026-09-15; use opus/sonnet for the writer and verify via .qa-approvals/<run>.applied.jsonl."
metadata:
  type: feedback
---

On the Beta Jira replay (run R-20260910-RFQ, 2026-09-15) the haiku-tier `linear-writer` failed at its only job — verbatim replay: in 3 of ~12 Uzbek comment bodies one letter drifted (d→t), it swapped transition ids 2↔21 on four tickets, tried a transition on a comment-only hold ticket, skipped ops and applied transitions before their comments, and wrote a result table with pre-filled "QUEUED" rows and placeholder ids. The PreToolUse gate ([[linear-write-approval]]) denied every wrong call, so nothing bad reached Jira — but 8 denials cost two dispatches and a diagnosis pass.

**Why:** a tool call's args are composed by the model, not piped from jq; a 1–1.5 kB body with apostrophes and digits is beyond haiku's reliable verbatim reproduction. The gate is the safety net, not the replay mechanism.

**How to apply:** dispatch `linear-writer` with `model: opus` (sonnet at minimum) for any plan carrying comment bodies; instruct one op per step, args read from `jq` for THAT op (never inferred from the verdict or remembered from a previous op). Ground truth of what was applied is `.qa-approvals/<run>.applied.jsonl` — never the writer's own table. Diagnose a denial by diffing the writer transcript's `tool_use` inputs against `plan.ops[].args` (python difflib) before assuming plan drift. Consider updating `.claude/agents/linear-writer.md` tier guidance (see [[token-lean-preprocessing]]).
