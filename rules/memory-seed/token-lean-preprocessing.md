---
name: token-lean-preprocessing
description: "Standing token-economy rules for qa-hub — never read raw design SVGs, read only failing-case screenshots, model tiers, preprocessing scripts."
metadata: 
  node_type: memory
  type: project
  originSessionId: 76600600-e11d-41ac-8994-008eff1a2b5f
  modified: 2026-08-12T18:09:17.710Z
---

Standing rule for every project the hub tests (added 2026-07-22, after a qa-hub token-cost optimization pass). The session/token budget is the scarce resource; these cut it without hurting QA quality.

**Never read raw design exports (`.svg`/`.fig`) into context.** Figma SVG exports are XML text — a single board can be 5–30MB ≈ millions of tokens (zeta had 49 SVGs, several 18–30MB). This was the #1 hidden token sink. Instead:
- Rasterize once with `~/Desktop/qa-hub/scripts/render-figma.mjs` (auto-scans `projects/*/delivery_handoff/figma`, or pass a dir) → bounded PNGs cached in `<figma>/_rendered/` (≤1600px, ~1,600 image tokens each). Idempotent; uses `sharp` (from appium's node_modules) with a headless-Chrome fallback for giant multi-artboard boards that blow libvips's XML limit.
- Agents read `_rendered/*.png`, never the `.svg`. Profiles point `figma` at `_rendered`.

**Read only the screenshots you need.** The verifier judges from the executor's recorded text first (`actual`, httpStatus, console, logcat) and opens **≤1 image per FAILING case** — never bulk-opens an `*_attachments/` folder, never opens images for passing cases. Prefer text evidence (a status code ~5 tokens vs a screenshot ~1,600).
- Downscaling screenshots barely helps tokens (the API resizes images server-side anyway) — `scripts/downscale-screenshots.sh` exists for disk/upload relief only, dry-run by default, not auto-applied. The real lever is *count*, not resolution.

**Model tiers (in agent frontmatter), set by how much judgement each agent's *remaining* work needs:** opus = orchestrator + requirements-analyst + verifier (judgment); sonnet = test-executor (drives the build) **and project-onboarder** (raised from haiku 2026-08-12 — a wrong host or a misspelled state name in a profile silently corrupts every later run); haiku = ticket-intake (parse, then gated by `intake-assert.mjs`) + report-writer (**prose only** — counts/`_SUMMARY.md`/`.docx` are generated from the ledger) + linear-writer (replays an approved plan verbatim, makes no decisions). Don't upgrade a mechanical agent, don't downgrade one that adjudicates.

Encoded in `QA-AGENT-MASTER-PROMPT.md` §14 + §2, and the requirements-analyst/verifier/test-executor agent files. Reinforces [[lean-run-defaults]] (cheapest mode, diff-aware re-runs) and [[hub-self-contained-layout]] (fixed a stale `~/Desktop/<slug>_qa/` attachment path in test-executor). See [[qa-evidence-consistency]] for the one-listing evidence rule.
