---
name: qa-verification-rigor
description: "QA verdicts must be dev-comment-first + tested on the exact surface/current build; don't score deferred-scope/by-design as FAIL"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 565079d9-37bc-4faf-8d64-f20c60986c7a
  modified: 2026-08-12T18:09:23.663Z
---

**Why:** In the 2026-07-23 Alpha sweep, the QA lead caught that a FAIL verdict (ALP-392) was wrong. A full re-verification of all ~84 FAIL/Reopen verdicts found **~45 were wrong (flipped), only ~38 genuine** — a >50% false-fail rate. Root causes, all avoidable:
1. **Tested the wrong surface** — e.g. the dealer public **storefront** is served at `dexample000000.cloudfront.net` (Host-based `GET /api/v1/brand-load/by-host/<host>`), NOT the marketplace `staging-customer.alpha.example`; the whole DEALER-WEB logo/copy cluster + SITE-GEO were failed on the marketplace.
2. **Never clicked Save** → missed save-time inline validation the dev shipped (ALP-129/138/321/349/355…).
3. **Tested a stale FE bundle / pre-fix data** (ALP-PAY: 17 "sold-with-balance" deals all predated the fix deploy → falsely concluded "payment layer broken"; current build is `index-Et_B-GI7.js` / API rev 167).
4. **Scored dev-deferred-scope or by-design behavior as a defect** (comparison-matrix dashes, method-aware cash labels, product-gap "remainders" the dev explicitly deferred).
5. **Misquoted/swapped dev comments** (ALP-354/359).

**How to apply (mandatory verifier/executor protocol):**
- Per ticket, read `get_issue` + `list_comments` FIRST. The developer's deploy/QA comment — the **surface/URL they name, conditions ("legacy → re-upload"), "fixed in PR", repro steps** — is AUTHORITATIVE. Test exactly there, on the **current deployed build**.
- Distinguish **environment-gap → NEEDS-MANUAL** (surface unreachable on staging, e.g. DNS-dead branded subdomain) from a genuine **code defect → FAIL**. Use route-interception with REAL backend JSON into the real bundle when a surface is env-blocked but the code is testable.
- A "**delivered fix + deferred/unclaimed remainder**" = **PASS (with a scope-question for PM)**, NOT a Reopen. Only reproduce-on-the-correct-surface findings are real FAILs.
- Do NOT blanket-flip either: in the same audit, ALP-DOC (8/10) and several P0s (ALP-123 staging→prod redirect, ALP-343 no EIN uniqueness, ALP-365 unverified-dealer PII access) correctly STOOD. Judge each on its AC + the dev's evidence.

Complements [[linear-write-approval]] (propose, hold) and [[qa-evidence-consistency]].

## 2026-08-12 addendum — false verdicts also enter at the WRITE-UP stage, not just at testing
the QA lead restated the bar: "I don't want from you any false fail or false pass." A new failure mode surfaced in the 105-ticket Alpha run that the rules above don't cover: **the testing was right and the deliverable was still wrong.** ALP-282 was written into the dev-facing .docx as a FAIL while its own ledger recorded a clean PASS — a transcription error by the report-writing agent, caught only because its summary listed 27 tickets under a "26 FAIL" heading. An agent's "Ready for the QA lead" sign-off is not evidence.

Two more self-inflicted classes from the same run:
- **Harness error masquerading as a product defect.** We reported a "No active subscription / Deal not found" wall as a possible P0 frontend bug and let it cost coverage in two parts. Root cause was ours: we passed a *deal number* to `/deals/deal/:param`, which expects a *car UUID*; the resulting 400 renders "Deal not found". The 200s we cited as contradiction came from a different endpoint. Before escalating any blocker as a defect, prove the request itself was well-formed.
- **Systematically pessimistic deferral triage.** 10 tickets deferred as unrunnable were fully runnable (ALP-525, 388, 341, 517, 487, 172, 486, 489, 488, 56); 8 other deferrals were correct. Treat "not testable" as a hypothesis to disprove.

A fourth class, caught by the QA lead afterwards: **"PARTIAL" used as a dumping ground.** It was flattening three unrelated states — *coverage gap* (QA didn't finish), *deferred scope* (dev knowingly didn't build it), and *blocked on definition* (nobody knows the intended behaviour) — which put two non-defects into a dev-facing defect document. ALP-389's shipped slice was fully correct with the remainder explicitly descoped by the dev → **PASS + scope question, no dev action**; its ledger cited that very rule and labelled it PARTIAL anyway. ALP-55's own entry read "UI correctly hides when unconfigured" while typed PARTIAL — it is blocked on vendor-key provisioning, not broken. Only ALP-283 was a true mixed verdict. **Require a sub-reason on every PARTIAL at write-up**, and treat "product decision" in a severity field as a prompt to re-ask whether anything is actually broken.

**How to apply:** before any report or .docx ships, cross-check every ticket's classification in the deliverable against the verdict stated in its ledger, and confirm the buckets sum to the ticket total with each ticket in exactly one. Arithmetic that doesn't reconcile is the cheapest available signal that a verdict is misfiled — chase it, don't smooth it over.

## 2026-08-03 addendum — comments inform, they don't verdict
the QA lead caught the hub defaulting to a PASS/FAIL verdict by reading a dev's resolution comment instead of independently re-executing the case, and separately over-deferring testable cases (e.g. payment) to needs-manual when fixtures existed to run them for real. Tightened rule: a dev comment tells you *where* and *how* to test (surface, build, repro steps) — it is never itself the verdict. Every case gets actually driven on the current live build; the verifier adversarially re-challenges before a PASS or FAIL is final — no false passes, no false fails. Before deferring anything to needs-manual, confirm it's a genuine agent-cannot-run case per [[agent-cannot-run-handling]] (real-device sensor/biometric/NFC, push, SMS, manual OAuth/CAPTCHA, physical device — **not** "missing inbox", which the Gmail connector covers, and **not** payments, which PAYGW UAT cards cover) and record the probe that proves it — not just "this looked hard" or "the dev said it's fixed." See [[alpha-payment-test-harness]] for the payment-specific fixture that removes that excuse for Alpha.
