---
name: docx-fail-sections-complete
description: Every QA .docx must show, per failing case, the acceptance criterion not met, expected vs actual, why it fails, and numbered repro steps — gen-docx pulls Expected + steps from the analyst plan when the ledger lacks them (the QA lead 2026-10-09)
metadata:
  type: feedback
---

the QA lead, 2026-10-09, after the first Gamma FE report: "when you create a doc file, make sure that you include repro steps and which part of the tickets is not met and why, so recreate it." The first `QA-Report-R-20261009-FE1.docx` listed the 3 failing cases with Actual + Where only — the ledger cases carry no `expected` / `repro`, so those lines were blank.

**Why:** The docx is what the QA lead reviews before anything is filed; a failure without the AC it breaks, the expected result, the reason and the steps cannot be judged or forwarded to a dev.

**How to apply:**
- `scripts/gen-docx.mjs` now renders per FAIL case: `Acceptance criterion not met` (ledger `acRef`, else plan), `Expected` (ledger, else plan case `expected`), `Actual`, `Why it fails` (ledger `whyNotMet` / `reason` / verifier `note`), `Where`, `Steps to reproduce` (ledger `repro`, else plan `precond` + `actions` + `verifyBy`). It finds the newest `_PLAN-*-<ticket>.json` in the reports dir, or `--plans-run <runId>`. A missing plan case prints a red "missing" line — fix the ledger or plan, never the docx by hand.
- Verifier: when a FAIL verdict's expected result differs from the plan's (sourced from a different doc), put the sourced expectation in the case `expected` and the reason in `whyNotMet`, so the docx does not show a plan line that contradicts the verdict.
- Related: [[qa-report-deliverables]], [[qa-ticket-comments-self-contained]].

**Update 2026-10-09, same day:** the QA lead: "your report looks like a machine reading, make it human readable, simple explanation, simple reasons." The AC/expected/why/steps lines pulled from the ledger and plan were raw evidence (selectors, ms timings, K-C refs). Fix: the verifier now also writes `_PLAIN-<run>.json` (per FAIL case: problem, ac, expected, actual, why, steps — plain words for a PM), `gen-docx.mjs` prints that block first, falls back to raw evidence marked in red, and the Outcome table uses human verdict words ("Fails — bug found", "Partly tested — some checks could not run yet", "Waiting on a product decision"). Rule: a QA document is written for a person who did not run the test; if a line only makes sense with the harness open, it does not belong in the docx.
