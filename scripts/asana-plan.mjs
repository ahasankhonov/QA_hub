#!/usr/bin/env node
// E-1, Asana edition — generate the exact tracker call plan from the ledger for a project that
// tracks in Asana (gamma). Deterministic: same ledger + live pull in, same calls out, byte for
// byte. No model chooses a column, a section gid, an order or a body here.
//
// This is scripts/jira-plan.mjs with the tracker swapped. The plan file is byte-compatible with
// what scripts/qa-approve.mjs consumes, and the PreToolUse gate refuses every Asana call that is
// not in an approved plan (lib/tracker-ops.mjs gates *every* Asana tool except explicit reads).
// The shape of the calls lives in lib/asana-ops.mjs.
//
// Differences from the Jira generator, all forced by Asana:
//   · a column is a per-board section gid, so every ticket needs its board — which only the live
//     pull knows. --live is REQUIRED, and a ledger ticket missing from it is refused, not skipped;
//   · the ledger says GAM-<n>, the API wants a task gid — also from the live pull;
//   · the connector's tool and argument names are pinned in the profile, stamped toolsVerifiedAt
//     (see lib/asana-ops.mjs). Without that stamp nothing is planned.
//
// New bugs ("Reopen + comment + linked bug") are reported in the notes, never written from here.
//
// moveMode "manual" (profile.asana.moveMode — gamma, because the connector has no move-to-section
// tool): the ops are comments only. Each column move goes into plan.manualMoves — inside the file
// that qa-approve hashes, so the approved plan freezes the moves too — and into a checklist
// _ASANA-MOVES-<run>.md for the user to do by hand after the comments are posted.
// scripts/asana-moves-check.mjs then checks a fresh READ-only pull against that list.
//
//   node scripts/asana-plan.mjs --ledger _LEDGER-R1.json --live _LIVE-R1.json [--out _ASANA-PLAN-R1.json]

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { args, fail, loadProfile, HUB } from '../lib/profile.mjs';
import { validateLedger } from '../lib/ledger.mjs';
import { route, stateFor } from '../lib/routing.mjs';
import { canonicalOp, describeOp, sha256, defaultMaxApplies } from '../lib/tracker-ops.mjs';
import { asanaConfig, commentOp, moveOp, isManualMove, sectionGidFor } from '../lib/asana-ops.mjs';

const { flags } = args();
if (!flags.ledger || !flags.live)
  fail('usage: asana-plan.mjs --ledger <ledger.json> --live <live.json> [--project <slug>] [--out <plan.json>] [--only GAM-1,GAM-2] [--comment-only] [--force]', 2);

const ledgerPath = resolve(flags.ledger);
const ledgerRaw = readFileSync(ledgerPath, 'utf8');
const ledger = JSON.parse(ledgerRaw);
const slug = flags.project || ledger.project;
const profile = loadProfile(slug);

if (profile.tracker?.kind !== 'asana')
  fail(`[asana-plan] ${slug} does not track in Asana (tracker.kind = ${profile.tracker?.kind || 'unset'}) — refusing (R-01)`, 2);

// ---- (a) the profile must carry the workspace's own gids, columns and verified tool shapes ----
let asana;
try {
  asana = asanaConfig(profile);
} catch (e) {
  fail(
    `[asana-plan] ${slug}: ${e.message} — refusing to plan Asana writes without the workspace's own ` +
      `board/section gids and the connector's verified tool + argument names (R-01/R-04). Read them ` +
      `(READ-only) into profiles/${slug}.json first. A guessed section gid moves a task somewhere nobody approved.`,
    2,
  );
}
const manual = isManualMove(asana);
const stateMap = profile.linear?.stateMap;
if (!stateMap)
  fail(`[asana-plan] ${slug} has no linear.stateMap — refusing to plan tracker writes with another project's default column names (R-04).`, 2);

// ---- (b) an invalid ledger is not a source of truth -----------------------------------------
const { errors } = validateLedger(ledger, { profile, currentBuildId: ledger.build?.buildId });
if (errors.length && !flags.force) {
  console.error('[asana-plan] refusing to plan writes from an invalid ledger:');
  for (const e of errors) console.error(`  ✗ ${e}`);
  process.exit(1);
}
const forced = errors.length > 0;
if (forced)
  console.error(`[asana-plan] ⚠ --force: planning from a ledger with ${errors.length} validation error(s); the plan is marked forced and qa-approve will refuse it without --accept-forced`);

// ---- (c) the live pull: GAM id → task gid + board + current column --------------------------
if (!existsSync(flags.live)) fail(`[asana-plan] --live ${flags.live} does not exist`, 2);
const live = new Map();
{
  const raw = JSON.parse(readFileSync(flags.live, 'utf8'));
  for (const t of Array.isArray(raw) ? raw : raw.tickets || []) live.set(t.id, t);
}

let plannedTickets = ledger.tickets;
if (flags.only) {
  const want = String(flags.only).split(',').map((s) => s.trim()).filter(Boolean);
  const have = new Set(ledger.tickets.map((t) => t.id));
  const unknown = want.filter((id) => !have.has(id));
  if (unknown.length) fail(`[asana-plan] --only names ticket(s) not in the ledger: ${unknown.join(', ')}`, 2);
  const sel = new Set(want);
  plannedTickets = ledger.tickets.filter((t) => sel.has(t.id));
}

/** Routes whose target column IS where the ticket already belongs — comment, never move (R-02/R-04). */
const HOLD_ROUTES = new Set(['stagingQaHold', 'blocked']);

const ops = [];
const manualMoves = [];
const notes = [];
const unmapped = [];
let n = 0;
const add = (tool, argsObj, meta = {}) => {
  const opId = `op-${String(++n).padStart(3, '0')}`;
  const base = describeOp(tool, argsObj);
  const summary = meta.kind === 'state' ? `${meta.ticket} → "${meta.to}" on ${meta.board} (from ${meta.from || '?'}) — ${base}` : `${meta.ticket}: ${base}`;
  ops.push({ opId, tool, args: argsObj, summary, maxApplies: defaultMaxApplies(meta.kind), ...meta });
};

for (const t of plannedTickets) {
  let r;
  try {
    r = route(t);
  } catch (e) {
    notes.push(`${t.id}: skipped — ${e.message}`);
    continue;
  }
  const rec = live.get(t.id);
  if (!rec || !rec.gid || !rec.board) {
    // Not skippable: the ticket would keep its old column while the run reported it as handled.
    unmapped.push(t.id);
    continue;
  }

  // ---- (d) comment first — the explanation belongs on the task before the column moves ------
  if (t.comment) {
    const c = commentOp(rec.gid, t.comment, asana);
    add(c.tool, c.args, { ticket: t.id, board: rec.board, kind: 'comment' });
  }

  // ---- (e) the column move, last ------------------------------------------------------------
  const target = stateFor(r.route, stateMap);
  if (flags['comment-only']) {
    notes.push(`${t.id}: ${t.verdict} — routed to "${target}", move suppressed (--comment-only)`);
    continue;
  }
  if (HOLD_ROUTES.has(r.route)) {
    notes.push(`${t.id}: ${t.verdict} — stays in ${target} (hold)`);
    continue;
  }
  const current = rec.section || rec.state || rec.status || null;
  if (current && current === target) {
    notes.push(`${t.id}: already in "${target}" — no move planned`);
    continue;
  }
  let op;
  try {
    op = manual ? null : moveOp(rec.gid, rec.board, target, asana);
    if (manual) {
      const sectionGid = sectionGidFor(rec.board, target, asana); // throws on an unknown board/column
      const projectGid = String(asana.boards[rec.board].projectGid);
      manualMoves.push({
        ticket: t.id, taskGid: String(rec.gid), board: rec.board, projectGid, from: current, to: target,
        sectionGid, url: `https://app.asana.com/0/${projectGid}/${rec.gid}`,
      });
    }
  } catch (e) {
    fail(`[asana-plan] ${t.id}: ${e.message} — read the section gid off the board into profiles/${slug}.json and regenerate.`, 1);
  }
  if (op) add(op.tool, op.args, { ticket: t.id, board: rec.board, kind: 'state', from: current, to: target });
}

if (unmapped.length)
  fail(
    `[asana-plan] ${unmapped.length} ledger ticket(s) have no task gid/board in the live pull: ${unmapped.join(', ')}\n` +
      `Re-pull them (READ-only) so every ticket has { id, gid, board, section } and regenerate.`,
    1,
  );

for (const [field, list] of [['newBugs', ledger.newBugs], ['candidateBugs', ledger.candidateBugs]]) {
  for (const b of list || []) notes.push(`ledger.${field}: "${b.title || b.id || '(untitled)'}" not planned — new Asana bugs are filed separately (Gathering Requirements on the app's board)`);
}

const plan = {
  schemaVersion: 1,
  project: slug,
  runId: ledger.runId,
  generatedAt: new Date().toISOString(),
  ledgerFile: basename(ledgerPath),
  ledgerSha256: sha256(ledgerRaw),
  forced,
  commentOnly: !!flags['comment-only'],
  moveMode: manual ? 'manual' : 'tool',
  manualMoves: manual ? manualMoves : undefined,
  forcedValidationErrors: forced ? errors : undefined,
  build: ledger.build?.buildId || null,
  ops: ops.map((o) => ({ ...o, hash: canonicalOp(o.tool, o.args).hash })),
  notes,
};

const out = flags.out ? resolve(HUB, flags.out) : join(dirname(ledgerPath), `_ASANA-PLAN-${ledger.runId}.json`);
mkdirSync(dirname(out), { recursive: true });
const planRaw = JSON.stringify(plan, null, 2) + '\n';
writeFileSync(out, planRaw);

// ---- (f) manual mode: the moves become a checklist for the user, not tool calls ---------------
let movesOut = null;
if (manual && manualMoves.length) {
  movesOut = join(dirname(out), `_ASANA-MOVES-${ledger.runId}.md`);
  const lines = [
    `# Asana moves to do by hand — run ${ledger.runId}`,
    '',
    `From \`${basename(out)}\` (sha256 ${sha256(planRaw).slice(0, 16)}…). The Asana connector cannot move a task`,
    'to another column, so these are not tool calls. They are part of the plan you approve.',
    '',
    '**Do them after the approved comments are posted** (the comment explains the move).',
    '',
    ...manualMoves.map((m, i) => `- [ ] ${i + 1}. **${m.ticket}** (${m.board}): ${m.from || '?'} → **${m.to}** — ${m.url}`),
    '',
    'When done, pull the tickets again (READ-only) and check:',
    '',
    `    node scripts/asana-moves-check.mjs --plan ${out} --live <fresh live pull>`,
    '',
  ];
  writeFileSync(movesOut, lines.join('\n'));
}

const byKind = {};
for (const o of ops) byKind[o.kind || o.tool] = (byKind[o.kind || o.tool] || 0) + 1;

console.log(`[asana-plan] wrote ${out}`);
console.log(`  ${ops.length} operations across ${new Set(ops.map((o) => o.ticket).filter(Boolean)).size} tickets (Asana)`);
for (const [k, v] of Object.entries(byKind)) console.log(`    ${k.padEnd(18)} ${v}`);
if (manual) {
  console.log(`  ${manualMoves.length} column move(s) for the user to do by hand (moveMode "manual")`);
  if (movesOut) console.log(`    checklist: ${movesOut}`);
  if (ops.length === 0) console.log('  No tracker calls to approve — only the manual moves.');
}
if (notes.length) {
  console.log('\n  Not planned (and why):');
  for (const x of notes) console.log(`    · ${x}`);
}
console.log(
  `\n  Nothing is authorised yet. Show this plan to the user, and only if they approve:\n` +
    `    node scripts/qa-approve.mjs --plan ${out} --user-quote "<their exact words>"`
);
