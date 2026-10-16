---
name: qa-hub-token-cost-model
description: Measured cost model for QA-hub runs — spend = context size x API calls; 68% came from calls made above 400k context
metadata: 
  node_type: memory
  type: project
  originSessionId: e122aa8a-baba-4d11-8072-65a5a6c22f97
  modified: 2026-08-05T04:07:10.565Z
---

Audit of 15 qa-hub session transcripts covering 2026-07-21 → 2026-08-04 (the QA lead's weekly limit was
being exhausted in ~2 days). Ground truth from `message.usage` in
`~/.claude/projects/-Users-<you>-Desktop-qa-hub/*.jsonl`.

**Totals:** 4,723 API calls · 1.75B raw tokens (1.64B cache read, 100M cache write, 10.5M output)
≈ 342M cost-weighted, ~24M/day.

**The cost model: spend = context size × number of API calls.** At 700k context every later tool
call — even a one-line Bash — re-pays the whole context. 1,979 calls were made above 400k context
and those alone cost 1.18B tokens = **68% of everything**. Two sessions (`d7efad87` 1,268 calls @
740k median; `4bacc209` 651 calls @ 588k median, 969k peak) were 51% of the fortnight.

**What was NOT the cause** (so don't re-litigate these): images — only 42 read, ~59k tokens total,
the existing screenshot/SVG rules work. Big markdown reads amortized to 92M (~5%).

**Root enablers:** `model: opus[1m]` in `~/.claude/settings.json` let context grow to 970k instead
of compacting, and `effortLevel: xhigh` drove 2,221 output tok/call (15% of weighted spend).

**How to apply:** cap the context window rather than trusting discipline — `autoCompactWindow:
200000` in the hub's `.claude/settings.local.json`. Keep the main thread a dispatcher (measured:
subagents return ~300 tokens for work costing 10–60k in their own context). Grep archives instead
of opening them. One phase per chat. Full rules are in the hub's `CLAUDE.md` §Token discipline.

Corrects the "more agents cost more" line in [[lean-run-defaults]]. See [[token-lean-preprocessing]],
[[qa-verification-rigor]].
