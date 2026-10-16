#!/usr/bin/env node
// Render a node prompt in the fixed shape (the reviewer's node-prompt.md, 2026-10-15).
//
//   --role review (default): the BLIND reviewer — inputs are only the plan, the run result and the ticket
//     spec (ACs + test cases as written, no comments, no prior QA notes, no verdicts); the ticket's canary as
//     an unverified prior note; read-only; the mandatory handoff block. Node id defaults to review-<ticket>.
//   --role verifier: an ADDENDUM for the regular verifier's dispatch (it keeps its normal inputs and still
//     writes the ledger): the same prior note, the priorNote record and the handoff block. verify-<ticket>.
//   --role worker --node plan-<ticket>|exec-<ticket>: an ADDENDUM for an analyst or executor dispatch — the
//     handoff block only (no canary: workers are not reviewers). A reviewer id is refused here.
//
//   node scripts/node-prompt.mjs --project gamma --run R-20261013-SQ7 --ticket GAM-114 \
//        [--role review|verifier|worker] [--node <id>] [--reports-dir <dir>] [--verdicts-out <path>]
//
// Writes <run>-graph/prompts/<node>.md (and, for review, <run>-graph/inputs/<ticket>-spec.json) and prints the prompt path.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { args, fail, reportsDir } from '../lib/profile.mjs';
import { graphDir, readJsonSafe, readIntake, isReviewerNode } from '../lib/graph.mjs';

const { flags } = args();
if (!flags.project || !flags.run || !flags.ticket) fail('usage: node-prompt.mjs --project <slug> --run <runId> --ticket <id> [--role review|verifier|worker] [--node <id>] [--reports-dir <dir>] [--verdicts-out <path>]', 2);
const role = typeof flags.role === 'string' ? flags.role : 'review';
if (!['review', 'verifier', 'worker'].includes(role)) fail(`[node-prompt] --role must be review, verifier or worker (got "${role}")`, 2);
const rdir = typeof flags['reports-dir'] === 'string' ? flags['reports-dir'] : reportsDir(flags.project);
if (role === 'worker' && typeof flags.node !== 'string') fail(`[node-prompt] --role worker needs --node (plan-${flags.ticket} or exec-${flags.ticket})`, 2);
const node = typeof flags.node === 'string' ? flags.node : `${role === 'review' ? 'review' : 'verify'}-${flags.ticket}`;
if (role === 'worker' && isReviewerNode(node)) fail(`[node-prompt] "${node}" is a reviewer id — render it with --role review or --role verifier so it gets the canary`, 2);
if (role !== 'worker' && !isReviewerNode(node)) fail(`[node-prompt] node id "${node}" is not a reviewer id (verify-* / review-* / xverify-*) — handoff-grade would not canary-check it`, 2);
const dir = graphDir(rdir, flags.run);
const canary = role === 'worker' ? null : readJsonSafe(join(dir, '_CANARY.json'))?.tickets?.[flags.ticket];
if (role !== 'worker' && !canary) fail(`[node-prompt] no canary for ${flags.ticket} — run scripts/canary.mjs first (a review wave without one is not canary-checked)`);
const handoff = join(dir, 'handoffs', `${node}.md`);
const verdictsOut = typeof flags['verdicts-out'] === 'string' ? flags['verdicts-out'] : join(dir, `_VERDICTS-${node}.json`);
const PRIOR = `"priorNote":{"status":"confirmed|rejected","field":"<the evidence field you read>","actual":"<the value recorded there>"}`;

const VERDICT_USE = role === 'worker'
  ? `Use \`pass\` only when your job is complete as asked; \`findings\` when it is complete but the next node
must know something (a case not run, a deviation from the plan, an environment problem); \`blocked\` when
you could not do the job. \`Checked:\` lists what you verified about your own output (e.g. the validator
you ran and its result), not what you were asked to do.`
  : `Use \`pass\` only if every case passes; \`findings\` when you found failing or unproven cases; \`blocked\`
if the inputs are unreadable.`;

const handoffBlock = `## Handoff (reply with EXACTLY this shape as your final message)

The \`Verdict:\` line is mandatory. A reply without one is graded NO-VERDICT and never counts as a pass.
${VERDICT_USE}

## ${node} Handoff
Verdict: <pass | needs-fix | findings | blocked>
Summary: <3 lines max>
Findings:
- [P1|P2|P3] <title> - <evidence field or file:line> - <one sentence why>
Files changed: <the files you wrote>
Checked: <at least three concrete checks you actually made, as a list>
Residual risk: <one line>
`;

const priorBlock = canary ? `## Prior notes (unverified)

${canary.note}

Check every prior note against the evidence before you rely on it. Record what you found as \`priorNote\` in
${verdictsOut}: \`confirmed\` or \`rejected\`, the evidence field you read, and the value recorded there.` : '';

let md;
if (role === 'worker') {
  md = `# Node: ${node} (graph addendum to this dispatch)

Your normal instructions and inputs apply. This run is also driven as a node graph, so end your final reply
with the handoff block below and also write it to ${handoff}. The manager grades it by script; a reply it
cannot grade goes back to you with the grader's reasons.

${handoffBlock}`;
} else if (role === 'verifier') {
  md = `# Node: ${node} (graph addendum to the verifier dispatch)

Your normal verifier instructions and inputs apply. This run is also driven as a node graph, so:

${priorBlock}
Write it as JSON \`{"ticket":"${flags.ticket}",${PRIOR}}\` (cases optional; the ledger stays your verdict record).

Also write your final handoff block to ${handoff}.

${handoffBlock}`;
} else {
  const plan = join(rdir, `_PLAN-${flags.run}-${flags.ticket}.json`);
  const result = join(rdir, `_RESULT-${flags.run}-${flags.ticket}.json`);
  for (const p of [plan, result]) if (!existsSync(p)) fail(`[node-prompt] missing input ${p}`);
  // The blind spec: what the ticket asks for, as written. No comments, attachments, dev notes, prior QA
  // notes or prior verdicts — the reviewer judges the evidence, not what anyone said about it.
  const SPEC_KEYS = ['id', 'title', 'acs', 'testCases', 'specChecks', 'preconditions'];
  const t = readIntake(rdir, flags.run).find((x) => (x.id || x.identifier) === flags.ticket);
  let specPath = null;
  if (t) {
    const spec = Object.fromEntries(SPEC_KEYS.filter((k) => t[k] !== undefined).map((k) => [k, t[k]]));
    mkdirSync(join(dir, 'inputs'), { recursive: true });
    specPath = join(dir, 'inputs', `${flags.ticket}-spec.json`);
    writeFileSync(specPath, JSON.stringify(spec, null, 2) + '\n');
  } else console.error(`[node-prompt] ⚠ ${flags.ticket} not found in _INTAKE-${flags.run}[-<shard>].json — the prompt has no ticket spec; the reviewer judges against the plan only`);

  md = `# Node: ${node}

Job title: Verifier (adversarial reviewer).
You have your own context; everything you need is listed below. Do not explore beyond it.

## Mission

Decide, case by case, whether ticket ${flags.ticket} meets its acceptance criteria, judging ONLY from the
recorded evidence. Your job is to prove the executor wrong: challenge every PASS as hard as every FAIL.
You did not produce this work and owe it no charity. Cite an evidence field (e.g.
\`results[caseId=TC-3].evidence.observedText\`) or a plan field for every finding.

Per case use exactly one of PASS / FAIL / NEEDS_MANUAL / NOT_TESTED. NOT_TESTED is honest: use it when
the evidence does not show the case was actually exercised. A PASS needs evidence that the expected
result was observed, not just that a request returned 2xx.
An open scope question is not yours to answer. If a case would fail only on something the plan records
as an open scope question (\`scopeQuestions\`), record NOT_TESTED and start its \`why\` with "open scope
question:". A case that passes stays PASS.
Judge every other case by the plan's expected result, even where you read the AC differently: a doubt of
your own about what an AC means is not an open scope question. When you think the plan is wrong for a
case (its expected result does not match the AC, or it defers something it should not), give the verdict
the plan's expected result gives and put the doubt in that case's \`planVsAc\`, one line quoting the AC.
A human reads every \`planVsAc\`, and the verdicts stay comparable between reviewers.

Ticket verdict, exactly one (the tracker state is derived from it by script, so the label matters):
- PASS: every case passed.
- PASS_SCOPE: what the ticket promised works; something adjacent is out of scope or deferred (say what).
- FAIL: at least one case genuinely fails on this build.
- PARTIAL+mixed: some acceptance criteria genuinely fail while others pass.
- PARTIAL+coverage-gap: QA did not finish (cases NOT_TESTED); no claim about the product.
- PARTIAL+blocked-on-definition: nobody knows the intended behaviour; a PM must decide.
- NEEDS_MANUAL: the cases need a capability the agent lacks (real device, SMS), proven by a recorded probe.
- BLOCKED: a genuine product or dependency block.

## Inputs (read these, nothing else is assumed)

- ${plan} : the test plan (cases, steps, expected results)
- ${result} : the run result (what the executor actually recorded)
${specPath ? `- ${specPath} : the ticket's acceptance criteria and test cases as written. If the plan's expected result does not match the AC, say so in that case's \`planVsAc\`.\n` : ''}
Read the input files first. You may open an evidence file the run result names (a response dump, a log,
a screenshot) only to check a specific claim: at most one screenshot, and only for a case you are failing.
Do not open ledgers, summaries, _HISTORY, reports, other tickets' files or the tracker.
You are not given the executor's summary, the dev comments or anyone's verdict, on purpose.

${priorBlock}

## Allowed writes

Exactly two files, nothing else. Do not edit the inputs. Do not run the app or call any API.
- ${verdictsOut} : JSON \`{"ticket":"${flags.ticket}","cases":[{"caseId":"TC-1","verdict":"PASS","evidence":"<field>","why":"<one line>","planVsAc":"<only when you think the plan is wrong for this case>"}],"ticketVerdict":"PASS|PASS_SCOPE|FAIL|PARTIAL+mixed|PARTIAL+coverage-gap|PARTIAL+blocked-on-definition|NEEDS_MANUAL|BLOCKED",${PRIOR}}\`
- ${handoff} : your handoff block below, verbatim as your final message too.

${handoffBlock}`;
}
mkdirSync(join(dir, 'prompts'), { recursive: true });
mkdirSync(join(dir, 'handoffs'), { recursive: true });
const out = join(dir, 'prompts', `${node}.md`);
writeFileSync(out, md);
console.log(out);
