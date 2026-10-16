---
name: flow-test-ui-only-stop-on-blocker
description: "E2E/deal-flow runs — every step via the real UI, never pass a step by API; report each blocker immediately with screenshots and pause the whole run until the QA lead fixes it"
metadata:
  node_type: memory
  type: feedback
  originSessionId: d2ad9dc2-3b4a-473a-8c63-ebc28c1c9ead
  modified: 2026-10-01T19:37:44.396Z
---

the QA lead, 2026-10-01, during the Alpha R14 deal-matrix run: "do not pass any step using apis, tell me any blocker immidiately with screenshots, and stop untill i fix that blocker".

**Why:** R13-DEAL-E2E used API fallbacks: generate-packet, payment/confirm and task-complete. They pushed deals past disabled UI buttons, so the run "passed" stages a real user can't get through. It then reported the blocker hours later inside a long summary.

Refined 2026-10-02 (same run): "execute different deal flows, different purchase profiles, make a list of flows and start testing, if one gets blocked continue with the other one be smart like a senior qa tester".

**How to apply:**
- In flow runs, mutating steps happen only through real UI clicks. API GETs to read or verify state are fine as evidence.
- On a real app blocker, check it isn't a harness or network artefact. Then take viewport screenshots and write `_BLOCKER-<run>-<n>.md`.
- Tell the QA lead at once, with the screenshot paths. **Only the blocked flow stops**; the other flows keep running (each flow is independent: its own car, own customer alias, own executor). Never route around the blocker in the blocked flow.
- Resume the blocked flow only after he says it's fixed.

Related: [[qa-verification-rigor]], [[alpha-prod-safety]], [[qa-orchestrator-stalls-large-runs]].
