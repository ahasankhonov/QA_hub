# QA Hub — the agency multi-agent QA system

One orchestrator ("brain") + specialist agents that can test **any** project you hand them (web / Android / iOS / API). Runs entirely on your Claude session — **no API keys**. Local harness (Playwright, Android SDK/emulator) + your authorized claude.ai connectors (Linear/Figma/Gmail).

**`rules/RULES.md` is the single source of truth**, and the rules that matter are enforced by code — a PreToolUse hook, the validators and a self-test — not by an agent remembering to comply. Where this README and a gate disagree, the gate is right and the README is a bug.

## How to use
1. Open a Claude Code session **in this folder** (`~/Desktop/qa-hub`) — that makes the agents below available.
2. Say what to QA, e.g.:
   - `Onboard and QA this: https://staging.example.com`
   - `QA the Epsilon project` (uses cached profile `profiles/epsilon.json`)
   - `QA this: ~/Downloads/app-release.apk` (a handed-over build; the hub copies it in under `projects/<slug>/`)
3. The orchestrator profiles the project, runs the pipeline, and comes back with **proposed** results. **Nothing is written to Linear until you approve — and now that is enforced, not promised** (see *The gates*).

## The agents (`.claude/agents/`)
| Agent | Job | Model |
|---|---|---|
| `qa-orchestrator` | Brain: dispatch, aggregate, hold the approval gate | opus |
| `project-onboarder` | Detect platform/stack, find the team+prefix, record states/surfaces/build probe, scaffold the harness → `profiles/<slug>.json` | sonnet |
| `ticket-intake` | Pull Staging-QA tickets → raw JSON + structured `ticket-spec` (Linear read only) | haiku |
| `requirements-analyst` | Understand the logic → executable `test-plan`, one surface per step | opus |
| `test-executor` | Drive the build via the project's harness module, record typed evidence | sonnet |
| `verifier` | Adjudicate per case, reproduce failures, dedupe → the ledger | opus |
| `report-writer` | The prose around the generated deliverables | haiku |
| `linear-writer` | Replays an approved, hash-frozen call plan — verbatim, no decisions | opus (haiku drifted on a 60-op replay, 2026-09-15) |

Tiers follow how much judgement each agent's *remaining* work needs. **Opus** where something is adjudicated (brain / analyst / verifier). **Sonnet** for driving the live build, and for the onboarder — a wrong host or a misspelled state name in a profile silently corrupts every later run. **Haiku** only where the work is now genuinely mechanical: intake parses, report-writer writes prose (the counts are generated), linear-writer replays a plan it did not author.

Pipeline: `onboarder → intake → analyst → executor → verifier → report-writer → (your approval) → linear-writer`.

## The gates (what stops a mistake, versus what merely discourages one)
| Gate | Enforces | Fails on |
|---|---|---|
| `.claude/hooks/tracker-write-gate.mjs` | **R-01** — no tracker write outside an approved, hash-frozen plan | any unapproved / edited / expired / replayed call |
| `scripts/intake-assert.mjs` | **H-1** — parsed TC+AC counts match the raw ticket body | a silently under-parsed ticket |
| `scripts/run-plan.mjs` | **R-06/R-07** — re-runs keyed on `(updatedAt, buildId)` | an empty queue, or a carry-forward across a redeploy |
| `scripts/run-result-validate.mjs` | **R-05/R-09** — typed evidence, the step's surface reconciled against the host actually hit | a claim with no evidence, or evidence from the wrong surface |
| `scripts/ledger-validate.mjs` | **R-11** — the verdict matches its own evidence; the route is derived, not authored | a hand-written `proposedState` that disagrees with the routing table |
| `.claude/hooks/doc-read-guard.mjs` | **R-17** — documents are read as markitdown Markdown, not raw | a raw `Read` of a `.pdf/.docx/.pptx/.xlsx/…` (denied with the `.md` path; fails open) |

Run them all at once: `node scripts/qa-gates.mjs --project <slug> --run <runId>`. It **names the gates it skipped** — a skipped gate is not a passed one.

**Prove they can fail:** `npm run selftest` feeds every gate a known-bad input (all checks) and fails loudly if any gate *accepts* one. It runs the gate checks in a throwaway sandbox; three end-to-end checks drive the installed hook under a SELFTEST run id and revoke it afterwards. Run it after touching a hook, a validator or a generator. A gate nobody has watched reject something is a decoration.

The write flow: `linear-plan.mjs` derives the ops from the ledger → you see the plan → you approve **in your own words** → `qa-approve.mjs --plan <plan> --user-quote "<your exact words>"` freezes it by sha256 → `linear-writer` replays it. Editing the plan afterwards voids the approval. The gate fails **closed** (bad input, missing approval, or its own crash all deny) and denies *everything* if it finds a tracker write tool or `qa-approve.mjs` pre-approved in `permissions.allow`.

The quote must be the user's own words, written after the plan; a settings `permissions.ask` rule on `qa-approve.mjs` keeps the human Allow/Deny prompt even in auto mode (rules/RULES.md **R-01**).

Jira (beta) has the same flow: `jira-plan.mjs` (ledger → transitions + comments), `jira-newbugs-plan.mjs` (bug drafts → creates, runId `<run>-NB`; severity Low → P4, Low-Medium → P3, an explicit draft `pLevel` wins), and `jira-comments-plan.mjs --drafts _COMMENTS-<run>.json --live _LIVE-<run>.json` (comments on tickets outside the ledger → comment ops only, runId `<run>-CM`; refuses WAF/R-10 bodies, keys not in the live pull or another project, transition fields, duplicate ids, empty bodies).

## Standing rules (enforced by every agent)
- **Never write to Linear without explicit approval** (R-01). Only `linear-writer` writes, only from an approved plan, only verbatim. A background notification is not approval; silence is not approval.
- **"The agent can't run this" is a claim to disprove (R-02)** — it needs a recorded probe naming the missing capability. Genuinely uncovered: real-device mic/camera/GPS/biometric/NFC, push on hardware, SMS, manual OAuth/CAPTCHA. **Covered, so not a valid deferral:** email (Gmail connector + `+alias`) and Alpha card payments (PAYGW UAT). A true can't-run case: **don't execute, don't change status** — stays in "Staging QA" + a comment with the reason and numbered manual repro steps → logged in `_NEEDS-MANUAL.md` **for you only**. Never Blocked, never a bug, never Slack.
- **Blocked** = a genuine product/dependency block, or an AC nobody can adjudicate — never a tooling limit.
- **Only fully verified tickets take the `pass` route** (R-04) — which state that is comes from the profile's `linear.stateMap` (Alpha: **Release Candidate**), never from an agent's memory of a board.
- **Everything countable is generated from the ledger (R-11)**, never typed by hand.
- **Everything stays inside the hub (R-03)** — `projects/<slug>/…`; never `~/Desktop/<slug>_qa/`.
- **Per-project safety (R-13):** Alpha is staging-only; prod shares the domain, S3, PAYGW, DocuSign and mail with it, and `harness/alpha/config.mjs` refuses a forbidden host at the URL level.

## Run modes — pick the cheapest that answers (default = lean)
The orchestrator does the *least* work that answers you. Say the mode, or let it infer:
- **Status / lookup** (cheapest) — "what's PRO-18's verdict?", "what's in Staging QA?" → answered from cached files (`_SUMMARY.md` / profile / `gen-counts.mjs`). **No pipeline, no browser.**
- **Scoped / diff-aware re-test** (default for re-runs) — name tickets ("re-test PRO-1, 12"), or `run-plan.mjs` selects only what changed since the last run. The diff is **computed**, keyed on `(updatedAt, buildId)`: a verdict from a superseded build is never carried forward.
- **Full pass** — every Staging-QA ticket (what a first run does). Most expensive.
- **Exploratory** — open-ended bug-hunt, on request.

**Token reality:** cost = context size × number of calls. At 700k context even a one-line Bash call re-pays 700k — an audit of 14 days of transcripts found **68% of all spend came from calls made above 400k context**, not from big reads. So: the main thread dispatches and never works; subagents burn their own context and return ~300 tokens; every phase writes its file to disk as it goes, so a compact or a fresh chat loses nothing. **Start a fresh session per heavy run**, one phase per session.

### Kickoff prompt (paste into a fresh session opened in `~/Desktop/qa-hub`)
```
You are my QA hub orchestrator (~/Desktop/qa-hub). Read rules/RULES.md first, then load
QA-AGENT-MASTER-PROMPT.md, the project profile, its _SUMMARY.md and reports/_PORTFOLIO.md.
Then QA <project> — <scope: "status only" | "re-test PRO-x,y" | "diff-aware re-test" | "full pass">.
Propose Linear moves; don't write until I approve.
```

## Files
- `rules/RULES.md` — **the canonical rules, with stable ids (R-01 … R-14)**, each carrying why it exists, when and who decided. Agents cite ids instead of restating rules; that is what keeps four documents from drifting apart.
- `QA-AGENT-MASTER-PROMPT.md` — the shared standard: how a run is actually performed.
- `qa-profile.schema.json` — the profile shape the onboarder emits.
- `profiles/` — cached per-project profiles, including each project's `stateMap`, `surfaces` (+ `forbidden`) and `buildProbe`.
- `projects/<slug>/` — each project's working folder & `qa-reports/`, kept INSIDE the hub (R-03).
- `harness/<slug>/` — the per-project harness module: login, navigation, the known UI quirks and the staging guard, written once as reusable functions. See `harness/README.md`; `harness/alpha/` is the worked example. Ticket scripts import it — they are not another throwaway `car18_07_v3.js`.
- `scripts/` — the gates, the generators and the preprocessing (below).
- `.claude/hooks/` — the tracker write gate.
- `reports/` — cross-project / portfolio reports.

## Scripts (`scripts/`)
**Gates & generators** — see the table above, plus `gen-counts.mjs` / `gen-summary.mjs` / `gen-docx.mjs`, which produce the headline numbers, `_SUMMARY.md` and the `.docx` **from the ledger**. If a generator refuses, the ledger is invalid: fix the ledger, don't `--force`, and never hand-edit generated output.

**Preprocessing (keeps runs token-lean)**
- **`render-figma.mjs`** — rasterizes Figma `.svg` exports to bounded PNGs cached in `<figma>/_rendered/`. **Agents read these PNGs, never the raw SVG** (a raw board is 5–30MB of XML ≈ millions of tokens; the PNG is ~1,600). Idempotent; Chrome fallback for giant multi-artboard boards.
  - `node scripts/render-figma.mjs` (auto-scans `projects/*/delivery_handoff/figma`) or `… <figma-dir>`.
- **`read-doc.mjs`** — **Reading documents (R-17).** Converts `.pdf .docx .pptx .xlsx .xls .epub .msg` to Markdown with Microsoft's [markitdown](https://github.com/microsoft/markitdown), cached beside the source in `_md/<name>.md`, re-made only when the source changes. Spreadsheets lose the `NaN`/`Unnamed: N` noise. Prints one line per document (path, size, a LARGE warning) — never the content unless `--print`. Read or grep the `.md`.
  - `node scripts/read-doc.mjs <file|dir> [--force] [--print] [--json]` · `npm run doc -- <file>`.
  - The `doc-read-guard` hook does this for you: a raw `Read` of a document is converted and denied with the `.md` path. A PDF `Read` with `pages` is allowed once the text exists (for figures or layout). Scanned or image-only documents fall back to the native Read.
  - **Page images:** `swift scripts/render-pdf.swift <file.pdf> <docs>/_rendered/<name> [width]` rasterizes every page with macOS PDFKit. Use it for a PDF the Read tool refuses (>100 MB) or an image-only PDF that read-doc marks EMPTY, then Read only the pages you need.
  - **Install / repair** (hub-local, no Homebrew or sudo needed):
    ```
    /usr/bin/python3 -m venv .tools/bootstrap && .tools/bootstrap/bin/pip install -q uv
    UV_PYTHON_INSTALL_DIR=$PWD/.tools/python .tools/bootstrap/bin/uv venv --python 3.12 .tools/markitdown
    .tools/bootstrap/bin/uv pip install --python .tools/markitdown/bin/python 'markitdown[pdf,docx,pptx,xlsx,xls,outlook]'
    ```
    Never add the `audio-transcription`/`youtube-transcription`/`all` extras: they send media to Google's speech API.
- **`downscale-screenshots.sh`** — optional disk/upload relief; caps screenshot long-edge (default 1600px). **Dry-run by default; `--apply` to act.** Token savings are marginal (the API resizes images anyway) — the real lever is *reading fewer* (the verifier reads ≤1 image per failing case).

See `QA-AGENT-MASTER-PROMPT.md` §14 (token discipline) and §15 (the gates).

## Cost note
Runs on your Claude session usage (not $ / API keys). Biggest savers, in order: **keep the main thread small** (dispatch, don't work), **never read raw design SVGs**, **read only failing-case screenshots**, grep the archives instead of opening them, model tiers, diff-aware re-tests, a fresh session per heavy run.
