#!/usr/bin/env node
// PreToolUse gate for tracker writes (Linear / Jira / Confluence / Asana). Enforces R-01.
//
// Deny by default. A call is allowed only when its canonical hash appears in a non-expired
// approval file under <hub>/.qa-approvals/, and that approval still matches the plan on disk.
// Every failure mode — bad JSON, missing dir, tampered plan, an exception in this file — denies.
//
// This exists because "never write to Linear without approval" was written in eleven prose files
// and waived by two lines of settings allowlist. Prose is not a control.

import { readFileSync, readdirSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { canonicalOp, isTrackerWrite, describeOp, sha256, configProblem, clip, writeHookOutput, readRegularFile } from '../../lib/tracker-ops.mjs';

const HUB = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const APPROVALS = join(HUB, '.qa-approvals');

/**
 * FS-01: the reason is clipped and the JSON written synchronously before exit. process.stdout.write()
 * then process.exit() cut a 70 KB reason at the 64 KB pipe buffer, and truncated JSON at exit 0 is
 * no decision at all — the gate failed open. A failed write exits 2 (blocking) instead.
 */
function emit(decision, reason) {
  try {
    writeHookOutput({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: decision,
        permissionDecisionReason: clip(reason),
      },
    });
  } catch (e) {
    process.stderr.write(`R-01: write gate could not write its decision (${e && e.message}); blocking.\n`);
    process.exit(2);
  }
  process.exit(0);
}

const deny = (reason) => emit('deny', reason);
const allow = (reason) => emit('allow', reason);
/** Fall through to the normal permission prompt — used for non-tracker tools only. */
const passthrough = () => process.exit(0);

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

/**
 * R-01 self-protection: if ANY settings file Claude Code merges has been re-poisoned with a tracker
 * write tool or with the approval script itself, or the Telegram DM allowlist lets anyone but the
 * owner answer permission prompts, the gate is no longer the only door — so it closes every door.
 * (lib/tracker-ops.mjs configProblem: all settings files + access.json.)
 */
function assertConfigSafe() {
  const problem = configProblem({ hub: HUB, home: process.env.HOME || homedir(), env: process.env });
  if (problem) deny(problem);
}

function loadApprovals(nowMs) {
  if (!existsSync(APPROVALS)) return { approvals: [], notes: ['no .qa-approvals/ directory'] };
  const notes = [];
  const approvals = [];
  for (const f of readdirSync(APPROVALS)) {
    if (!f.endsWith('.approved.json')) continue;
    const path = join(APPROVALS, f);
    let a;
    try {
      a = JSON.parse(readRegularFile(path));
    } catch (e) {
      notes.push(`${f}: unparseable (${e.message}) — ignored`);
      continue;
    }
    if (!a.expiresAt || Date.parse(a.expiresAt) < nowMs) {
      notes.push(`${f}: expired ${a.expiresAt} — ignored`);
      continue;
    }
    // Tamper check: the plan the human approved must be the plan still on disk.
    const planPath = resolve(HUB, a.planPath || '');
    if (!a.planPath || !existsSync(planPath)) {
      notes.push(`${f}: plan ${a.planPath} missing — ignored`);
      continue;
    }
    let actual;
    try {
      actual = sha256(readRegularFile(planPath));
    } catch (e) {
      notes.push(`${f}: plan ${clip(a.planPath, 200)} unreadable (${clip(e.message, 200)}) — ignored`);
      continue;
    }
    if (actual !== a.planSha256) {
      notes.push(`${f}: plan CHANGED since approval (${actual.slice(0, 12)} != ${String(a.planSha256).slice(0, 12)}) — VOID`);
      continue;
    }
    if (!Array.isArray(a.ops) || a.ops.length === 0) {
      notes.push(`${f}: no ops — ignored`);
      continue;
    }
    approvals.push({ ...a, _file: f });
  }
  return { approvals, notes };
}

function appliedCount(runId, opHash) {
  const path = join(APPROVALS, `${runId}.applied.jsonl`);
  if (!existsSync(path)) return 0;
  let n = 0;
  for (const line of readRegularFile(path).split('\n')) {
    if (!line.trim()) continue;
    try {
      if (JSON.parse(line).hash === opHash) n++;
    } catch {
      /* a corrupt audit line must not silently reset the counter */
      n++;
    }
  }
  return n;
}

function record(runId, entry) {
  mkdirSync(APPROVALS, { recursive: true });
  appendFileSync(join(APPROVALS, `${runId}.applied.jsonl`), JSON.stringify(entry) + '\n');
  appendFileSync(join(APPROVALS, 'audit.jsonl'), JSON.stringify(entry) + '\n');
}

function main() {
  const raw = readStdin();
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    // We cannot tell what tool this is. If the matcher routed it here it is a tracker tool.
    deny('R-01: hook received unparseable input; denying fail-closed.');
  }

  // FS-09: Claude Code always sends an object with a string tool_name. Anything else (an array, a bare
  // string, null, no tool_name) cannot be classified — and the matcher routed it here — so deny.
  if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.tool_name !== 'string' || !input.tool_name)
    deny('R-01: hook input is not a tool-call object with a tool_name; denying fail-closed.');
  const toolName = input.tool_name;
  if (!isTrackerWrite(toolName)) passthrough(); // reads and everything else: normal handling

  assertConfigSafe();

  const now = Date.now();
  const { approvals, notes } = loadApprovals(now);
  const ti = input.tool_input && typeof input.tool_input === 'object' && !Array.isArray(input.tool_input) ? input.tool_input : null;
  if (!ti) deny(`R-01 DENIED — ${clip(toolName, 120)}: tool_input is missing or not an object; denying fail-closed.`);
  const op = canonicalOp(toolName, ti);
  const human = describeOp(toolName, ti);

  if (approvals.length === 0) {
    deny(
      `R-01 DENIED — ${human}\n` +
        `No valid approval on file.${notes.length ? '\n  ' + notes.join('\n  ') : ''}\n` +
        `To authorise: generate a call plan (scripts/linear-plan.mjs), show it to the user, and after ` +
        `they approve run: node scripts/qa-approve.mjs --plan <plan.json> --user-quote "<their words>". ` +
        `Do not add this tool to permissions.allow — the gate will refuse everything if you do.`
    );
  }

  for (const a of approvals) {
    const match = a.ops.find((o) => o.hash === op.hash);
    if (!match) continue;
    const max = match.maxApplies ?? a.maxApplies ?? 3;
    const used = appliedCount(a.runId, op.hash);
    if (used >= max) {
      deny(
        `R-01 DENIED — ${human}\nThis op is approved but has already been applied ${used}× ` +
          `(limit ${max}). If a genuine retry is needed, re-approve with a higher --max-applies.`
      );
    }
    record(a.runId, {
      at: new Date().toISOString(),
      runId: a.runId,
      opId: match.opId,
      tool: toolName,
      hash: op.hash,
      summary: human,
      attempt: used + 1,
      session: input.session_id || null,
    });
    allow(`R-01: matches approved op ${match.opId} in ${a._file} (attempt ${used + 1}/${max}).`);
  }

  const sample = approvals
    .map((a) => `${a._file}: ${a.ops.length} approved ops for run ${a.runId}`)
    .join('; ');
  deny(
    `R-01 DENIED — ${human}\n` +
      `This exact call is not in any approved plan (hash ${op.hash.slice(0, 12)}).\n` +
      `On file: ${sample}\n` +
      `Either the content drifted from what was approved, or this write was not proposed at all. ` +
      `Re-generate the plan, show the diff to the user, and re-approve. Never edit an approved plan ` +
      `in place — the gate voids an approval whose plan hash changed.`
  );
}

try {
  main();
} catch (e) {
  deny(`R-01: write gate crashed (${e && e.message}); denying fail-closed.`);
}
