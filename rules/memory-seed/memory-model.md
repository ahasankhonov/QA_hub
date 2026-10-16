---
name: memory-model
description: Where QA history/config live and the per-run read/append contract for the hub
metadata: 
  node_type: memory
  type: reference
  originSessionId: d07d1e3b-045b-4dd5-8cc1-51703c81f3d1
  modified: 2026-08-12T18:08:56.525Z
---

The hub's "memory" is explicit files (not just Claude auto-memory), because sub-agents don't inherit the main session's memory. Three layers:

- **Rules (behavior):** `~/Desktop/qa-hub/rules/RULES.md` is the **canonical** rules file (stable ids R-01…R-14, each with why/when/who) — this memory folder and `QA-AGENT-MASTER-PROMPT.md` echo it and must never contradict it. Several rules are now enforced by code (a PreToolUse write gate + validators, all runnable via `node scripts/qa-gates.mjs`, provable via `npm run selftest`); where prose and a gate disagree, the gate is right.
- **Config:** `~/Desktop/qa-hub/profiles/<slug>.json` (one per project, cached by the onboarder) — including `linear.stateMap`, `surfaces` (+ `forbidden` hosts) and `buildProbe`.
- **History (what was tested/found over time):** each project's `~/Desktop/qa-hub/projects/<slug>/qa-reports/` — everything lives **inside the hub** (see [[hub-self-contained-layout]]); the old `~/Desktop/<slug>_qa/` path was migrated away on 2026-07-17. `_SUMMARY.md` (current state, generated), `_LEDGER-<run>.json` (the machine record everything is generated from), `_HISTORY.md` (append-only run log), plus dated reports. Cross-project roll-up: `~/Desktop/qa-hub/reports/_PORTFOLIO.md`.

**Per-run memory contract (orchestrator enforces):**
1. At START: read `rules/RULES.md`, the project `profiles/<slug>.json`, and the project's `qa-reports/_SUMMARY.md` to load prior state. **Grep the archives, never open them** — `_HISTORY.md`, `_NEEDS-MANUAL.md` and the ledgers are 20–60k tokens each; `grep -n "<TICKET-ID>"` costs ~200.
2. DURING: write-through — every phase writes its file as results are produced, so a compact or a fresh chat loses nothing.
3. At END: `report-writer` appends a dated entry to `_HISTORY.md` (date, mode, build id, tickets touched, counts, new bugs, the ledger filename) and refreshes the project's row in `reports/_PORTFOLIO.md`. Update the profile if config changed.

This makes PRO/EPS/any-project history durable and queryable across sessions without relying on implicit memory.
