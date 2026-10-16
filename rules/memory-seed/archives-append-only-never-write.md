---
name: archives-append-only-never-write
description: "Per-project archives (_NEEDS-MANUAL.md, _HISTORY.md, _LEDGER-*, _INTAKE-*) are append-only; never Write/overwrite them — the R14 report-writer destroyed the Alpha needs-manual archive on 2026-10-01 and it could not be recovered"
metadata:
  node_type: memory
  type: feedback
  originSessionId: d2ad9dc2-3b4a-473a-8c63-ebc28c1c9ead
  modified: 2026-10-01T23:12:21.187Z
---

On 2026-10-01 23:02Z the R14 report-writer (haiku) produced the run's needs-manual section with a `Write` to
`projects/alpha/qa-reports/_NEEDS-MANUAL.md` without reading it first. That replaced a ~71 KB, ~480-line,
2026-07-22 → 2026-09-30 archive with 20 lines. No copy survived anywhere (Claude file-history, APFS snapshots,
Trash, every transcript — the file had only ever been grep'd/sed'd, never cat'd in full). The hub now holds a
clearly-marked reconstruction plus raw fragments in `_NEEDS-MANUAL-RECOVERY/`.

**Why:** the hub's memory model depends on these files being the durable record; the per-run output files
(`_RESULT-*`, `_LEDGER-<run>.json`) are regenerable, the cross-run archives are not. The CLAUDE.md "grep
archives, never open them" rule means no agent ever has the full content in context to restore it.

**How to apply:**
- Archives are written only by `cat >> file <<'EOF'` appends (or a script that appends). Never `Write`, never
  `>` redirect, never `sed -i` on them except for a single-row strike-through that a human asked for.
- Report-writer dispatch prompts must say: "needs-manual goes into `_NEEDS-MANUAL-<run>.md` (new file) or is
  appended — you may not Write `_NEEDS-MANUAL.md`". Prefer per-run files; the coordinator appends.
- Before dispatching any agent that touches `qa-reports/_*.md`, size-check after it returns:
  `wc -c` smaller than before = overwrite → stop and report.
- Worth adding: a PreToolUse guard that denies `Write`/`>` on `_NEEDS-MANUAL.md`, `_HISTORY.md`, `_LEDGER-*`,
  `_INTAKE-*` (same pattern as the Linear write gate), and a nightly `tar` of `qa-reports/_*.md` into
  `backups/`.

Related: [[memory-model]], [[qa-hub-gates-and-rules]], [[qa-orchestrator-stalls-large-runs]].

**2026-10-09:** the `archive-guard` hook that enforced this (2026-10-07/08) was retired with the the chat-bot integration removal — it ran on every Bash/Write/Edit call and blocked ordinary work. The rule is unchanged and now rests on discipline: append with `cat >> '<archive>' <<'EOF'`, never `Write`/`>`/`sed -i`/`rm`/`mv` an archive, grep instead of reading, size-check (`wc -c`) after any agent that touched `qa-reports/_*.md`. Snapshots the guard took are still in `.qa-backups/` (prune with `npm run prune-backups`); `lib/archive-policy.mjs` still classifies paths if a script wants to check itself.
