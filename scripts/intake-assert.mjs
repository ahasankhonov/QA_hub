#!/usr/bin/env node
// H-1 — assert the parsed intake against the raw ticket bodies. Fail closed on mismatch.
//
// ticket-intake runs on a cheap model parsing acceptance criteria and TC-N.x out of long ticket
// markdown. Cheap models silently truncate structured extraction from long documents. Drop TC-3.2
// and the analyst never plans it, the executor never runs it, the verifier sees all-pass, and the
// ticket is promoted on partial coverage. That is a false pass with no fingerprint, which makes it
// worse than any false fail in the system. The model stays cheap; the count is checked in code.
//
//   node scripts/intake-assert.mjs --raw _INTAKE-<run>-raw.json --spec _INTAKE-<run>.json
//
// --raw : [{ id, title, body, comments?: [{body}] }]   verbatim from get_issue / list_comments
//         (Asana: [{ id, gid, task: { notes, ... }, stories }] — see asana-pull.mjs)
// --spec: [{ id, acs: [...], testCases: [{id, ...}] }] what ticket-intake emitted
//
// Raw floor (lib/raw-floor.mjs): every count above is only as good as the raw it is taken from, and a
// model asked for a "verbatim" raw has twice written a summary instead (Alpha R7, R4-B/C). A raw that
// reads like a summary — thin median body, placeholder text, elided fragments, one-liner comments, a
// spec with more text than its own source — FAILS here too. When the tickets really are that short,
// `--allow-thin-raw "<reason>"` turns those findings into warnings and prints the reason with them.

import { readFileSync } from 'node:fs';
import { args, fail } from '../lib/profile.mjs';
import { bodyOf, commentsOf, rawFloor } from '../lib/raw-floor.mjs';
import { scanText, describeThreats } from '../lib/text-threats.mjs';

const { flags } = args();
if (!flags.raw || !flags.spec) {
  fail('usage: intake-assert.mjs --raw <raw.json> --spec <spec.json> [--json] [--allow-extra] [--allow-thin-raw "<reason>"]', 2);
}
const thinWaiver = flags['allow-thin-raw'];
if (thinWaiver !== undefined && (typeof thinWaiver !== 'string' || !thinWaiver.trim()))
  fail('[intake-assert] --allow-thin-raw needs a reason in words ("Alpha Done-when tickets are one line each") — a waiver nobody can read is not a waiver', 2);

const raw = JSON.parse(readFileSync(flags.raw, 'utf8'));
const spec = JSON.parse(readFileSync(flags.spec, 'utf8'));
const rawList = Array.isArray(raw) ? raw : raw.tickets || [];
const specList = Array.isArray(spec) ? spec : spec.tickets || [];

if (rawList.length === 0) fail('[intake-assert] raw file has no tickets — nothing to check against (R-07)');

const specById = new Map(specList.map((t) => [t.id, t]));

/**
 * A plain-text heading: the whole line is the heading, optionally bold, ending in ":" — or "." when bold.
 * Asana task notes have no markdown headings at all; gamma carries its criteria under a bare
 * "Acceptance Criteria:" line followed by "- " bullets. Matching only `## ` headings made H-1 find no
 * section, expect 0 ACs, and pass every Asana intake vacuously (found 2026-10-06, R-20261006-INTAKE).
 */
const PLAIN_HEADING_RE = /^\s*(?:(?:\*\*|__)\s*([A-Za-z][^*_:\n]{0,60}?)\s*[:.]?\s*(?:\*\*|__)\s*[:.]?|([A-Za-z][^:\n]{0,60}?)\s*:)\s*$/;
function plainHeading(line) {
  if (/^\s*(?:[-*+]|\d+[.)])\s/.test(line)) return null; // a list item ending in ":" is not a heading
  const m = PLAIN_HEADING_RE.exec(line);
  return m ? (m[1] ?? m[2]).trim() : null;
}
const isListLine = (l) => /^\s*(?:[-*+]\s|\d+[.)]\s)/.test(l);

/**
 * Pull a section out of a ticket body: a `## <heading>` section up to the next heading of the same or
 * higher level, or a plain-text heading section (see plainHeading) up to the next heading of either
 * kind, or up to the first non-list paragraph after a blank line once its list has started.
 */
function section(body, headingRe) {
  const lines = String(body || '').split('\n');
  let start = -1;
  let level = 0; // 0 = plain-text heading
  for (let i = 0; i < lines.length; i++) {
    const m = /^(#{1,6})\s+(.*)$/.exec(lines[i]);
    if (m && headingRe.test(m[2])) {
      start = i + 1;
      level = m[1].length;
      break;
    }
    const p = !m && plainHeading(lines[i]);
    if (p && headingRe.test(p)) {
      start = i + 1;
      break;
    }
  }
  if (start < 0) return null;
  const out = [];
  let sawList = false;
  for (let i = start; i < lines.length; i++) {
    const m = /^(#{1,6})\s+/.exec(lines[i]);
    if (m && (level === 0 || m[1].length <= level)) break;
    if (level === 0) {
      if (!m && plainHeading(lines[i]) && !lines[i - 1].trim()) break; // a heading opens a block; a prose "…following:" mid-list does not end it
      if (isListLine(lines[i])) sawList = true;
      else if (sawList && lines[i].trim() && !/^\s/.test(lines[i]) && !lines[i - 1].trim()) break;
    }
    out.push(lines[i]);
  }
  return out.join('\n');
}

const uniq = (a) => [...new Set(a)];

function tcIdsIn(text) {
  return uniq([...String(text || '').matchAll(/\bTC[-\s]?(\d+)(?:\.(\d+))?\b/gi)].map(
    (m) => `TC-${m[1]}${m[2] !== undefined ? `.${m[2]}` : ''}`
  ));
}

function acIdsIn(text) {
  return uniq([...String(text || '').matchAll(/\bAC[-\s]?(\d+)\b/gi)].map((m) => `AC-${m[1]}`));
}

/** Fallback when a section uses bare bullets/numbers instead of AC-n / TC-N.x ids. */
function countListItems(text) {
  if (!text) return 0;
  return text
    .split('\n')
    .filter((l) => /^\s*(?:[-*+]\s+(?:\[[ xX]\]\s*)?|\d+[.)]\s+)\S/.test(l))
    .filter((l) => l.trim().length > 3).length;
}

/**
 * Template-blind miss (found 2026-09-10 on beta / Jira BET): the bodies carried numbered repro
 * steps under a plain "Takrorlash qadamlari:" heading, the intake parser only matched **bold**
 * headings, and 37 of 39 tickets reached this gate with `testCases: []`. Nothing above noticed —
 * there were no TC-N.x / AC-n ids to count — so H-1 passed a spec with nothing to plan from.
 * A body that visibly carries repro steps while the spec emitted no test case at all is a WARN per
 * ticket, and a systemic FAIL when it hits most of the batch (≥ 3 tickets and ≥ 50 % of the
 * step-carrying bodies): one or two may be a tidy description, dozens are a parser that does not
 * match the template.
 */
const STEPS_HEADING_RE = /^\s*(?:\*\*|__)?\s*(?:Takrorlash qadamlari|Steps? to reproduce|Reproduction steps|Repro steps|Шаги воспроизведения)\b/im;
function stepLikeBody(body) {
  const text = String(body || '');
  const numbered = text.split('\n').filter((l) => /^\s*\d+\\?[.)]\s+\S/.test(l)).length; // "1. " or the escaped "1\. " Jira emits
  return { heading: STEPS_HEADING_RE.test(text), numbered };
}
let stepLike = 0;
let stepMissCount = 0;

const problems = [];
const warnings = [];
const rows = [];

for (const t of rawList) {
  const body = bodyOf(t); // Linear/Jira `body`, Asana raw: { task: { notes } }
  const s = specById.get(t.id);

  if (!s) {
    problems.push(`${t.id}: present in the raw pull but MISSING from the emitted spec — the whole ticket was dropped`);
    continue;
  }

  // --- test cases -------------------------------------------------------------------------
  const tcSection = section(body, /test\s*cases?/i);
  const rawTc = tcIdsIn(tcSection ?? body);
  const specTc = uniq((s.testCases || []).map((c) => String(c.id || c.caseId || '').trim()).filter(Boolean));
  let tcExpected = rawTc.length;
  let tcNote = '';
  if (rawTc.length === 0 && tcSection) {
    tcExpected = countListItems(tcSection);
    tcNote = ' (counted list items — the section has no TC-N.x ids)';
  }

  const missingTc = rawTc.filter((id) => !specTc.includes(id));
  const extraTc = specTc.filter((id) => !rawTc.includes(id));

  if (missingTc.length) {
    problems.push(`${t.id}: ${missingTc.length} test case(s) in the ticket body are absent from the spec: ${missingTc.join(', ')}`);
  } else if (rawTc.length === 0 && tcExpected > specTc.length) {
    problems.push(`${t.id}: Test Cases section has ~${tcExpected} items${tcNote} but the spec emitted ${specTc.length}`);
  }
  if (extraTc.length) warnings.push(`${t.id}: spec has test case(s) not found in the body: ${extraTc.join(', ')}`);

  // --- template-blind miss: repro steps in the body, no test case in the spec ---------------------
  const sl = stepLikeBody(body);
  const bodyHasSteps = sl.heading || sl.numbered >= 2;
  const stepMiss = bodyHasSteps && specTc.length === 0;
  if (bodyHasSteps) stepLike++;
  if (stepMiss) {
    stepMissCount++;
    warnings.push(
      `${t.id}: the body carries ${sl.heading ? 'a repro-steps heading' : ''}${sl.heading && sl.numbered ? ' and ' : ''}${sl.numbered ? `${sl.numbered} numbered step(s)` : ''} but the spec emitted no test case — the parser may not match this ticket template`
    );
  }

  // --- acceptance criteria ----------------------------------------------------------------
  const acSection = section(body, /acceptance\s*criteria/i);
  const rawAcIds = acIdsIn(acSection ?? '');
  const specAcCount = (s.acs || []).length;
  const specAcIds = acIdsIn(JSON.stringify(s.acs || []));

  let acExpected = rawAcIds.length;
  let acNote = '';
  if (rawAcIds.length === 0) {
    if (acSection === null) {
      acExpected = acIdsIn(body).length;
      if (acExpected === 0) {
        acNote = ' (no Acceptance Criteria section found)';
      }
    } else {
      acExpected = countListItems(acSection);
      acNote = ' (counted list items — the section has no AC-n ids)';
    }
  }

  const missingAc = rawAcIds.filter((id) => !specAcIds.includes(id));
  if (rawAcIds.length && missingAc.length) {
    problems.push(`${t.id}: ${missingAc.length} acceptance criteri(a) absent from the spec: ${missingAc.join(', ')}`);
  } else if (!rawAcIds.length && acExpected > specAcCount) {
    problems.push(`${t.id}: Acceptance Criteria has ~${acExpected} items${acNote} but the spec emitted ${specAcCount}`);
  }
  if (acExpected === 0 && specAcCount === 0 && !tcExpected) {
    warnings.push(`${t.id}: neither acceptance criteria nor test cases found — confirm the ticket really has none`);
  }

  rows.push({
    id: t.id,
    tcExpected,
    tcEmitted: specTc.length,
    acExpected,
    acEmitted: specAcCount,
    stepMiss,
    ok: !missingTc.length && !missingAc.length,
  });
}

if (stepMissCount >= 3 && stepMissCount * 2 >= stepLike) {
  problems.push(
    `systemic step-extraction failure: ${stepMissCount} of ${stepLike} tickets whose bodies carry numbered repro steps have NO test case in the spec — the intake parser does not match the bodies' template (a spec with nothing to plan from is the H-1 gap one stage earlier)`
  );
}

// --- raw floor: is the reference itself a summary? ---------------------------------------------
const floor = rawFloor(rawList, { specById });
for (const f of floor.findings) {
  if (thinWaiver) warnings.push(`raw floor (waived: ${thinWaiver.trim()}): ${f}`);
  else problems.push(`raw floor: ${f}`);
}

for (const s of specList) {
  if (!rawList.some((t) => t.id === s.id)) {
    warnings.push(`${s.id}: in the spec but not in the raw pull — cannot be verified, so it cannot be trusted`);
  }
}

// --- prompt injection: ticket text is pasted into every agent's prompt, and none of it is ours ---
// A warning, never a failure: the ticket is still tested; a human reads the flagged text first.
for (const t of rawList) {
  const parts = [['title', t.title ?? t.task?.name], ['body', bodyOf(t)], ...commentsOf(t).map((c, i) => [`comment ${i + 1}`, c])];
  for (const [where, text] of parts) {
    const hits = scanText(text);
    if (hits.length) warnings.push(describeThreats(`${t.id} ${where}`, hits));
  }
}

if (flags.json) {
  console.log(JSON.stringify({ rows, rawFloor: floor.stats, problems, warnings }, null, 2));
} else {
  const w = (s, n) => String(s).padEnd(n);
  console.log(`${w('TICKET', 12)}${w('TC raw→spec', 14)}${w('AC raw→spec', 14)}OK`);
  for (const r of rows) {
    console.log(`${w(r.id, 12)}${w(`${r.tcExpected} → ${r.tcEmitted}`, 14)}${w(`${r.acExpected} → ${r.acEmitted}`, 14)}${r.ok ? '✓' : '✗'}`);
  }
  const fs = floor.stats;
  console.log(`\nraw floor: ${fs.tickets} tickets · median body ${fs.medianBody} chars · ${fs.comments} comments, median ${fs.medianComment} chars`);
  if (thinWaiver) console.log(`raw floor WAIVED by --allow-thin-raw: ${thinWaiver.trim()}`);
  console.log('');
  for (const x of warnings) console.log(`WARN  ${x}`);
}

if (problems.length) {
  console.error(`\n[intake-assert] H-1 FAILED — ${problems.length} mismatch(es) between the raw tickets and the parsed spec:`);
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.error(
    `\nThe pipeline must not proceed: anything missing here is never planned, never run, and lands as a\n` +
      `silent PASS. Re-run ticket-intake for the affected tickets (or hand-fix the spec) and re-assert.` +
      (floor.findings.length && !thinWaiver
        ? `\nRaw floor: re-pull the raw verbatim (Linear: per-ticket MCP dumps → scripts/linear-assemble.mjs) and compare one\n` +
          `ticket against get_issue. Only if the tickets really are that short: --allow-thin-raw "<reason>".`
        : '')
  );
  process.exit(1);
}

console.log(`[intake-assert] H-1 OK — ${rows.length} tickets, all acceptance criteria and test cases accounted for.`);
