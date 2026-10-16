# QA Hub: review guide

This repository is the framework of a multi-agent QA system built on Claude Code. It is shared so engineers can
review the design and say what is wrong with it. It contains **no project information**. There are no client
names, hosts, tickets, accounts, test evidence or reports. Every project reference in code and fixtures has been
renamed to a neutral placeholder:

| Placeholder | Meaning |
|---|---|
| `alpha`, `beta`, `gamma` (`ALP-`, `BET-`, `GAM-` keys) | three fixture projects: a Linear web app, a Jira web + mobile app, an Asana web app |
| `delta`, `epsilon`, `zeta` | other projects mentioned in lessons learned |
| `*.example` hosts | staging and production hosts of those projects |
| "the QA lead" / "the agency" | the hub owner and their company |

Because the rename was applied consistently to code, fixtures and file names, `npm run selftest` still runs here.

## What it does, in one paragraph

A QA request ("QA the Staging QA tickets of this project") runs as a pipeline of subagents:
`project-onboarder → ticket-intake → requirements-analyst → test-executor → verifier → report-writer →
(human approval) → linear-writer`. The **executor records and does not judge**. It drives the live build
(Playwright, adb, iOS simulator, HTTP) and writes down what happened with typed evidence. A separate
**verifier** on a stronger model decides pass/fail from that record. **Counts, ticket verdicts and destination
statuses are derived by script** from the verifier's per-case ledger, never typed by a model. **Nothing reaches a
tracker without a human**: a script derives the write plan from the ledger, the human approves it in their own
words, the plan is frozen by sha256, and a PreToolUse hook denies every tracker call that is not in it.

## Where to look

| Path | What it is |
|---|---|
| `rules/RULES.md` | **Start here.** The canonical rules R-01…R-17 and the gate index (which script or hook enforces which rule) |
| `CLAUDE.md` | Session operating rules loaded into every Claude Code session in this folder |
| `QA-AGENT-MASTER-PROMPT.md` | How a run is performed: the shared standard every agent reads |
| `.claude/agents/*.md` | The 8 agent definitions (role, model tier, tools, rules) |
| `.claude/hooks/tracker-write-gate.mjs` | R-01 enforcement: denies tracker writes not in an approved, hash-frozen plan; fails closed |
| `.claude/hooks/doc-read-guard.mjs` | R-17: redirects raw PDF/Office reads to a Markdown conversion |
| `lib/` | Ledger model, verdict → status routing, tracker op builders (Linear / Jira / Asana), profile loader |
| `scripts/*-plan.mjs`, `qa-approve.mjs` | Write-plan generation and approval freezing |
| `scripts/gen-*.mjs` | Generated deliverables: counts, `_SUMMARY.md`, Word report |
| `scripts/*-validate.mjs`, `run-plan.mjs`, `qa-gates.mjs` | The gates a run must pass before it is reported |
| `scripts/selftest-gates.mjs`, `scripts/selftest/` | Feeds every gate a known-bad input and asserts it rejects |
| `harness/lib/` | Shared harness building blocks (Playwright, adb, evidence capture) |
| `profiles/*.json`, `qa-profile.schema.json` | Per-project config shape; the three profiles here are selftest fixtures |
| `rules/memory-seed/` | Standing lessons learned from real runs, each with its reason (project names replaced) |
| `IDEAS-FROM-REPOS.md` | What was taken from other public QA repos and what was rejected, with the reason for each |

## What came from other repos

The hub is improved partly by reading public QA and agent repos. An idea is taken only if it fixes a failure
the hub has actually recorded. Each idea taken gets a selftest section that feeds it a known-bad input. Each
idea rejected gets one line saying why. Nothing was installed or run from these repos. Every idea was rewritten
for this codebase, and each file that took one credits the source. The full log, including what was rejected,
is in `IDEAS-FROM-REPOS.md`.

| Source repo | What the hub took | Where it lives | Selftest |
|---|---|---|---|
| `vostride/agent-qa` | A prompt-injection scan of ticket and document text (it flags and never blocks). A page-readiness wait and a short text outline of the page when a selector misses. A failure taxonomy that keeps harness, browser and network failures from being judged as product bugs. Trust scores for lessons learned. | `lib/text-threats.mjs`, `harness/lib/page.mjs`, `harness/lib/evidence.mjs`, `scripts/brain-recall.mjs` | `repo-ideas.mjs` |
| `petrkindlmann/qa-skills` (first read) | A plan linter and a test-design checklist: every rule gets a negative case, every write gets a read-back, an expected result names what must not happen, and a fail on an unwritten requirement becomes a question for the PM. Act only on a unique element match. Assert a link's host instead of clicking it. Check test mode before typing a card. | `scripts/plan-lint.mjs`, `harness/lib/page.mjs`, `.claude/agents/requirements-analyst.md` | `qa-skills-ideas.mjs` |
| `LambdaTest/agent-skills` | A read-only preflight before anything is dispatched: surfaces, build, emulator or simulator, tracker token and connectors. A STOP result fails the gates. Failed backend calls are recorded in every capture. Three more lint rules for how a test step is worded. | `scripts/preflight.mjs`, `harness/lib/evidence.mjs`, `scripts/plan-lint.mjs` | `lambdatest-ideas.mjs` |
| `denfry/claude-skills` | A start-up context baseline and drift line in the cost meter. Per-agent `tools:` allowlists cut a subagent's first-call context from 45.9k to 23.6k tokens. A checker fails an allowlist that misses a tool its prompt names, or that gives an agent a tracker write tool. | `scripts/session-cost.mjs`, `scripts/agent-tools-check.mjs`, `.claude/agents/*.md` | `denfry-ideas.mjs`, `session-cost.mjs` |
| `petrkindlmann/qa-skills` (second read) | Failure fingerprints clustered across tickets, scored against the run's base fail rate. Bug dedupe searches every tracker state, Done and Canceled included, and records the search in the ledger. A register of the test data each run created and whether it was cleaned up. A case that changes an account may not use one of the profile's shared accounts. | `scripts/failure-cluster.mjs`, `lib/dedupe-check.mjs`, `scripts/residue.mjs`, `scripts/plan-lint.mjs` | `qaskills2-*.mjs` |

## Run it

Node 20+. No services, no API keys.

```bash
npm install
npm run selftest        # every gate fed a bad input; expect all checks to pass
```

One check needs the hub-local markitdown install described in `README.md`. Without it, expect exactly one failure,
in the doc-read section.

Running an actual QA pass needs Claude Code plus tracker connectors and a real project, which this copy does not
include. Reviewing it does not need one.

## What feedback is most useful

1. **False verdicts.** Where can the pipeline still produce a wrong FAIL (a false reopen) or a wrong PASS? Look at
   R-04, R-05 and R-11, `lib/routing.mjs` and `scripts/ledger-validate.mjs`.
2. **Independence of the verifier.** The executor records and the verifier judges. Does the executor's recorded
   framing still bias the verdict? See `.claude/agents/test-executor.md` and `.claude/agents/verifier.md`.
3. **The approval gate (R-01).** Can a tracker write get past `tracker-write-gate.mjs` without a human-approved
   plan? Look at the hash binding, the fail-closed paths and the `permissions.allow` check.
4. **"Agent cannot run" (R-02).** Is the boundary between automatable and manual-only cases drawn in the right
   place, or can it become an excuse to skip testable work?
5. **Gates that do not gate.** Any rule in `RULES.md` whose gate can be satisfied without the rule being met, or
   any selftest check that would still pass if the gate were removed.
6. **Cost and complexity.** Anything that is over-engineered for what it protects, or a simpler design that
   gives the same guarantee.
7. **The ideas from other repos.** Is any idea taken not worth what it adds, or was a rejected one rejected for
   the wrong reason? `IDEAS-FROM-REPOS.md` records the measured effect of each one (some are still unproven).

## How to give feedback

Open an issue in this repository with the **Feedback** template. Put one finding per issue, and include the file
and line, what goes wrong, and a concrete scenario. For a fix, open a pull request against the file. If a change
touches a gate or validator, run `npm run selftest` first.
