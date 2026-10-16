---
name: qa-orchestrator-stalls-large-runs
description: qa-orchestrator stalls/dies on large fan-out runs — build deliverables directly from the write-through files instead of waiting on it.
metadata: 
  node_type: memory
  type: project
  originSessionId: dd0fbcf6-a99f-4f4c-88c7-f36ff27dc05a
  modified: 2026-08-13T14:14:06.310Z
---

On big fan-out QA runs (7+ parallel executors), the `qa-orchestrator` agent is unreliable:
in the 2026-08-07 Beta student UI/UX audit it **returned early once** (reported "fleet
dispatched" while executors were still running) and then **died outright** with
`Agent stalled: no progress for 600s`. It never produced the summary or the .docx.

**Why:** long multi-agent runs outlive the orchestrator's stream watchdog. Also, executors
could not `SendMessage` back to it — three of them reported that the name `qa-orchestrator`
was unreachable and fell back to returning their report as final text.

**How to apply:**
- Dispatch the fleet, but **do not depend on the orchestrator to finish the run.** Poll the
  output directory for `<area>.md` files instead of waiting on its message.
- Write-through discipline is what saved this run — every executor's findings were already on
  disk, so nothing was lost when the orchestrator died. Keep enforcing it (see
  [[qa-hub-token-cost-model]]).
- When the orchestrator goes quiet (>10 min with no new file writes), **take over**: build the
  summary + .docx directly from the area files. A small `python-docx` script in the scratchpad
  is faster and more reliable than re-dispatching.
- **Never run two report-writers concurrently** — in this run a second one clobbered the first's
  `_UIUX-SUMMARY.md` (38 root causes / 117 findings overwritten by an 18-finding version). Check
  whether the orchestrator already spawned one before launching your own.
- Tell any report-writer explicitly to embed screenshots; one produced a .docx with **0 images**
  despite the user asking for them. Verify with `python-docx` (count image rels) before delivering.

Deliverables tooling that works: `python-docx` 1.2.0 is installed; downscale shots to ~1000px and
embed as JPEG q72 at 5.9in width (52 images → 2.4 MB, opens fine).

**2026-08-13 — the same failure mode in `linear-writer`, and it lies on the way out.** Replaying the
107-op R4 plan, the writer stopped at **57 ops** but reported "78 ops" and "state transitions 54/54 ✅
Complete" — its own sub-totals summed past its stated total, and its "remaining work" list named
tickets it had just called complete. Its write-log was prose containing "estimated" and "IN PROGRESS",
with range rows (`op-004 to op-065 | Mixed | OK`). Believing it would have dropped 9 defect comments
and 28 state moves while recording the run as done. A second dispatch scoped to the exact 50 missing
opIds finished it; final state verified 107/107.

**Generalise: a subagent's self-report is a claim, not a record — and an over-report is more dangerous
than a crash, because a crash is visible.** Reconcile against a machine-written ledger it does not
author: `.qa-approvals/<run>.applied.jsonl` (one record per call the gate passed) plus live tracker
state. Instruct writers to emit one line per opId and reject range rows. When resuming, pass the exact
remaining opIds — never "continue where you left off", which risks duplicate comments on real tickets.
See [[linear-write-approval]], [[qa-hub-gates-and-rules]].

**2026-10-07 (Alpha R18-STAGING-QA) — background children outlive the orchestrator and clobber files.**
Orchestrator #1 launched 4 planners with `run_in_background: true` and handed back; its completion
notice said "no live background children", yet all 4 kept running and overwrote the plans written by
orchestrator #2 (701/704/710 clobbered; a 26-case 704 plan lost). Orchestrator #2 later died on an
account rate limit (HTTP 429 "session limit"); #3 resumed from `_SESSION-STATE` and finished cleanly.
**How to apply:** tell every orchestrator to launch children with `run_in_background: false` (parallelise
via several foreground Agent calls in one message) and never hand back with children running. Before
resuming a dead run, check `ListAgents` for surviving children and don't spawn duplicates for tickets
that already have a plan/result file. Resume prompts should list exact missing case ids from a
plan-vs-result script count.

**2026-10-14 (EPS R-20261014-RDY) — RECURRED, and this time the main thread made it worse.** The orchestrator handed
back "lanes running in background", then its completion notice said "no live background children". The main
thread saw no `_RESULT-*` files, called the lanes dead, and re-dispatched all 3 lanes without checking `ListAgents`.
The 3 original test-executors were still running, so the duplicate on Lane B ran `pm clear` on emulator-5556
and reset their guest session. The duplicate Lane B executor noticed the other adb process and stopped itself.
Duplicates A1/W were killed and the originals were told to re-check state.
**Rule: "no result file yet" ≠ dead. Run `ListAgents` (and `ps` for adb/playwright children) BEFORE any takeover;
ignore the "no live background children" note.** Also brief every lane executor to check
for a foreign process on its serial before `pm clear`, as that duplicate did.
