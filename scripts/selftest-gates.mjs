#!/usr/bin/env node
// H-5 — feed every gate a known-bad input and prove it fails.
//
// The review's sharpest line about this system was that its rules were "prose enforced by model
// compliance". The answer to that is code — but a gate that has never rejected anything is just
// prose in a different file. This runs each gate against fixtures that MUST fail and fixtures that
// MUST pass, and is itself the thing that fails when someone loosens a check.
//
//   node scripts/selftest-gates.mjs [--keep]
//
// It never touches a real ledger or a real report. The write gate is exercised against a sandboxed
// copy of itself under .qa-selftest/ with its own settings + approvals — except the end-to-end checks
// in section 6, which drive the INSTALLED hook with a run id of SELFTEST and revoke it afterwards.
//
// Sections, in order:
//   1  R-01 tracker write gate (sandbox + INSTALLED; every settings file)
//   2  H-1 intake (+ raw floor, linear-assemble) · R-06/R-07 run plan + build probe · ticket-less parity, matrix, routing, _CASES
//   3  R-11 ledger validator · R-05/R-09 run results · R-02 asking a human
//   6  E-1 end to end: Linear / Jira / Asana plans → approve → gate, plus the 2026-09-08 audit regressions
//   7  R-11 generated deliverables, and the Beta Android tap guard (harness guard-selftest spawn)
//   8  Section modules (scripts/selftest/*.mjs, each sandboxed under TMP/<name>):
//        session-cost  scripts/session-cost.mjs (npm run cost)
//        jira-attach   R-01 Jira REST screenshot plan + self-gating uploader (sandbox under os.tmpdir)
//        doc-read      R-17 doc-read-guard hook + read-doc CLI + lib/doc-convert.mjs (stub + real markitdown)
//        node-graph    R-19 handoff grading, canary, 2-attempt cap, generated _GRAPH view, qa-gates R-19 row
//        slack-report  scripts/slack-report.mjs: generated counts, leak guard, gates first, edit-in-place (mock Slack)

import { writeFileSync, mkdirSync, rmSync, copyFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { HUB, args, loadProfile } from '../lib/profile.mjs';
import { canonicalOp, describeOp, sha256, isTrackerWrite, isUnsafeAllowEntry, configProblem } from '../lib/tracker-ops.mjs';
import { jiraConfig, transitionIdFor, wafViolations } from '../lib/jira-ops.mjs';
import { validateLedger, computeCounts } from '../lib/ledger.mjs';
import { route } from '../lib/routing.mjs';
import { resolvePattern, extractBuildId, composeBuildId, parseApkBadging, composeApkBuildId, parseIosInfoPlist, composeIosBuildId } from '../lib/build-probe.mjs';
import { assertSurface } from '../harness/beta/config.mjs';
import sessionCostSection from './selftest/session-cost.mjs';
import jiraAttachSection from './selftest/jira-attach.mjs';
import docReadSection from './selftest/doc-read.mjs';
import brainRecallSection from './selftest/brain-recall.mjs';
import nodeGraphSection from './selftest/node-graph.mjs';
import slackReportSection from './selftest/slack-report.mjs';
import repoIdeasSection from './selftest/repo-ideas.mjs';
import qaSkillsIdeasSection from './selftest/qa-skills-ideas.mjs';
import lambdatestIdeasSection from './selftest/lambdatest-ideas.mjs';
import denfryIdeasSection from './selftest/denfry-ideas.mjs';
import qaskills2ClusterSection from './selftest/qaskills2-cluster.mjs';
import qaskills2DedupeSection from './selftest/qaskills2-dedupe.mjs';
import qaskills2ResidueSection from './selftest/qaskills2-residue.mjs';
import qaskills2AccountsSection from './selftest/qaskills2-accounts.mjs';

const { flags } = args();
const TMP = join(HUB, '.qa-selftest');
const BUILD = 'index-SELFTEST01.js';
const OTHER_BUILD = 'index-OLDBUILD9.js';
// Fixture dates are relative: run-plan ages a carried verdict against today (default 14 days), so an
// absolute date silently rots the suite red (it did, from 2026-08-25 on).
const daysAgo = (n) => new Date(Date.now() - n * 86400_000).toISOString();

rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

const w = (name, obj) => {
  const p = join(TMP, name);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) + '\n');
  return p;
};

let passed = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failures.push(`${name}\n      ${String(e.message).split('\n').join('\n      ')}`);
    console.log(`  ✗ ${name}\n      ${String(e.message).split('\n')[0]}`);
  }
}
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
/** A gate that accepts a known-bad input has failed, so say so in those words. */
const mustReject = (res, needle, what) => {
  const out = (res.stdout || '') + (res.stderr || '');
  assert(res.status !== 0, `${what}: the gate ACCEPTED a known-bad input (exit 0).\n${out.slice(0, 600)}`);
  if (needle) assert(out.includes(needle), `${what}: rejected, but not for the expected reason "${needle}".\n${out.slice(0, 600)}`);
};
const mustAccept = (res, what) => {
  const out = (res.stdout || '') + (res.stderr || '');
  assert(res.status === 0, `${what}: the gate REJECTED a known-good input (exit ${res.status}).\n${out.slice(0, 800)}`);
};
const run = (script, argv) => spawnSync('node', [join(HUB, 'scripts', script), ...argv], { encoding: 'utf8' });

// ───────────────────────────────────────────────────────────────────────────────────────────
// 1. R-01 — the tracker write gate
// ───────────────────────────────────────────────────────────────────────────────────────────
console.log('\nR-01 tracker write gate');

// Sandbox: a throwaway hub containing only the gate, its one import, and its own approvals dir.
const SB = join(TMP, 'hub');
mkdirSync(join(SB, '.claude', 'hooks'), { recursive: true });
mkdirSync(join(SB, 'lib'), { recursive: true });
mkdirSync(join(SB, '.qa-approvals'), { recursive: true });
copyFileSync(join(HUB, '.claude', 'hooks', 'tracker-write-gate.mjs'), join(SB, '.claude', 'hooks', 'tracker-write-gate.mjs'));
copyFileSync(join(HUB, 'lib', 'tracker-ops.mjs'), join(SB, 'lib', 'tracker-ops.mjs'));
const GATE = join(SB, '.claude', 'hooks', 'tracker-write-gate.mjs');
const cleanSettings = { permissions: { allow: ['mcp__claude_ai_Linear__list_issue_statuses'] } };
writeFileSync(join(SB, '.claude', 'settings.local.json'), JSON.stringify(cleanSettings, null, 2));

// The sandbox gate gets a sandbox HOME, so the QA lead's real ~/.claude settings cannot flip a sandbox result.
// The INSTALLED gate runs with the real environment.
const SB_HOME = join(TMP, 'home');
mkdirSync(join(SB_HOME, '.claude'), { recursive: true });
const sandboxEnv = () => ({ ...process.env, HOME: SB_HOME });
const hook = (payload, gate = GATE) =>
  spawnSync('node', [gate], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    ...(gate === GATE ? { env: sandboxEnv() } : {}),
  });
const decisionOf = (res) => {
  if (!res.stdout.trim()) return { decision: 'passthrough', reason: '' };
  const j = JSON.parse(res.stdout);
  return { decision: j.hookSpecificOutput.permissionDecision, reason: j.hookSpecificOutput.permissionDecisionReason };
};

/** The approval path: qa-approve freezes the plan by sha256 against the user's quote. */
const approve = (planPath, quote, extra = []) => run('qa-approve.mjs', ['--plan', planPath, '--user-quote', quote, ...extra]);

const SAVE = 'mcp__claude_ai_Linear__save_issue';
const stateOp = { id: 'ALP-999', state: 'Reopen' };
const commentOp = { issueId: 'ALP-999', body: 'The dealer inventory page still 500s on load.\n\n@Dev Lead' };

check('a read tool falls through to normal handling', () => {
  const r = hook({ tool_name: 'mcp__claude_ai_Linear__list_issues', tool_input: { team: 'Alpha' } });
  assert(decisionOf(r).decision === 'passthrough', `expected passthrough, got ${r.stdout}`);
});

check('an unapproved state change is DENIED', () => {
  const d = decisionOf(hook({ tool_name: SAVE, tool_input: stateOp }));
  assert(d.decision === 'deny', `expected deny, got ${d.decision}`);
  assert(/No valid approval/.test(d.reason), `wrong reason: ${d.reason}`);
});

check('an unapproved comment is DENIED', () => {
  const d = decisionOf(hook({ tool_name: 'mcp__claude_ai_Linear__save_comment', tool_input: commentOp }));
  assert(d.decision === 'deny', `expected deny, got ${d.decision}`);
});

check('unparseable hook input is DENIED (fail closed)', () => {
  const d = decisionOf(hook('{not json'));
  assert(d.decision === 'deny', `expected deny, got ${d.decision}`);
});

// Now install a valid approval in the sandbox and re-test.
const sbPlan = { schemaVersion: 1, project: 'selftest', runId: 'SELFTEST', ops: [
  { opId: 'op-001', tool: SAVE, args: stateOp, hash: canonicalOp(SAVE, stateOp).hash },
] };
const sbPlanPath = join(SB, 'plan.json');
const writeSbApproval = (over = {}) => {
  const raw = JSON.stringify(sbPlan, null, 2) + '\n';
  writeFileSync(sbPlanPath, raw);
  const approval = {
    schemaVersion: 1,
    runId: 'SELFTEST',
    project: 'selftest',
    approvedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    userQuote: 'selftest',
    planPath: 'plan.json',
    planSha256: sha256(raw),
    maxApplies: 1,
    ops: [{ opId: 'op-001', tool: SAVE, hash: canonicalOp(SAVE, stateOp).hash, ticket: 'ALP-999' }],
    ...over,
  };
  writeFileSync(join(SB, '.qa-approvals', 'SELFTEST.approved.json'), JSON.stringify(approval, null, 2));
  rmSync(join(SB, '.qa-approvals', 'SELFTEST.applied.jsonl'), { force: true });
};

check('an approved op is ALLOWED', () => {
  writeSbApproval();
  const d = decisionOf(hook({ tool_name: SAVE, tool_input: stateOp }));
  assert(d.decision === 'allow', `expected allow, got ${d.decision}: ${d.reason}`);
});

check('the same op a second time is DENIED (maxApplies)', () => {
  const d = decisionOf(hook({ tool_name: SAVE, tool_input: stateOp }));
  assert(d.decision === 'deny', `replay was allowed — maxApplies is not enforced`);
  assert(/already been applied/.test(d.reason), d.reason);
});

check('key order and trailing whitespace do not change the hash', () => {
  writeSbApproval();
  const d = decisionOf(hook({ tool_name: SAVE, tool_input: { state: 'Reopen  ', id: 'ALP-999' } }));
  assert(d.decision === 'allow', `canonicalisation is too strict: ${d.reason}`);
});

check('a one-character drift from the approved args is DENIED', () => {
  writeSbApproval();
  const d = decisionOf(hook({ tool_name: SAVE, tool_input: { id: 'ALP-999', state: 'Reopened' } }));
  assert(d.decision === 'deny', 'a different target state was allowed against an approval for another one');
});

check('a different ticket id is DENIED', () => {
  writeSbApproval();
  const d = decisionOf(hook({ tool_name: SAVE, tool_input: { id: 'ALP-998', state: 'Reopen' } }));
  assert(d.decision === 'deny', 'the approval leaked onto a ticket it did not name');
});

check('editing the plan after approval VOIDS it', () => {
  writeSbApproval();
  writeFileSync(sbPlanPath, JSON.stringify({ ...sbPlan, tampered: true }, null, 2) + '\n');
  const d = decisionOf(hook({ tool_name: SAVE, tool_input: stateOp }));
  assert(d.decision === 'deny', 'a hand-edited plan still authorised its ops');
  assert(/plan CHANGED|No valid approval/.test(d.reason), d.reason);
});

check('an expired approval is DENIED', () => {
  writeSbApproval({ expiresAt: new Date(Date.now() - 1000).toISOString() });
  const d = decisionOf(hook({ tool_name: SAVE, tool_input: stateOp }));
  assert(d.decision === 'deny', 'an expired approval still authorised a write');
});

check('re-poisoning permissions.allow denies EVERYTHING (self-protection)', () => {
  writeSbApproval();
  writeFileSync(
    join(SB, '.claude', 'settings.local.json'),
    JSON.stringify({ permissions: { allow: ['mcp__claude_ai_Linear__save_issue'] } }, null, 2)
  );
  const d = decisionOf(hook({ tool_name: SAVE, tool_input: stateOp }));
  assert(d.decision === 'deny', 'an allowlisted write tool bypassed the gate — this is exactly defect E-1');
  assert(/CONFIG UNSAFE/.test(d.reason), d.reason);
  writeFileSync(join(SB, '.claude', 'settings.local.json'), JSON.stringify(cleanSettings, null, 2));
});

check('allowlisting qa-approve.mjs itself denies EVERYTHING', () => {
  writeFileSync(
    join(SB, '.claude', 'settings.local.json'),
    JSON.stringify({ permissions: { allow: ['Bash(node scripts/qa-approve.mjs:*)'] } }, null, 2)
  );
  const d = decisionOf(hook({ tool_name: SAVE, tool_input: stateOp }));
  assert(d.decision === 'deny', 'the approval script was pre-approved and the gate did not notice');
  assert(/CONFIG UNSAFE/.test(d.reason), d.reason);
  writeFileSync(join(SB, '.claude', 'settings.local.json'), JSON.stringify(cleanSettings, null, 2));
});

// ── every settings file Claude Code merges, not just settings.local.json ──
const approvedOpAllowed = () => {
  writeSbApproval();
  return decisionOf(hook({ tool_name: SAVE, tool_input: stateOp }));
};
const extraSettings = [
  ['hub .claude/settings.json', join(SB, '.claude', 'settings.json')],
  ['home ~/.claude/settings.json', join(SB_HOME, '.claude', 'settings.json')],
  ['home ~/.claude/settings.local.json', join(SB_HOME, '.claude', 'settings.local.json')],
];
for (const [label, file] of extraSettings) {
  check(`an unsafe allow in ${label} denies EVERYTHING, naming the file`, () => {
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, JSON.stringify({ permissions: { allow: ['Bash(node scripts/qa-approve.mjs *)'] } }));
    try {
      const d = approvedOpAllowed();
      assert(d.decision === 'deny' && /CONFIG UNSAFE/.test(d.reason) && d.reason.includes(file), `${label} was not scanned: ${d.decision} ${d.reason}`);
    } finally {
      rmSync(file, { force: true });
    }
  });
  check(`an unparseable ${label} denies EVERYTHING`, () => {
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, '{ "permissions": ');
    try {
      const d = approvedOpAllowed();
      assert(d.decision === 'deny' && /unparseable/.test(d.reason) && d.reason.includes(file), `${label} unparseable did not deny: ${d.decision} ${d.reason}`);
    } finally {
      rmSync(file, { force: true });
    }
  });
  check(`a safe allow in ${label} still lets an approved op through`, () => {
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, JSON.stringify({ permissions: { allow: ['mcp__claude_ai_Linear__get_issue', 'Bash(git status)'] } }));
    try {
      const d = approvedOpAllowed();
      assert(d.decision === 'allow', `a clean ${label} blocked an approved op: ${d.reason}`);
    } finally {
      rmSync(file, { force: true });
    }
  });
}

check('the INSTALLED gate with the REAL environment passes its config checks (the QA lead\'s live config is safe today)', () => {
  const problem = configProblem({ hub: HUB, home: process.env.HOME, env: process.env });
  assert(problem === null, `the live config fails the R-01 scan: ${problem}`);
  const d = decisionOf(hook({ tool_name: SAVE, tool_input: { id: 'ALP-000000', state: 'Done' } }, join(HUB, '.claude', 'hooks', 'tracker-write-gate.mjs')));
  assert(d.decision === 'deny' && !/UNSAFE/.test(d.reason), `the installed gate tripped a config check on the real environment: ${d.reason}`);
});

check('the INSTALLED gate denies an unapproved write right now', () => {
  const d = decisionOf(hook({ tool_name: SAVE, tool_input: { id: 'ALP-000000', state: 'Done' } }, join(HUB, '.claude', 'hooks', 'tracker-write-gate.mjs')));
  assert(d.decision === 'deny', `the real hook allowed an unapproved write: ${d.reason}`);
});

check('the installed settings.local.json is clean', () => {
  const cfg = JSON.parse(readFileSync(join(HUB, '.claude', 'settings.local.json'), 'utf8'));
  const bad = (cfg.permissions?.allow || []).filter((e) => /save_|create_|transitionJiraIssue|qa-approve/.test(String(e)));
  assert(bad.length === 0, `permissions.allow pre-approves: ${bad.join(', ')}`);
  const matcher = JSON.stringify(cfg.hooks?.PreToolUse || []);
  assert(/tracker-write-gate/.test(matcher), 'the write gate is not wired into hooks.PreToolUse');
});

// ───────────────────────────────────────────────────────────────────────────────────────────
// 2. H-1 — intake assertion
// ───────────────────────────────────────────────────────────────────────────────────────────
console.log('\nH-1 intake assertion');

const rawBody = `## Description
Dealer inventory filters.

## Acceptance Criteria
- AC-1 filters persist across pagination
- AC-2 clearing filters restores the full list

## Test Cases
- TC-1.1 apply a make filter
- TC-1.2 paginate and confirm the filter is still applied
- TC-1.3 clear and confirm the count returns
`;
const rawPath = w('intake-raw.json', [{ id: 'ALP-101', title: 'Filters', body: rawBody }]);
const goodSpec = w('intake-spec-good.json', [
  { id: 'ALP-101', acs: ['AC-1 filters persist', 'AC-2 clearing restores'], testCases: [{ id: 'TC-1.1' }, { id: 'TC-1.2' }, { id: 'TC-1.3' }] },
]);
const truncSpec = w('intake-spec-truncated.json', [
  { id: 'ALP-101', acs: ['AC-1 filters persist', 'AC-2 clearing restores'], testCases: [{ id: 'TC-1.1' }, { id: 'TC-1.3' }] },
]);
const droppedSpec = w('intake-spec-dropped.json', []);
const missingAcSpec = w('intake-spec-missing-ac.json', [
  { id: 'ALP-101', acs: ['AC-1 filters persist'], testCases: [{ id: 'TC-1.1' }, { id: 'TC-1.2' }, { id: 'TC-1.3' }] },
]);

check('a complete intake passes', () => mustAccept(run('intake-assert.mjs', ['--raw', rawPath, '--spec', goodSpec]), 'intake-assert'));
check('a silently dropped TC-1.2 is caught', () =>
  mustReject(run('intake-assert.mjs', ['--raw', rawPath, '--spec', truncSpec]), 'TC-1.2', 'intake-assert'));
check('a dropped acceptance criterion is caught', () =>
  mustReject(run('intake-assert.mjs', ['--raw', rawPath, '--spec', missingAcSpec]), 'AC-2', 'intake-assert'));
check('a whole ticket missing from the spec is caught', () =>
  mustReject(run('intake-assert.mjs', ['--raw', rawPath, '--spec', droppedSpec]), 'MISSING', 'intake-assert'));

// Template-blind miss (2026-09-10, beta / Jira BET): bodies with plain "Takrorlash qadamlari:" headings and
// escaped "1\. " steps carry no TC-N.x / AC-n ids, so nothing above counts anything — 37 of 39 tickets passed
// this gate with `testCases: []` and the analysts would have had nothing to plan from.
const jiraBody = (n) =>
  `Xato tavsifi:  \nTugma ishlamaydi ${n}.  \n\nTakrorlash qadamlari:  \n1\\. Sahifani oching.  \n2\\. Tugmani bosing.  \n\nKutilgan natija:  \nSahifa ochiladi.  \n\nHaqiqiy natija:  \nHech narsa bo'lmaydi.  \n`;
const jiraIds = [1, 2, 3, 4];
const jiraRaw = w('intake-raw-jira.json', jiraIds.map((n) => ({ id: `BET-90${n}`, title: `Bug ${n}`, body: jiraBody(n) })));
const jiraGood = w('intake-spec-jira-good.json', jiraIds.map((n) => ({ id: `BET-90${n}`, acs: ['AC-1 Sahifa ochiladi.'], testCases: [{ id: 'TC-1', steps: ['Sahifani oching.', 'Tugmani bosing.'] }] })));
const jiraEmpty = w('intake-spec-jira-empty.json', jiraIds.map((n) => ({ id: `BET-90${n}`, acs: ['AC-1 Sahifa ochiladi.'], testCases: [] })));
const jiraOneMiss = w('intake-spec-jira-onemiss.json', jiraIds.map((n) => ({ id: `BET-90${n}`, acs: ['AC-1 Sahifa ochiladi.'], testCases: n === 1 ? [] : [{ id: 'TC-1', steps: ['a', 'b'] }] })));
check('plain-heading Jira bodies with parsed steps pass (id warnings only)', () =>
  mustAccept(run('intake-assert.mjs', ['--raw', jiraRaw, '--spec', jiraGood]), 'intake-assert'));
check('a template-blind parser (steps in every body, no test case in the spec) is caught as systemic', () =>
  mustReject(run('intake-assert.mjs', ['--raw', jiraRaw, '--spec', jiraEmpty]), 'systemic', 'intake-assert'));
check('one step-less spec among four is a WARN, not a failure', () =>
  mustAccept(run('intake-assert.mjs', ['--raw', jiraRaw, '--spec', jiraOneMiss]), 'intake-assert'));

// Vacuous on Asana (2026-10-06, gamma R-20261006-INTAKE): the raw is { task: { notes } } with no `body`, and
// the criteria sit under a bare "Acceptance Criteria:" line — H-1 read an empty body, expected 0 ACs and
// passed whatever the spec held. Same blind spot for **bold.** headings (Alpha ALP-488, R4-A2).
const asanaNotes = `Dev assignment: the frontend dev
Track: Survey · Epic E2 · Type Feature · Estimate 3d
Depends on: GAM-113

The QC queue lists every survey awaiting review.

Acceptance Criteria:
- Queue shows surveys in Pending QC only
- Sorting by due date works both ways
- Empty state reads "Nothing to review"

Grounded in: SurveyApp FRS v0.7 §4.2`;
const asanaRaw = w('intake-raw-asana.json', [{ id: 'GAM-901', gid: '1644151043371916', task: { gid: '1644151043371916', name: 'QC queue [GAM-901]', notes: asanaNotes }, stories: [] }]);
const asanaGood = w('intake-spec-asana-good.json', [{ id: 'GAM-901', acs: ['Pending QC only', 'Sorting by due date', 'Empty state'], testCases: [] }]);
const asanaShort = w('intake-spec-asana-short.json', [{ id: 'GAM-901', acs: ['Pending QC only', 'Sorting by due date'], testCases: [] }]);
check('an Asana intake (task.notes, plain "Acceptance Criteria:") with every criterion passes', () =>
  mustAccept(run('intake-assert.mjs', ['--raw', asanaRaw, '--spec', asanaGood]), 'intake-assert'));
check('an Asana intake that dropped a criterion is caught (H-1 is not vacuous on task.notes)', () =>
  mustReject(run('intake-assert.mjs', ['--raw', asanaRaw, '--spec', asanaShort]), 'Acceptance Criteria has ~3 items', 'intake-assert'));
const boldRaw = w('intake-raw-bold.json', [{ id: 'ALP-902', title: 'x', body: '**Acceptance criteria.**\n\n* one thing works\n* two things work\n\n**Test cases.**\n\n1. do the first thing\n2. do the second thing\n' }]);
const boldPlaceholder = w('intake-spec-bold-placeholder.json', [{ id: 'ALP-902', acs: [{ id: 'AC-1', text: 'See body for details' }], testCases: [{ id: 'TC-1.1' }] }]);
check('a placeholder spec under **bold.** headings is caught', () =>
  mustReject(run('intake-assert.mjs', ['--raw', boldRaw, '--spec', boldPlaceholder]), 'Test Cases section has ~2 items', 'intake-assert'));

// Raw floor (2026-10-15): H-1 checks the spec against the raw, never the raw against the tracker. Alpha R7
// (2026-09-10) got a model-written "verbatim" raw of 50–200-char bodies for 1,000–3,000-char tickets; R4-B's
// bodies all read "[Ticket ALP-n - see raw fetched data]"; R4-C stitched fragments with "...". Each of those
// fingerprints must fail on its own, the --allow-thin-raw waiver must need a reason, and a real batch must pass.
const realBody = (id, n) =>
  `## Description\nOn the dealer inventory page ${id}, ${'the filter panel keeps its state when the user pages forward and back; '.repeat(2 + n)}reported by the dealer team.\n\n## Acceptance Criteria\n- AC-1 the selected filters persist across pagination\n`;
const realComment = (n) => `Retested on staging build 44${n}: ${'paging forward keeps make and model selected, and the count matches the list. '.repeat(1 + n)}`;
const floorSpec = (ids) => ids.map((id) => ({ id, acs: ['AC-1 the selected filters persist across pagination'], testCases: [] }));
const floorRun = (name, tickets, extra = []) =>
  run('intake-assert.mjs', ['--raw', w(`intake-raw-floor-${name}.json`, tickets), '--spec', w(`intake-spec-floor-${name}.json`, floorSpec(tickets.map((t) => t.id))), ...extra]);
const realTickets = [0, 1, 2].map((n) => ({ id: `ALP-93${n}`, title: `Filters ${n}`, body: realBody(`ALP-93${n}`, n), comments: [{ author: 'Dev', body: realComment(n) }] }));
const thinTickets = [1, 2, 3, 4].map((n) => ({ id: `ALP-94${n}`, title: `Filters ${n}`, body: `Filters reset on page ${n}${'!'.repeat(n)}. AC-1 the selected filters persist across pagination` }));

check('raw floor: a realistic 3-ticket raw with paragraph comments passes', () => mustAccept(floorRun('real', realTickets), 'intake-assert'));
check('raw floor: a batch of ~75-char bodies (median under 150) is caught', () =>
  mustReject(floorRun('thin', thinTickets), 'median body', 'intake-assert'));
check('raw floor: --allow-thin-raw "<reason>" waives the floor and prints the reason', () => {
  const res = floorRun('thin-waived', thinTickets, ['--allow-thin-raw', 'ALP one-line tickets, checked ALP-941 get_issue: 75 chars']);
  mustAccept(res, 'intake-assert --allow-thin-raw');
  assert(res.stdout.includes('checked ALP-941 get_issue'), `the waiver reason is not printed:\n${res.stdout.slice(0, 600)}`);
});
check('raw floor: a bare --allow-thin-raw (no reason) is refused', () =>
  mustReject(floorRun('thin-bare', thinTickets, ['--allow-thin-raw']), 'needs a reason', 'intake-assert'));
check('raw floor: five bodies of one exact length (a filled-in template) are caught', () =>
  mustReject(
    floorRun('samelen', [1, 2, 3, 4, 5].map((n) => ({ id: `ALP-95${n}`, title: 't', body: `Ticket ALP-95${n} on the dealer page. ${'The filter panel keeps its state. '.repeat(5)}` }))),
    'exactly',
    'intake-assert'
  ));
check('raw floor: a "[truncated]" marker in an otherwise long body is caught', () =>
  mustReject(floorRun('marker', [{ ...realTickets[0], body: realTickets[0].body + '\n[truncated]\n' }]), 'summarisation marker', 'intake-assert'));
check('raw floor: text stitched together with "word...word" across the batch is caught', () =>
  mustReject(
    floorRun('elided', realTickets.concat({ ...realTickets[0], id: 'ALP-933' }).map((t, n) => ({ ...t, body: t.body.replace('keeps its state', `keeps its${'s'.repeat(n)}...state`) }))),
    'elided',
    'intake-assert'
  ));
check('raw floor: a spec whose AC text is longer than the raw ticket is caught', () => {
  const raw = w('intake-raw-floor-specover.json', [{ id: 'ALP-960', title: 'Filters', body: 'AC-1 filters persist' }]);
  const spec = w('intake-spec-floor-specover.json', [
    { id: 'ALP-960', acs: [`AC-1 ${'the selected make, model, year and price filters persist across pagination and a page reload; '.repeat(3)}`], testCases: [] },
  ]);
  mustReject(run('intake-assert.mjs', ['--raw', raw, '--spec', spec]), 'longer than the raw', 'intake-assert');
});
check('raw floor: one-line comments (median under 100 over 9 comments) are caught', () =>
  mustReject(
    floorRun('thincomments', realTickets.map((t, i) => ({ ...t, comments: [0, 1, 2].map((k) => ({ author: 'QA', body: `Checked, works ${'.'.repeat(i * 3 + k)}` })) }))),
    'median comment',
    'intake-assert'
  ));
check('raw floor: five comments all of one exact length are caught', () =>
  mustReject(
    floorRun('samelencomments', [{ ...realTickets[0], comments: [1, 2, 3, 4, 5].map((k) => ({ author: 'QA', body: `Retest ${k}: paging keeps the filter.`.padEnd(160, ' ok') })) }]),
    'comments are exactly',
    'intake-assert'
  ));

// linear-assemble (2026-10-15): the raw is assembled from per-ticket get_issue / list_comments dumps by code,
// so no model composes it. Read-only on profiles/alpha.json (prefix ALP); every output goes under TMP.
const linIssue = (n, extra = {}) => ({
  id: `0000000${n}-uuid`,
  identifier: `ALP-97${n}`,
  title: `Filters ${n}`,
  description: realBody(`ALP-97${n}`, n),
  priority: { value: 2, name: 'High' },
  url: `https://linear.app/x/issue/ALP-97${n}`,
  createdAt: daysAgo(10),
  updatedAt: daysAgo(1),
  status: 'Staging QA',
  labels: ['Bug'],
  assignee: 'Dev One',
  relations: { blocks: [], blockedBy: ['ALP-972'], relatedTo: [], duplicateOf: null },
  ...extra,
});
const linComment = (n) => ({ id: `c${n}`, body: realComment(n), createdAt: daysAgo(2), author: { name: 'Dev One' } });
const linDump = (dir, files) => {
  for (const [name, obj] of Object.entries(files)) w(`${dir}/${name}`, obj);
  return join(TMP, dir);
};
const linGood = {
  'issue-ALP-970.json': linIssue(0),
  'comments-ALP-970.json': { comments: [linComment(0), linComment(1)], hasNextPage: false },
  // an MCP text envelope + a bare comments array
  'issue-ALP-971.json': { content: [{ type: 'text', text: JSON.stringify(linIssue(1)) }] },
  'comments-ALP-971.json': [linComment(2)],
  // both in one file, comments as { nodes, pageInfo }
  'ALP-972.json': { issue: linIssue(2), comments: { nodes: [], pageInfo: { hasNextPage: false } } },
};
const linRun = (from, out, extra = []) =>
  run('linear-assemble.mjs', ['--project', 'alpha', '--run', 'SELFTEST-L', '--from', from, '--out-dir', join(TMP, out), ...extra]);
check('linear-assemble: a good dump (plain, MCP-wrapped, combined) assembles a raw that passes H-1', () => {
  const res = linRun(linDump('lin-good', linGood), 'lin-good-out');
  mustAccept(res, 'linear-assemble');
  const raw = JSON.parse(readFileSync(join(TMP, 'lin-good-out', '_INTAKE-SELFTEST-L-raw.json'), 'utf8'));
  const live = JSON.parse(readFileSync(join(TMP, 'lin-good-out', '_LIVE-SELFTEST-L.json'), 'utf8'));
  assert(raw.map((t) => t.id).join() === 'ALP-970,ALP-971,ALP-972', `ids/order wrong: ${raw.map((t) => t.id)}`);
  assert(raw[0].body === linIssue(0).description, 'body is not the description verbatim');
  assert(raw[0].comments.length === 2 && raw[0].comments[1].body === realComment(1) && raw[0].comments[0].author === 'Dev One', 'comments not carried verbatim');
  assert(raw[1].comments.length === 1 && raw[2].comments.length === 0, 'wrapped / combined comments not read');
  assert(raw[0].state === 'Staging QA' && raw[0].relations.some((r) => r.id === 'ALP-972' && r.type === 'blockedBy'), 'state / relations not mapped');
  assert(live.length === 3 && Object.keys(live[0]).join() === 'id,title,updatedAt,state,priority', `_LIVE shape wrong: ${Object.keys(live[0] || {})}`);
  assert(/median body \d+/.test(res.stdout) && res.stdout.includes('ALP-971'), 'no per-ticket length table');
  const spec = w('lin-good-spec.json', floorSpec(['ALP-970', 'ALP-971', 'ALP-972']));
  mustAccept(run('intake-assert.mjs', ['--raw', join(TMP, 'lin-good-out', '_INTAKE-SELFTEST-L-raw.json'), '--spec', spec]), 'intake-assert on the assembled raw');
});
check('linear-assemble: refuses to overwrite its outputs without --force', () => {
  mustReject(linRun(join(TMP, 'lin-good'), 'lin-good-out'), 'refusing to overwrite', 'linear-assemble');
  mustAccept(linRun(join(TMP, 'lin-good'), 'lin-good-out', ['--force']), 'linear-assemble --force');
});
check('linear-assemble: a comments page with hasNextPage: true is refused', () =>
  mustReject(
    linRun(linDump('lin-nextpage', { ...linGood, 'comments-ALP-970.json': { comments: [linComment(0)], hasNextPage: true } }), 'lin-nextpage-out'),
    'hasNextPage',
    'linear-assemble'
  ));
check('linear-assemble: an issue with no comments dump is refused', () =>
  mustReject(linRun(linDump('lin-nocomments', { 'issue-ALP-970.json': linIssue(0) }), 'lin-nocomments-out'), 'no list_comments dump', 'linear-assemble'));
check('linear-assemble: a retyped get_issue (no updatedAt / url) is refused', () => {
  const { updatedAt, url, ...retyped } = linIssue(0);
  mustReject(
    linRun(linDump('lin-retyped', { 'issue-ALP-970.json': retyped, 'comments-ALP-970.json': [] }), 'lin-retyped-out'),
    'not a get_issue response',
    'linear-assemble'
  );
});
check('linear-assemble: a thin pull assembles but warns loudly under the H-1 floor', () => {
  const thin = {};
  for (const n of [0, 1, 2]) {
    thin[`issue-ALP-97${n}.json`] = linIssue(n, { description: `Filters reset on page ${n}${'!'.repeat(n)}.` });
    thin[`comments-ALP-97${n}.json`] = [];
  }
  const res = linRun(linDump('lin-thin', thin), 'lin-thin-out');
  mustAccept(res, 'linear-assemble (thin)');
  assert(res.stdout.includes('THIN RAW') && res.stdout.includes('median body'), `no floor warning:\n${res.stdout.slice(0, 600)}`);
});

// ───────────────────────────────────────────────────────────────────────────────────────────
// 3. R-06 / R-07 — the run plan
// ───────────────────────────────────────────────────────────────────────────────────────────
console.log('\nR-06/R-07 run plan');

const liveOne = w('live.json', [{ id: 'ALP-201', title: 'x', updatedAt: daysAgo(3) }]);
const emptyLive = w('live-empty.json', []);
const priorSameBuild = w('prior-same-build.json', {
  schemaVersion: 1, runId: 'R3', project: 'alpha', generatedAt: daysAgo(2),
  build: { buildId: BUILD },
  tickets: [{ id: 'ALP-201', verdict: 'PASS', buildId: BUILD, surface: 'staging-dealer.alpha.example', observedAt: daysAgo(2), cases: [{ caseId: 'AC-1', verdict: 'PASS' }] }],
});
const priorOldBuild = w('prior-old-build.json', {
  schemaVersion: 1, runId: 'R3', project: 'alpha', generatedAt: daysAgo(2),
  build: { buildId: OTHER_BUILD },
  tickets: [{ id: 'ALP-201', verdict: 'PASS', buildId: OTHER_BUILD, surface: 'staging-dealer.alpha.example', observedAt: daysAgo(2), cases: [{ caseId: 'AC-1', verdict: 'PASS' }] }],
});

check('an empty Staging QA queue fails loudly (not "clean")', () =>
  mustReject(run('run-plan.mjs', ['--project', 'alpha', '--live', emptyLive, '--build', BUILD]), 'R-07', 'run-plan'));

check('no build id fails', () =>
  mustReject(run('run-plan.mjs', ['--project', 'alpha', '--live', liveOne]), 'R-06', 'run-plan'));

check('an unchanged ticket on the same build is carried forward', () => {
  const r = run('run-plan.mjs', ['--project', 'alpha', '--live', liveOne, '--prior', priorSameBuild, '--build', BUILD]);
  mustAccept(r, 'run-plan');
  assert(/carried forward : 1/.test(r.stdout), `expected 1 carried:\n${r.stdout}`);
  // Age is relative to today, so pin the shape (ticket + verdict + age + source run), not a
  // literal number of days — a hardcoded "1d old" silently rots into a red suite overnight.
  assert(/ALP-201\s+PASS\s+\d+d old, from R3/.test(r.stdout), `carried verdict age not printed:\n${r.stdout}`);
});

check('a redeploy invalidates the carry-forward', () => {
  const r = run('run-plan.mjs', ['--project', 'alpha', '--live', liveOne, '--prior', priorOldBuild, '--build', BUILD]);
  mustAccept(r, 'run-plan');
  assert(/to test         : 1/.test(r.stdout), `the stale verdict was carried across a redeploy:\n${r.stdout}`);
  assert(/build moved/.test(r.stdout), `reason not reported:\n${r.stdout}`);
});

check('a ticket edited after the verdict is re-tested', () => {
  const live = w('live-updated.json', [{ id: 'ALP-201', title: 'x', updatedAt: daysAgo(1) }]);
  const r = run('run-plan.mjs', ['--project', 'alpha', '--live', live, '--prior', priorSameBuild, '--build', BUILD]);
  mustAccept(r, 'run-plan');
  assert(/to test         : 1/.test(r.stdout), `an edited ticket was carried forward:\n${r.stdout}`);
});

// ───────────────────────────────────────────────────────────────────────────────────────────
// 3b. R-06 — the build probe itself
//
// Found live on 2026-08-12: the Alpha profile carries `buildProbe.pattern` once for the whole
// probe set, but build-id.mjs read `probe.pattern` only. `new RegExp(undefined)` is /(?:)/, which
// matches the empty string, so all three probes reported ok:true with value:"" and the run was
// keyed on a build id of "". A probe that fails OPEN is worse than no probe at all, because the
// build id it invents is the thing nobody thinks to doubt.
// ───────────────────────────────────────────────────────────────────────────────────────────
console.log('\nR-06 build probe');

const PAGE = '<html><script type="module" crossorigin src="/assets/index-ABC12345.js"></script></html>';
const SET_PATTERN = { pattern: 'assets/(index-[A-Za-z0-9_-]+\\.js)' };

check('a set-level pattern is honoured, not read as undefined', () => {
  const pat = resolvePattern({ name: 'customer', url: 'https://x/' }, SET_PATTERN);
  assert(pat === SET_PATTERN.pattern, `the probe fell back to ${JSON.stringify(pat)} instead of the set pattern`);
  const got = extractBuildId(PAGE, pat);
  assert(got.ok && got.value === 'index-ABC12345.js', `expected the bundle id, got ${JSON.stringify(got)}`);
});

check('a missing pattern fails instead of matching everything', () => {
  const pat = resolvePattern({ name: 'customer' }, {});
  assert(pat === null, `a missing pattern resolved to ${JSON.stringify(pat)} — /(?:)/ matches the empty string`);
  const got = extractBuildId(PAGE, pat);
  assert(!got.ok && /no pattern/.test(got.error), `a patternless probe was accepted: ${JSON.stringify(got)}`);
});

check('a pattern that captures nothing is not a build id', () => {
  const got = extractBuildId(PAGE, '(x?)');
  assert(!got.ok && /captured nothing/.test(got.error), `an empty capture was accepted as a build id: ${JSON.stringify(got)}`);
});

check('a pattern that does not match at all fails closed', () => {
  const got = extractBuildId(PAGE, 'assets/(bundle-[0-9]+\\.js)');
  assert(!got.ok && /did not match/.test(got.error), `a non-matching probe was accepted: ${JSON.stringify(got)}`);
});

check('a broken regex is an error, not a silent pass', () => {
  const got = extractBuildId(PAGE, 'assets/(index-');
  assert(!got.ok && /not a valid regex/.test(got.error), `an invalid pattern was accepted: ${JSON.stringify(got)}`);
});

check('no surface probed successfully → no build id at all', () => {
  assert(composeBuildId([{ name: 'a', ok: false }, { name: 'b', ok: false }]) === '', 'an all-failed probe set still produced an id');
});

check('a partial redeploy is visible in the composed id', () => {
  const id = composeBuildId([
    { name: 'customer', ok: true, value: 'index-ABC12345.js' },
    { name: 'dealer', ok: true, value: 'index-ZZZ99999.js' },
  ]);
  assert(id.includes('customer=index-ABC12345.js') && id.includes('dealer=index-ZZZ99999.js'), `surfaces not distinguishable in "${id}"`);
});

check('an apk probe parses aapt2 badging output into package + versionCode', () => {
  const badging = "package: name='com.beta' versionCode='13' versionName='1.0.3' compileSdkVersion='36'\nsdkVersion:'24'\ntargetSdkVersion:'36'\n";
  const got = parseApkBadging(badging);
  assert(got.ok && got.package === 'com.beta' && got.versionCode === '13', `expected com.beta/13, got ${JSON.stringify(got)}`);
  const id = composeApkBuildId(got.package, got.versionCode, '20f9b57d4f16ffea299a4c16842de2f46b839bc2ff5e87e0704b4cce59cd629a');
  assert(id === 'com.beta@13+20f9b57d', `expected com.beta@13+20f9b57d, got ${id}`);
});

check('aapt2 output with no package/versionCode line fails closed, not with an empty id', () => {
  const got = parseApkBadging('some unrelated aapt2 output\nwith no package line\n');
  assert(!got.ok, `a badging dump with no package line was accepted: ${JSON.stringify(got)}`);
});

check('composeApkBuildId refuses to compose from a short/missing sha256', () => {
  assert(composeApkBuildId('com.beta', '13', 'ab') === null, 'a 2-char hash prefix produced a build id — that is not a hash, it is noise');
  assert(composeApkBuildId('com.beta', '13', '') === null, 'an empty hash produced a build id');
});

check('an ios-app probe parses Info.plist JSON into bundle id + CFBundleVersion and composes <id>@<ver>+<sha8>', () => {
  const plist = JSON.stringify({ CFBundleIdentifier: 'com.allinsan.beta', CFBundleShortVersionString: '1.6.1', CFBundleVersion: '26', CFBundleExecutable: 'Beta' });
  const got = parseIosInfoPlist(plist);
  assert(got.ok && got.bundleId === 'com.allinsan.beta' && got.buildVersion === '26' && got.executable === 'Beta', `got ${JSON.stringify(got)}`);
  const id = composeIosBuildId(got.bundleId, got.buildVersion, 'd9c31d4fe39dc8d570e39473d207b5db8238f8975e3c0cf4bdbbdea3df1060eb');
  assert(id === 'com.allinsan.beta@26+d9c31d4f', `expected com.allinsan.beta@26+d9c31d4f, got ${id}`);
});

check('an Info.plist with no bundle id / build version / executable (or not JSON) fails closed, not with an empty id', () => {
  assert(!parseIosInfoPlist('{"CFBundleShortVersionString":"1.0"}').ok, 'a plist with no CFBundleIdentifier/CFBundleVersion was accepted');
  assert(!parseIosInfoPlist('not json').ok, 'a non-JSON plist was accepted');
  assert(composeIosBuildId('com.x', '1', 'ab') === null, 'a 2-char hash prefix produced an ios build id');
});

// ───────────────────────────────────────────────────────────────────────────────────────────
// 3c. Ticket-less parity run (Beta mobile, R-20260929-AND) — R-05/R-07 on generated ids
//
// No tracker tickets exist for this pass (D1 in _MOBILE-PLAN.md), so the "live queue" is a
// generated cases file cross-checked against a parity matrix instead of a Staging QA pull. R-07
// still has to hold in full: non-zero case count, tested+carried == cases, and the matrix/case
// cross-reference exhaustive both ways — an uncovered row or a dangling reference is exactly the
// silent-shrink failure R-07 exists to catch, just one layer up from the ticket case.
// ───────────────────────────────────────────────────────────────────────────────────────────
console.log('\nR-05/R-07 ticket-less parity run (Beta mobile)');

const pxMatrix = w('px-matrix.json', {
  runId: 'SELFTEST-AND', project: 'beta', generatedBy: 'selftest', generatedAt: daysAgo(1),
  buildId: 'student=index-abc.js android=com.beta@13+20f9b57d', roles: ['student'],
  rows: [
    { rowId: 'PM-1', area: 'courses', feature: 'Course list', role: 'student', webRoute: '/courses', webBehaviour: 'lists purchased courses', appScreen: 'Courses', status: 'present', evidence: { web: 'x', app: 'y' }, notes: '' },
    { rowId: 'PM-2', area: 'courses', feature: 'Course detail', role: 'student', webRoute: '/courses/1', webBehaviour: 'shows detail + progress', appScreen: null, status: 'missing', evidence: { web: 'x', app: null }, notes: '' },
  ],
});
const pxCasesGood = w('px-cases-good.json', {
  runId: 'SELFTEST-AND', project: 'beta', mode: 'ticketless', buildId: 'student=index-abc.js android=com.beta@13+20f9b57d',
  source: { matrix: pxMatrix, plan: 'n/a' },
  cases: [
    { id: 'PAR-COURSES-1', kind: 'parity', matrixRow: 'PM-1', area: 'courses', surfaces: ['web.beta.example:8443', 'com.beta'], expected: 'x' },
    { id: 'PAR-COURSES-2', kind: 'parity', matrixRow: 'PM-2', area: 'courses', surfaces: ['web.beta.example:8443', 'com.beta'], expected: 'x' },
    { id: 'MOB-1', kind: 'mobile', area: 'Session', title: 'login persists after kill', expected: 'x', surface: 'com.beta', platforms: ['android', 'ios'] },
    { id: 'MOB-ROLE-1', kind: 'mobile', area: 'Role', title: 'admin login refused', expected: 'refused, clear message', surface: 'com.beta', platforms: ['android', 'ios'] },
  ],
});
const pxBuild = 'student=index-abc.js android=com.beta@13+20f9b57d';

check('a well-formed ticket-less cases+matrix pair plans cleanly (incl. MOB-ROLE-1)', () => {
  const r = run('run-plan.mjs', ['--project', 'beta', '--cases', pxCasesGood, '--matrix', pxMatrix, '--build', pxBuild]);
  mustAccept(r, 'run-plan (ticket-less)');
  assert(/cases\s*:\s*4/.test(r.stdout), `expected 4 cases:\n${r.stdout}`);
});

check('an empty cases file fails loudly, not as a clean run (R-07)', () => {
  const emptyCases = w('px-cases-empty.json', { runId: 'SELFTEST-AND', project: 'beta', mode: 'ticketless', buildId: pxBuild, source: {}, cases: [] });
  mustReject(run('run-plan.mjs', ['--project', 'beta', '--cases', emptyCases, '--matrix', pxMatrix, '--build', pxBuild]), 'R-07', 'run-plan (ticket-less)');
});

check('a PAR case pointing at a non-existent matrix row is rejected', () => {
  const bad = w('px-cases-dangling.json', {
    runId: 'SELFTEST-AND', project: 'beta', mode: 'ticketless', buildId: pxBuild, source: {},
    cases: [{ id: 'PAR-COURSES-1', kind: 'parity', matrixRow: 'PM-999' }, { id: 'PAR-COURSES-2', kind: 'parity', matrixRow: 'PM-2' }],
  });
  mustReject(run('run-plan.mjs', ['--project', 'beta', '--cases', bad, '--matrix', pxMatrix, '--build', pxBuild]), 'does not exist in the matrix', 'run-plan (ticket-less)');
});

check('a matrix row with no covering PAR case is rejected', () => {
  const bad = w('px-cases-uncovered.json', {
    runId: 'SELFTEST-AND', project: 'beta', mode: 'ticketless', buildId: pxBuild, source: {},
    cases: [{ id: 'PAR-COURSES-1', kind: 'parity', matrixRow: 'PM-1' }], // PM-2 uncovered
  });
  mustReject(run('run-plan.mjs', ['--project', 'beta', '--cases', bad, '--matrix', pxMatrix, '--build', pxBuild]), 'has no PAR case covering it', 'run-plan (ticket-less)');
});

check('a malformed case id (PAR-1, MOB-x) is rejected', () => {
  const bad = w('px-cases-badid.json', {
    runId: 'SELFTEST-AND', project: 'beta', mode: 'ticketless', buildId: pxBuild, source: {},
    cases: [{ id: 'PAR-1', kind: 'parity', matrixRow: 'PM-1' }, { id: 'MOB-x', kind: 'mobile' }],
  });
  mustReject(run('run-plan.mjs', ['--project', 'beta', '--cases', bad, '--matrix', pxMatrix, '--build', pxBuild]), 'R-07', 'run-plan (ticket-less)');
});

check('a lowercase MOB area segment (MOB-role-1) is rejected even though MOB-ROLE-1 is accepted', () => {
  const bad = w('px-cases-lowercase-mob.json', {
    runId: 'SELFTEST-AND', project: 'beta', mode: 'ticketless', buildId: pxBuild, source: {},
    cases: [{ id: 'PAR-COURSES-1', kind: 'parity', matrixRow: 'PM-1' }, { id: 'PAR-COURSES-2', kind: 'parity', matrixRow: 'PM-2' }, { id: 'MOB-role-1', kind: 'mobile' }],
  });
  mustReject(run('run-plan.mjs', ['--project', 'beta', '--cases', bad, '--matrix', pxMatrix, '--build', pxBuild]), 'MOB-role-1', 'run-plan (ticket-less)');
});

check('an android result whose observed host disagrees with com.beta is rejected (R-05)', () => {
  const good = w('px-result-android-good.json', {
    ticketId: 'MOB-1', project: 'beta', runId: 'SELFTEST-AND', buildId: pxBuild,
    results: [{ caseId: 'MOB-1', plannedSurface: 'com.beta', ranOk: true, evidence: { url: 'android-app://com.beta/home', observedText: 'Home screen visible', buildId: 'com.beta@13+20f9b57d' } }],
  });
  mustAccept(run('run-result-validate.mjs', ['--result', good, '--build', pxBuild]), 'run-result (android, on-surface)');

  const bad = w('px-result-android-bad.json', {
    ticketId: 'MOB-1', project: 'beta', runId: 'SELFTEST-AND', buildId: pxBuild,
    results: [{ caseId: 'MOB-1', plannedSurface: 'com.beta', ranOk: true, evidence: { url: 'android-app://com.otherpkg/home', observedText: 'Home screen visible', buildId: 'com.beta@13+20f9b57d' } }],
  });
  mustReject(run('run-result-validate.mjs', ['--result', bad, '--build', pxBuild]), 'R-05', 'run-result (android, off-surface)');
});

check('a bare android evidence buildId that is not part of the composite run build fails R-06', () => {
  const staleBuild = w('px-result-android-stalebuild.json', {
    ticketId: 'MOB-1', project: 'beta', runId: 'SELFTEST-AND', buildId: pxBuild,
    results: [{ caseId: 'MOB-1', plannedSurface: 'com.beta', ranOk: true, evidence: { url: 'android-app://com.beta/home', observedText: 'Home screen visible', buildId: 'com.beta@99+deadbeef' } }],
  });
  mustReject(run('run-result-validate.mjs', ['--result', staleBuild, '--build', pxBuild]), 'R-06', 'run-result (android, bare buildId not in composite)');
});

{
  const throws = (fn) => { try { fn(); return false; } catch { return true; } };
  check('assertSurface refuses the bare forbidden hosts', () => {
    assert(throws(() => assertSurface('https://beta.example/x')), 'assertSurface accepted the forbidden host beta.example');
    assert(throws(() => assertSurface('https://www.beta.example/x')), 'assertSurface accepted the forbidden host www.beta.example');
  });
  check('assertSurface allows the D4 studentAlias (web.beta.example, no port)', () => {
    assert(!throws(() => assertSurface('https://web.beta.example/register?ref=abc')), 'assertSurface refused web.beta.example — D4 says it is safe to open');
  });
  check('assertSurface still allows the ported student surface (web.beta.example:8443)', () => {
    assert(!throws(() => assertSurface('https://web.beta.example:8443/')), 'assertSurface refused its own student surface');
  });
  check('assertSurface allows the android package surface (android-app://com.beta/...)', () => {
    assert(!throws(() => assertSurface('android-app://com.beta/home')), 'assertSurface refused the android surface com.beta');
  });
}

// ───────────────────────────────────────────────────────────────────────────────────────────
// 3d. gen-counts --matrix and parity-cases.mjs — the two ticket-less generators that were landed
// with no selftest coverage at all.
// ───────────────────────────────────────────────────────────────────────────────────────────
console.log('\ngen-counts --matrix / parity-cases.mjs');

check('gen-counts --matrix with zero rows fails instead of reporting an empty clean run (R-07)', () => {
  const emptyMatrix = w('px-matrix-empty.json', { runId: 'SELFTEST-AND', project: 'beta', rows: [] });
  mustReject(run('gen-counts.mjs', ['--matrix', emptyMatrix]), 'R-07', 'gen-counts --matrix');
});

check('gen-counts --matrix summarises present/missing per role from a well-formed matrix', () => {
  const r = run('gen-counts.mjs', ['--matrix', pxMatrix, '--json']);
  mustAccept(r, 'gen-counts --matrix');
  const c = JSON.parse(r.stdout);
  assert(c.total === 2 && c.perRole.student.present === 1 && c.perRole.student.missing === 1, `wrong matrix counts: ${r.stdout}`);
});

const pxPlanMd = w('px-plan.md', [
  '# Mobile plan',
  '',
  '### Part C: mobile-specific checklist',
  '',
  '| Area | Cases |',
  '| --- | --- |',
  '| Session | login persists after kill |',
  '',
].join('\n'));

check('parity-cases.mjs expands a matrix + Part-C plan into PAR-/MOB- cases deterministically', () => {
  const out = join(TMP, 'px-cases-generated.json');
  const r = run('parity-cases.mjs', ['--matrix', pxMatrix, '--plan', pxPlanMd, '--out', out, '--project', 'beta', '--runId', 'SELFTEST-AND']);
  mustAccept(r, 'parity-cases');
  const cases = JSON.parse(readFileSync(out, 'utf8')).cases;
  assert(cases.some((c) => c.id === 'PAR-COURSES-1') && cases.some((c) => c.id === 'MOB-1'), `expected PAR-COURSES-1 and MOB-1, got ${JSON.stringify(cases.map((c) => c.id))}`);
});

check('parity-cases.mjs refuses a duplicate --extra case id (R-07)', () => {
  const extra = w('px-extra-dup.json', [{ id: 'PAR-COURSES-1', kind: 'parity', matrixRow: 'PM-1' }]);
  const out = join(TMP, 'px-cases-dup.json');
  mustReject(
    run('parity-cases.mjs', ['--matrix', pxMatrix, '--plan', pxPlanMd, '--out', out, '--project', 'beta', '--runId', 'SELFTEST-AND', '--extra', extra]),
    'duplicate',
    'parity-cases'
  );
});

check('gen-counts --matrix buckets candidate-missing / held / app-only separately (not as unclear)', () => {
  const m = w('px-matrix-statuses.json', {
    runId: 'SELFTEST-AND', project: 'beta',
    rows: [
      { rowId: 'PM-1', role: 'student', feature: 'a', status: 'present' },
      { rowId: 'PM-2', role: 'student', feature: 'b', status: 'candidate-missing' },
      { rowId: 'PM-3', role: 'student', feature: 'c', status: 'held' },
      { rowId: 'PM-4', role: 'student', feature: 'd', status: 'app-only' },
      { rowId: 'PM-5', role: 'student', feature: 'e', status: 'unclear' },
    ],
  });
  const r = run('gen-counts.mjs', ['--matrix', m, '--json']);
  mustAccept(r, 'gen-counts --matrix');
  const t = JSON.parse(r.stdout).totals;
  assert(t.present === 1 && t['candidate-missing'] === 1 && t.held === 1 && t['app-only'] === 1 && t.unclear === 1, `wrong buckets: ${r.stdout}`);
});

check('gen-counts --matrix refuses an unknown row status instead of counting it as unclear (R-11)', () => {
  const m = w('px-matrix-badstatus.json', { runId: 'SELFTEST-AND', project: 'beta', rows: [{ rowId: 'PM-1', role: 'student', status: 'kinda-there' }] });
  mustReject(run('gen-counts.mjs', ['--matrix', m]), 'unknown status', 'gen-counts --matrix');
});

const pxPlanMdSemi = w('px-plan-semi.md', [
  '### Part C: mobile-specific checklist',
  '',
  '| Area | Cases |',
  '| --- | --- |',
  '| Session | login persists after kill; **token expiry (600s TTL) mid-use**; logout clears data |',
  '| Payments | checkout UI per method, pending/"awaiting payment" state. **No card entry.** |',
  '| Push | FCM on a Google-APIs image: **probe first**. Receive, tap to open (`/a/`, `/b/`) |',
  '',
].join('\n'));

check('parity-cases.mjs splits Part C cells on ";" too and turns note sentences into rowNotes, not cases', () => {
  const out = join(TMP, 'px-cases-semi.json');
  const r = run('parity-cases.mjs', ['--matrix', pxMatrix, '--plan', pxPlanMdSemi, '--out', out, '--project', 'beta', '--runId', 'SELFTEST-AND']);
  mustAccept(r, 'parity-cases');
  const mob = JSON.parse(readFileSync(out, 'utf8')).cases.filter((c) => c.kind === 'mobile');
  const titles = mob.map((c) => c.title);
  const want = ['login persists after kill', 'token expiry (600s TTL) mid-use', 'logout clears data', 'checkout UI per method', 'pending/"awaiting payment" state', 'Receive', 'tap to open (`/a/`, `/b/`)'];
  assert(JSON.stringify(titles) === JSON.stringify(want), `wrong MOB titles: ${JSON.stringify(titles)}`);
  const pay = mob.find((c) => c.title === 'checkout UI per method');
  const push = mob.find((c) => c.title === 'Receive');
  assert(pay.rowNotes?.[0] === 'No card entry.' && /probe first/.test(push.rowNotes?.[0] || ''), `rowNotes not attached: ${JSON.stringify(mob)}`);
});

check('parity-cases.mjs refuses a --mob-spec key that matches no Part C item (stale spec)', () => {
  const spec = w('px-mobspec-stale.json', { byItem: { 'Session :: no such item': { lane: 'emulator-5554' } } });
  const out = join(TMP, 'px-cases-stale.json');
  mustReject(
    run('parity-cases.mjs', ['--matrix', pxMatrix, '--plan', pxPlanMdSemi, '--out', out, '--project', 'beta', '--runId', 'SELFTEST-AND', '--mob-spec', spec]),
    'stale spec',
    'parity-cases'
  );
});

// ───────────────────────────────────────────────────────────────────────────────────────────
// 3e. R-04 — ticket-less routing (PAR-/MOB- ids have no tracker ticket to transition)
// ───────────────────────────────────────────────────────────────────────────────────────────
console.log('\nR-04 ticket-less routing (PAR-/MOB-)');

check('a ticket-less PASS never proposes a transition', () => {
  const r = route({ id: 'PAR-COURSES-1', verdict: 'PASS' });
  assert(r.transition === false, `ticket-less PASS proposed a transition: ${JSON.stringify(r)}`);
});
check('a ticket-less FAIL routes to newBug (a new ticket would have to be filed), not reopen', () => {
  const r = route({ id: 'MOB-1', verdict: 'FAIL' });
  assert(r.route === 'newBug' && r.transition === false, `expected newBug/no-transition, got ${JSON.stringify(r)}`);
});
check('a ticket-less PARTIAL/mixed also routes to newBug, not reopen', () => {
  const r = route({ id: 'PAR-COURSES-2', verdict: 'PARTIAL', partialReason: 'mixed' });
  assert(r.route === 'newBug' && r.transition === false, `expected newBug/no-transition, got ${JSON.stringify(r)}`);
});
check('an ordinary tracker id is unaffected — FAIL still reopens with a transition', () => {
  const r = route({ id: 'ALP-999', verdict: 'FAIL' });
  assert(r.route === 'reopen' && r.transition === true, `existing tracker-id behaviour regressed: ${JSON.stringify(r)}`);
});

const pxLedgerTicketless = w('px-ledger-ticketless.json', {
  schemaVersion: 1, runId: 'SELFTEST-AND', project: 'beta', generatedAt: daysAgo(1),
  build: { buildId: pxBuild },
  tickets: [
    {
      id: 'PAR-COURSES-1', verdict: 'PASS', surface: 'com.beta', buildId: pxBuild, observedAt: daysAgo(1),
      cases: [{ caseId: 'PAR-COURSES-1', verdict: 'PASS' }],
    },
    {
      id: 'MOB-1', verdict: 'FAIL', surface: 'com.beta', buildId: pxBuild, observedAt: daysAgo(1),
      comment: 'On Android, killing the app and reopening it drops the student back to the login screen instead of resuming the session. Expected the session to persist the way it does on web.',
      cases: [{ caseId: 'MOB-1', verdict: 'FAIL', evidence: { url: 'android-app://com.beta/home', observedText: 'Login screen shown after relaunch', buildId: pxBuild } }],
    },
  ],
});

check('a ticket-less ledger (PAR-/MOB- ids) validates cleanly through validateLedger', () => {
  const { errors } = validateLedger(JSON.parse(readFileSync(pxLedgerTicketless, 'utf8')), { profile: loadProfile('beta'), currentBuildId: pxBuild });
  assert(errors.length === 0, `ticket-less ledger rejected:\n  ${errors.join('\n  ')}`);
});

check('gen-counts --ledger on a ticket-less ledger routes the FAIL to newBug (Backlog), not Reopen (R-04)', () => {
  const r = run('gen-counts.mjs', ['--ledger', pxLedgerTicketless, '--project', 'beta', '--json']);
  mustAccept(r, 'gen-counts (ticket-less)');
  const c = JSON.parse(r.stdout);
  assert(c.byProposedState['Backlog'] === 1, `expected the ticket-less FAIL to map to Backlog (newBug), got ${JSON.stringify(c.byProposedState)}`);
  assert(!c.byProposedState['Ready for dev'], `a ticket-less FAIL must not propose "Ready for dev" (that is reopen, not newBug): ${JSON.stringify(c.byProposedState)}`);
});

check('gen-summary.mjs generates from a ticket-less ledger', () => {
  const out = join(TMP, 'px-summary-ticketless.md');
  mustAccept(run('gen-summary.mjs', ['--ledger', pxLedgerTicketless, '--project', 'beta', '--out', out]), 'gen-summary (ticket-less)');
  const md = readFileSync(out, 'utf8');
  assert(/MOB-1/.test(md), 'the ticket-less FAIL case is missing from the generated summary');
});

// ───────────────────────────────────────────────────────────────────────────────────────────
// 3f. R-07 — qa-gates.mjs picks up the ticket-less run-plan (_CASES-<run>.json) instead of
// _LIVE-<run>.json when it is the file present, and leaves ticket-mode runs untouched.
// ───────────────────────────────────────────────────────────────────────────────────────────
console.log('\nqa-gates.mjs ticket-less (_CASES) pickup');

const gatesDirTicketless = join(TMP, 'gates-ticketless-reports');
mkdirSync(gatesDirTicketless, { recursive: true });
writeFileSync(join(gatesDirTicketless, '_BUILD-SELFTEST-AND.json'), JSON.stringify({ buildId: pxBuild }, null, 2) + '\n');
writeFileSync(join(gatesDirTicketless, '_CASES-SELFTEST-AND.json'), readFileSync(pxCasesGood, 'utf8'));
writeFileSync(join(gatesDirTicketless, '_PARITY-MATRIX-SELFTEST-AND.json'), readFileSync(pxMatrix, 'utf8'));

check('qa-gates.mjs runs the ticket-less run-plan gate when _CASES-<run>.json is present', () => {
  const r = run('qa-gates.mjs', ['--project', 'beta', '--run', 'SELFTEST-AND', '--reports-dir', gatesDirTicketless]);
  mustAccept(r, 'qa-gates (ticket-less)');
  assert(r.stdout.includes('R-07 run-plan [ticket-less]'), `expected the ticket-less run-plan gate to run:\n${r.stdout}`);
});

check('qa-gates.mjs fails closed when the ticket-less cases file itself is broken', () => {
  const gatesDirBad = join(TMP, 'gates-ticketless-bad');
  mkdirSync(gatesDirBad, { recursive: true });
  writeFileSync(join(gatesDirBad, '_BUILD-SELFTEST-AND.json'), JSON.stringify({ buildId: pxBuild }, null, 2) + '\n');
  writeFileSync(join(gatesDirBad, '_CASES-SELFTEST-AND.json'), JSON.stringify({ runId: 'SELFTEST-AND', project: 'beta', mode: 'ticketless', buildId: pxBuild, source: {}, cases: [] }, null, 2) + '\n');
  writeFileSync(join(gatesDirBad, '_PARITY-MATRIX-SELFTEST-AND.json'), readFileSync(pxMatrix, 'utf8'));
  mustReject(run('qa-gates.mjs', ['--project', 'beta', '--run', 'SELFTEST-AND', '--reports-dir', gatesDirBad]), 'R-07 run-plan [ticket-less]', 'qa-gates (ticket-less, broken cases)');
});

check('qa-gates.mjs adds NO run-plan gate when only _LIVE-<run>.json exists (ticket-mode unaffected)', () => {
  const gatesDirLive = join(TMP, 'gates-ticket-mode');
  mkdirSync(gatesDirLive, { recursive: true });
  writeFileSync(join(gatesDirLive, '_LIVE-SELFTEST-AND.json'), JSON.stringify({ tickets: [] }, null, 2) + '\n');
  const r = run('qa-gates.mjs', ['--project', 'beta', '--run', 'SELFTEST-AND', '--reports-dir', gatesDirLive]);
  assert(!/run-plan/.test(r.stdout), `a _LIVE-only reports dir must not gain a new run-plan gate entry (pre-existing ticket-mode behaviour must be unchanged):\n${r.stdout}`);
});

// ───────────────────────────────────────────────────────────────────────────────────────────
// 4. R-11 — the ledger validator (in-process: many small mutations of one good ledger)
// ───────────────────────────────────────────────────────────────────────────────────────────
console.log('\nR-11 ledger validator');

const PROFILE = { linear: { stateMap: { pass: 'Release Candidate', reopen: 'Reopen', blocked: 'Blocked', stagingQaHold: 'Staging QA', newBug: 'Ready for Dev' }, commentMentionSuffix: '@Dev Lead' } };
const baseTicket = (over = {}) => ({
  id: 'ALP-301',
  verdict: 'PASS',
  surface: 'staging-dealer.alpha.example',
  buildId: BUILD,
  observedAt: daysAgo(1),
  cases: [{ caseId: 'AC-1', verdict: 'PASS' }],
  ...over,
});
const ledgerWith = (...tickets) => ({
  schemaVersion: 1, runId: 'SELFTEST', project: 'alpha', generatedAt: daysAgo(1),
  build: { buildId: BUILD }, tickets,
});
const v = (ledger) => validateLedger(ledger, { profile: PROFILE, currentBuildId: BUILD });
const mustError = (ledger, needle, what) => {
  const { errors } = v(ledger);
  assert(errors.length > 0, `${what}: the validator ACCEPTED a known-bad ledger`);
  assert(errors.some((e) => e.includes(needle)), `${what}: rejected for the wrong reason:\n  ${errors.join('\n  ')}`);
};

check('a clean ledger validates', () => {
  const { errors } = v(ledgerWith(baseTicket()));
  assert(errors.length === 0, `clean ledger rejected:\n  ${errors.join('\n  ')}`);
});

check('an empty ledger is not a clean run', () => mustError(ledgerWith(), 'R-07', 'ledger'));

check('PASS on top of a NOT_TESTED case is rejected (the silent false pass)', () =>
  mustError(ledgerWith(baseTicket({ cases: [{ caseId: 'AC-1', verdict: 'PASS' }, { caseId: 'AC-2', verdict: 'NOT_TESTED' }] })), 'never a pass', 'ledger'));

check('PASS on top of a FAIL case is rejected', () =>
  mustError(ledgerWith(baseTicket({ cases: [{ caseId: 'AC-1', verdict: 'FAIL', evidence: { url: 'https://staging-dealer.alpha.example/x', observedText: 'boom', buildId: BUILD } }] })), 'contradicts its own cases', 'ledger'));

check('a bare PARTIAL is rejected (it flattened three states)', () =>
  mustError(ledgerWith(baseTicket({ verdict: 'PARTIAL', comment: 'x @Dev Lead' })), 'R-04', 'ledger'));

check('an authored proposedState that contradicts the routing table is rejected', () =>
  mustError(ledgerWith(baseTicket({ proposedState: 'Done' })), 'derived, not authored', 'ledger'));

check('a descoped case with no recorded user ruling is rejected', () =>
  mustError(ledgerWith(baseTicket({ descopedCases: [{ caseId: 'AC-9', verdict: 'FAIL', descopedByRuling: '2026-10-07' }] })), 'only the user can take a case out of scope', 'ledger'));

check('a ruling without the user\'s verbatim quote is rejected', () =>
  mustError(ledgerWith(baseTicket({ rulings: [{ date: '2026-10-07', decidedBy: 'the QA lead' }] })), 'userQuote is required', 'ledger'));

check('a ruling-requested PASS comment that leaks an internal artefact is rejected (R-10)', () =>
  mustError(ledgerWith(baseTicket({ comment: 'See shot-01.png', rulings: [{ date: '2026-10-07', decidedBy: 'the QA lead', userQuote: 'ok', postComment: true }] })), 'R-10', 'ledger'));

check('a FAIL with no typed evidence is rejected', () =>
  mustError(
    ledgerWith(baseTicket({ verdict: 'FAIL', comment: 'The filter resets on page 2.\n\n@Dev Lead', cases: [{ caseId: 'AC-1', verdict: 'FAIL' }] })),
    'R-09',
    'ledger'
  ));

check('a FAIL with real evidence and a proper comment passes', () => {
  const { errors } = v(ledgerWith(baseTicket({
    verdict: 'FAIL',
    comment: 'On the dealer inventory page, applying a make filter and moving to page 2 clears the filter and the full list returns. Expected the filter to persist across pagination.\n\n@Dev Lead',
    cases: [{ caseId: 'AC-1', verdict: 'FAIL', evidence: { url: 'https://staging-dealer.alpha.example/inventory?page=2', observedText: '412 vehicles', httpStatus: 200, buildId: BUILD } }],
  })));
  assert(errors.length === 0, `a well-formed FAIL was rejected:\n  ${errors.join('\n  ')}`);
});

check('a Reopen comment missing the mention suffix is rejected', () =>
  mustError(
    ledgerWith(baseTicket({ verdict: 'FAIL', comment: 'The filter resets on page 2.', cases: [{ caseId: 'AC-1', verdict: 'FAIL', evidence: { url: 'https://x.alpha.example/', observedText: 'y', buildId: BUILD } }] })),
    'commentMentionSuffix',
    'ledger'
  ));

check('a comment leaking an internal QA filename is rejected (R-10)', () =>
  mustError(
    ledgerWith(baseTicket({ verdict: 'FAIL', comment: 'See ALP-301_attachments/step3.png for the failure.\n\n@Dev Lead', cases: [{ caseId: 'AC-1', verdict: 'FAIL', evidence: { url: 'https://x.alpha.example/', observedText: 'y', buildId: BUILD } }] })),
    'R-10',
    'ledger'
  ));

check('a category-name deferral ("payments") is rejected', () =>
  mustError(
    ledgerWith(baseTicket({
      verdict: 'NEEDS_MANUAL',
      comment: 'Deferred.\n\n@Dev Lead',
      cases: [{ caseId: 'AC-1', verdict: 'NEEDS_MANUAL' }],
      needsManual: [{ caseId: 'AC-1', probe: { attempted: 'x', failureMode: 'y', missingCapability: 'payments', evidence: 'z' }, manualRepro: ['1. do it'] }],
    })),
    'is a category, not a reason',
    'ledger'
  ));

check('a needs-manual with no probe at all is rejected', () =>
  mustError(
    ledgerWith(baseTicket({ verdict: 'NEEDS_MANUAL', comment: 'Deferred.\n\n@Dev Lead', cases: [{ caseId: 'AC-1', verdict: 'NEEDS_MANUAL' }] })),
    'R-02',
    'ledger'
  ));

check('a needs-manual naming the specific missing capability passes', () => {
  const { errors } = v(ledgerWith(baseTicket({
    verdict: 'NEEDS_MANUAL',
    comment: 'This case needs a real handset: the flow requires an SMS one-time code and there is no SMS inbox for the test number.\n\n@Dev Lead',
    cases: [{ caseId: 'AC-1', verdict: 'NEEDS_MANUAL' }],
    needsManual: [{
      caseId: 'AC-1',
      probe: {
        attempted: 'POST https://staging-api.alpha.example/api/v1/auth/sms-verify with +15555550123',
        failureMode: '202 accepted, but the code is delivered by Twilio SMS and no inbox is connected for that number',
        missingCapability: 'SMS inbox for the Twilio test number +15555550123',
        evidence: 'projects/alpha/qa-reports/ALP-301_attachments/sms-probe.json',
      },
      manualRepro: ['1. On a phone with the test SIM, open staging-customer.alpha.example', '2. Request the code', '3. Enter it within 10 minutes'],
    }],
  })));
  assert(errors.length === 0, `a well-formed deferral was rejected:\n  ${errors.join('\n  ')}`);
});

check('a carry-forward from an older build is rejected', () =>
  mustError(
    ledgerWith({ id: 'ALP-302', verdict: 'PASS', carriedForward: true, carriedFrom: { runId: 'R3', buildId: OTHER_BUILD }, cases: [{ caseId: 'AC-1', verdict: 'PASS' }] }),
    'redeploy invalidates',
    'ledger'
  ));

check('a freshly tested ticket with no surface is rejected (R-05)', () =>
  mustError(ledgerWith(baseTicket({ surface: undefined })), 'R-05', 'ledger'));

check('PASS_SCOPE without a scope question is rejected', () =>
  mustError(ledgerWith(baseTicket({ verdict: 'PASS_SCOPE' })), 'scopeQuestion', 'ledger'));

check('PARTIAL/coverage-gap holds in Staging QA, PARTIAL/mixed reopens', () => {
  assert(route({ verdict: 'PARTIAL', partialReason: 'coverage-gap' }).transition === false, 'a coverage gap proposed a transition');
  assert(route({ verdict: 'PARTIAL', partialReason: 'coverage-gap' }).devFacing === false, 'a coverage gap was marked dev-facing');
  assert(route({ verdict: 'PARTIAL', partialReason: 'mixed' }).route === 'reopen', 'mixed did not route to reopen');
  assert(route({ verdict: 'NEEDS_MANUAL' }).transition === false, 'needs-manual proposed a state change');
});

check('duplicate ticket entries are caught', () =>
  mustError(ledgerWith(baseTicket(), baseTicket()), 'duplicate', 'ledger'));

// ───────────────────────────────────────────────────────────────────────────────────────────
// 5. R-05 / R-09 — run-result validation
// ───────────────────────────────────────────────────────────────────────────────────────────
console.log('\nR-05/R-09 run results');

const okEvidence = { url: 'https://staging-dealer.alpha.example/inventory', host: 'staging-dealer.alpha.example', httpStatus: 200, selector: '[data-count]', observedText: '412 vehicles', buildId: BUILD };
const resultGood = w('result-good.json', {
  ticketId: 'ALP-401', project: 'alpha', runId: 'SELFTEST', buildId: BUILD,
  results: [{ caseId: 'AC-1', plannedSurface: 'staging-dealer.alpha.example', ranOk: true, evidence: okEvidence }],
});
const resultWrongHost = w('result-wrong-host.json', {
  ticketId: 'ALP-402', project: 'alpha', runId: 'SELFTEST', buildId: BUILD,
  results: [{ caseId: 'AC-1', plannedSurface: 'staging-dealer.alpha.example', ranOk: true, evidence: { ...okEvidence, url: 'https://staging-customer.alpha.example/inventory', host: 'staging-customer.alpha.example' } }],
});
const resultUntyped = w('result-untyped.json', {
  ticketId: 'ALP-403', project: 'alpha', runId: 'SELFTEST', buildId: BUILD,
  results: [{ caseId: 'AC-1', plannedSurface: 'staging-dealer.alpha.example', ranOk: true, actual: 'looked fine to me' }],
});
const resultStaleBuild = w('result-stale-build.json', {
  ticketId: 'ALP-404', project: 'alpha', runId: 'SELFTEST', buildId: BUILD,
  results: [{ caseId: 'AC-1', plannedSurface: 'staging-dealer.alpha.example', ranOk: true, evidence: { ...okEvidence, buildId: OTHER_BUILD } }],
});
const resultBareDefer = w('result-bare-defer.json', {
  ticketId: 'ALP-405', project: 'alpha', runId: 'SELFTEST', buildId: BUILD,
  results: [{ caseId: 'AC-1', plannedSurface: 'staging-customer.alpha.example', ranOk: false, skippedReason: 'needs-manual' }],
});

check('a typed, on-surface result passes', () => mustAccept(run('run-result-validate.mjs', ['--result', resultGood, '--build', BUILD]), 'run-result'));
check('evidence taken on the wrong host is caught mechanically', () =>
  mustReject(run('run-result-validate.mjs', ['--result', resultWrongHost, '--build', BUILD]), 'R-05', 'run-result'));
check('prose instead of typed evidence is rejected', () =>
  mustReject(run('run-result-validate.mjs', ['--result', resultUntyped, '--build', BUILD]), 'R-09', 'run-result'));
check('evidence captured on a different build is caught', () =>
  mustReject(run('run-result-validate.mjs', ['--result', resultStaleBuild, '--build', BUILD]), 'R-06', 'run-result'));
check('a needs-manual with no probe is rejected', () =>
  mustReject(run('run-result-validate.mjs', ['--result', resultBareDefer, '--build', BUILD]), 'R-02', 'run-result'));
// R-12: on 2026-08-17 an executor wrote a 2.74MB result — a 120-deal raw census inside one evidence
// field — and the validator passed it with "0 errors", because it checked structure and never
// looked at scale. Three executors that run reported clean validation on bloated files.
const resultBloated = w('result-bloated.json', {
  ticketId: 'ALP-406', project: 'alpha', runId: 'SELFTEST', buildId: BUILD,
  results: [{
    caseId: 'AC-1', plannedSurface: 'staging-dealer.alpha.example', ranOk: true,
    evidence: { ...okEvidence, rawFleetCensus: Array.from({ length: 400 }, (_, i) => ({ id: 100000 + i, blob: 'x'.repeat(2000) })) },
  }],
});
check('a result file bloated with a raw payload is rejected on size', () =>
  mustReject(run('run-result-validate.mjs', ['--result', resultBloated, '--build', BUILD]), 'R-12', 'run-result'));
check('the size check names the offending field, not just the file', () => {
  const r = run('run-result-validate.mjs', ['--result', resultBloated, '--build', BUILD]);
  assert(
    `${r.stdout}${r.stderr}`.includes('evidence.rawFleetCensus'),
    `size failure did not name the oversized field — "trim the file" is not actionable:\n${r.stdout}${r.stderr}`
  );
});

check('a directory with no result files fails rather than reporting nothing', () => {
  mkdirSync(join(TMP, 'empty-results'), { recursive: true });
  mustReject(run('run-result-validate.mjs', ['--dir', join(TMP, 'empty-results'), '--run', 'SELFTEST']), 'R-08', 'run-result');
});

// ───────────────────────────────────────────────────────────────────────────────────────────
// 5b. R-02 — a question to a human has to be earned
// ───────────────────────────────────────────────────────────────────────────────────────────
console.log('\nR-02 asking a human');

const qLedger = w('q-ledger.json', ledgerWith(baseTicket({
  id: 'ALP-601', verdict: 'BLOCKED',
  comment: 'The dealer inventory page returns 500 for a dealer with no active subscription.\n\n@Dev Lead',
  cases: [{ caseId: 'AC-1', verdict: 'BLOCKED', evidence: { url: 'https://staging-dealer.alpha.example/inventory', httpStatus: 500, buildId: BUILD } }],
})));
const qRouting = (probe) => w(`q-routing-${Math.abs(JSON.stringify(probe || '').length)}-${Object.keys(probe || {}).join('')}.json`, {
  transitionTo: 'Blocked', mentionHandle: 'Dev Lead',
  tickets: [{ id: 'ALP-601', ask: 'can you confirm the intended behaviour here?', ...(probe ? { probe } : {}) }],
});
const qRun = (routing) => run('plan-questions.mjs', ['--project', 'alpha', '--run', 'SELFTEST', '--ledger', qLedger, '--routing', routing, '--out', join(TMP, 'q-plan.json')]);
const goodProbe = {
  attempted: 'Registered a dealer via the harness and drove the subscription upgrade flow to completion.',
  failureMode: 'The upgrade requires an SMS one-time code sent to a real handset; no code is deliverable to any address we control.',
  missingCapability: 'SMS delivery to a real device',
  evidence: 'POST /dealer/subscription → 202, then GET /dealer/me still reports subscriptionState "none"; the OTP screen has no email fallback.',
};

check('a question with a full probe is planned', () => {
  const r = qRun(qRouting(goodProbe));
  mustAccept(r, 'plan-questions');
  const p = JSON.parse(readFileSync(join(TMP, 'q-plan.json'), 'utf8'));
  const c = p.ops.find((o) => o.kind === 'comment');
  assert(c && c.probe && c.probe.missingCapability === 'SMS delivery to a real device',
    'the probe did not ride along into the plan, so an approver cannot see what QA tried');
});

check('a question with no probe at all is refused', () =>
  mustReject(qRun(qRouting(null)), 'R-02', 'plan-questions'));

check('a probe missing its evidence is refused', () => {
  const { evidence, ...noEvidence } = goodProbe;
  mustReject(qRun(qRouting(noEvidence)), 'probe.evidence', 'plan-questions');
});

// The two capabilities R-02 names as covered. Both were cited as real blockers in earlier runs.
check('"we cannot receive email" is refused — Gmail is connected', () =>
  mustReject(qRun(qRouting({ ...goodProbe, missingCapability: 'no way to receive the verification email' })), 'email is covered', 'plan-questions'));

check('"we cannot take a card payment" is refused — PAYGW UAT covers it', () =>
  mustReject(qRun(qRouting({ ...goodProbe, missingCapability: 'cannot complete a card payment on staging' })), 'PAYGW UAT', 'plan-questions'));

// The R4 batch-2 failure, in its own words: 18 tickets asked a developer to seed fixtures the
// harness could already build. This is the check that would have stopped it.
check('"no deal exists at that stage" is refused — that is work, not a missing capability', () =>
  mustReject(qRun(qRouting({ ...goodProbe, missingCapability: 'there is no deal currently at the PURCHASE_PACKET_SENT stage' })), 'fixture', 'plan-questions'));

check('"we need a test account seeded" is refused for the same reason', () =>
  mustReject(qRun(qRouting({ ...goodProbe, missingCapability: 'need a test account with an active subscription seeded by the dev' })), 'fixture', 'plan-questions'));

// ───────────────────────────────────────────────────────────────────────────────────────────
// 6. E-1 end to end — ledger → plan → approval → gate
// ───────────────────────────────────────────────────────────────────────────────────────────
console.log('\nE-1 end to end (plan → approve → gate)');

// ───────────────────────────────────────────────────────────────────────────────────────────
// 5b. Regressions from the 2026-09-08 hub audit (F-004/F-012/F-013/F-069/F-070/F-088/F-089/F-090)
// ───────────────────────────────────────────────────────────────────────────────────────────
console.log('\n2026-09-08 audit regressions');

check('computeCounts routes with the profile stateMap, not the defaults (R-04)', () => {
  const led = ledgerWith(baseTicket({ verdict: 'PASS', cases: [{ caseId: 'AC-1', verdict: 'PASS' }] }));
  const c = computeCounts(led, { stateMap: { pass: 'Done (selftest)' } });
  assert(c.byProposedState['Done (selftest)'] === 1, `expected "Done (selftest)":1, got ${JSON.stringify(c.byProposedState)}`);
  assert(computeCounts(led).byProposedState['Release Candidate'] === 1, 'defaults still apply when no stateMap is given');
});
check('a PASS over a NEEDS_MANUAL case is rejected — a case nobody ran is not a pass (H-1)', () => {
  const { errors } = validateLedger(ledgerWith(baseTicket({ verdict: 'PASS', cases: [{ caseId: 'AC-1', verdict: 'PASS' }, { caseId: 'AC-2', verdict: 'NEEDS_MANUAL' }] })), { currentBuildId: BUILD });
  assert(errors.some((e) => /NEEDS_MANUAL is present/.test(e)), `expected the case-consistency error, got: ${errors.join(' | ') || '(none)'}`);
});
check('PARTIAL/mixed without a FAIL case is rejected', () => {
  const { errors } = validateLedger(ledgerWith(baseTicket({ verdict: 'PARTIAL', partialReason: 'mixed', cases: [{ caseId: 'AC-1', verdict: 'PASS' }] })), { currentBuildId: BUILD });
  assert(errors.some((e) => /PARTIAL\/mixed requires/.test(e)), `expected the mixed-needs-FAIL error, got: ${errors.join(' | ') || '(none)'}`);
});
check('a profile without linear.stateMap is flagged (R-04)', () => {
  const { warnings } = validateLedger(ledgerWith(baseTicket({ verdict: 'PASS', cases: [{ caseId: 'AC-1', verdict: 'PASS' }] })), { currentBuildId: BUILD, profile: { slug: 'selftest', linear: { team: 'X' } } });
  assert(warnings.some((w) => /stateMap/.test(w)), `expected a stateMap warning, got: ${warnings.join(' | ') || '(none)'}`);
});
check('share_issue, a Slack post and a Gmail send are gated writes; reads are not (R-01)', () => {
  for (const t of ['mcp__claude_ai_Linear__share_issue', 'mcp__claude_ai_Linear__save_issue', 'mcp__claude_ai_Slack__slack_send_message', 'mcp__claude_ai_Gmail__gmail_send_email'])
    assert(isTrackerWrite(t), `${t} should be gated`);
  for (const t of ['mcp__claude_ai_Linear__list_issues', 'mcp__claude_ai_Gmail__gmail_search_messages', 'mcp__claude_ai_Slack__slack_search_messages'])
    assert(!isTrackerWrite(t), `${t} should NOT be gated`);
});
check('an approved {id,state} does not also authorise {id,state,assignee:null}', () => {
  const a = canonicalOp('mcp__claude_ai_Linear__save_issue', { id: 'X', state: 'S' }).hash;
  const b = canonicalOp('mcp__claude_ai_Linear__save_issue', { id: 'X', state: 'S', assignee: null }).hash;
  assert(a !== b, 'a null field must change the hash');
});
check('a wildcard Bash or server-wide MCP allow entry counts as unsafe config (R-01)', () => {
  for (const e of ['Bash', 'Bash(*)', 'Bash(node *)', 'Bash(node:*)', 'Bash(node scripts/*)', 'Bash(node scripts/qa-approve.mjs *)', 'mcp__claude_ai_Linear', 'mcp__claude_ai_Linear__save_issue'])
    assert(isUnsafeAllowEntry(e), `${e} should be unsafe`);
  for (const e of ['Bash(npm run selftest)', 'Bash(node scripts/gen-counts.mjs *)', 'mcp__claude_ai_Linear__list_issues', 'Read'])
    assert(!isUnsafeAllowEntry(e), `${e} should be fine`);
});
check('the installed hook matcher also covers Slack and Gmail tools', () => {
  const cfg = JSON.parse(readFileSync(join(HUB, '.claude', 'settings.local.json'), 'utf8'));
  const m = (cfg.hooks?.PreToolUse || []).map((h) => h.matcher).filter(Boolean).join('|');
  for (const t of ['mcp__claude_ai_Linear__save_issue', 'mcp__claude_ai_Atlassian__createJiraIssue', 'mcp__claude_ai_Slack__slack_send_message', 'mcp__claude_ai_Gmail__gmail_send_email'])
    assert(new RegExp(`^(?:${m})$`).test(t), `matcher "${m}" misses ${t}`);
});
// Asana (gamma): the connector was not authorized when this landed, so its tool names are unknown.
// The gate is therefore inverted for Asana — every tool is a write unless its verb is an explicit read.
const ASANA_WRITES = ['mcp__claude_ai_Asana__asana_create_task', 'mcp__claude_ai_Asana__asana_update_task', 'mcp__claude_ai_Asana__asana_create_task_story',
  'mcp__claude_ai_Asana__asana_delete_task', 'mcp__claude_ai_Asana__asana_add_task_to_section', 'mcp__claude_ai_Asana__create_task', 'mcp__claude_ai_Asana__add_comment',
  'mcp__claude_ai_Asana__move_task', 'mcp__claude_ai_Asana__some_tool_nobody_has_seen'];
const ASANA_READS = ['mcp__claude_ai_Asana__asana_get_task', 'mcp__claude_ai_Asana__asana_list_workspaces', 'mcp__claude_ai_Asana__asana_search_tasks',
  'mcp__claude_ai_Asana__asana_typeahead_search', 'mcp__claude_ai_Asana__get_tasks'];
check('every Asana tool is a gated write unless its verb is an explicit read — unknown names included (R-01)', () => {
  for (const t of ASANA_WRITES) assert(isTrackerWrite(t), `${t} should be gated`);
  for (const t of ASANA_READS) assert(!isTrackerWrite(t), `${t} should NOT be gated`);
});
check('the installed hook matcher routes Asana tools to the gate', () => {
  const cfg = JSON.parse(readFileSync(join(HUB, '.claude', 'settings.local.json'), 'utf8'));
  const m = (cfg.hooks?.PreToolUse || []).map((h) => h.matcher).filter(Boolean).join('|');
  for (const t of [...ASANA_WRITES, ...ASANA_READS]) assert(new RegExp(`^(?:${m})$`).test(t), `matcher "${m}" misses ${t}`);
});
check('the INSTALLED gate denies an unapproved Asana write, and passes an Asana read through', () => {
  const real = join(HUB, '.claude', 'hooks', 'tracker-write-gate.mjs');
  const d = decisionOf(hook({ tool_name: 'mcp__claude_ai_Asana__asana_update_task', tool_input: { task_id: '0', completed: true } }, real));
  assert(d.decision === 'deny', `the real hook allowed an unapproved Asana write: ${d.reason}`);
  const r = decisionOf(hook({ tool_name: 'mcp__claude_ai_Asana__asana_get_task', tool_input: { task_id: '0' } }, real));
  assert(r.decision === 'passthrough', `an Asana read was gated: ${r.reason}`);
});
check('a server-wide or write-tool Asana allow entry counts as unsafe config (R-01)', () => {
  for (const e of ['mcp__claude_ai_Asana', 'mcp__claude_ai_Asana__*', 'mcp__claude_ai_Asana__asana_update_task'])
    assert(isUnsafeAllowEntry(e), `${e} should be unsafe`);
  assert(!isUnsafeAllowEntry('mcp__claude_ai_Asana__asana_get_task'), 'an Asana read allow entry should be fine');
});
check('a plan generated with --force is refused by qa-approve without --accept-forced', () => {
  const forcedPlan = w('forced-plan.json', { schemaVersion: 1, project: 'alpha', runId: 'SELFTEST-FORCED', ledgerSha256: 'deadbeef', forced: true, forcedValidationErrors: ['fixture'], ops: [{ opId: 'op-001', tool: 'mcp__claude_ai_Linear__save_issue', args: { id: 'X', state: 'S' }, hash: 'h' }] });
  // A ticket is minted first, so the refusal can only come from the --force check, not a missing ticket.
  try {
    mustReject(approve(forcedPlan, 'selftest — not a real approval'), '--force', 'qa-approve');
  } finally {
  }
});
const compositeRun = 'customer=index-A1.js dealer=index-B2.js admin=index-C3.js';
const resultComposite = w('result-composite.json', { ticketId: 'ALP-402', project: 'alpha', runId: 'SELFTEST', buildId: compositeRun,
  results: [{ caseId: 'AC-1', plannedSurface: 'staging-dealer.alpha.example', ranOk: true, evidence: { ...okEvidence, buildId: 'index-B2.js' } }] });
check('a bare per-surface build id is accepted against a composite run id (R-06)', () =>
  mustAccept(run('run-result-validate.mjs', ['--result', resultComposite, '--build', compositeRun]), 'run-result'));
const resultCompositeStale = w('result-composite-stale.json', { ticketId: 'ALP-403', project: 'alpha', runId: 'SELFTEST', buildId: compositeRun,
  results: [{ caseId: 'AC-1', plannedSurface: 'staging-dealer.alpha.example', ranOk: true, evidence: { ...okEvidence, buildId: 'index-ZZ9.js' } }] });
check('a build id from none of the run surfaces is still rejected (R-06)', () =>
  mustReject(run('run-result-validate.mjs', ['--result', resultCompositeStale, '--build', compositeRun]), 'R-06', 'run-result'));
const resultHostLie = w('result-host-lie.json', { ticketId: 'ALP-404', project: 'alpha', runId: 'SELFTEST', buildId: BUILD,
  results: [{ caseId: 'AC-1', plannedSurface: 'staging-dealer.alpha.example', ranOk: true, evidence: { ...okEvidence, url: 'https://alpha.example/inventory', host: 'staging-dealer.alpha.example' } }] });
check('a typed evidence.host cannot contradict evidence.url (R-05)', () =>
  mustReject(run('run-result-validate.mjs', ['--result', resultHostLie, '--build', BUILD]), 'R-05', 'run-result'));
check('--key=value flags parse like --key value', () => {
  const res = run('gen-counts.mjs', ['--ledger=' + join(TMP, 'does-not-exist.json')]);
  assert(!/usage:/.test(String(res.stderr) + String(res.stdout)), `--ledger=… was not recognised: ${String(res.stderr).slice(0, 120)}`);
});

const e2eLedger = w('e2e-ledger.json', ledgerWith(
  baseTicket({ id: 'ALP-501' }),
  baseTicket({
    id: 'ALP-502',
    verdict: 'FAIL',
    comment: 'Applying a make filter on the dealer inventory page and paging forward clears the filter; the unfiltered list returns. Expected the filter to persist across pagination.\n\n@Dev Lead',
    cases: [{ caseId: 'AC-1', verdict: 'FAIL', evidence: { url: 'https://staging-dealer.alpha.example/inventory?page=2', observedText: '412 vehicles', httpStatus: 200, buildId: BUILD } }],
  })
));
const e2ePlan = join(TMP, 'e2e-plan.json');

check('a plan generates deterministically from the ledger', () => {
  const r = run('linear-plan.mjs', ['--ledger', e2eLedger, '--project', 'alpha', '--out', e2ePlan]);
  mustAccept(r, 'linear-plan');
  const p = JSON.parse(readFileSync(e2ePlan, 'utf8'));
  const kinds = p.ops.map((o) => `${o.ticket}:${o.kind}`);
  assert(kinds.includes('ALP-502:comment'), `no comment planned for the FAIL: ${kinds.join(', ')}`);
  assert(kinds.includes('ALP-502:state'), `no state change planned for the FAIL: ${kinds.join(', ')}`);
  const pass = p.ops.find((o) => o.ticket === 'ALP-501');
  assert(pass && pass.args.state === 'Release Candidate', `PASS did not route to Release Candidate: ${JSON.stringify(pass?.args)}`);
  const r2 = run('linear-plan.mjs', ['--ledger', e2eLedger, '--project', 'alpha', '--out', join(TMP, 'e2e-plan-2.json')]);
  mustAccept(r2, 'linear-plan rerun');
  const p2 = JSON.parse(readFileSync(join(TMP, 'e2e-plan-2.json'), 'utf8'));
  assert(JSON.stringify(p.ops) === JSON.stringify(p2.ops), 'two runs over the same ledger produced different call plans');
});

check('planning from an invalid ledger is refused', () => {
  const bad = w('e2e-bad-ledger.json', ledgerWith(baseTicket({ id: 'ALP-503', verdict: 'FAIL', cases: [{ caseId: 'AC-1', verdict: 'FAIL' }] })));
  mustReject(run('linear-plan.mjs', ['--ledger', bad, '--project', 'alpha', '--out', join(TMP, 'never.json')]), 'invalid ledger', 'linear-plan');
});

check('approval without the user\'s own words is refused', () =>
  mustReject(run('qa-approve.mjs', ['--plan', e2ePlan]), 'user-quote', 'qa-approve'));

check('a hand-edited plan hash is refused', () => {
  const p = JSON.parse(readFileSync(e2ePlan, 'utf8'));
  p.ops[0].args.state = 'Done';
  const tampered = w('e2e-plan-tampered.json', p);
  try {
    mustReject(approve(tampered, 'go ahead'), 'edited by hand', 'qa-approve');
  } finally {
  }
});

check('approve → the exact planned call is allowed, a neighbouring one is not', () => {
  const r = approve(e2ePlan, 'selftest — not a real approval', ['--ttl-hours', '1']);
  try {
    mustAccept(r, 'qa-approve');
    const plan = JSON.parse(readFileSync(e2ePlan, 'utf8'));
    const op = plan.ops.find((o) => o.tool === 'mcp__claude_ai_Linear__save_issue');
    const real = join(HUB, '.claude', 'hooks', 'tracker-write-gate.mjs');
    const ok = decisionOf(hook({ tool_name: op.tool, tool_input: op.args }, real));
    assert(ok.decision === 'allow', `the approved op was denied: ${ok.reason}`);
    const no = decisionOf(hook({ tool_name: op.tool, tool_input: { ...op.args, state: 'Done' } }, real));
    assert(no.decision === 'deny', 'an unapproved neighbouring state change was allowed');
  } finally {
    run('qa-approve.mjs', ['--revoke', 'SELFTEST']);
    rmSync(join(HUB, '.qa-approvals', 'SELFTEST.applied.jsonl'), { force: true });
  }
});

check('after revoke, the same call is denied again', () => {
  const plan = JSON.parse(readFileSync(e2ePlan, 'utf8'));
  const op = plan.ops.find((o) => o.tool === 'mcp__claude_ai_Linear__save_issue');
  const d = decisionOf(hook({ tool_name: op.tool, tool_input: op.args }, join(HUB, '.claude', 'hooks', 'tracker-write-gate.mjs')));
  assert(d.decision === 'deny', 'a revoked approval still authorised its ops');
});

// ───────────────────────────────────────────────────────────────────────────────────────────
// 6b. E-1j — the same pipeline, on Jira (beta / BET): ledger → plan → approval → gate
//
// The write gate never knew what a tracker was: it hashes whatever call it is handed. What was
// Linear-only was the *plan generator*, so a Jira project had no way to get a hash-bound plan and
// therefore no legal way to write at all. These checks pin the Jira half to the same contract:
// derived states (R-04), comment before status, no transition for a hold, and one approved hash
// that authorises exactly one call and none of its neighbours (R-01).
// ───────────────────────────────────────────────────────────────────────────────────────────
console.log('\nE-1j Jira plan (ledger → plan → approve → gate)');

const jProfile = loadProfile('beta');
const jira = jProfile.jira || {};
const JBUILD = 'student=index-SELFTEST01.js admin=index-SELFTEST02.js';
const JSURFACE = 'web.beta.example:8443';

const jTicket = (over = {}) => ({
  id: 'BET-900',
  verdict: 'PASS',
  surface: JSURFACE,
  buildId: JBUILD,
  observedAt: daysAgo(1),
  cases: [{ caseId: 'AC-1', verdict: 'PASS' }],
  ...over,
});
const jLedgerWith = (...tickets) => ({
  schemaVersion: 1, runId: 'SELFTEST-J', project: 'beta', generatedAt: daysAgo(1),
  build: { buildId: JBUILD }, tickets,
});
// The dev-facing prose is plain Uzbek on purpose: it is what a real BET comment looks like, and it
// is the shape the Cloudflare WAF in front of the site accepts.
const jFail = (comment) => jTicket({
  id: 'BET-901',
  verdict: 'FAIL',
  comment,
  cases: [{
    caseId: 'AC-1',
    verdict: 'FAIL',
    evidence: { url: 'https://web.beta.example:8443/courses/12', httpStatus: 200, observedText: 'Kurslar', buildId: JBUILD },
  }],
});
const J_FAIL_COMMENT = "Tekshiruv natijasi: tugma hali ham ishlamaydi. Kutilgan: kurs sahifasiga o'tish.";
const jNeedsManual = jTicket({
  id: 'BET-902',
  verdict: 'NEEDS_MANUAL',
  comment: "Bu holatni tekshirish uchun haqiqiy telefon kerak: kartani biriktirishda SMS orqali keladigan tasdiqlash kodi so'raladi va test raqami uchun SMS qutisi ulanmagan.",
  cases: [{ caseId: 'AC-1', verdict: 'PASS' }, { caseId: 'AC-2', verdict: 'NEEDS_MANUAL' }],
  needsManual: [{
    caseId: 'AC-2',
    probe: {
      attempted: 'card binding on https://web.beta.example:8443/billing/cards with the staging test card',
      failureMode: 'the form accepts the card and then waits for a 5-digit code delivered by SMS to +998901234567; no inbox is connected for that number',
      missingCapability: 'SMS inbox for the Uzbek test number +998901234567',
      evidence: 'projects/beta/qa-reports/BET-902_attachments/sms-probe.json',
    },
    manualRepro: [
      '1. On a handset holding the +998901234567 SIM, open web.beta.example:8443 and log in as student A',
      '2. Add the staging test card under Billing',
      '3. Enter the 5-digit code from the SMS within 2 minutes and confirm the card is saved',
    ],
  }],
});

const jLedger = w('jira-ledger.json', jLedgerWith(jTicket(), jFail(J_FAIL_COMMENT), jNeedsManual));
const jLive = w('jira-live.json', { tickets: [{ id: 'BET-900', status: 'READY FOR QA' }, { id: 'BET-901', status: 'READY FOR QA' }, { id: 'BET-902', status: 'READY FOR QA' }] });
const jPlan = join(TMP, 'jira-plan.json');
const jPlanFile = () => JSON.parse(readFileSync(jPlan, 'utf8'));
const jOp = (ticket, kind) => jPlanFile().ops.find((o) => o.ticket === ticket && o.kind === kind);
const jGen = (out, ledger = jLedger, project = 'beta') =>
  run('jira-plan.mjs', ['--ledger', ledger, '--project', project, '--out', out, '--live', jLive]);

check('profiles/beta.json carries the Jira board configuration', () => {
  const j = jiraConfig(jProfile);
  assert(j.projectKey === 'BET', `unexpected Jira project key "${j.projectKey}"`);
  assert(jProfile.linear?.stateMap, 'beta has no linear.stateMap — Jira writes cannot be planned (R-04)');
});

check('a Jira plan generates from a beta ledger', () => {
  mustAccept(jGen(jPlan), 'jira-plan');
  const kinds = jPlanFile().ops.map((o) => `${o.ticket}:${o.kind}`);
  for (const want of ['BET-900:state', 'BET-901:comment', 'BET-901:state', 'BET-902:comment'])
    assert(kinds.includes(want), `${want} was not planned: ${kinds.join(', ')}`);
});

check('the BET-901 comment is planned before its transition', () => {
  const ops = jPlanFile().ops;
  const ci = ops.findIndex((o) => o.ticket === 'BET-901' && o.kind === 'comment');
  const si = ops.findIndex((o) => o.ticket === 'BET-901' && o.kind === 'state');
  assert(ci >= 0 && si >= 0, `BET-901 is missing an op: ${ops.map((o) => o.opId + ':' + o.kind).join(', ')}`);
  assert(ci < si, 'the status would move before the explanation was posted');
});

check('the FAIL transition carries the profile transition id, tool and cloudId', () => {
  const op = jOp('BET-901', 'state');
  assert(op.tool === jira.tools.transition, `wrong tool: ${op.tool}`);
  assert(op.args.transition.id === '21', `FAIL did not route to "Ready for dev" (id 21): ${JSON.stringify(op.args.transition)}`);
  assert(op.args.cloudId === jira.cloudId, `wrong cloudId: ${op.args.cloudId}`);
  assert(op.args.issueIdOrKey === 'BET-901', `wrong issue: ${op.args.issueIdOrKey}`);
});

check('a PASS routes to the STAGING transition id', () => {
  const op = jOp('BET-900', 'state');
  assert(op && op.args.transition.id === '2', `PASS did not route to STAGING (id 2): ${JSON.stringify(op?.args)}`);
});

check('a Jira comment op is markdown and addressed to the issue key', () => {
  const op = jOp('BET-901', 'comment');
  assert(op.tool === jira.tools.comment, `wrong tool: ${op.tool}`);
  assert(op.args.contentFormat === 'markdown', `wrong contentFormat: ${op.args.contentFormat}`);
  assert(op.args.issueIdOrKey === 'BET-901' && op.args.commentBody === J_FAIL_COMMENT, `wrong comment target/body: ${JSON.stringify(op.args)}`);
});

check('a needs-manual ticket is commented, never moved, and the hold is noted (R-02)', () => {
  const p = jPlanFile();
  assert(!p.ops.some((o) => o.ticket === 'BET-902' && o.kind === 'state'), 'a NEEDS_MANUAL ticket was moved off the QA queue');
  assert(p.ops.some((o) => o.ticket === 'BET-902' && o.kind === 'comment'), 'the needs-manual explanation was not planned');
  assert(p.notes.includes('BET-902: NEEDS_MANUAL — stays in READY FOR QA (hold)'), `no hold note: ${p.notes.join(' | ')}`);
});

check('--comment-only plans every comment and no transition, and names each suppressed move', () => {
  const out3 = join(TMP, 'jira-plan-comment-only.json');
  mustAccept(run('jira-plan.mjs', ['--ledger', jLedger, '--project', 'beta', '--out', out3, '--live', jLive, '--comment-only']), 'jira-plan --comment-only');
  const p = JSON.parse(readFileSync(out3, 'utf8'));
  assert(p.commentOnly === true, 'plan does not record commentOnly');
  assert(!p.ops.some((o) => o.kind === 'state'), `a transition was planned under --comment-only: ${p.ops.map((o) => o.ticket + ':' + o.kind).join(', ')}`);
  for (const t of ['BET-901', 'BET-902']) assert(p.ops.some((o) => o.ticket === t && o.kind === 'comment'), `${t} comment missing under --comment-only`);
  assert(p.notes.some((n) => n.startsWith('BET-901:') && n.includes('suppressed (--comment-only)')), `suppressed move not noted: ${p.notes.join(' | ')}`);
});

check('two Jira plan runs over the same ledger produce byte-identical ops', () => {
  const out2 = join(TMP, 'jira-plan-2.json');
  mustAccept(jGen(out2), 'jira-plan rerun');
  assert(JSON.stringify(jPlanFile().ops) === JSON.stringify(JSON.parse(readFileSync(out2, 'utf8')).ops),
    'two runs over the same ledger produced different call plans');
});

check('describeOp renders a Jira comment legibly for the approval prompt', () => {
  const op = jOp('BET-901', 'comment');
  const d = describeOp(op.tool, op.args);
  assert(d.includes('BET-901'), `the description does not name the issue: ${d}`);
  assert(!d.startsWith(op.tool), `describeOp fell through to its default branch: ${d}`);
  assert(op.summary === d, 'the plan summary and describeOp disagree');
});

check('a hand-edited Jira transition id is refused by qa-approve', () => {
  const p = jPlanFile();
  p.ops.find((o) => o.kind === 'state').args.transition.id = '3'; // PRODUCTION
  try {
    mustReject(approve(w('jira-plan-tampered.json', p), 'go ahead'), 'edited by hand', 'qa-approve');
  } finally {
  }
});

check('approve → the exact planned Jira transition is allowed, its neighbours are not', () => {
  const r = approve(jPlan, 'selftest — not a real approval', ['--ttl-hours', '1']);
  try {
    mustAccept(r, 'qa-approve');
    const op = jOp('BET-901', 'state');
    const real = join(HUB, '.claude', 'hooks', 'tracker-write-gate.mjs');
    const ok = decisionOf(hook({ tool_name: op.tool, tool_input: op.args }, real));
    assert(ok.decision === 'allow', `the approved Jira transition was denied: ${ok.reason}`);
    const toProd = decisionOf(hook({ tool_name: op.tool, tool_input: { ...op.args, transition: { id: '3' } } }, real));
    assert(toProd.decision === 'deny', 'an unapproved transition to PRODUCTION was allowed');
    const other = decisionOf(hook({ tool_name: op.tool, tool_input: { ...op.args, issueIdOrKey: 'BET-1' } }, real));
    assert(other.decision === 'deny', 'the approved transition also moved a different issue');
  } finally {
    run('qa-approve.mjs', ['--revoke', 'SELFTEST-J']);
    rmSync(join(HUB, '.qa-approvals', 'SELFTEST-J.applied.jsonl'), { force: true });
  }
});

check('planning Jira writes for a project with no jira block is refused', () =>
  mustReject(jGen(join(TMP, 'never-jira.json'), jLedger, 'alpha'), 'jira', 'jira-plan'));

check('a comment the Cloudflare WAF would block (a shell snippet) refuses the whole plan', () => {
  const bad = w('jira-ledger-waf-curl.json', jLedgerWith(jFail("Tugma ishlamaydi. Xuddi shu so'rovni curl bilan takrorladim, javob o'zgarmadi.")));
  mustReject(jGen(join(TMP, 'never-jira.json'), bad), 'WAF', 'jira-plan');
});

check('a comment carrying markup the WAF would block refuses the whole plan', () => {
  const bad = w('jira-ledger-waf-markup.json', jLedgerWith(jFail("Tugma <b>hali ham</b> ishlamaydi. Kutilgan: kurs sahifasiga o'tish.")));
  mustReject(jGen(join(TMP, 'never-jira.json'), bad), 'WAF', 'jira-plan');
});

check('the WAF check is CAPS-sensitive: prose passes, a payload does not', () => {
  assert(wafViolations(J_FAIL_COMMENT).length === 0, 'plain Uzbek prose tripped the WAF check');
  assert(wafViolations('the dev will update the endpoint and get a fresh token').length === 0, 'lowercase "update"/"get" tripped a payload rule');
  assert(wafViolations('POST /api/v1/courses').includes('http-verb'), 'a capitalised HTTP verb did not trip');
  assert(wafViolations('{"id": 1}').includes('json-payload-start'), 'a JSON body did not trip');
});

check('transitionIdFor refuses a state the board has no transition to', () => {
  let threw = null;
  try {
    transitionIdFor('Blocked', jira);
  } catch (e) {
    threw = e;
  }
  assert(threw, 'an unmapped state name silently produced a transition id');
  assert(/no Jira transition id for state "Blocked"/.test(threw.message), threw.message);
});

check('a Jira comment is a gated write and Jira reads are not (R-01)', () => {
  assert(isTrackerWrite('mcp__claude_ai_Atlassian__addCommentToJiraIssue'), 'a Jira comment is an outward write and must be gated');
  for (const t of ['mcp__claude_ai_Atlassian__searchJiraIssuesUsingJql', 'mcp__claude_ai_Atlassian__getTransitionsForJiraIssue'])
    assert(!isTrackerWrite(t), `${t} is a read and must not be gated`);
});

// ───────────────────────────────────────────────────────────────────────────────────────────
// 6c. E-1a — the same pipeline, on Asana (gamma): ledger + live pull → plan → approve → gate
//
// The positive paths run against throwaway profiles (profiles/selftest-asana*.json, removed on
// exit) built from the real gamma one with fake gids: one with a pinned move tool, one with
// moveMode "manual" (what gamma really uses — the connector has no move-to-section tool).
// ───────────────────────────────────────────────────────────────────────────────────────────
console.log('\nE-1a Asana plan (ledger + live → plan → approve → gate)');

const aReal = loadProfile('gamma');
const A_SLUG = 'selftest-asana';
const aProfilePath = join(HUB, 'profiles', `${A_SLUG}.json`);
process.on('exit', () => rmSync(aProfilePath, { force: true }));
/** A throwaway Asana profile with `asana` swapped for the given block; removed on exit. */
const aFixture = (slug, asana) => {
  const path = join(HUB, 'profiles', `${slug}.json`);
  process.on('exit', () => rmSync(path, { force: true }));
  writeFileSync(path, JSON.stringify({ ...aReal, slug, asana }, null, 2) + '\n');
  return slug;
};
const A_SECTIONS = { 'Staging QA': '9001', 'Release Candidate': '9002', Reopen: '9003', Blocked: '9004', 'Gathering Requirements': '9005' };
const aProfile = {
  ...aReal,
  slug: A_SLUG,
  asana: {
    workspaceGid: '1000',
    toolsVerifiedAt: '2026-10-06 (selftest fixture)',
    tools: {
      comment: { name: 'mcp__claude_ai_Asana__asana_create_task_story', args: { task: 'task_id', text: 'text' } },
      move: { name: 'mcp__claude_ai_Asana__asana_add_task_to_section', args: { task: 'task_id', section: 'section_id' } },
    },
    boards: {
      'Gamma App': { projectGid: '2000', sections: A_SECTIONS },
      'Gamma Reporting App': { projectGid: '3000', sections: Object.fromEntries(Object.entries(A_SECTIONS).map(([k, v]) => [k, '8' + v.slice(1)])) },
    },
  },
};
writeFileSync(aProfilePath, JSON.stringify(aProfile, null, 2) + '\n');

const ABUILD = 'index-SELFTEST01.js';
const aTicket = (over = {}) => ({ id: 'GAM-900', verdict: 'PASS', surface: 'gamma-legacy.example', buildId: ABUILD, observedAt: daysAgo(1), cases: [{ caseId: 'AC-1', verdict: 'PASS' }], ...over });
const A_FAIL_COMMENT = 'The Survey Status filter still shows archived waves after choosing Active. Expected: only active waves are listed.';
const aFail = aTicket({
  id: 'GAM-901', verdict: 'FAIL', comment: A_FAIL_COMMENT,
  cases: [{ caseId: 'AC-1', verdict: 'FAIL', evidence: { url: 'https://gamma-legacy.example/surveys', httpStatus: 200, observedText: 'Archived', buildId: ABUILD } }],
});
const aLedgerWith = (project, ...tickets) => ({ schemaVersion: 1, runId: 'SELFTEST-A', project, generatedAt: daysAgo(1), build: { buildId: ABUILD }, tickets });
const aLedger = w('asana-ledger.json', aLedgerWith(A_SLUG, aTicket(), aFail));
const aLive = w('asana-live.json', { tickets: [
  { id: 'GAM-900', gid: '5550900', board: 'Gamma App', section: 'Staging QA' },
  { id: 'GAM-901', gid: '5550901', board: 'Gamma Reporting App', section: 'Staging QA' },
] });
const aPlan = join(TMP, 'asana-plan.json');
const aGen = (out, ledger = aLedger, project = A_SLUG, live = aLive) =>
  run('asana-plan.mjs', ['--ledger', ledger, '--project', project, '--out', out, '--live', live]);
const aOp = (ticket, kind) => JSON.parse(readFileSync(aPlan, 'utf8')).ops.find((o) => o.ticket === ticket && o.kind === kind);

check('an Asana profile with a TODO section gid refuses to plan Asana writes', () => {
  const slug = aFixture('selftest-asana-todo', { ...aProfile.asana, boards: { 'Gamma App': { projectGid: '2000', sections: { ...A_SECTIONS, 'Release Candidate': 'TODO: read off the board' } } } });
  mustReject(aGen(join(TMP, 'never-asana.json'), w('asana-ledger-todo.json', aLedgerWith(slug, aTicket())), slug), 'no section gid for column "Release Candidate"', 'asana-plan');
});

check('a profile with no move tool and no moveMode refuses — "manual" is an opt-in, never a fallback', () => {
  const slug = aFixture('selftest-asana-nomove', { ...aProfile.asana, tools: { comment: aProfile.asana.tools.comment, move: null } });
  mustReject(aGen(join(TMP, 'never-asana.json'), w('asana-ledger-nomove.json', aLedgerWith(slug, aTicket())), slug), 'tools.move.name is missing', 'asana-plan');
});

check('an unknown moveMode is refused', () => {
  const slug = aFixture('selftest-asana-badmode', { ...aProfile.asana, moveMode: 'auto' });
  mustReject(aGen(join(TMP, 'never-asana.json'), w('asana-ledger-badmode.json', aLedgerWith(slug, aTicket())), slug), 'moveMode must be', 'asana-plan');
});

check('an Asana plan generates, comment before move, each move on the task\'s OWN board', () => {
  mustAccept(aGen(aPlan), 'asana-plan');
  const ops = JSON.parse(readFileSync(aPlan, 'utf8')).ops;
  const ci = ops.findIndex((o) => o.ticket === 'GAM-901' && o.kind === 'comment');
  const si = ops.findIndex((o) => o.ticket === 'GAM-901' && o.kind === 'state');
  assert(ci >= 0 && si > ci, `GAM-901 comment/move missing or out of order: ${ops.map((o) => o.ticket + ':' + o.kind).join(', ')}`);
  assert(aOp('GAM-900', 'state').args.section_id === '9002', `PASS did not go to Release Candidate on Gamma App: ${JSON.stringify(aOp('GAM-900', 'state').args)}`);
  assert(aOp('GAM-901', 'state').args.section_id === '8003', `FAIL did not go to Reopen on the Reporting board: ${JSON.stringify(aOp('GAM-901', 'state').args)}`);
  assert(aOp('GAM-901', 'comment').args.task_id === '5550901' && aOp('GAM-901', 'comment').args.text === A_FAIL_COMMENT, 'comment target/body wrong');
});

check('a ledger ticket missing from the live pull refuses the whole plan (not skipped)', () => {
  const thin = w('asana-live-thin.json', { tickets: [{ id: 'GAM-900', gid: '5550900', board: 'Gamma App', section: 'Staging QA' }] });
  mustReject(aGen(join(TMP, 'never-asana.json'), aLedger, A_SLUG, thin), 'GAM-901', 'asana-plan');
});

check('Linear planners refuse a project whose tracker is Asana', () =>
  mustReject(run('linear-plan.mjs', ['--ledger', aLedger, '--project', A_SLUG, '--out', join(TMP, 'never-linear.json')]), 'not Linear', 'linear-plan'));

check('approve → the exact planned Asana move is allowed, another section or task is not', () => {
  const r = approve(aPlan, 'selftest — not a real approval', ['--ttl-hours', '1']);
  try {
    mustAccept(r, 'qa-approve');
    const op = aOp('GAM-901', 'state');
    const real = join(HUB, '.claude', 'hooks', 'tracker-write-gate.mjs');
    assert(decisionOf(hook({ tool_name: op.tool, tool_input: op.args }, real)).decision === 'allow', 'the approved Asana move was denied');
    assert(decisionOf(hook({ tool_name: op.tool, tool_input: { ...op.args, section_id: '8002' } }, real)).decision === 'deny', 'an unapproved move to Release Candidate was allowed');
    assert(decisionOf(hook({ tool_name: op.tool, tool_input: { ...op.args, task_id: '1' } }, real)).decision === 'deny', 'the approved move also moved a different task');
  } finally {
    run('qa-approve.mjs', ['--revoke', 'SELFTEST-A']);
    rmSync(join(HUB, '.qa-approvals', 'SELFTEST-A.applied.jsonl'), { force: true });
  }
});


// moveMode "manual": comments are the only gated calls; moves become a hashed list + a checklist.
const M_SLUG = aFixture('selftest-asana-manual', { ...aProfile.asana, moveMode: 'manual', tools: { comment: aProfile.asana.tools.comment, move: null } });
const mPlan = join(TMP, 'asana-manual', 'asana-plan.json');
const mLedger = w('asana-ledger-manual.json', aLedgerWith(M_SLUG, aTicket(), aFail));
const mGen = () => aGen(mPlan, mLedger, M_SLUG);

check('manual move mode: comments are the only ops; each move is listed with its OWN board\'s section gid', () => {
  mustAccept(mGen(), 'asana-plan (manual)');
  const plan = JSON.parse(readFileSync(mPlan, 'utf8'));
  assert(plan.moveMode === 'manual', `moveMode is ${plan.moveMode}`);
  assert(plan.ops.length > 0 && plan.ops.every((o) => o.kind === 'comment'), `ops other than comments planned: ${plan.ops.map((o) => o.ticket + ':' + o.kind).join(', ')}`);
  const mv = (id) => plan.manualMoves.find((m) => m.ticket === id);
  assert(mv('GAM-900')?.to === 'Release Candidate' && mv('GAM-900').sectionGid === '9002' && mv('GAM-900').url === 'https://app.asana.com/0/2000/5550900', `PASS move wrong: ${JSON.stringify(mv('GAM-900'))}`);
  assert(mv('GAM-901')?.to === 'Reopen' && mv('GAM-901').sectionGid === '8003', `FAIL move not to Reopen on the Reporting board: ${JSON.stringify(mv('GAM-901'))}`);
  const md = readFileSync(join(TMP, 'asana-manual', '_ASANA-MOVES-SELFTEST-A.md'), 'utf8');
  assert(md.includes('**GAM-901** (Gamma Reporting App): Staging QA → **Reopen**'), `checklist missing the GAM-901 move:\n${md.slice(0, 400)}`);
});

check('manual move mode: an approved comment plan still denies any Asana move-like write', () => {
  const r = approve(mPlan, 'selftest — not a real approval', ['--ttl-hours', '1']);
  try {
    mustAccept(r, 'qa-approve');
    const c = JSON.parse(readFileSync(mPlan, 'utf8')).ops[0];
    const real = join(HUB, '.claude', 'hooks', 'tracker-write-gate.mjs');
    assert(decisionOf(hook({ tool_name: c.tool, tool_input: c.args }, real)).decision === 'allow', 'the approved comment was denied');
    assert(decisionOf(hook({ tool_name: 'mcp__claude_ai_Asana__asana_update_task', tool_input: { task_id: '5550901', completed: true } }, real)).decision === 'deny', 'an unplanned update_task was allowed');
  } finally {
    run('qa-approve.mjs', ['--revoke', 'SELFTEST-A']);
    rmSync(join(HUB, '.qa-approvals', 'SELFTEST-A.applied.jsonl'), { force: true });
  }
});

check('asana-moves-check: a move not done, or done to the wrong column, fails; all done passes', () => {
  const after = (s900, s901) => w(`asana-live-after-${s900}-${s901}.json`.replace(/ /g, '_'), { tickets: [
    { id: 'GAM-900', gid: '5550900', board: 'Gamma App', section: s900 },
    { id: 'GAM-901', gid: '5550901', board: 'Gamma Reporting App', section: s901 },
  ] });
  const chk = (live) => run('asana-moves-check.mjs', ['--plan', mPlan, '--live', live]);
  mustReject(chk(after('Release Candidate', 'Staging QA')), 'NOT MOVED', 'asana-moves-check');
  mustReject(chk(after('Done', 'Reopen')), 'WRONG COLUMN', 'asana-moves-check');
  mustAccept(chk(after('Release Candidate', 'Reopen')), 'asana-moves-check');
});

// asana-pull.mjs — the queue is the section (not `completed`), the id comes from the "[GAM-n]" title suffix
// or the task is refused, and notes must agree with html_notes (the raw is copied out of MCP by an agent).
const P_NOTES = 'Depends on: GAM-899\n\nThe status filter narrows the survey list.\n\nAcceptance Criteria:\n- Active shows only active waves\n- Archived shows only archived waves\n\nGrounded in: FRS 4.2';
const P_HTML = '<body>Depends on: GAM-899\n\nThe status filter narrows the survey list.\n\nAcceptance Criteria:\n<ul><li>Active shows only active waves</li><li>Archived shows only archived waves</li></ul>\nGrounded in: FRS 4.2</body>';
const pTask = (gid, name, { project = '2000', section = ['9001', 'Staging QA'], completed = true, notes = P_NOTES, html = P_HTML } = {}) => ({
  task: { gid, name, completed, modified_at: daysAgo(1), notes, html_notes: html,
    memberships: [{ project: { gid: project }, section: { gid: section[0], name: section[1] } }],
    custom_fields: [{ name: 'Priority', display_value: 'High' }] },
  stories: { data: [
    { resource_subtype: 'section_changed', type: 'system', text: 'moved this task' },
    { resource_subtype: 'comment_added', type: 'comment', created_by: { name: 'the client QA' }, created_at: daysAgo(2), text: 'Ready for QA on Netlify' },
  ], next_page: null },
  attachments: [], subtasks: [],
});
const P_GOOD = [
  pTask('7000910', 'Survey status filter [GAM-910]'),
  pTask('7000911', 'Report export [GAM-911]', { project: '3000', section: ['8001', 'Staging QA'], completed: false }),
  pTask('7000912', 'Not queued yet [GAM-912]', { section: ['9007', 'Committed'], completed: false }),
];
const pPull = (name, entries, extra = []) => {
  const dir = join(TMP, 'asana-pull', name);
  rmSync(dir, { recursive: true, force: true });
  return { dir, res: run('asana-pull.mjs', ['--project', A_SLUG, '--run', 'SELFTEST-P', '--from', w(`asana-pull-${name}.json`, entries), '--out-dir', dir, ...extra]) };
};

check('asana-pull: queue = the Staging QA section on every board, completed ignored, ACs verbatim, H-1 passes', () => {
  const { dir, res } = pPull('good', P_GOOD);
  mustAccept(res, 'asana-pull');
  const live = JSON.parse(readFileSync(join(dir, '_LIVE-SELFTEST-P.json'), 'utf8')).tickets;
  assert(live.map((t) => t.id).join() === 'GAM-910,GAM-911', `queue wrong (Committed task or a completed one mishandled): ${live.map((t) => t.id).join()}`);
  assert(live[1].board === 'Gamma Reporting App' && live[1].gid === '7000911' && live[0].updatedAt, `live record wrong: ${JSON.stringify(live[1])}`);
  const spec = JSON.parse(readFileSync(join(dir, '_INTAKE-SELFTEST-P.json'), 'utf8'));
  assert(JSON.stringify(spec[0].acs) === JSON.stringify(['AC-1 Active shows only active waves', 'AC-2 Archived shows only archived waves']), `ACs not verbatim: ${JSON.stringify(spec[0].acs)}`);
  assert(spec[0].comments.length === 1 && spec[0].comments[0].text === 'Ready for QA on Netlify', `comments wrong: ${JSON.stringify(spec[0].comments)}`);
  mustAccept(run('intake-assert.mjs', ['--raw', join(dir, '_INTAKE-SELFTEST-P-raw.json'), '--spec', join(dir, '_INTAKE-SELFTEST-P.json')]), 'intake-assert on asana-pull output');
  const again = run('asana-pull.mjs', ['--project', A_SLUG, '--run', 'SELFTEST-P', '--from', join(TMP, 'asana-pull-good.json'), '--out-dir', dir]);
  mustReject(again, 'refusing to overwrite', 'asana-pull (second write to the same run)');
});

const P_NOTES_J = 'Acceptance Criteria:\n- Lock needs a reason\n\n==============================\nQA TEST PLAN (added 12 Oct 2026)\n==============================\n\nBEFORE YOU START\n• Two users.\n\nTEST CASES (steps → expected result), run for EACH type\nTC1 Lock: lock with a reason → locked.\nTC2 Reason required: empty reason → refused.\nType-specific checks:\n• grids too\n\nTC3 Other roles: as viewer → 403.\n\nKNOWN FINDING (12 Oct)\n• TC3 currently returns 500; log it separately.\n\nPASS RULE\nPass when TC1 to TC3 pass.\n\nEXTRA SPEC CHECKS (log gaps for the client QA)\nSC1 Locked means locked: edit after lock → refused.\n\nRELATED TICKETS (status on 12 Oct)\n• GAM-725 gate.';
check('asana-pull: the client QA-format "TEST CASES (…)" with TCn lines keeps the ticket\'s own numbers, folds sub-bullets into the case, parses SCn → specChecks, H-1 passes', () => {
  const { dir, res } = pPull('clientqa', [pTask('7000915', 'Lock path [GAM-915]', { notes: P_NOTES_J, html: `<body>${P_NOTES_J}</body>` })]);
  mustAccept(res, 'asana-pull (the client QA format)');
  const spec = JSON.parse(readFileSync(join(dir, '_INTAKE-SELFTEST-P.json'), 'utf8'))[0];
  assert(spec.testCases.map((c) => c.id).join() === 'TC-1,TC-2,TC-3', `TC ids wrong: ${spec.testCases.map((c) => c.id).join()}`);
  assert(spec.testCases[1].text === 'TC2 Reason required: empty reason → refused. Type-specific checks: • grids too', `sub-bullets not folded into TC2: ${spec.testCases[1].text}`);
  assert(spec.testCases[2].text === 'TC3 Other roles: as viewer → 403.', `TC3 leaked into the next section: ${spec.testCases[2].text}`);
  assert(spec.specChecks.length === 1 && spec.specChecks[0].id === 'SC-1' && /edit after lock/.test(spec.specChecks[0].text), `specChecks wrong: ${JSON.stringify(spec.specChecks)}`);
  assert(JSON.stringify(spec.acs) === JSON.stringify(['AC-1 Lock needs a reason']), `ACs wrong: ${JSON.stringify(spec.acs)}`);
  mustAccept(run('intake-assert.mjs', ['--raw', join(dir, '_INTAKE-SELFTEST-P-raw.json'), '--spec', join(dir, '_INTAKE-SELFTEST-P.json')]), 'intake-assert on the client QA-format output');
});

check('asana-pull: a queued task with no id, or a non-standard "[GAM-n follow-up]" tag, is refused (not guessed)', () => {
  mustReject(pPull('noid', [...P_GOOD, pTask('7000913', 'Fix the header')]).res, 'no "[GAM-n]" suffix', 'asana-pull');
  mustReject(pPull('oddid', [...P_GOOD, pTask('7000914', 'Header polish [GAM-910 follow-up]')]).res, 'non-standard id tag', 'asana-pull');
  const { dir, res } = pPull('allow', [...P_GOOD, pTask('7000913', 'Fix the header')], ['--allow-unidentified']);
  mustAccept(res, 'asana-pull --allow-unidentified');
  const ids = JSON.parse(readFileSync(join(dir, '_LIVE-SELFTEST-P.json'), 'utf8')).tickets.map((t) => t.id);
  assert(ids.includes('ASANA-7000913'), `--allow-unidentified did not key the task by gid: ${ids.join()}`);
});

check('asana-pull: a duplicate id, a stale section gid, a notes/html_notes mismatch or a truncated story page is refused', () => {
  mustReject(pPull('dup', [...P_GOOD, pTask('7000915', 'Copy [GAM-910]')]).res, 'two tasks carry this id', 'asana-pull');
  mustReject(pPull('stale', [pTask('7000910', 'x [GAM-910]', { section: ['9999', 'Staging QA'] })]).res, 'the profile is stale', 'asana-pull');
  mustReject(pPull('drift', [pTask('7000910', 'x [GAM-910]', { notes: P_NOTES.replace('only active', 'only the active') })]).res, 'not a verbatim copy', 'asana-pull');
  const trunc = pTask('7000910', 'x [GAM-910]');
  trunc.stories.next_page = { offset: 'abc' };
  mustReject(pPull('trunc', [trunc]).res, 'next_page', 'asana-pull');
});

// ───────────────────────────────────────────────────────────────────────────────────────────
// 6c. E-1k — new bugs on Jira: verifier drafts → createJiraIssue plan → approval → gate
//
// Defects observed outside a ticket's acceptance criteria used to end as "file separately" notes,
// which in practice meant never. This path plans them as gated creates. The checks pin: one
// create per non-duplicate draft, the project's title convention, WAF + R-10 refusals, and one
// approved hash that authorises exactly that issue and no variant of it (R-01).
// ───────────────────────────────────────────────────────────────────────────────────────────
console.log('\nE-1k Jira new-bug plan (drafts → plan → approve → gate)');

const NB_BODY = "## Takrorlash qadamlari\n1. Talaba saytining bosh sahifasini 390x844 o'lchamda oching.\n2. Sarlavhadagi kirish ikonasini toping.\n\n## Kutilgan natija\nIkona kamida 44 ga 44px bo'lsin.\n\n## Haqiqiy natija\nIkona 20 ga 20px.\n\n## Muhit\nTalaba sayti, mobil, mehmon.";
const nbDraft = (over = {}) => ({
  draftId: 'D-1', relatedTo: 'BET-105', duplicateOf: null, area: 'Sarlavha',
  title: 'Talaba: mobil sarlavhadagi kirish ikonasi juda kichik',
  descriptionMd: NB_BODY, surface: JSURFACE, severity: 'High', evidence: 'internal only', ...over,
});
const nbFile = (name, ...ds) => w(name, { runId: 'SELFTEST', project: 'beta', drafts: ds });
const nbDrafts = nbFile('nb-drafts.json',
  nbDraft(),
  nbDraft({ draftId: 'D-2', duplicateOf: 'BET-30', title: 'Talaba: rasmlar yuklanmaydi' }),
  nbDraft({ draftId: 'D-3', relatedTo: 'BET-80', area: 'Bosh panel', surface: 'test.beta-admin.example', severity: 'Low-Medium', title: 'Admin: Holat ustunida xom qiymat chiqadi' }));
const nbPlan = join(TMP, 'nb-plan.json');
const nbPlanFile = () => JSON.parse(readFileSync(nbPlan, 'utf8'));
const nbGen = (out, file = nbDrafts, project = 'beta') =>
  run('jira-newbugs-plan.mjs', ['--drafts', file, '--project', project, '--out', out]);

check('a create plan generates: one create per non-duplicate draft, duplicates noted', () => {
  mustAccept(nbGen(nbPlan), 'jira-newbugs-plan');
  const p = nbPlanFile();
  assert(p.ops.length === 2, `expected 2 create ops, got ${p.ops.length}`);
  assert(p.ops.every((o) => o.kind === 'new-bug' && o.maxApplies === 1), 'a create must be kind new-bug with maxApplies 1');
  assert(!p.ops.some((o) => o.ticket === 'D-2'), 'a draft marked duplicateOf was planned as a new issue');
  assert(p.notes.some((s) => s.includes('D-2') && s.includes('BET-30')), `no duplicate note: ${p.notes.join(' | ')}`);
  assert(p.runId === 'SELFTEST-NB', `plan runId must not collide with the run's own approval: ${p.runId}`);
});

check('the create call follows the board convention: Bug, project key, title prefix, priority', () => {
  const op = nbPlanFile().ops.find((o) => o.ticket === 'D-1');
  assert(op.tool === jira.tools.create, `wrong tool: ${op.tool}`);
  assert(op.args.projectKey === 'BET' && op.args.issueTypeName === 'Bug' && op.args.cloudId === jira.cloudId, `wrong target: ${JSON.stringify(op.args)}`);
  assert(/^\[Web\] BET – P1 – Talaba – Sarlavha – mobil sarlavhadagi/.test(op.args.summary), `summary breaks the convention: ${op.args.summary}`);
  assert(op.args.additional_fields.priority.name === 'High', `High severity did not map to High priority: ${JSON.stringify(op.args.additional_fields)}`);
  const adm = nbPlanFile().ops.find((o) => o.ticket === 'D-3');
  assert(/– P3 – Admin – Bosh panel –/.test(adm.args.summary) && adm.args.additional_fields.priority.name === 'Low', `Low-Medium/admin mapping wrong: ${adm.args.summary}`);
  assert(op.args.description.includes('BET-105'), 'the body does not name the related ticket');
});

check('Low severity titles P4 (Jira Low); an explicit pLevel wins over severity; a bad pLevel is refused', () => {
  const out = join(TMP, 'nb-plan-p4.json');
  mustAccept(nbGen(out, nbFile('nb-p4.json',
    nbDraft({ draftId: 'P-1', severity: 'Low' }),
    nbDraft({ draftId: 'P-2', severity: 'Low-Medium', pLevel: 'P4' }))), 'jira-newbugs-plan');
  const by = (id) => JSON.parse(readFileSync(out, 'utf8')).ops.find((o) => o.ticket === id).args;
  assert(/ – P4 – /.test(by('P-1').summary) && by('P-1').additional_fields.priority.name === 'Low', `Low did not map to P4/Low: ${by('P-1').summary}`);
  assert(/ – P4 – /.test(by('P-2').summary) && by('P-2').additional_fields.priority.name === 'Low', `explicit pLevel ignored: ${by('P-2').summary}`);
  mustReject(nbGen(join(TMP, 'never-nb.json'), nbFile('nb-p5.json', nbDraft({ pLevel: 'P5' }))), 'pLevel', 'jira-newbugs-plan');
});

check('describeOp renders a create legibly for the approval prompt', () => {
  const op = nbPlanFile().ops[0];
  const d = describeOp(op.tool, op.args);
  assert(d.startsWith('create Bug in BET'), `describeOp fell through: ${d}`);
  assert(op.summary === d, 'the plan summary and describeOp disagree');
});

check('two runs over the same drafts produce byte-identical ops', () => {
  const out2 = join(TMP, 'nb-plan-2.json');
  mustAccept(nbGen(out2), 'rerun');
  assert(JSON.stringify(nbPlanFile().ops) === JSON.stringify(JSON.parse(readFileSync(out2, 'utf8')).ops), 'non-deterministic create plan');
});

check('a mobile draft takes its platform prefix and the mobile label; web keeps qa-found only', () => {
  const out = join(TMP, 'nb-plan-mob.json');
  mustAccept(nbGen(out, nbFile('nb-mob.json',
    nbDraft({ draftId: 'M-1', platform: 'android', surface: 'com.beta' }),
    nbDraft({ draftId: 'M-2', platform: 'mobile', surface: 'com.beta' }),
    nbDraft({ draftId: 'M-3', platform: 'web' }))), 'jira-newbugs-plan');
  const ops = JSON.parse(readFileSync(out, 'utf8')).ops;
  const by = (id) => ops.find((o) => o.ticket === id).args;
  assert(/^\[Android\] BET – /.test(by('M-1').summary) && /^\[Mobile\] BET – /.test(by('M-2').summary) && /^\[Web\] BET – /.test(by('M-3').summary), `platform prefixes wrong: ${ops.map((o) => o.args.summary).join(' | ')}`);
  const labels = (id) => JSON.stringify(by(id).additional_fields.labels);
  assert(labels('M-1').includes('mobile') && labels('M-2').includes('mobile') && !labels('M-3').includes('mobile'), `mobile label wrong: ${ops.map((o) => labels(o.ticket)).join(' | ')}`);
});

check('an unknown platform, or a mobile platform on a web surface, is refused', () => {
  mustReject(nbGen(join(TMP, 'never-nb.json'), nbFile('nb-plat.json', nbDraft({ platform: 'desktop' }))), 'platform', 'jira-newbugs-plan');
  mustReject(nbGen(join(TMP, 'never-nb.json'), nbFile('nb-plat2.json', nbDraft({ platform: 'android' }))), 'does not match surface', 'jira-newbugs-plan');
});

check('a body the WAF would block refuses the whole plan', () =>
  mustReject(nbGen(join(TMP, 'never-nb.json'), nbFile('nb-waf.json', nbDraft({ descriptionMd: NB_BODY + "\nBuni curl bilan ham tekshirdim." }))), 'WAF', 'jira-newbugs-plan'));

check('a body naming an internal QA artefact refuses the whole plan (R-10)', () =>
  mustReject(nbGen(join(TMP, 'never-nb.json'), nbFile('nb-leak.json', nbDraft({ descriptionMd: NB_BODY + "\nSkrinshot: BET-105_attachments/header.png" }))), 'R-10', 'jira-newbugs-plan'));

check('a surface the project does not own is refused (R-13)', () =>
  mustReject(nbGen(join(TMP, 'never-nb.json'), nbFile('nb-host.json', nbDraft({ surface: 'beta-admin.example' }))), 'R-13', 'jira-newbugs-plan'));

check('a body missing the bug template sections is refused', () =>
  mustReject(nbGen(join(TMP, 'never-nb.json'), nbFile('nb-tpl.json', nbDraft({ descriptionMd: 'Ikona juda kichik.' }))), 'Kutilgan natija', 'jira-newbugs-plan'));

check('planning creates for a project with no jira block is refused', () =>
  mustReject(nbGen(join(TMP, 'never-nb.json'), nbDrafts, 'alpha'), 'jira', 'jira-newbugs-plan'));

check('approve → the exact planned create is allowed, a retitled or re-projected one is not', () => {
  const r = approve(nbPlan, 'selftest — not a real approval', ['--ttl-hours', '1']);
  try {
    mustAccept(r, 'qa-approve');
    const op = nbPlanFile().ops[0];
    const real = join(HUB, '.claude', 'hooks', 'tracker-write-gate.mjs');
    const ok = decisionOf(hook({ tool_name: op.tool, tool_input: op.args }, real));
    assert(ok.decision === 'allow', `the approved create was denied: ${ok.reason}`);
    const retitled = decisionOf(hook({ tool_name: op.tool, tool_input: { ...op.args, summary: op.args.summary + ' (2)' } }, real));
    assert(retitled.decision === 'deny', 'a create with an edited title was allowed');
    const elsewhere = decisionOf(hook({ tool_name: op.tool, tool_input: { ...op.args, projectKey: 'ALP' } }, real));
    assert(elsewhere.decision === 'deny', 'the approved create also filed into another project');
  } finally {
    run('qa-approve.mjs', ['--revoke', 'SELFTEST-NB']);
    rmSync(join(HUB, '.qa-approvals', 'SELFTEST-NB.applied.jsonl'), { force: true });
  }
});

check('a Jira create is a gated write (R-01)', () =>
  assert(isTrackerWrite('mcp__claude_ai_Atlassian__createJiraIssue'), 'createJiraIssue is an outward write and must be gated'));

// ───────────────────────────────────────────────────────────────────────────────────────────
// 6d. E-1m — comments on Jira tickets outside the run ledger: drafts + live pull → comment-only plan
//
// scripts/jira-comments-plan.mjs. Pins: comment ops only, in the exact shape jira-plan.mjs emits
// (so the same approval + gate path applies), and a refusal for every draft that cannot be posted
// as written — WAF, R-10 leak, a key from another project or missing from the live pull, a
// transition smuggled into a draft, a duplicate id, an empty body.
// ───────────────────────────────────────────────────────────────────────────────────────────
console.log('\nE-1m Jira comment-only plan (drafts + live → plan)');

const CM_BODY = "Qayta tekshiruv: iOS va Android ilovalarida muammo hali ham takrorlanadi. Kirish sahifasida parolni unutdim havolasi bosilganda hech narsa ochilmaydi.";
const cmDraft = (over = {}) => ({ commentId: 'C-1', ticket: 'BET-61', platform: 'ios', bodyMd: CM_BODY, sourceRc: null, evidence: 'internal only', ...over });
const cmFile = (name, ...cs) => w(name, { runId: 'SELFTEST', project: 'beta', comments: cs });
const cmLive = w('cm-live.json', [{ id: 'BET-61', state: 'Backlog' }, { id: 'BET-130', state: 'STAGING' }]);
const cmPlan = join(TMP, 'cm-plan.json');
const cmGen = (out, file, live = cmLive) => run('jira-comments-plan.mjs', ['--drafts', file, '--live', live, '--out', out]);
const cmNever = join(TMP, 'never-cm.json');

check('a comment plan generates comment ops only, in jira-plan\'s exact call shape, deterministically', () => {
  const file = cmFile('cm-drafts.json', cmDraft(), cmDraft({ commentId: 'C-2', ticket: 'BET-130', platform: 'ios+android' }));
  mustAccept(cmGen(cmPlan, file), 'jira-comments-plan');
  const p = JSON.parse(readFileSync(cmPlan, 'utf8'));
  assert(p.runId === 'SELFTEST-CM' && p.commentOnly === true && p.forced === false, `plan header wrong: ${p.runId}`);
  assert(p.ops.length === 2 && p.ops.every((o) => o.tool === jira.tools.comment && o.kind === 'comment' && o.maxApplies === 1), 'expected 2 single-use comment ops');
  const op = p.ops[0];
  assert(JSON.stringify(Object.keys(op.args).sort()) === JSON.stringify(['cloudId', 'commentBody', 'contentFormat', 'issueIdOrKey']), `args shape differs from jira-plan's comment op: ${Object.keys(op.args)}`);
  assert(op.args.cloudId === jira.cloudId && op.args.issueIdOrKey === 'BET-61' && op.args.commentBody === CM_BODY, `wrong target/body: ${JSON.stringify(op.args).slice(0, 200)}`);
  assert(op.hash === canonicalOp(op.tool, op.args).hash, 'plan hash is not the canonical hash the gate computes');
  assert(op.summary === describeOp(op.tool, op.args), 'the plan summary and describeOp disagree');
  const out2 = join(TMP, 'cm-plan-2.json');
  mustAccept(cmGen(out2, file), 'rerun');
  assert(JSON.stringify(p.ops) === JSON.stringify(JSON.parse(readFileSync(out2, 'utf8')).ops), 'non-deterministic comment plan');
});

check('a comment body the WAF would block is refused', () =>
  mustReject(cmGen(cmNever, cmFile('cm-waf.json', cmDraft({ bodyMd: CM_BODY + ' Buni curl bilan tekshirdim.' }))), 'WAF', 'jira-comments-plan'));

check('a comment body leaking an internal QA artefact or id is refused (R-10)', () => {
  mustReject(cmGen(cmNever, cmFile('cm-leak.json', cmDraft({ bodyMd: CM_BODY + ' Skrinshot: BET-61_attachments/login.png' }))), 'R-10', 'jira-comments-plan');
  mustReject(cmGen(cmNever, cmFile('cm-leak2.json', cmDraft({ bodyMd: CM_BODY + ' Bu PAR-AUTH-3 va RC-22 bilan bog\'liq.' }))), 'internal-qa-id', 'jira-comments-plan');
});

check('a ticket key not in the live pull, or from another project, is refused', () => {
  mustReject(cmGen(cmNever, cmFile('cm-unknown.json', cmDraft({ ticket: 'BET-9999' }))), 'not in the live pull', 'jira-comments-plan');
  mustReject(cmGen(cmNever, cmFile('cm-proj.json', cmDraft({ ticket: 'ALP-61' }))), 'not in project BET', 'jira-comments-plan');
});

check('a draft carrying a transition / state field is refused (comment-only)', () => {
  mustReject(cmGen(cmNever, cmFile('cm-trans.json', cmDraft({ transition: { id: '2' } }))), 'comments only', 'jira-comments-plan');
  mustReject(cmGen(cmNever, cmFile('cm-state.json', cmDraft({ state: 'STAGING' }))), 'comments only', 'jira-comments-plan');
});

check('a duplicate commentId, or an empty body, is refused', () => {
  mustReject(cmGen(cmNever, cmFile('cm-dup.json', cmDraft(), cmDraft({ ticket: 'BET-130' }))), 'duplicate commentId', 'jira-comments-plan');
  mustReject(cmGen(cmNever, cmFile('cm-empty.json', cmDraft({ bodyMd: '   ' }))), 'bodyMd is empty', 'jira-comments-plan');
});

// Linear edition of the same path (scripts/linear-newbugs-plan.mjs): dev-facing bug write-ups
// filed into a Linear project after a run. Pins R-10, R-13 on every URL in the body, the template,
// and that one approval authorises exactly that issue (R-01).
console.log('\nE-1l Linear new-bug plan (drafts → plan → approve → gate)');

const LNB_BODY = '## Steps to reproduce\n1. Sign in at https://staging-dealer.alpha.example.\n2. Open the deal.\n\n## Expected\nThe task completes.\n\n## Actual\nSave is disabled.\n\n## Done when\nThe task can be completed.';
const lnbDraft = (over = {}) => ({ draftId: 'L-1', title: 'Dealer task cannot be completed on staging', priority: 2, relatedTo: ['ALP-616'], descriptionMd: LNB_BODY, ...over });
const lnbFile = (name, ...ds) => w(name, { runId: 'SELFTEST-L', project: 'alpha', linearProject: 'October', labels: ['Bug'], drafts: ds });
const lnbPlan = join(TMP, 'lnb-plan.json');
const lnbGen = (out, file) => run('linear-newbugs-plan.mjs', ['--drafts', file, '--out', out]);

check('a Linear create plan generates one Ready-for-Dev create per non-duplicate draft', () => {
  mustAccept(lnbGen(lnbPlan, lnbFile('lnb-drafts.json', lnbDraft(), lnbDraft({ draftId: 'L-2', duplicateOf: 'ALP-30' }))), 'linear-newbugs-plan');
  const p = JSON.parse(readFileSync(lnbPlan, 'utf8'));
  assert(p.ops.length === 1, `expected 1 create, got ${p.ops.length}`);
  assert(p.ops[0].args.state === 'Ready for Dev' && p.ops[0].args.project === 'October', 'state/project not taken from the profile + drafts');
  assert(p.ops[0].maxApplies === 1, 'a create must be single-use');
});

check('a Linear bug body naming an internal QA artefact is refused (R-10)', () =>
  mustReject(lnbGen(join(TMP, 'never-lnb.json'), lnbFile('lnb-leak.json', lnbDraft({ descriptionMd: LNB_BODY + '\nSee S06f-task-link-modal.png' }))), 'R-10', 'linear-newbugs-plan'));

check('a Linear bug body linking production is refused (R-13)', () =>
  mustReject(lnbGen(join(TMP, 'never-lnb.json'), lnbFile('lnb-prod.json', lnbDraft({ descriptionMd: LNB_BODY + '\nAlso on https://www.alpha.example/deals.' }))), 'R-13', 'linear-newbugs-plan'));

check('a Linear bug body without "Done when" is refused', () =>
  mustReject(lnbGen(join(TMP, 'never-lnb.json'), lnbFile('lnb-tpl.json', lnbDraft({ descriptionMd: LNB_BODY.replace('## Done when', '## Notes') }))), 'Done when', 'linear-newbugs-plan'));

check('approve → the exact Linear create is allowed, a retitled or re-projected one is not', () => {
  const r = approve(lnbPlan, 'selftest — not a real approval', ['--ttl-hours', '1']);
  try {
    mustAccept(r, 'qa-approve');
    const op = JSON.parse(readFileSync(lnbPlan, 'utf8')).ops[0];
    const real = join(HUB, '.claude', 'hooks', 'tracker-write-gate.mjs');
    const ok = decisionOf(hook({ tool_name: op.tool, tool_input: op.args }, real));
    assert(ok.decision === 'allow', `the approved create was denied: ${ok.reason}`);
    assert(decisionOf(hook({ tool_name: op.tool, tool_input: { ...op.args, title: op.args.title + ' (2)' } }, real)).decision === 'deny', 'a retitled create was allowed');
    assert(decisionOf(hook({ tool_name: op.tool, tool_input: { ...op.args, project: 'September' } }, real)).decision === 'deny', 'the create was allowed into another project');
  } finally {
    run('qa-approve.mjs', ['--revoke', 'SELFTEST-L-NB']);
    rmSync(join(HUB, '.qa-approvals', 'SELFTEST-L-NB.applied.jsonl'), { force: true });
  }
});

// ───────────────────────────────────────────────────────────────────────────────────────────
// 7. R-11 — generated deliverables
// ───────────────────────────────────────────────────────────────────────────────────────────
console.log('\nR-11 generated deliverables');

check('counts are derived and reconcile', () => {
  const r = run('gen-counts.mjs', ['--ledger', e2eLedger, '--json']);
  mustAccept(r, 'gen-counts');
  const c = JSON.parse(r.stdout);
  assert(c.total === 2 && c.buckets.PASS === 1 && c.buckets.FAIL === 1, `wrong counts: ${r.stdout}`);
  assert(c.byProposedState['Release Candidate'] === 1, `PASS did not map to Release Candidate: ${r.stdout}`);
});

check('_SUMMARY.md generates from the ledger', () => {
  const out = join(TMP, '_SUMMARY.md');
  mustAccept(run('gen-summary.mjs', ['--ledger', e2eLedger, '--project', 'alpha', '--out', out]), 'gen-summary');
  const md = readFileSync(out, 'utf8');
  assert(/Do not hand-edit/.test(md), 'the generated summary does not warn against hand-editing');
  assert(/ALP-502/.test(md), 'the failing ticket is missing from the summary');
});

check('generation from an invalid ledger is refused', () => {
  const bad = w('bad-for-summary.json', ledgerWith(baseTicket({ verdict: 'PASS', cases: [{ caseId: 'AC-1', verdict: 'NOT_TESTED' }] })));
  mustReject(run('gen-summary.mjs', ['--ledger', bad, '--project', 'alpha', '--out', join(TMP, 'never.md')]), '', 'gen-summary');
});

check('the .docx builds and contains only dev-facing tickets', () => {
  const out = join(TMP, 'report.docx');
  const r = run('gen-docx.mjs', ['--ledger', e2eLedger, '--project', 'alpha', '--out', out]);
  mustAccept(r, 'gen-docx');
  assert(existsSync(out), 'no .docx was produced');
  const xml = spawnSync('unzip', ['-p', out, 'word/document.xml'], { encoding: 'utf8' }).stdout || '';
  assert(xml.includes('ALP-502'), 'the failing ticket is not in the document');
  assert(xml.length > 500, 'the document body is suspiciously empty');
});


// ───────────────────────────────────────────────────────────────────────────────────────────
// 8. Phase 1 hardening — section modules (scripts/selftest/*.mjs). Each is synchronous and builds
//    its sandbox under join(TMP, '<name>').
// ───────────────────────────────────────────────────────────────────────────────────────────
const h = { check, assert, mustReject, mustAccept, run, w, TMP, HUB };
sessionCostSection(h);
jiraAttachSection(h);
docReadSection(h);
brainRecallSection(h);
nodeGraphSection(h);
slackReportSection(h);
repoIdeasSection(h);
qaSkillsIdeasSection(h);
lambdatestIdeasSection(h);
denfryIdeasSection(h);
qaskills2ClusterSection(h);
qaskills2DedupeSection(h);
qaskills2ResidueSection(h);
qaskills2AccountsSection(h);

// ───────────────────────────────────────────────────────────────────────────────────────────
console.log('');
if (!flags.keep) rmSync(TMP, { recursive: true, force: true });
else console.log(`fixtures kept in ${TMP}\n`);

if (failures.length) {
  console.error(`SELFTEST FAILED — ${failures.length} of ${failures.length + passed} checks:`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  console.error(
    `\nA gate that accepts a known-bad input is not a gate. Fix the gate, not this file — and if a\n` +
      `check here is genuinely wrong, change it in the same commit as the rule it tests (R-00).`
  );
  process.exit(1);
}
console.log(`SELFTEST OK — ${passed} checks. Every gate rejected its known-bad input.`);
