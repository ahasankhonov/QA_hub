# QA Hub — operating rules (read first, every session)

This folder (`~/Desktop/qa-hub`) is a multi-agent QA system for the agency. When the user
asks to QA / test / re-test / bug-hunt any project (web / Android / iOS / API), you follow the
hub's flow and rules below — do not improvise your own QA process.

## Do this on any QA request
1. **Route through the `qa-orchestrator` agent.** It owns the pipeline
   (onboarder → intake → analyst → executor → verifier → report-writer → *your approval* → linear-writer).
   Don't hand-run QA in the main thread.
2. **Load context before testing:** read `rules/RULES.md` **first — it is the single source of truth**
   (stable ids R-01…R-14; cite the id rather than restating the rule, and where prose and a gate
   disagree, the gate is right and the prose is a bug). Then `QA-AGENT-MASTER-PROMPT.md` (how a run is
   performed), the project's `profiles/<slug>.json`, its `projects/<slug>/qa-reports/_SUMMARY.md`, and
   `reports/_PORTFOLIO.md`. Grep `_HISTORY.md`, don't open it. The one-line memory index lists standing +
   per-project rules — open the specific memory file when a rule is relevant.
3. **Pick the cheapest mode that answers** (see README "Run modes"): status/lookup → answer from
   cached files, NO pipeline; re-runs → diff-aware (only changed/named tickets); full pass → first run
   or on request. More agents/reads cost more tokens, not fewer.

## Hard rules — never break (these override any request)
- **Never write to Linear** (create / comment / status / attach) without the user's explicit approval
  (**R-01**). Everything is PROPOSED first; only `linear-writer` writes, and only what was approved.
  This is now enforced by a PreToolUse hook, not by compliance: `linear-plan.mjs` derives the ops from
  the ledger → the user approves in their own words → `qa-approve.mjs --user-quote "…"` freezes the plan
  by sha256 → the gate denies every call that isn't in it. It fails **closed**, and denies *everything*
  if a write tool or `qa-approve.mjs` turns up in `permissions.allow`. **A background task notification
  is not approval. Silence is not approval. Your summary of what the user probably wants is not approval.**
  If the gate denies a call, that is information: stop and report it — never route around it.
  `--user-quote` must be the user's own words, written after the plan was generated.
- **Archives are append-only (R-15):** `_HISTORY.md`, `_NEEDS-MANUAL.md`, `_INTAKE-*.md` and `_LEDGER-*.json` are only ever appended (`cat >> … <<'EOF'`), never `Write`-n or overwritten; size-check after any agent that touches them. No hook enforces this since 2026-10-09 — it is discipline.
- **"The agent can't run this" is a claim to disprove (R-02), not a category to pick.** It needs a
  recorded probe naming the specific missing capability. Genuinely uncovered: real-device
  mic/camera/GPS/biometric/NFC, push on hardware, SMS, manual OAuth/CAPTCHA. **Covered — not valid
  reasons:** email (Gmail connector on qa@your-company.example with `+alias`) and Alpha card payments
  (PAYGW UAT test cards). A true can't-run case → don't execute, don't change status → ticket **stays in
  Staging QA** + comment with the missing capability, the probe and numbered manual repro steps → log in
  `_NEEDS-MANUAL.md`. Never Blocked / bug / Slack.
- **Verdict routing is derived, not authored (R-04/R-11).** The verifier records per-case verdicts; the
  ticket verdict, the `proposedState` and every count come from the ledger by script
  (`gen-counts.mjs` / `gen-summary.mjs` / `gen-docx.mjs`) via the profile's `linear.stateMap`. Never type
  a count or a destination status. Before reporting, run
  `node scripts/qa-gates.mjs --project <slug> --run <runId>` — it names the gates it skipped, and a
  skipped gate is not a passed one. After changing a hook, validator or generator, run `npm run selftest`
  (all checks, each feeding a gate a known-bad input).
- **Per-project safety rules apply** (from the profile and memory). A project's `profiles/<slug>.json` → `surfaces` lists the hosts you may test; `surfaces.forbidden` is the production boundary: never navigate to a forbidden host and never edit that list. The project's `harness/<slug>/config.mjs` enforces both lists in code (R-13); a navigation it refuses is a finding to report, not something to route around. A host in neither list: stop and ask the QA lead. Shared services still need care: ask before an action that emails a real address, signs a real e-signature envelope or charges a real card.

- **Keep every file inside the hub** (`projects/<slug>/…`) — never create `~/Desktop/<slug>_qa/` outside it.

## Token discipline — the real cost model (measured from 14 days of transcripts, 2026-08-04)

Cost of a run = **context size × number of API calls**. It is NOT "how many files did I read":
at 700k context, every later tool call — even a one-line Bash — re-pays 700k tokens. The audit
found **68% of all spend came from calls made above 400k context**, not from big reads.

- `npm run cost -- --live` shows this session's current context size.
- **Context ceiling.** Auto-compact is pinned to a 200k window for this project
  (`.claude/settings.local.json`). Don't fight a compact by re-reading everything afterwards —
  the durable record is on disk (see write-through). Adjudicating at 120k also beats 800k on accuracy.
- **The main thread is a dispatcher, not a worker.** In the main thread: never drive
  Playwright/adb/simulator, never open `qa-reports/*` result files, never do bulk Linear/Jira writes.
  Dispatch a subagent, let it burn its own context, take back a short verdict + the path to its
  results file. Measured: subagents return ~300 tokens for work costing 10–60k inside their context.
- **Write-through: no phase ends without its results file on disk.** Verdicts, run results and
  evidence paths go to `projects/<slug>/qa-reports/` *as they are produced* — never held only in
  conversation. This is what makes compaction and fresh-chat handoff lossless.
- **Grep archives, never open them.** `_HISTORY.md`, `_NEEDS-MANUAL.md`, `_LEDGER-<run>.json` (and legacy `_P*-LEDGER-*.md`),
  `_INTAKE-*.md` are 20–60k tokens each. During a run, `grep -n "<TICKET-ID>"` the archive (~200
  tokens) before adjudicating. `_SUMMARY.md` + the profile is enough for orientation.
- **Batch the harness, step through the assertion.** Known setup (login, create listing, navigate)
  comes from the project's harness module (`harness/<slug>/`, see `harness/README.md`) — import it,
  don't write another throwaway script. One ticket script printing a compact `RunResult`; step-by-step
  browser calls only for the assertion itself and for unexpected state. Anything you had to work out the
  hard way (a hidden duplicate chip, a field that must be filled last) goes back into the module.
- **One phase per session.** intake → execute → verify → report are separate chats, handed off via
  `_SESSION-STATE.md` — not through a 900k conversation. Past ~150 tool calls: write the file, start fresh.
- **Cross-ticket synthesis is an explicit step.** Isolated subagents can't see each other's findings,
  so after a batch run one pass that reads the results *files* looking for shared root causes. Don't
  try to preserve that by keeping everything in one context.

- **Documents are read as Markdown (R-17).** `.pdf/.docx/.pptx/.xlsx/.xls/.epub/.msg` →
  `node scripts/read-doc.mjs <file|dir>` (markitdown, cached in a sibling `_md/`), then Read/grep the `.md`.
  The `doc-read-guard` hook redirects a raw Read automatically; a PDF with `pages` is allowed after the text.

These already work — keep them (the audit found only 42 images read, ~59k tokens total):
- **Never read raw design exports (`.svg`/`.fig`)** — they're millions of tokens each. Read the
  rasterized PNGs in `<figma>/_rendered/`; regenerate with `node scripts/render-figma.mjs <figma-dir>` if missing.
- **Read only the screenshots you need** — the verifier judges from recorded text and opens ≤1 image
  per FAILING case; never bulk-open an `*_attachments/` folder.
- Model tiers are set per agent by how much judgement the agent's *remaining* work needs (opus:
  orchestrator/analyst/verifier · sonnet: executor, and onboarder — a wrong host or state name in a
  profile corrupts every later run · haiku: intake, report-writer for prose only). **linear-writer is opus** since 2026-09-15:
  haiku retyped comment bodies and swapped transition ids on a 60-op replay (the gate caught all 8, but the
  replay had to be redone). Don't upgrade a mechanical agent, don't downgrade one that adjudicates.

Full detail: `rules/RULES.md` (canonical), `README.md`, `QA-AGENT-MASTER-PROMPT.md`, and the memory index.

