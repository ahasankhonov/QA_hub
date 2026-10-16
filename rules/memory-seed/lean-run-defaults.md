---
name: lean-run-defaults
description: "Default to the cheapest run mode that answers the ask — status-from-files, diff-aware re-tests, scope to what's named"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: fc43afa5-04d5-4727-83d5-4948e624070f
  modified: 2026-08-12T18:10:26.357Z
---

the QA lead wants QA-hub runs to be **smart and token-lean by default** — do the *least* work that answers the request.

**Correction (2026-08-04, measured — see [[qa-hub-token-cost-model]]):** the original "more agents cost MORE" line is wrong for *execution* work. A subagent's context is isolated and discarded; it returns ~300 tokens for work costing 10–60k internally. Doing that same work in the main thread at 700k context costs ~10x more. The rule that survives is **don't spawn agents you don't need** — but never hand-run execution in the main thread to "save" an agent.

**How to apply (orchestrator picks the cheapest mode that fits):**
- **Status / lookup questions** ("what's PRO-18's verdict?", "what's in Staging QA?", "last-known state of EPS?") → answer from cached files (`_SUMMARY.md` / `_HISTORY.md` / `profiles/<slug>.json`). **Do NOT launch the harness, executors, or the pipeline.**
- **Re-runs are diff-aware (default) — and since 2026-08-12 the diff is computed, not judged.** `node scripts/build-id.mjs <slug>` reads the deployed bundle id, then `scripts/run-plan.mjs` keys every carry-forward on `(ticket.updatedAt, buildId)`, prints the age of each carried verdict, refuses an empty queue, and **refuses to carry a verdict across a redeploy** — on 2026-08-12 the Alpha bundle changed mid-run with ~47 tickets already "tested" on code that was no longer deployed. A **full pass** is only for a first run or when the QA lead explicitly asks. See [[qa-hub-gates-and-rules]].
- **Scope to what's named.** If the QA lead names tickets ("re-test PRO-1, 12"), test only those. Don't fan out more executors than the scope needs.
- **Session hygiene beats agent count.** A long chat costs more every turn (accumulated conversation, not re-reading files). Recommend a **fresh session per heavy run** (state is on disk); reuse a session for light follow-ups. Reuse cached profiles + captured harness/quirk notes so runs start warm.

**Why:** the QA lead raised token spend repeatedly (2026-07-21) and asked to make the hub "smarter." The real levers are routing/caching/scoping, not a bigger agent fleet. Codified in README (§Run modes) and QA-AGENT-MASTER-PROMPT (§4 Scope, §13 Kickoff). See [[memory-model]], [[qa-evidence-consistency]].
