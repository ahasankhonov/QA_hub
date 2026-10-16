---
name: hub-self-contained-layout
description: "Keep every QA project's files inside qa-hub/projects/<slug>/ — nothing needed outside the qa-hub folder"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: fc43afa5-04d5-4727-83d5-4948e624070f
---

the QA lead wants the QA hub to be **fully self-contained**: every file a project needs lives **inside `~/Desktop/qa-hub/`**, never in a sibling `~/Desktop/<slug>_qa/` folder.

**How to apply:** When onboarding any project, set its `workingFolder` to `~/Desktop/qa-hub/projects/<slug>` and put deliverables in `~/Desktop/qa-hub/projects/<slug>/qa-reports/`. Per-project config stays in `~/Desktop/qa-hub/profiles/<slug>.json`; cross-project roll-up stays in `~/Desktop/qa-hub/reports/_PORTFOLIO.md`. Do NOT create `<slug>_qa` folders on the Desktop.

**Why:** the QA lead asked for Alpha's files to be moved inside qa-hub (2026-07-17) and stated the general rule: "i dont want any needed file be outside of my qa-hub folder."

**Migration done (2026-07-17):** all three projects now live inside the hub — `qa-hub/projects/alpha/`, `qa-hub/projects/zeta/` (was `~/Desktop/zeta_test_qa/`), `qa-hub/projects/epsilon/` (was `~/Desktop/epsilon_qa/`). Profiles, `_PORTFOLIO.md`, and the EPS APK path were all repointed. No `<slug>_qa` folders remain on the Desktop. See [[memory-model]].
