---
name: linear-intake-verbatim-pull
description: Haiku ticket-intake summarised the "verbatim" Linear raw file twice in Alpha R7 (2026-09-10) and H-1 cannot detect it; pull the raw with a sonnet agent that saves each tool result to disk + a script assembles it, then spot-check lengths against Linear.
metadata:
  type: feedback
---

In Alpha R7 (2026-09-10) the `ticket-intake` (haiku) agent was asked twice to write
`_INTAKE-<run>-<shard>-raw.json` "verbatim, unedited" from `get_issue` + `list_comments`. Both times it
wrote summaries: ~50–200-char bodies instead of 1,000–3,000, 0–1 comments instead of 3–9, and on
ALP-595 it invented body text quoting a hub memory that is not in Linear. `intake-assert.mjs` (H-1)
passed both times because it counts AC/TC ids *in the raw body*: a thin raw makes the gate vacuous.
The spec it emitted from a genuine raw also left `acs` empty on prose-acceptance tickets and picked
surfaces by default.

**Why:** the raw file is the ground truth every later stage is checked against; a summarised or
fabricated raw silently corrupts intake → analyst → executor for a whole shard, and the gate meant
to catch truncation cannot see truncation of its own reference.

**How to apply:**
- Pull Linear raws with a **sonnet general-purpose agent** told to Write each `get_issue` /
  `list_comments` result to a per-ticket file *as it goes*, then assemble the raw with a script
  (pattern: `scratchpad/intakeA/assemble.mjs` in the R7 session — fails on `hasNextPage`, prints
  body/comment lengths per ticket). Haiku intake then emits only the spec from the on-disk raw
  ("raw is already on disk, do not call Linear").
- Before trusting any shard: compare median body/comment chars across shards, and `get_issue` one
  or two tickets yourself to compare lengths. A median body under ~300 chars on a QA-findings ticket
  template is a summary, not a copy.
- If `acs` is empty where the body has `### Acceptance test|criteria|Verify`, rebuild it by script
  from the section (one AC per numbered/bulleted item, else the paragraph) and mirror numbered
  Verify items as TC-n so H-1's step heuristic passes.
- Tooling follow-up worth doing: give H-1 a floor check (raw body length vs `_LIVE` title/updatedAt
  presence, or a `--min-body` warning) and add a Linear equivalent of `jira-pull.mjs` so no model
  ever writes the raw. See [[qa-hub-gates-and-rules]], [[qa-orchestrator-stalls-large-runs]].
