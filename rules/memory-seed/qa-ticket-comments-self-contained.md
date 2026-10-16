---
name: qa-ticket-comments-self-contained
description: "Dev-facing Jira/Linear tickets + comments must explain the bug fully in prose; NEVER reference internal QA files (docx reports, screenshot filenames/paths)"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 8eb6f9a0-26fd-456c-8bae-1ba418ca3cf0
  modified: 2026-08-04T05:42:20.912Z
---

the QA lead (2026-08-04, Beta) caught QA reopen comments that referenced internal artifacts — e.g. "Ekran surati: stA-BET-05-after.png" and the "Beta-Frontend-Bug-Report-2026-07-28.docx" report. His rule: **those files are for the QA lead (me/the QA lead), NOT for the developers. Do not mention the report file or screenshot filenames/paths in tickets or comments — instead explain the issue well, in words, inside the comment itself.**

**Why:** developers can't open the hub's local `.docx` or `_frontend-attachments/*.png` files, so a filename reference is noise to them and leaks internal naming. A ticket/comment must be fully self-contained: what's wrong, where, expected vs actual, and (for visual bugs) a clear prose description of what is seen — enough to act on without any attachment.

**How to apply (every project, dev-facing writes):**
- Reopen/bug comments: describe the defect in complete prose. For FE/visual bugs, spell out exactly what renders wrong (colours, layout px, which labels, which language) instead of pointing to a screenshot file.
- Never paste the deliverable docx name, the `shots/`/`_frontend-attachments/` path, or a screenshot filename into a Jira/Linear ticket or comment.
- If a real inline image is wanted, ATTACH the actual file to the issue (see [[beta-jira-tracker]] token/REST path) and reference it via the tracker's image markup — never a bare local filename.
- The count summary + Word .docx from [[qa-report-deliverables]] stays an internal deliverable for the QA lead; it is not linked from tickets.

Complements [[qa-report-deliverables]], [[linear-write-approval]].

**2026-10-09 (the QA lead: "comment also needs to be short"):** self-contained does not mean long. 50–90 words, max 120: what is wrong → steps in one sentence → expected + the clause → one sentence on the rest. The Gamma FE1 verifier wrote 1,000–1,700-char comments listing every screen opened; all 9 were rewritten by hand. Rule is now in `.claude/agents/verifier.md`.
