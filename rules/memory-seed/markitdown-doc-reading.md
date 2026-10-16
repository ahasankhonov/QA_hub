---
name: markitdown-doc-reading
description: "Hub reads every .pdf/.docx/.pptx/.xlsx/.xls/.epub/.msg through Microsoft markitdown (R-17) — read-doc.mjs + doc-read-guard hook, hub-local install in .tools/, set up 2026-10-07 at the QA lead's request"
metadata:
  node_type: memory
  type: project
  originSessionId: 6c9a3b28-9d1d-4793-83fa-1c48d03c8635
  modified: 2026-10-07T10:00:02.777Z
---

the QA lead asked on 2026-10-07 that the hub use markitdown (github.com/microsoft/markitdown) whenever it reads a file. Implemented as **R-17** in `rules/RULES.md`.

- **Pieces:**
  - CLI: `node scripts/read-doc.mjs <file|dir>` (also `npm run doc`).
  - Shared lib: `lib/doc-convert.mjs`.
  - PreToolUse hook: `.claude/hooks/doc-read-guard.mjs`, matcher `Read`, timeout 90 s. It converts the file and denies the Read with the `.md` path to use instead.
  - Selftest: `scripts/selftest/doc-read.mjs` (13 checks).
- **Output:** a sibling `_md/<name>.md` carrying a `<!-- read-doc: … -->` header with size, mtime, chars and an empty flag. Files outside the hub go to `.doc-cache/`. Spreadsheet `NaN`/`Unnamed` noise is compacted away.
- **Install:**
  - Location: `.tools/markitdown` is a Python 3.12 venv via uv. `uv` was bootstrapped in `.tools/bootstrap`, because system Python is 3.9 and `/opt/homebrew` is not writable by this user.
  - Version: markitdown 0.1.8, extras `pdf,docx,pptx,xlsx,xls,outlook` only.
  - Never add the audio/youtube/`all` extras: they upload media to Google speech.
  - Reinstall steps are in the README "Preprocessing → read-doc.mjs".
- **Backfill on 2026-10-07:** 117 hub docs converted. 5 have no text layer (EMPTY), including the image-only `epsilon/delivery_handoff/Epsilon-Addendum-3.pdf`, so they go through the native page Read.
- **Fix for connector truncation:** the M365 connector cuts `.xlsx` at ~190k chars (the Gamma FRS v0.7 copy stops at FR 5.2.4). the QA lead downloads the file into `projects/<slug>/docs/`, then run read-doc to get every sheet. See [[gamma-status]].
- **Page images (2026-10-07):** `swift scripts/render-pdf.swift <pdf> <docs>/_rendered/<name>` (PDFKit, 52 pages in 5 s) for PDFs the Read tool refuses (>100 MB, e.g. the 134 MB Gamma wireframe deck) or image-only PDFs read-doc marks EMPTY. No poppler/mutool/ghostscript on this Mac.
- **Hook behaviour:**
  - Fails OPEN: a missing converter or a converter error passes the Read through.
  - A slow conversion (over 45 s) is denied, and the denial gives the CLI command.
  - A PDF Read with `pages` is allowed once the Markdown exists.

**Why:** a raw Office/PDF Read is either unreadable or page images at many times the token cost (R-12). Markdown on disk is greppable and survives compaction.
**How to apply:** before reading any document, run read-doc and grep the `.md`. Don't fight the hook's denial. When a new doc lands in a project, run `read-doc` on its folder. Related: [[token-lean-preprocessing]], [[qa-hub-gates-and-rules]].
