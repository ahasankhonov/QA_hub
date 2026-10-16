#!/usr/bin/env node
// Run every gate that applies to a run, in dependency order, and stop at the first failure.
// One command so no phase can "forget" a check.
//
//   node scripts/qa-gates.mjs --project alpha --run R4 [--strict] [--reports-dir <dir>] [--ignore-intake-shard <a,b>]
//                             [--allow-thin-raw "<reason>"]   ← passed to every H-1 row (intake-assert raw floor)
//
// Looks in projects/<slug>/qa-reports for the conventional filenames and skips gates whose inputs
// are not present yet — but it always says which ones it skipped, lists them again at the end
// (R-07: nothing invisible), and --strict turns any skip into a failure.
//
// Rows: preflight (only when _PREFLIGHT-<run>.json exists; a STOP on record fails) · R-06 build id · H-1 intake (per shard; a raw pull without its spec FAILS) ·
//       R-09/R-05 run results (per results dir, tied to the run build) · R-11 ledger (tied to the run build) ·
//       R-07 run plan (ticket-less runs only) · R-19 node handoffs (node-graph runs only: <run>-graph/ exists) ·
//       R-19 Slack replies (graph runs with a Slack thread only; an undecided reply fails under --strict).

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { args, fail, reportsDir, HUB } from '../lib/profile.mjs';
import { readEvents, readJsonSafe, slackReplyStatus, tsIso } from '../lib/graph.mjs';

const { flags } = args();
if (!flags.project || !flags.run)
  fail('usage: qa-gates.mjs --project <slug> --run <runId> [--strict] [--reports-dir <dir>] [--ignore-intake-shard <a,b>] [--allow-thin-raw "<reason>"]', 2);

const dir = typeof flags['reports-dir'] === 'string' ? flags['reports-dir'] : reportsDir(flags.project);
const f = (name) => join(dir, name);
const has = (name) => existsSync(f(name));
const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const RUN = escapeRegExp(flags.run); // run ids like "R-20260814-BUGHUNT" or "SQA59.2" must match literally
// '' names the unsharded pull (_INTAKE-<run>-raw.json) — the H-1 failure message tells the user to
// pass exactly that, so an explicit empty value must survive (filter(Boolean) used to drop it).
const ignoredShards = new Set(
  typeof flags['ignore-intake-shard'] === 'string'
    ? flags['ignore-intake-shard'].trim() === ''
      ? ['']
      : flags['ignore-intake-shard'].split(',').map((s) => s.trim()).filter(Boolean)
    : []
);

// --- R-06: the run's build id -----------------------------------------------------------------
const buildFile = f(`_BUILD-${flags.run}.json`);
let buildInfo = null;
if (existsSync(buildFile)) {
  try {
    buildInfo = JSON.parse(readFileSync(buildFile, 'utf8'));
  } catch (e) {
    fail(`[qa-gates] ${buildFile} is not valid JSON (${e.message}) — R-06 fails closed`);
  }
  if (!buildInfo?.buildId) fail(`[qa-gates] ${buildFile} has no buildId — R-06 fails closed`);
}
const buildId = buildInfo?.buildId || null;
const buildIncomplete =
  !!buildInfo &&
  (buildInfo.incomplete === true ||
    (Array.isArray(buildInfo.parts) && buildInfo.parts.some((p) => p && p.ok === false)) ||
    /\b(unknown|null|undefined|error|failed)\b/i.test(String(buildId)));

const entries = existsSync(dir) ? readdirSync(dir).sort() : [];

// --- R-07: the ticket-less run plan reconciles (Beta mobile R-20260929-AND has no tracker
// tickets, so its "live queue" is `_CASES-<run>.json` cross-checked against `_PARITY-MATRIX-
// <run>.json` instead of a `_LIVE-<run>.json` pull). Only added for a run that actually has a
// _CASES file — a ticket-mode run (which never had a run-plan gate here before) is completely
// unaffected, so its gate count does not change. Validate-only (no --out): a real run's own
// _RUN-PLAN-<run>.json is never touched by running the gates. --------------------------------
const casesFile = f(`_CASES-${flags.run}.json`);
const matrixFile = f(`_PARITY-MATRIX-${flags.run}.json`);
const runPlanGate = existsSync(casesFile)
  ? existsSync(matrixFile)
    ? {
        id: 'R-07 run-plan [ticket-less]',
        when: !!buildId,
        why: `_CASES-${flags.run}.json present but no build id (_BUILD-${flags.run}.json) — R-06 gates R-07`,
        cmd: ['scripts/run-plan.mjs', '--project', flags.project, '--cases', casesFile, '--matrix', matrixFile, '--build', String(buildId)],
      }
    : {
        id: 'R-07 run-plan [ticket-less]',
        when: false,
        why: `_CASES-${flags.run}.json present but no _PARITY-MATRIX-${flags.run}.json to cross-reference against`,
      }
  : null;

/**
 * A big run is SHARDED: execution splits into `<run>-P<n>-results/` directories and intake into
 * `_INTAKE-<run>-<shard>{,-raw}.json` pairs. This runner originally looked only for the flat,
 * single-file layout, so on a sharded run BOTH the intake gate and the run-result gate quietly
 * skipped — and a skipped gate is not a passed one. Found on alpha R4 (2026-08-13), where 99
 * tickets across 11 result directories would have been reported as gated when nothing had been
 * checked. Discover both layouts.
 */
const resultDirs = entries
  .filter((e) => new RegExp(`^${RUN}-.*-results$`).test(e))
  .filter((e) => statSync(join(dir, e)).isDirectory())
  .map((e) => join(dir, e));
if (entries.some((e) => new RegExp(`^_RESULT-${RUN}-.*\\.json$`).test(e))) resultDirs.unshift(dir);

// Intake: every raw pull must have its emitted spec. A raw file alone means a whole shard of tickets
// was pulled and never parsed, planned or run — the exact H-1 gap the gate exists for.
const intakePairs = [];
const intakeOrphans = [];
if (has(`_INTAKE-${flags.run}-raw.json`)) {
  if (has(`_INTAKE-${flags.run}.json`)) intakePairs.push({ shard: '', raw: f(`_INTAKE-${flags.run}-raw.json`), spec: f(`_INTAKE-${flags.run}.json`) });
  else intakeOrphans.push({ shard: '', raw: `_INTAKE-${flags.run}-raw.json` });
}
for (const e of entries) {
  const m = e.match(new RegExp(`^_INTAKE-${RUN}-(.+)-raw\\.json$`));
  if (!m) continue;
  const spec = `_INTAKE-${flags.run}-${m[1]}.json`;
  if (has(spec)) intakePairs.push({ shard: m[1], raw: f(e), spec: f(spec) });
  else intakeOrphans.push({ shard: m[1], raw: e });
}

const planFiles = entries.filter((e) => e.startsWith(`_PLAN-${flags.run}-`) && e.endsWith('.json')).map(f);

const graphRunDir = join(dir, `${flags.run}-graph`);
// A handoff in the trace makes R-19 due even when its file is missing; an unreadable trace runs the gate too.
const tracedHandoff = (d) => { try { return readEvents(d).some((e) => e.event === 'handoff'); } catch { return true; } };
const label = (shard) => (shard ? ` [${shard}]` : '');
const gates = [
  // Preflight (2026-10-16, idea from LambdaTest/agent-skills): the environment check the orchestrator
  // runs before intake. Only added when the run has a _PREFLIGHT file, so other runs keep their gate
  // count; it fails while the file still holds a STOP (rerun preflight.mjs --write after the fix).
  ...(has(`_PREFLIGHT-${flags.run}.json`)
    ? [{
        id: 'preflight',
        when: true,
        inline: () => {
          const pf = readJsonSafe(f(`_PREFLIGHT-${flags.run}.json`));
          if (!pf || !Array.isArray(pf.checks)) return `_PREFLIGHT-${flags.run}.json is unreadable`;
          const stops = pf.checks.filter((c) => c.level === 'stop');
          const warns = pf.checks.filter((c) => c.level === 'warn');
          console.log(`  taken ${pf.at || '?'} · ${pf.checks.length} check(s) · ${stops.length} stop · ${warns.length} warn`);
          for (const c of [...stops, ...warns]) console.log(`  ${c.level === 'stop' ? '✗' : '⚠'} ${c.check}: ${c.msg}`);
          return stops.length ? `${stops.length} preflight STOP(s) still on record — fix them, then node scripts/preflight.mjs --project ${flags.project} --run ${flags.run} --write` : null;
        },
      }]
    : []),
  ...(runPlanGate ? [runPlanGate] : []),
  buildId
    ? {
        id: 'R-06 build id',
        when: true,
        inline: () => {
          console.log(`  ${buildId}`);
          if (buildIncomplete) {
            const failedParts = (buildInfo.parts || []).filter((p) => p && p.ok === false).map((p) => p.name || '?');
            console.log(`  ⚠ INCOMPLETE build id${failedParts.length ? ` — failed probe(s): ${failedParts.join(', ')}` : ''}. Verdicts keyed on it cannot be carried forward safely.`);
            return flags.strict ? 'build id is incomplete (--strict)' : null;
          }
          return null;
        },
      }
    : {
        id: 'R-06 build id',
        when: false,
        why: `no _BUILD-${flags.run}.json — results and ledger are checked for self-consistency only, NOT against the run build. Fix: node scripts/build-id.mjs ${flags.project} --write projects/${flags.project}/qa-reports/_BUILD-${flags.run}.json`,
      },
  ...intakePairs.map((p) => ({
    id: `H-1 intake${label(p.shard)}`,
    when: true,
    // a bare --allow-thin-raw is passed on bare, so intake-assert refuses it for want of a reason
    cmd: ['scripts/intake-assert.mjs', '--raw', p.raw, '--spec', p.spec, ...(typeof flags['allow-thin-raw'] === 'string' ? ['--allow-thin-raw', flags['allow-thin-raw']] : flags['allow-thin-raw'] ? ['--allow-thin-raw'] : [])],
  })),
  ...intakeOrphans.map((o) =>
    ignoredShards.has(o.shard || '')
      ? { id: `H-1 intake${label(o.shard)}`, when: false, why: `${o.raw} has no spec — superseded per --ignore-intake-shard` }
      : { id: `H-1 intake${label(o.shard)}`, when: true, inline: () => `${o.raw} has no emitted spec — every ticket in this pull was never parsed, planned or run (H-1). Emit the spec, or pass --ignore-intake-shard ${o.shard || "''"} if the shard was superseded.` }
  ),
  ...(intakePairs.length || intakeOrphans.length ? [] : [{ id: 'H-1 intake', when: false, why: `no _INTAKE-${flags.run}[-<shard>]-raw.json + spec pair found` }]),
  // Plan lint (2026-10-16, ideas from qa-skills): a runnable case with no expected result or no caseId
  // fails; test-design gaps (vague expected, no negative case, a write never read back) only print.
  // Only added when the run has plans, so a run without them keeps its gate count.
  ...(planFiles.length
    ? [{ id: 'plan lint', when: true, cmd: ['scripts/plan-lint.mjs', ...planFiles] }]
    : []),
  ...resultDirs.map((d) => ({
    id: `R-09/R-05 run results [${d === dir ? 'flat' : d.split('/').pop()}]`,
    when: true,
    cmd: ['scripts/run-result-validate.mjs', '--dir', d, '--run', flags.run, ...(buildId ? ['--build', buildId] : [])],
  })),
  ...(resultDirs.length ? [] : [{ id: 'R-09/R-05 run results', when: false, why: `no _RESULT-${flags.run}-*.json and no ${flags.run}-*-results/ dir` }]),
  {
    id: 'R-11 ledger',
    when: has(`_LEDGER-${flags.run}.json`),
    why: `needs _LEDGER-${flags.run}.json`,
    cmd: ['scripts/ledger-validate.mjs', '--ledger', f(`_LEDGER-${flags.run}.json`), '--project', flags.project, ...(buildId ? ['--build', buildId] : [])],
  },
  // R-19: every node handoff graded; NO-VERDICT / canary-repeat / reviewer without a canary fail.
  // Only added for a run driven as a node graph (<run>-graph/ exists), like R-07 above, so a legacy
  // run's gate count and its --strict result do not change.
  ...(existsSync(graphRunDir)
    ? [{
        id: 'R-19 handoffs',
        when: (existsSync(join(graphRunDir, 'handoffs')) && readdirSync(join(graphRunDir, 'handoffs')).some((e) => e.endsWith('.md'))) || tracedHandoff(graphRunDir),
        why: `${flags.run}-graph/ has no handoffs/*.md and no handoff in its trace yet`,
        cmd: ['scripts/handoff-grade.mjs', '--project', flags.project, '--run', flags.run, '--reports-dir', dir],
      }]
    : []),
  // R-19 Slack replies: only for a graph run with a Slack thread. Every decision on a reply is one note
  // with the user's own words; a bookkeeping error fails, a reply still waiting fails only under --strict.
  ...(existsSync(join(graphRunDir, '_SLACK.json')) || existsSync(join(graphRunDir, '_SLACK-REPLIES.jsonl'))
    ? [{
        id: 'R-19 Slack replies',
        when: true,
        inline: () => {
          let events;
          try { events = readEvents(graphRunDir); } catch (e) { return `trace unreadable: ${e.message}`; }
          const s = slackReplyStatus(graphRunDir, events);
          const cursor = readJsonSafe(join(graphRunDir, '_SLACK.json'))?.repliesCursor;
          console.log(`  ${s.replies.length} read · ${s.decided.length} decided · ${s.pending.length} waiting${s.deleted.length ? ` · ${s.deleted.length} deleted by their author` : ''} · read up to ${cursor ? tsIso(cursor) : 'nothing yet'} (a later reply is read on the next slack-window.mjs --send or --replies)`);
          for (const p of s.problems) console.log(`  ✗ ${p}`);
          if (s.problems.length) return `${s.problems.length} bookkeeping error(s) in the thread-reply decisions`;
          if (s.pending.length) {
            console.log(`  ⚠ ${s.pending.length} thread repl${s.pending.length === 1 ? 'y waits' : 'ies wait'} for the user's decision: ${s.pending.slice(0, 8).map((r) => 'slack:' + r.ts).join(', ')}${s.pending.length > 8 ? ', …' : ''}`);
            return flags.strict ? `${s.pending.length} thread repl${s.pending.length === 1 ? 'y' : 'ies'} not decided (--strict)` : null;
          }
          return null;
        },
      }]
    : []),
];

let ran = 0;
const skipped = [];
for (const g of gates) {
  if (!g.when) {
    console.log(`— SKIP ${g.id} (${g.why})`);
    skipped.push(g.id);
    continue;
  }
  console.log(`\n═══ ${g.id} ═══`);
  let error = null;
  if (g.inline) error = g.inline();
  else {
    const res = spawnSync('node', g.cmd, { cwd: HUB, stdio: 'inherit' });
    if (res.status !== 0) error = `exit ${res.status}`;
  }
  ran++;
  if (error) {
    console.error(`\n[qa-gates] ${g.id} FAILED (${error}) — stopping. Fix it before the next phase.`);
    process.exit(1);
  }
}

console.log(`\n[qa-gates] ${ran} gate(s) passed for ${flags.project} run ${flags.run}${buildId ? ` @ ${buildId}` : ''}.`);
if (skipped.length) console.log(`  skipped (not passed): ${skipped.join(' · ')}`);
if (ran === 0) console.log('  (nothing to check yet — that is not the same as a clean run, R-07)');
if (flags.strict && skipped.length) {
  console.error(`[qa-gates] --strict: ${skipped.length} gate(s) skipped — a skipped gate is not a passed one.`);
  process.exit(1);
}
