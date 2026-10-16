# QA Hub — memory index

Standing rules (apply to every project the hub tests). `rules/RULES.md` is canonical (R-01…R-17); these files carry the lessons behind the rules.

- [agent-cannot-run-handling](agent-cannot-run-handling.md) — How to handle test cases the agent physically cannot run (real-device sensors, etc.)
- [android-emulator-dns-restart](android-emulator-dns-restart.md) — Android emulator "No internet connection" = empty net.dns1; fix is a cold restart with -dns-server, not runtime patching. Standing hub rule.
- [archives-append-only-never-write](archives-append-only-never-write.md) — Per-project archives (_NEEDS-MANUAL.md, _HISTORY.md, _LEDGER-*, _INTAKE-*) are append-only; never Write/overwrite them — the R14 report-writer destroyed the Alpha needs-manual archive on 2026-10-01 and it could not be recovered
- [auto-mode-classifier-denials](auto-mode-classifier-denials.md) — Auto-mode classifier denials are final (stop, report, never retry — it classifies Agent dispatches too). 2026-10-09: the QA lead wants auto mode everywhere with NO prompts; the VS Code initialPermissionMode=acceptEdits override (cause of the Allow-this-bash-command prompts) was removed so sessions fall back to global defaultMode auto.
- [docx-fail-sections-complete](docx-fail-sections-complete.md) — Every QA .docx must show, per failing case, the acceptance criterion not met, expected vs actual, why it fails, and numbered repro steps — gen-docx pulls Expected + steps from the analyst plan when the ledger lacks them (the QA lead 2026-10-09)
- [flow-test-ui-only-stop-on-blocker](flow-test-ui-only-stop-on-blocker.md) — E2E/deal-flow runs — every step via the real UI, never pass a step by API; report each blocker immediately with screenshots and pause the whole run until the QA lead fixes it
- [hub-self-contained-layout](hub-self-contained-layout.md) — Keep every QA project's files inside qa-hub/projects/<slug>/ — nothing needed outside the qa-hub folder
- [lean-run-defaults](lean-run-defaults.md) — Default to the cheapest run mode that answers the ask — status-from-files, diff-aware re-tests, scope to what's named
- [linear-connector-session-registry](linear-connector-session-registry.md) — claude.ai Linear connector authorized ≠ Linear MCP tools registered in a Claude Code session; how to detect and what does NOT work around it (2026-09-17)
- [linear-intake-verbatim-pull](linear-intake-verbatim-pull.md) — Haiku ticket-intake summarised the "verbatim" Linear raw file twice in Alpha R7 (2026-09-10) and H-1 cannot detect it; pull the raw with a sonnet agent that saves each tool result to disk + a script assembles it, then spot-check lengths against Linear.
- [linear-write-approval](linear-write-approval.md) — Always ask before writing anything to Linear (create/comment/status/attach) during testing
- [markitdown-doc-reading](markitdown-doc-reading.md) — Hub reads every .pdf/.docx/.pptx/.xlsx/.xls/.epub/.msg through Microsoft markitdown (R-17) — read-doc.mjs + doc-read-guard hook, hub-local install in .tools/, set up 2026-10-07 at the QA lead's request
- [memory-model](memory-model.md) — Where QA history/config live and the per-run read/append contract for the hub
- [qa-evidence-consistency](qa-evidence-consistency.md) — Keep per-ticket QA evidence on one consistent listing/actor; use a verifier agent to reproduce failed cases individually
- [qa-gmail-inbox](qa-gmail-inbox.md) — A connected Gmail (qa@your-company.example) is usable for QA signups + inbox/verification/receipt checks — unblocks email-gated flows
- [qa-hub-token-cost-model](qa-hub-token-cost-model.md) — Measured cost model for QA-hub runs — spend = context size x API calls; 68% came from calls made above 400k context
- [qa-orchestrator-stalls-large-runs](qa-orchestrator-stalls-large-runs.md) — qa-orchestrator stalls/dies on large fan-out runs — build deliverables directly from the write-through files instead of waiting on it.
- [qa-report-deliverables](qa-report-deliverables.md) — Every QA pass must report PASS/FAIL/BLOCKED/NEEDS-MANUAL counts and produce a Word (.docx) doc with fail explanations; Linear only after explicit approval
- [qa-ticket-comments-self-contained](qa-ticket-comments-self-contained.md) — Dev-facing Jira/Linear tickets + comments must explain the bug fully in prose; NEVER reference internal QA files (docx reports, screenshot filenames/paths)
- [qa-verification-rigor](qa-verification-rigor.md) — QA verdicts must be dev-comment-first + tested on the exact surface/current build; don't score deferred-scope/by-design as FAIL
- [slack-never-post-as-claude](slack-never-post-as-claude.md) — Never send Slack (or Teams/Telegram) messages on the QA lead's behalf through the connector — they appear as the Claude app, not as the QA lead; "do them for me" / "post them" means prepare copy-paste texts, the QA lead posts himself
- [token-lean-preprocessing](token-lean-preprocessing.md) — Standing token-economy rules for qa-hub — never read raw design SVGs, read only failing-case screenshots, model tiers, preprocessing scripts.
- [tracker-writer-verbatim-drift](tracker-writer-verbatim-drift.md) — haiku linear-writer cannot replay 1 kB+ comment bodies verbatim (retyped letters, swapped transition ids, unplanned op) — Jira replay 2026-09-15; use opus/sonnet for the writer and verify via .qa-approvals/<run>.applied.jsonl.

Per-project rules: add one file per project as you learn its quirks (safety boundaries, by-design rulings, harness gotchas) and list it here.
