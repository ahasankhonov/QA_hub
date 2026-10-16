# Ideas taken from public repos

One entry per repo that was mined. Add a new entry at the bottom for each repo and don't rewrite old ones.

**The filter:** take an idea only if it fixes a gap or a failure we have actually recorded (a brain
failure page, a memory, a false FAIL or a lost run). "Nice to have" is a rejection. Every idea taken
needs a selftest check that feeds it a known-bad input. Every idea rejected gets one line saying why,
so the same idea isn't weighed twice.

Why the filter exists: on 2026-10-09 a guard hook added "for safety" on every Bash/Write/Edit call made
the hub unusable and had to be torn out. Adding things costs something too.

---

## vostride/agent-qa (read 2026-10-16)

- **What it is:** an LLM-driven QA runner (planner → executor → verifier loop) for web, plus an action
  cache, a memory curator, ablation and triage skills. TypeScript monorepo.
- **License:** FSL-1.1. Internal use and client professional services are allowed. Reselling it as a
  competing product is not. Nothing was copied verbatim: each idea was rewritten for our corpus and
  conventions, and every file credits the source.
- **Not trialled:** the npm package was not installed or run (the QA lead, 2026-10-16: "i dont need trial").

### Taken

| Idea | Their source | Where it lives now | Gap it fixes |
|---|---|---|---|
| Prompt-injection scan of untrusted text (flag, never block) | `packages/core/src/memory/security-scanner.ts` | `lib/text-threats.mjs` → WARN in `scripts/intake-assert.mjs` (title/body/comments) and `lib/doc-convert.mjs` `describe()` (so read-doc and the doc-read-guard hook both show it) | Client ticket and document text goes into agent prompts word for word and nothing checked it. Patterns were narrowed until they had 0 hits on all 1293 existing raw pulls and `_md/` files. |
| Page-readiness wait | `packages/web/src/smart-wait.ts` | `harness/lib/page.mjs` `waitForPageReady()`, `capture({ ready })` | Only Alpha had a settle(). Captures taken while a spinner was still up produced timing-shaped false FAILs. Ours counts only *visible* loaders and ignores infinite animations, because theirs always waited the full timeout on both. |
| Text outline of the visible page | `packages/web/src/dom-extractor.ts` | `harness/lib/page.mjs` `pageOutline()`, `capture({ outline })`, recorded automatically when a selector misses | "Selector did not resolve" told us nothing about what WAS on screen, and the verifier had to open a screenshot (~1600 tokens) to find out. The outline is ≤750 tokens. |
| Failure taxonomy | `skills/agent-qa-result-triage/references/triage-categories.md` | `harness/lib/evidence.mjs` `classifyFailure()` → `failureClass` on every thrown case → validator WARN | Harness, browser or network failures were being adjudicated as product bugs. An R-13 guard refusal now reads as "report the link", not as a bug. |
| Lesson trust scores (start 0.5, +0.02 helped, −0.05 wrong) | `packages/core/src/memory/curator.ts` | `scripts/brain-recall.mjs` `--outcome` / `--trust`, log `reports/_BRAIN-TRUST.jsonl` (append-only, kept out of the vault) | Brain lessons were injected with no record of whether they helped. A stale lesson and one that keeps getting ignored looked the same. `--trust` names the fix: rewrite it, build a gate for it, or fix its keywords. |
| Ablation, cut down | `packages/core/src/memory/ablation.ts` | the `injected` events plus the `missed` outcome in the same trust log | A lesson injected and still missed twice means text alone isn't enough and it needs a gate. Rerunning a QA case without its dossier can't be done mechanically, so the full A/B wasn't taken. |

Selftest: `scripts/selftest/repo-ideas.mjs`, 10 checks. Each "it warns" check is paired with one proving
that normal text stays quiet.

### Rejected

- **LLM screenshot verdicts.** The verdict comes from typed evidence and the ledger by script (R-04/R-11).
  An image-judged PASS is the exact failure R-09 exists to stop.
- **Self-healing selectors during ticket QA.** A selector that quietly heals can test a different element.
  The hub reports the miss instead, now with an outline of what was there.
- **Action cache (stepHash + screenHash, 7-day TTL).** Our setup is already code (`harness/<slug>/`, R-14),
  so there's nothing to replay. A cached step on a new build would hide exactly the change being tested.
- **Their accessibility checks.** They conflict with the Beta no-a11y rule, and no other project asked for them.
- **The planner/executor loop itself.** The hub's pipeline (analyst → executor → verifier) already
  separates these, and our gates assume it.
- **`you are now` and bare `agent should send` patterns.** Our tickets say both all the time
  ("you are now logged in", the Alpha agent role, Epsilon's "AI should send").

### Agent prompts (done 2026-10-16, after the QA lead's "go")

- `.claude/agents/verifier.md`: read `evidence.outline` before any screenshot; a non-assertion
  `failureClass` means rerun, not FAIL; `guard_refused` means report the link (R-13); a loader still in
  `pageReady.pending` means re-capture.
- `.claude/agents/qa-orchestrator.md`: every hand-back lists `Brain outcomes`, and the main thread
  records each one with `brain-recall.mjs --outcome`.
- The staged node-graph promote anchors are untouched (`promote.py --check` still applies cleanly).

---

## petrkindlmann/qa-skills (read 2026-10-16)

- **What it is:** 40-odd Claude skills for QA: test-case management, AI test generation,
  risk-based testing, Playwright automation, selector drift, reliability, email/payment/mobile
  testing, bug reproduction. Markdown references plus a few scripts.
- **License:** MIT, so copying is allowed with credit. Each file that took something says so.
  Everything was rewritten for our plan schema and harness anyway.
- **Asked for:** "be smart on writing test cases and automation". Test-case design was read in the
  main thread. A background agent mined the automation skills (read-only), and its claims about our
  harness were checked against the code before anything was built.
- **Calibrated on our corpus:** 305 plans (2,168 cases).
  - Expected results are already concrete: 19 vague, 16 missing.
  - 107 runnable cases have neither `verifyBy` nor `evidence`.
  - 27 plans with 3+ cases have no negative case.
  - Of 599 cases that write data, 311 check that the write stuck.

### Taken

| Idea | Their source | Where it lives now | Gap it fixes |
|---|---|---|---|
| Plan linter (ambiguous step, non-observable expected, unbounded wait, vague data, expected restating the action) | `test-case-management/references/linting.md` | `scripts/plan-lint.mjs` → a `plan lint` gate in `qa-gates.mjs`, added only when the run has plans | Plans went to the executor unchecked. Errors (no expected result, missing or duplicate caseId) fail the gate; design gaps only warn. On the 302 plans it raises 14 errors, all in 2 August plans, and 125 warnings. |
| Every rule gets a negative case; a write gets a persistence oracle; explicit vs implied requirements | `ai-test-generation/SKILL.md` + `references/prompt-patterns.md` | plan-lint warnings `no-negative-case`, `mutating-no-persistence`, `implied-no-question`; analyst step 4 | 27 plans had no negative case. Half of all writes were never read back. An unwritten expectation could still become a Reopen. |
| BOUNDARIES edge kinds and state-transition heuristics, chosen per feature | `ai-test-generation/references/prompt-patterns.md`, `exploratory-testing/references/heuristics-and-automation.md` | `requirements-analyst.md` step 4 ("only the kinds that apply, never pad") | Edge cases were a single "note variations" line. |
| Depth follows risk (impact × likelihood) | `risk-based-testing/SKILL.md` | analyst step 4 | Without it the checklist would inflate every plan. |
| Oracle that names what must NOT happen | `agentic-browser-testing/SKILL.md` | plan field `forbidden` (analyst); executor captures that it is absent | "No error shown" counted as a PASS. |
| Implied-basis FAIL goes to PM | `ai-test-generation` [IMP] tag | `verifier.md` step 3 → `scopeQuestion` / `PASS_SCOPE` | `qa-verification-rigor`: false fails from requirements nobody wrote down. |
| Act only on a unique match; record the match count | `selector-drift-recovery/SKILL.md`, `references/recovery-scripts.md` | `harness/lib/page.mjs` `clickUnique()`, `visibleMatches()`; `capture()` → `matchCount` → run-result-validate WARN | `capture()` silently read `.first()`. Alpha's hidden duplicate chip and evidence from the wrong listing (`qa-evidence-consistency`) happened exactly this way. |
| Result writer refuses to overwrite | `playwright-automation/references/auth-patterns.md` (one file per worker) | `RunResult` constructor (`harness/lib/evidence.mjs`) | Brain failure "run-id env default overwrote prior run result". The fix existed only in the Gamma harness; 422 scripts use the shared class. |
| Re-read the form after filling it | `playwright-automation/references/anti-patterns.md` (closest) | `page.mjs` `fillAndConfirm()` | Alpha "this field must be filled last" (`alpha-sell-listing-harness`). |
| Assert the href, don't click | `playwright-automation/references/selector-strategies.md` | `page.mjs` `assertLinkHost()` | Beta banners and legal rows opened production (`beta-ios-prod-host-leaks`). |
| Assert test mode before typing a card | `payment-testing/SKILL.md` | `harness/alpha/payment.mjs`: the card goes only into `*.uat.payments.example` frames | R-13: PAYGW `.com` is production. Before this, only `field=` in the frame URL was checked. |
| Email search scoped to the run's alias and start time | `email-testing/SKILL.md` | analyst step 4 | "Newest message" can be a previous run's mail. |
| Cheap simulator/emulator probes before R-02 | `mobile-testing/references/mobile-patterns.md` | analyst step 4 (`simctl privacy/push/location`, `adb emu geo fix`, airplane mode, deep link) | `agent-over-deferral-to-needs-manual`. |

Selftest: `scripts/selftest/qa-skills-ideas.mjs`, 8 checks. The page helpers run against a fake page
in a child process. Total after this repo: 351 OK.

### Rejected

- **One assertion per step.** Our case is one AC with several observable facts; splitting them
  would multiply cases without catching anything new.
- **Confidence-scored selector healing, quarantine, retries-as-a-fix, CI.** Self-healing was already
  rejected (agent-qa entry). The others are suite-maintenance tools, and we run tickets.
- **`route.fulfill` / HAR mocking, `page.clock`.** They mock or freeze the app under test. On staging
  that hides the behaviour we are paid to see.
- **Environment-aware diagnosis (health probe → `backend_down` / `build_changed`).** Mostly covered
  by `failureClass` plus the R-06 build id. Revisit if a backend outage is ever adjudicated as a FAIL.
- **`attempts[]` on probes / a not-reproducible table.** `rec.probe()` already demands
  attempted / failureMode / missingCapability, and the validator rejects category names.
- **`actAndAwait` (waitForResponse before the click).** `capture({ apiUrlIncludes })` already records
  the backing call. Not worth a second way.
- **ARIA snapshot evidence, cut-one-step repro minimisation, AJV schema checks.** Overlap with
  `pageOutline`, cost tokens per FAIL, or only matter for API-only projects. Maybe later, not now.
- **Filler-phrase blocklist for reports.** The comment-length rule and the plain-language sidecar
  already shape the prose, and nothing recorded points at filler words.
- **Their 5×5 risk heatmap as a document.** Only the sizing rule was taken.

### Agent prompts (done 2026-10-16, same session)

- `requirements-analyst.md` step 4: the test-design checklist. Step 5: run `plan-lint` before
  hand-back. The output schema gains `basis`, `acRef`, `forbidden` and `mutating`.
- `test-executor.md`: "One element, the right element" (the helpers above and the RunResult refusal).
- `verifier.md` step 3: check `matchCount` > 1; an implied-basis FAIL becomes a scope question.
- The node-graph promote anchors are untouched (`promote.py --check` still applies cleanly).

---

## LambdaTest/agent-skills (read 2026-10-16)

- **What it is:** skills for LambdaTest's paid cloud (the `kane-cli` browser agent, HyperExecute,
  SmartUI, a device grid), plus about 45 generic per-framework tutorials. The useful parts are the
  `ready-check` skill and `kanecli-skill/references/objectives-cookbook.md` (how to word a test step).
- **License:** MIT ("Copyright (c) 2025 TestMu AI / LambdaTest"). Each file that took something says so.
- **Not trialled:** nothing from the repo was installed or run. The clone stayed in the scratchpad.
- **Calibrated on our corpus:** the 3 new lint rules give 0 hits on our 302 plans (1,949 runnable cases).
  The analyst already writes good expected results (median 126 chars). These rules catch the cookbook's
  bad examples and stop them from creeping in. Live preflight: alpha, zeta, beta and
  epsilon READY. gamma NOT READY: the `legacy` surface returns 503 (Netlify password protection
  is on, but SITE_AUTH_USER/PASSWORD are not set).

### Taken

| Idea | Their source | Where it lives here | Gap it fixes |
|---|---|---|---|
| Preflight ready card: read-only, STOP vs WARN, runs before anything is dispatched | `ready-check` skill | `scripts/preflight.mjs` (gate config, build file, surfaces answer without following redirects and never touch `forbidden`, emulator DNS ping + app installed, booted simulator + `codesign` flags, Jira `/myself`, ToolSearch reminder for connectors) → `_PREFLIGHT-<run>.json` → `qa-gates.mjs` fails while a STOP is on record; orchestrator runs it after `build-id` | Emulator "No internet" (`android-emulator-dns-restart`); Beta build 27 linker-signed → Keychain -34018; Jira token rejected mid-run 2026-09-10 and 2026-10-05; tracker gate locked by a write tool in `permissions.allow`; Linear connector not registered |
| Failed backend calls in every capture | evidence-pack "network failures" section | `harness/lib/evidence.mjs` `failedCallsSince()` → `capture()` `failedCalls` (≤5, 5xx first, no telemetry or documents, response message kept) → `run-result-validate` WARN when the expected does not name the status → `verifier.md` step 3 | The recorder already kept 4xx/5xx with their bodies, and `capture()` dropped them. R-14 asks for the response message. On 2026-08-12 a "Deal not found" screen was escalated as a possible P0 before anyone looked at the request behind it. |
| Lint: expected only asserts the trigger | cookbook §1.1 "don't assert the trigger" | `plan-lint.mjs` `asserts-trigger` | "Submit button is visible" fails exactly when the submit worked |
| Lint: "confirm" / "click OK" used as the check | cookbook §1.1 | `plan-lint.mjs` `confirm-as-check` | A click is an action; it proves nothing |
| Lint: a check that needs its own navigation | cookbook §1.1 "a look, not a trip" | `plan-lint.mjs` `check-needs-navigation` (on `expected` only; on `verifyBy` it false-fired on "confirmed in the recorded network list") | The route belongs in the actions so the executor records it |
| Simulator Face ID / Touch ID is fakeable | device-cloud biometric docs | `requirements-analyst.md` step 4 cheap probes (Appium `enrollBiometric` / `sendBiometricMatch`, or headless `notifyutil -p com.apple.BiometricKit_Sim.pearl.match`) | CLAUDE.md lists biometrics as uncovered; that is true only on a real device (R-02) |

Not built: a per-project test-data check (Gamma had 0 datasets on Railway). No generic probe exists
for it, so it waits for a per-profile hook if it recurs.

Selftest: `scripts/selftest/lambdatest-ideas.mjs`, 8 checks. Preflight runs with fake exec/fetch in a
child process: no network, adb or Simulator. The checks also prove that the Jira token never reaches
the output. Total after this repo: 359 OK.

### Rejected

- **kane-cli, HyperExecute, SmartUI, the TestMu grid:** these are LambdaTest's paid cloud. We run
  headless browsers locally against staging.
- **"Never write test cases by hand, use kane-cli":** product pitch. The analyst checklist, `acRef`,
  scope questions and the H-1 coverage gate already link tests to requirements.
- **Evidence packs (a zip plus a web viewer):** the typed JSON and the ledger drive the verdicts, and a
  viewer adds nothing to them.
- **The ~45 per-framework skills (Selenium, Cypress, pytest, Behat, …):** generic tutorials. Our stack
  is Playwright, adb and simctl, and the harness already holds what we have learned.
- **Playwright flaky-test fixes:** covered by `pageReady`, the rerun rule for non-assertion failures
  and `clickUnique`. Mocking and freezing the clock were rejected last round.
- **API design, SDK generation, compliance and monitoring skills:** for building APIs, not for testing
  tickets.
- **Accessibility:** conflicts with the Beta no-a11y rule (also rejected for agent-qa).
- **Framework migration, CI pipelines:** we test tickets; we don't maintain a suite.
- **Their `evals/*.json`:** keyword lists per prompt, weaker than a selftest that feeds each gate a
  known-bad input.

### Agent prompts (done 2026-10-16, same session)

- `qa-orchestrator.md` "The run": preflight after `build-id`, scoped with `--surfaces`/`--platforms`;
  a STOP halts dispatch; run its `next` lines.
- `requirements-analyst.md` step 4: the simulator biometrics line.
- `test-executor.md` step 4: `failedCalls`, and one assertion capture per case.
- `verifier.md` step 3: check `failedCalls` before keeping a PASS.

## denfry/claude-skills (read 2026-10-16) — ANALYSIS ONLY, awaiting the QA lead's go

**What it is:** one skill, `token-efficiency` (MIT, commit cc73299, 22 files). Prose rules (SKILL.md §1–7 + an 8-line CORE.md), 4 Python hooks (per-turn contract injection, PostToolUse waste guard, Stop usage report, SessionStart `context_budget.py`), and an A/B word-count eval.

**Measured on this hub's transcripts while reading it (2026-10-16):**
- Main thread: the first call of a session already carries 56–62k tokens (last 15 sessions, oldest→newest +6k drift). In every long session that start-up baseline is ≈50% of Σ context.
- Subagents: avg first-call context ≈42k for every hub agent (general-purpose 41.7k, test-executor 43.0k, verifier 42.8k, analyst 43.8k, orchestrator 44.6k; 10 days). `claude-code-guide` (4 tools only) starts at ≈24.6k.
- Tools actually used in 30 days: report-writer (20 runs) only Bash/Read/Edit/Write/Skill; project-onboarder only Bash/Read; requirements-analyst Bash/Write/Read/Edit + Linear read; test-executor (217 runs) Bash/Read/Edit/Write/Monitor + Gmail (232), with Linear 5, Figma 5, Slack 3. None of them used Artifact, Workflow, WebSearch or M365.
- `session-cost.mjs` reports growth, peak and the above-threshold share. It does not report the start-up baseline.

**Worth taking (proposed):**
1. A baseline line in `session-cost.mjs`: first-call context per thread, its share of Σ, and a trend across sessions to catch drift. Selftest uses fake transcripts.
2. Per-agent `tools:` allowlists built from observed use plus every tool each prompt names. qa-orchestrator and linear-writer stay on All tools. Add a selftest so an allowlist can't miss a tool its prompt names. The saving is inferred at ≤ ~15k per subagent call (claude-code-guide may also skip CLAUDE.md), so measure one agent before and after first. `.claude/agents` edits will prompt.

**Rejected:** the prose rules and per-turn CORE injection (CLAUDE.md "Token discipline" already says this with measured numbers, and injecting adds tokens every turn) · `trajectory_guard.py` (a broad PostToolUse hook, the pattern torn out 2026-10-09; the audit found reads aren't the cost driver) · `session_report.py` (Stop fires every turn; `npm run cost -- --live` answers on request) · `context_budget.py --fix` (edits user-level `~/.claude.json`/plugins outside the hub; only its measuring idea is taken) · `evals/measure.py` (measures reply words, not context × calls) · 12-language depth detection (no recorded problem).

### Taken (done 2026-10-16, after the QA lead's "go ahead with Worth taking")

| Idea | Their source | Where it lives here | Gap it fixes |
|---|---|---|---|
| Start-up baseline: each thread's first-call context (START), its share of Σ context (BASE), and drift across sessions | `hooks/context_budget.py` (measures what loads before any work) | `scripts/session-cost.mjs`: START and BASE columns in the list, detail and `--live` views. `--baseline` adds main threads (a continued session is marked `*` and left out of drift), subagent starts by agent type, a DRIFT line when the median start grows by more than 10%, and CLAUDE.md / MEMORY.md sizes | The meter showed growth and peak but not the fixed part. In 30 days the start-up baseline was **40% of Σ context** (2.4B of 5.8B). Main-thread start drifted **46k → 60k (+30%)** from the oldest 5 sessions to the newest 5. |
| Per-agent `tools:` allowlists, READ-only for trackers | `context_budget.py` counts which MCP servers transcripts actually call and unloads the rest (globally, via `--fix`) | `.claude/agents/{report-writer,requirements-analyst,test-executor,verifier,ticket-intake}.md` `tools:` (built from 30 days of calls per agent type, plus every tool each prompt names). qa-orchestrator and linear-writer stay on all tools; project-onboarder stays open (2 runs in 30 days, and its connector check must see every connector). Guarded by `scripts/agent-tools-check.mjs` | Every subagent loaded the whole roster. **Measured in a fresh `claude -p` session: 45.9k → 23.6k tokens at first call** (report-writer from its file: 24.6k), and every later call in that thread re-pays it. A missing tool fails silently, so the checker flags `named-not-listed`, `required-missing` (e.g. executor Gmail = R-02 email coverage), `write-tool` (R-01), `unknown-tool` (typo or rename), `mcp-needs-toolsearch`, `no-allowlist` and `must-stay-open` |

Learned while measuring:
- Agent files are read at session start. An edit takes effect from the next session.
- `SubagentHandback` is added automatically.
- Allowlisted MCP tools stay deferred, so any list with an `mcp__` name must also list `ToolSearch`.

Dropped from observed use:
- test-executor's 1 `Agent` call in 217 threads.
- Model typos (`bash`, `bash_placeholder`).

Not done: trimming the main-thread drift. Candidates are MEMORY.md (≈4.4k tokens), CLAUDE.md (≈3.0k), the SessionStart brain output and the connector rosters. Waits for the QA lead.

Selftest: `scripts/selftest/denfry-ideas.mjs` has 11 checks; session-cost gained 7. Each bad input is one real agent file with one mutation. Total after this repo: 377 OK.

## petrkindlmann/qa-skills — second read: ai-bug-triage + test-data-management (2026-10-16) — ANALYSIS ONLY, awaiting the QA lead's go

Read: `ai-bug-triage/SKILL.md` + the fingerprint, decision-tree and root-cause sections of its references;
`test-data-management/SKILL.md` + both references (mostly Fishery/FactoryBot/SQL seeding code).

### Worth taking
| # | Idea | Recorded gap it fixes | Build |
|---|---|---|---|
| A | Deterministic failure fingerprint + cross-ticket clusters (ai-bug-triage: normalise ids/uuids/timestamps/numbers, keep method + path template + status + message template, sha256[:16]) | Orchestrator step 6 "cross-ticket synthesis" is prose only. Beta: 9 FE-filed tickets had one backend root cause (BET-17/19/20/21/29/31/67/69/72); 38 root causes behind 117 findings were grouped by hand. Alpha vinApiData cross-cutting cause found by hand. | `scripts/failure-cluster.mjs --project --run` over `_RESULT-<run>-*.json` (`failedCalls`, `consoleErrors`, page `httpStatus` ≥400) → `_CLUSTERS-<run>.json`; clusters spanning ≥2 tickets are printed for the verifier/orchestrator. Selftest = their 5 stability cases + a 3-ticket fixture. Backtest on a Beta run before calling it done. |
| B | Dedupe scope: search every state incl. Done/Canceled; a match on a closed ticket = regression → reference/reopen that id, not a new bug; live complete list, never the queue-shaped cache; tracker per profile (Linear/Jira/Asana) | ALP-482 dealer-signature ticket missed because dedupe ran against the Staging-QA-shaped cache (alpha-cache-blind-spot). Verifier step 4 says "Linear" only and sets no state scope. | Verifier step 4 wording (a `.claude/agents` edit → permission prompt). Optional: ledger `candidateBugs[].dedupe {query, states}` checked by ledger-validate so "dedupe ran on all states" is a gate, not a promise. Staged node-graph promote anchors on "## Output" — unaffected. |
| C | Created-data register (test-data-management "no cleanup strategy" / "cleanup returns to baseline", adapted to black-box) | Residue is logged as prose in five histories: Alpha `_HISTORY.md` has 46 residue/purge lines (QATESTCAR listing + offer, ALP-AUTH customer ids, undeletable Sold `[QA]` car, orphaned S3 object); Beta 7 "Sess Probe" accounts; Gamma `[QA-SYN]` surveys (no DELETE endpoint); Zeta unremovable embeds. Nobody can answer "what QA data is still on staging?" without grepping. | `rec.created(caseId, {type, id, label, cleanup: 'deleted'|'left'|'needs-admin'})` in `RunResult`; `scripts/residue.mjs --project` regenerates `_RESIDUE.md` (open items across runs) from the result files — generated, not an archive. |
| D | Each test owns its data: destructive cases never on a shared profile account | Zeta shared A/B accounts destroyed by a duplicate-registration test (2026-08-04); Alpha `[QA]` fixture dealer got an unplanned state change during status-jump probing. Today only a memory note guards it. | Plan field `mutatesAccount: true`; plan validator fails when such a case logs in as an account listed in the profile's `accounts` block. Weakest of the four (relies on the analyst marking the flag). |

### Rejected
- Severity × priority matrix — no recorded failure came from missing definitions; the false P1/P0 escalations had evidence causes.
- LLM classification / LLM dedupe / LLM ticket generation — the skill itself warns against LLM dedupe; tickets are generated by script (R-10, gen-docx, docx-fail-sections).
- Test-bug vs app-bug vs environment decision tree — covered by `failureClass` (verifier step 1) and preflight.
- Flaky quarantine, CI log parsing, MTTR/accuracy metrics — CI-specific; verdict accuracy is covered by the node-graph blind review.
- Auto-close — R-01 already requires approval for every write.
- Factories (Fishery/FactoryBot/Factory Boy), idempotent SQL seeds, DB branching, transaction-rollback cleanup — the hub is black-box against client staging; no DB access.
- PII anonymisation / GDPR checklist — the hub never copies production data; synthetic data is `+alias` + `[QA]`.
- Edge-case string/date arrays — the analyst already writes boundary cases from ACs; no recorded miss traced to a missing edge value.

### Taken (done 2026-10-16, after the QA lead's "go ahead A, B, C, and D")
| # | What was built | Selftest | Live-data check |
|---|---|---|---|
| A | `scripts/failure-cluster.mjs --project --run` → `_CLUSTERS-<run>.json` (fingerprint = method + path template + status + message template, ids/uuids/numbers/quoted strings normalised; per-cluster `failRate` vs run `baseFailRate`; `--out` refuses `_LEDGER`/`_HISTORY` names). Orchestrator step 6 now runs it, then keeps the model pass. | `qaskills2-cluster.mjs`, 10 | Backtest on 6 Beta + 5 Alpha runs (`_stage/qaskills2/backtest/`): the widest shared clusters were background noise (Beta web ERR_CONNECTION_REFUSED on 32 tickets, 30% fail vs 23% base; Alpha URL-less console 404/400). No shared cluster matched a recorded cause — the known ones (iOS keychain -34018, wrong copy) are not network signals. One plausible lead: Alpha R4 `/deals/deal/:id` 422 on ALP-573/577. Value unproven; the step stays cheap and deterministic. |
| B | `lib/dedupe-check.mjs` + `ledger-validate.mjs`: a `candidateBugs[].dedupe {query, states, outcome, matchId}` is checked strictly (states must reach a closed state; matchId unless outcome new); prose/legacy dedupe only WARNs. Verifier step 4 now: complete live list, every state, `includeArchived: true` on Linear, `completed` unset on Asana, closed match = regression. | `qaskills2-dedupe.mjs`, 11 | 103 ledgers: exit codes unchanged (99×0, 4×1). 516 live candidate bugs: 151 no dedupe, 249 prose, 116 Alpha object — all WARN. Closed states checked live on the Alpha + EPS Linear boards: Done / Canceled / Duplicate (RC and Production QA are `started` = open). |
| C | `rec.created(caseId, {type, id, label, cleanup})` in `harness/lib/evidence.mjs`; `run-result-validate` checks it when present; `scripts/residue.mjs --project [--write]` folds all runs → `_RESIDUE.md`/`.json` (generated, not an archive). Executor step 6 now registers created data. | `qaskills2-residue.mjs`, 8 | 35 validator invocations byte-identical before/after; every project reports "no registered test data" today (865 Alpha result files scanned) — starts filling from the next run. |
| D | `scripts/plan-lint.mjs`: `mutatesAccount: true` needs `account`; fails on any profile `accounts` entry (key, email, phone digits, username; `+alias` passes). Codes `mutates-account-no-account`, `mutates-shared-account`, `mutates-account-no-profile`. Analyst step 2 + output schema now carry the fields. | `qaskills2-accounts.mjs`, 13 | 304 live plans lint byte-identical. 21 of 2,024 runnable cases look account-mutating by keyword; none is flagged today (no plan has the field yet). |

Same session: Gamma `gamma-legacy.example` surface dropped (option 1); `scripts/selftest/run-section.mjs` added so parallel builders test one section in its own TMP; Obsidian-brain value check scheduled for 2026-10-30 (`brain-recall.mjs --review`, config `reports/_BRAIN-REVIEW.json`, 6 checks in the brain-recall section).
Full selftest after all four: 425 OK. Agent edits applied to orchestrator/verifier/test-executor/requirements-analyst; `agent-tools-check` OK; staged node-graph promote still applies cleanly.
