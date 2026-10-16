---
name: qa-gmail-inbox
description: A connected Gmail (qa@your-company.example) is usable for QA signups + inbox/verification/receipt checks — unblocks email-gated flows
metadata: 
  node_type: memory
  type: reference
  originSessionId: 565079d9-37bc-4faf-8d64-f20c60986c7a
  modified: 2026-08-05T13:35:37.656Z
---

the QA lead confirmed (2026-07-23) that the **Gmail connector is connected and authorized for QA use** — account **qa@your-company.example** (Google Workspace; verified live this session via list_labels + a sent-mail metadata read). Originally connected for the "Zeta project." Explicit grant: *"if something requires new gmail, new user, or inbox check, you can use it."*

**How to use for QA:**
- Sign up `[QA]` users/dealers with **`+` aliasing** — e.g. `qa+project01@your-company.example`, `+qaalpha02`, … — each is unique to the app but all deliver to the one inbox. Lets you create many test accounts and read their verification/confirmation/receipt emails.
- Read verification/reset/receipt mail via the Gmail MCP tools (`search_threads` → `get_thread`/`get_message`). Prefer `THREAD_VIEW_METADATA_ONLY` and targeted queries (`from:`, `subject:`, `newer_than:`) so you read QA-generated mail, not the QA lead's personal mail.

**What it unblocks** (previously NEEDS-MANUAL "no inbox"): email-based signup/verification/password-reset, purchase-complete **receipt emails** (e.g. Alpha ALP-221 with a Gmail-based `[QA]` buyer), and new-signup-default checks (e.g. Alpha ALP-137). Also supplies the email for a 2nd `[QA]` dealer (ALP-SELL/DEALER-NET isolation).

**Limits:** covers **email only** — **SMS/phone** (Twilio) verification is still not covered → those stay NEEDS-MANUAL. Re-verify the connector is present each session (connectors are auth-dependent). Signups are done on **staging**, so they don't reach real prod users — consistent with [[alpha-prod-safety]] and [[agent-cannot-run-handling]].

## ⚠️ 2026-08-05 — NEVER judge emailed-LINK integrity through the connector
**The connector mangles URLs in message bodies.** On Zeta it consistently returned verify/reset links whose `?token=` separator was replaced by a replacement char (the `=` plus the next 2 hex chars eaten), making the link look corrupted and unusable. QA escalated that to a **P1 "nobody can verify email or reset a password"** — and it was **WRONG**. the QA lead clicked the same link in a real mail client: it works end to end. PRO-7 was reopened, then retracted, its comment and screenshot deleted, and moved to Release Candidate.

**Root cause of the mistake:** `get_message`/`get_thread` decode content-transfer-encoding server-side and expose no raw RFC822 (`messageFormat:"RAW"` is rejected, `METADATA_ONLY` shows no `Content-Transfer-Encoding`), so the on-the-wire bytes are **never observable**. Three cycles' worth of "mail-token blocker" notes were a tooling artifact, not a product defect.

**The invalid control to never repeat:** a verifier "proved" it was app-side because token links from *other* senders (Alpha, Linear) rendered intact in the same inbox. That proves nothing — different senders use different transfer encodings, so a cross-sender, same-inbox comparison cannot establish per-message encoding integrity.

**Rules now:**
- Use the connector for **did an email arrive, when, from whom, what subject, and does the body say X** — all reliable, and it caught real defects this pass (PRO-6's confirmation email never sends; PRO-20's opt-out suppression verified with a control).
- **Any claim about a link being broken/corrupted is agent-cannot-run** → route to a human with a real mail client per [[agent-cannot-run-handling]]. Never file it as a bug from connector evidence.
- Reconstructing a mangled token to *proceed with testing* is fine and works (it unblocked onboarding this pass). Just never treat the mangling itself as a product finding.
- **Thread-list views truncate to the first ~5 messages.** A "no email arrived" conclusion from `search_threads` is unsafe — always re-check with `get_thread` on the specific thread. This nearly produced a false negative on PRO-20 for emails that had in fact been delivered.
