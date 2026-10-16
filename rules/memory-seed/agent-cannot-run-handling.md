---
name: agent-cannot-run-handling
description: "How to handle test cases the agent physically cannot run (real-device sensors, etc.)"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 116f2af3-2991-462d-8222-0302467852e8
  modified: 2026-08-12T18:08:38.194Z
---

**"The agent cannot run this" is a claim to disprove, not a category to select** (rule **R-02** in `~/Desktop/qa-hub/rules/RULES.md`, the canonical rules file). Deferring requires a **recorded probe** naming the specific missing capability — the attempt and what it returned. Genuinely uncovered: real-device microphone/camera/GPS/biometric/NFC, push on hardware, SMS, manual OAuth/CAPTCHA, a physical device. **Covered, so never a valid reason:** email (the Gmail connector on qa@your-company.example with `+alias` signup — see [[qa-gmail-inbox]]) and Alpha card payments (PAYGW UAT test cards — see [[alpha-payment-test-harness]]). "No inbox" and "no credentials" are no longer valid deferrals; that clause was removed from the hub docs on 2026-08-12.

When a case genuinely cannot be run:

- **Do NOT attempt to execute the case, and do NOT change the ticket's status** — leave the Linear ticket in **"Staging QA"** (never Blocked, never the pass state). Add a comment that includes all three of: **(a)** the exact case (TC-N.x), **(b)** **why** it needs a human / real device (the specific capability the agent lacks, plus the probe that proved it), and **(c)** the **repro steps** a human must follow to run the case manually — numbered, noting build + account + device. Example: *"TC-4.3 (speak a command to Luna) needs a real-device microphone — the emulator exposes no audio input (probe: `adb shell dumpsys media.audio_flinger` → no input device). Manual repro: 1) install v1.0.1 on a physical Android device, 2) sign in as &lt;account&gt;, 3) open the Voice Orb, 4) say the command, 5) confirm Luna responds. Leaving in Staging QA for manual verification."*
- **Do NOT** file a Linear bug for it, and **do NOT** post it to Slack.
- **Report it to the QA lead in a local file only** — `qa-reports/_NEEDS-MANUAL.md` (a manual-verification checklist): ticket + TC-N.x + reason. Standalone limitations not tied to a ticket go in the same local report.

**Blocked** status is reserved only for a genuine product/dependency block (feature can't work because another ticket/backend is broken) — never for an agent/tooling limitation.

**Precedence:** a ticket with both a real failure and a can't-run case → Reopen (failure wins), note the can't-run case in the comment + manual report. A ticket whose runnable cases all pass but has any can't-run case → verdict `PARTIAL`/coverage-gap, which routes to **stays in Staging QA** — only a fully verified ticket takes the pass route (which state that is comes from the profile's `linear.stateMap`; for Alpha it is Release Candidate, not Production QA).

**Why:** the QA lead doesn't want tooling limits polluting the Linear board (false "Blocked") or the Slack/bug stream; those cases just need a human to run them, tracked privately for the QA lead. **Clarified by the QA lead 2026-07-21:** never execute a manual/real-device case and never touch the ticket's status — just leave it in Staging QA and make the comment self-sufficient for a human to reproduce (why + numbered repro steps). See [[linear-write-approval]].
