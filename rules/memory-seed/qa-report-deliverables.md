---
name: qa-report-deliverables
description: Every QA pass must report PASS/FAIL/BLOCKED/NEEDS-MANUAL counts and produce a Word (.docx) doc with fail explanations; Linear only after explicit approval
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 3577d459-cb5b-46f2-8260-7786c22daf76
  modified: 2026-08-12T18:10:12.684Z
---

Standing deliverable format for the end of any QA pass (any project, not just Alpha):

1. **A clear count breakdown** — how many tickets are PASS, FAIL, BLOCKED (genuine product/dependency block, not tooling), and NEEDS-MANUAL. Give this both per batch/part (for a phased run) and cumulative for the whole pass, surfaced directly in the chat reply, not just buried in a file.
2. **A Word (.docx) file containing the FAIL explanations** — the reasoning/evidence behind each FAIL/Reopen verdict (why it failed, repro, evidence), not just a status line. This matches the hub's existing Alpha practice (`Alpha-Reopen-Justification-*.docx`, `ALPHA-Reopen-Report-*.docx`, `Alpha-Needs-Manual-Guide-*.docx`) — treat that pattern as the standard for every project's report-writer output, not a one-off.
3. **Zero Linear writes without the QA lead's explicit approval** — reaffirms [[linear-write-approval]]; nothing here changes that gate.

**Why:** the QA lead restated this 2026-08-03 mid-run with "as always," signaling it's a standing expectation across the hub, not something to re-derive per project. report-writer should default to producing the docx + count summary on every pass without being asked each time.

**Since 2026-08-12 the counts and the docx are generated, not written** (R-11, see [[qa-hub-gates-and-rules]]): `_LEDGER-<run>.json` is the record, and `scripts/gen-counts.mjs` / `gen-summary.mjs` / `gen-docx.mjs` produce the numbers, `_SUMMARY.md` and the `.docx` from it. report-writer supplies only the prose. Never hand-type a count — that is how a ticket shipped as a FAIL while the record said PASS. If a generator refuses, the ledger is invalid: fix it, don't `--force`.

**Before filing, the QA lead reviews a Jira-view .docx** (`<Project>-Bugs-Jira-View-<run>.docx`, asked for 2026-10-07): one Jira-style card per bug (title, priority, platform, steps/expected/actual, related tickets, ≤3 labelled screenshots), generated counts, comments on existing tickets, coverage gaps; PII images excluded. After filing he wants **plain URL lists grouped by priority** to paste into Telegram (no markdown).
