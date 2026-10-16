---
name: qa-evidence-consistency
description: Keep per-ticket QA evidence on one consistent listing/actor; use a verifier agent to reproduce failed cases individually
metadata: 
  node_type: memory
  type: feedback
  originSessionId: e7453a1b-a0bc-4c10-86bb-e899f24251d6
  modified: 2026-07-21T11:46:46.035Z
---

When capturing QA evidence for a ticket, **keep all screenshots for that ticket on the SAME listing/record and consistent actors.** Do not mix different vehicles/accounts across one ticket's attachments (e.g., a dealer-side popup on one car + a customer-side form on another) — it looks inconsistent and undermines the finding.

**Why:** On the 2026-07-21 Alpha run, ALP-17's attachments mixed listings — the dealer offer-popup shots were a test dealer's Ford F-150 lead while the customer counter-form shot was the `[QA]` QATESTCAR listing. the QA lead caught it ("they look different listings"). Fixed by re-capturing on the single QATESTCAR listing.

**How to apply:**
- Pick one test record per ticket and capture every surface (both actors) on it.
- For **failed / flagged / contested** cases especially, spin up a dedicated **verifier** agent (subagent_type `verifier`) that reproduces each failing case **individually** and produces its own clean, self-consistent attachment set — before proposing any Linear change (Reopen/bug). This is an adversarial re-check, and it isolates each finding's evidence. Pass the agent the prod-safety rules + accounts + harness path explicitly (subagents don't inherit memory). See [[alpha-prod-safety]], [[alpha-sell-listing-harness]], [[linear-write-approval]].
