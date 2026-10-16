#!/usr/bin/env node
// R-11 — generate the dev-facing .docx from the ledger. No hand-authored classification.
//
// Only dev-facing verdicts appear (R-04): FAIL, PARTIAL/mixed, BLOCKED. A pass with a deferred
// remainder, a coverage gap and a needs-manual are NOT defects and must never land in a defect
// document — that is exactly how ALP-389 and ALP-55 got there.
//
//   node scripts/gen-docx.mjs --ledger _LEDGER-R4.json [--out QA-Report.docx] [--prose intro.md] [--lang en|uz]
//
// --lang uz renders the fixed labels in Uzbek (Latin). Per-case Expected/Actual text and scope
// questions are English ledger data and cannot be translated by script, so in uz mode they are
// omitted and the (Uzbek, self-contained — R-10) proposed ticket comment carries the detail.

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { args, fail, loadProfile, reportsDir, HUB } from '../lib/profile.mjs';
import { validateLedger, computeCounts } from '../lib/ledger.mjs';
import { route } from '../lib/routing.mjs';
import { planLookup, readPlain, plainCaseOf, reproSteps as reproStepsOf, PlainRunMismatch } from '../lib/case-detail.mjs';

const { flags } = args();
if (!flags.ledger) fail('usage: gen-docx.mjs --ledger <ledger.json> [--out <file.docx>] [--prose <file.md>] [--lang en|uz] [--force]', 2);
const LANG = flags.lang || 'en';
if (!['en', 'uz'].includes(LANG)) fail(`[gen-docx] unknown --lang ${LANG}; use en or uz`, 2);

const ledger = JSON.parse(readFileSync(flags.ledger, 'utf8'));
const slug = flags.project || ledger.project;
let profile = null;
try {
  profile = loadProfile(slug);
} catch { /* optional */ }

const { errors } = validateLedger(ledger, { profile, currentBuildId: ledger.build?.buildId });
if (errors.length && !flags.force) {
  console.error('[gen-docx] refusing to generate a dev-facing document from an invalid ledger:');
  for (const e of errors) console.error(`  ✗ ${e}`);
  process.exit(1);
}

const counts = computeCounts(ledger, { stateMap: profile?.linear?.stateMap || {} });

// ---------------------------------------------------------------- plan lookup (the QA lead, 2026-10-09)
// Every FAIL case must show which acceptance criterion is not met, the expected result, the steps
// to reproduce and why it fails. Ledger cases often carry only the evidence, so Expected + steps
// are taken from the analyst's plan for that ticket: --plans-run <runId> or, by default, the newest
// _PLAN-*-<ticket>.json in the reports dir. A ledger field (expected / repro / whyNotMet) always wins.
const PLAN_DIR = (() => { try { return reportsDir(slug); } catch { return null; } })();
// The lookups live in lib/case-detail.mjs (shared with slack-report.mjs since 2026-10-16), same behaviour.
const plans = planLookup(PLAN_DIR, { planRun: flags['plans-run'] });
const planCase = plans.planCase;
const planTitles = { get: plans.planTitle };
// Plain-language sidecar (the QA lead, 2026-10-09: "make it human readable, simple explanation, simple
// reasons"). The verifier writes _PLAIN-<runId>.json next to the ledger: per failing case
// {problem, ac, expected, actual, why, steps[]} in plain words. The ledger keeps the evidence;
// this file keeps the explanation. --plain <file> overrides the default path.
const plainPath = flags.plain ? resolve(HUB, flags.plain) : PLAN_DIR ? join(PLAN_DIR, `_PLAIN-${ledger.runId}.json`) : null;
let PLAIN = { cases: {} };
try {
  PLAIN = readPlain(PLAN_DIR, ledger.runId, { plainPath });
} catch (e) {
  if (e instanceof PlainRunMismatch) fail(`[gen-docx] ${e.message}`, 2);
  throw e;
}
const plainCase = plainCaseOf(PLAIN);
const verdictWord = (v) => LABELS.verdictWord[v] || v;

const reproSteps = (c, p) => reproStepsOf(c, p, LABELS);
const out = flags.out ? resolve(HUB, flags.out) : join(reportsDir(slug), `QA-Report-${ledger.runId}.docx`);

// ---------------------------------------------------------------- OOXML building blocks
const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function runs(text, { bold = false, mono = false, color = null } = {}) {
  // Word needs each line break as an explicit <w:br/>.
  const parts = String(text ?? '').split('\n');
  const rPr =
    `<w:rPr>${bold ? '<w:b/>' : ''}${mono ? '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>' : ''}` +
    `${color ? `<w:color w:val="${color}"/>` : ''}</w:rPr>`;
  return parts
    .map((p, i) => `<w:r>${rPr}${i ? '<w:br/>' : ''}<w:t xml:space="preserve">${esc(p)}</w:t></w:r>`)
    .join('');
}

const para = (text, opts = {}) =>
  `<w:p><w:pPr>${opts.style ? `<w:pStyle w:val="${opts.style}"/>` : ''}` +
  `${opts.bullet ? '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>' : ''}` +
  `<w:spacing w:after="${opts.after ?? 120}"/></w:pPr>${runs(text, opts)}</w:p>`;

const h1 = (t) => para(t, { style: 'Heading1', after: 200 });
const h2 = (t) => para(t, { style: 'Heading2', after: 160 });

function table(header, rows) {
  const cell = (t, bold) =>
    `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr><w:p><w:pPr><w:spacing w:after="40"/></w:pPr>${runs(t, { bold })}</w:p></w:tc>`;
  const tr = (cells, bold) => `<w:tr>${cells.map((c) => cell(c, bold)).join('')}</w:tr>`;
  return (
    '<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/>' +
    '<w:tblBorders>' +
    ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
      .map((s) => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/>`)
      .join('') +
    '</w:tblBorders></w:tblPr>' +
    tr(header, true) +
    rows.map((r) => tr(r, false)).join('') +
    '</w:tbl><w:p><w:pPr><w:spacing w:after="120"/></w:pPr></w:p>'
  );
}

// ---------------------------------------------------------------- labels
const LABELS = {
  en: {
    title: (n) => `${n} — QA report`,
    runLine: (run, build, date) => `Run ${run} · build ${build} · ${date}`,
    outcome: 'Outcome', result: 'Result', tickets: 'Tickets', total: 'TOTAL',
    fresh: (t, c) => `Freshly tested this run: ${t}. Carried forward from a previous run without re-testing: ${c}.`,
    defects: (n) => `Defects requiring dev action (${n})`,
    none: 'None. Every ticket in this run either passed or is held on the QA side.',
    verdictLine: (v, s, b) => `Verdict: ${v}. Observed on ${s}, build ${b}.`,
    expected: 'Expected', actual: 'Actual', where: 'Where', at: 'at', element: 'element', repro: 'Steps to reproduce:',
    acNotMet: 'Acceptance criterion not met', why: 'Why it fails', precond: 'Precondition', check: 'Check',
    whatAsks: 'What the ticket asks for', shouldHappen: 'What should happen', happensInstead: 'What happens instead',
    whyBug: 'Why this is a bug', howTo: 'How to reproduce:', seenAt: 'Seen at', caseTag: 'test case',
    rawNote: 'No plain-language explanation was recorded for this case; the raw evidence follows.',
    verdictWord: {
      PASS: 'Passes', FAIL: 'Fails — bug found', PASS_SCOPE: 'Passes for the delivered scope',
      'PARTIAL:coverage-gap': 'Partly tested — some checks could not run yet',
      'PARTIAL:blocked-on-definition': 'Waiting on a product decision',
      NEEDS_MANUAL: 'Needs a manual check', BLOCKED: 'Blocked',
    },
    commentHead: 'Suggested comment for the ticket:',
    scopeHead: 'Scope questions — not defects, no dev action',
    scopeIntro:
      'The delivered slice of each of these is correct. The remainder was explicitly deferred or was never defined. ' +
      'They are listed so product can decide, not because anything is broken.',
  },
  uz: {
    title: (n) => `${n} — QA hisoboti`,
    runLine: (run, build, date) => `Tekshiruv ${run} · build ${build} · ${date}`,
    outcome: 'Natija', result: 'Xulosa', tickets: 'Chiptalar', total: 'JAMI',
    fresh: (t, c) => `Shu tekshiruvda yangidan sinovdan o'tkazildi: ${t}. Oldingi tekshiruvdan qayta sinovsiz o'tkazildi: ${c}.`,
    defects: (n) => `Dasturchi aralashuvi kerak bo'lgan nuqsonlar (${n})`,
    none: "Yo'q. Bu tekshiruvdagi har bir chipta yo o'tdi, yo QA tomonida ushlab turilmoqda.",
    verdictLine: (v, s, b) => `Xulosa: ${v}. Kuzatilgan joy: ${s}, build ${b}.`,
    expected: 'Kutilgan', actual: 'Haqiqiy', where: 'Qayerda', at: 'manzil', element: 'element', repro: 'Takrorlash qadamlari:',
    acNotMet: 'Bajarilmagan qabul mezoni', why: "Nima uchun o'tmadi", precond: 'Dastlabki shart', check: 'Tekshirish',
    whatAsks: "Chipta nimani talab qiladi", shouldHappen: "Nima bo'lishi kerak", happensInstead: "Aslida nima bo'ladi",
    whyBug: "Nima uchun bu xato", howTo: 'Qanday takrorlash:', seenAt: "Ko'rilgan joy", caseTag: 'test holati',
    rawNote: "Bu holat uchun oddiy tushuntirish yozilmagan; quyida xom dalillar keltirilgan.",
    verdictWord: {
      PASS: "O'tdi", FAIL: "O'tmadi — xato topildi", PASS_SCOPE: "Yetkazilgan qamrov uchun o'tdi",
      'PARTIAL:coverage-gap': "Qisman tekshirildi — ba'zi tekshiruvlar hali o'tkazilmadi",
      'PARTIAL:blocked-on-definition': 'Mahsulot qarori kutilmoqda',
      NEEDS_MANUAL: "Qo'lda tekshirish kerak", BLOCKED: 'Bloklangan',
    },
    commentHead: 'Chiptaga taklif qilingan izoh:',
    scopeHead: "Qamrov savollari — nuqson emas, dasturchi harakati talab qilinmaydi",
    scopeIntro:
      "Bu chiptalarning yetkazilgan qismi to'g'ri ishlaydi. Qolgan qismi aniq kechiktirilgan yoki umuman belgilanmagan. " +
      "Ular mahsulot jamoasi qaror qilishi uchun keltirilgan, biror narsa buzilgani uchun emas. Savollarning to'liq matni PM uchun alohida eslatmada.",
  },
}[LANG];

// Minimal markdown → paragraphs for the --prose file: `## ` → Heading2, `- `/`* ` → bullet,
// inline `**` and backticks stripped. Anything else is a plain paragraph.
function proseBlocks(md) {
  const out = [];
  const strip = (t) => t.replace(/\*\*(.+?)\*\*/g, '$1').replace(/`([^`]*)`/g, '$1');
  for (const block of md.trim().split(/\n{2,}/)) {
    const lines = block.split('\n');
    if (/^###\s+/.test(lines[0]) && lines.length === 1) out.push(para(strip(lines[0].replace(/^###\s+/, '')), { bold: true, after: 60 }));
    else if (/^##\s+/.test(lines[0]) && lines.length === 1) out.push(h2(strip(lines[0].replace(/^##\s+/, ''))));
    else if (/^#\s+/.test(lines[0]) && lines.length === 1) out.push(h1(strip(lines[0].replace(/^#\s+/, ''))));
    else if (lines.every((l) => /^\s*[-*]\s+/.test(l))) for (const l of lines) out.push(para(strip(l.replace(/^\s*[-*]\s+/, '')), { bullet: true, after: 40 }));
    else out.push(para(strip(block)));
  }
  return out;
}

// ---------------------------------------------------------------- document body
const body = [];
body.push(h1(LABELS.title(profile?.name || slug)));
body.push(para(LABELS.runLine(ledger.runId, ledger.build?.buildId, new Date().toISOString().slice(0, 10)), { color: '595959' }));

if (flags.prose && existsSync(flags.prose)) {
  body.push(...proseBlocks(readFileSync(flags.prose, 'utf8')));
}

body.push(h2(LABELS.outcome));
body.push(
  table(
    [LABELS.result, LABELS.tickets],
    [
      ...Object.entries(counts.buckets).map(([k, v]) => [verdictWord(k), String(v)]),
      [LABELS.total, String(counts.total)],
    ]
  )
);
body.push(
  para(LABELS.fresh(counts.tested, counts.carriedForward))
);

const devFacing = ledger.tickets.filter((t) => {
  try {
    return route(t).devFacing;
  } catch {
    return false;
  }
});

body.push(h2(LABELS.defects(devFacing.length)));
if (devFacing.length === 0) {
  body.push(para(LABELS.none));
}

for (const t of devFacing) {
  planCase(t.id, '');
  body.push(h2(`${t.id} — ${t.title || planTitles.get(t.id) || ''}`));
  body.push(
    para(
      LABELS.verdictLine(verdictWord(t.partialReason ? `${t.verdict}:${t.partialReason}` : t.verdict), t.surface || 'staging', t.buildId || ledger.build?.buildId),
      { color: '595959' }
    )
  );
  if (t.headline && LANG === 'en') body.push(para(t.headline));

  // Per-case text is English ledger data; in uz mode the Uzbek comment carries the detail.
  const fails = LANG === 'en' ? (t.cases || []).filter((c) => c.verdict === 'FAIL') : [];
  for (const c of fails) {
    const p = planCase(t.id, c.caseId);
    const pl = plainCase(t.id, c.caseId);
    if (pl) {
      body.push(para(pl.problem || c.caseId, { bold: true, after: 60 }));
      if (pl.ac) body.push(para(`${LABELS.whatAsks}: ${pl.ac}`, { bullet: true, after: 40 }));
      if (pl.expected) body.push(para(`${LABELS.shouldHappen}: ${pl.expected}`, { bullet: true, after: 40 }));
      if (pl.actual) body.push(para(`${LABELS.happensInstead}: ${pl.actual}`, { bullet: true, after: 40 }));
      if (pl.why) body.push(para(`${LABELS.whyBug}: ${pl.why}`, { bullet: true, after: 40 }));
      if (c.evidence?.url) body.push(para(`${LABELS.seenAt}: ${c.evidence.url}`, { bullet: true, after: 40 }));
      if (Array.isArray(pl.steps) && pl.steps.length) {
        body.push(para(LABELS.howTo, { bullet: true, after: 40 }));
        pl.steps.forEach((st, i) => body.push(para(`${i + 1}. ${st}`, { after: 20 })));
      }
      body.push(para(`(${LABELS.caseTag} ${c.caseId})`, { color: '808080', after: 120 }));
      continue;
    }
    body.push(para(`${c.caseId}`, { bold: true, after: 40 }));
    body.push(para(LABELS.rawNote, { color: 'C00000', after: 40 }));
    const acRef = c.acRef || p?.acRef;
    if (acRef) body.push(para(`${LABELS.acNotMet}: ${acRef}`, { bullet: true, after: 40 }));
    const expected = c.expected || p?.expected;
    if (expected) body.push(para(`${LABELS.expected}: ${expected}`, { bullet: true, after: 40 }));
    const observed = c.evidence?.observedText || c.actual;
    if (observed) body.push(para(`${LABELS.actual}: ${observed}`, { bullet: true, after: 40 }));
    const why = c.whyNotMet || c.reason || c.note;
    if (why) body.push(para(`${LABELS.why}: ${why}`, { bullet: true, after: 40 }));
    const where = [
      c.evidence?.url ? `${LABELS.at} ${c.evidence.url}` : null,
      c.evidence?.httpStatus !== undefined ? `HTTP ${c.evidence.httpStatus}` : null,
      c.evidence?.selector ? `${LABELS.element} ${c.evidence.selector}` : null,
    ]
      .filter(Boolean)
      .join(' · ');
    if (where) body.push(para(`${LABELS.where}: ${where}`, { bullet: true, after: 40 }));
    const steps = reproSteps(c, p);
    if (steps.length) {
      body.push(para(LABELS.repro, { bullet: true, after: 40 }));
      steps.forEach((s, i) => body.push(para(`${i + 1}. ${s}`, { after: 20 })));
    } else {
      body.push(para(`${LABELS.repro} (missing — no plan case found for ${c.caseId})`, { bullet: true, after: 40, color: 'C00000' }));
    }
  }
  if (t.comment) {
    body.push(para(LABELS.commentHead, { bold: true, after: 40 }));
    body.push(para(t.comment, { color: '404040' }));
  }
}

const passScope = ledger.tickets.filter((t) => t.verdict === 'PASS_SCOPE' || t.scopeQuestion);
if (passScope.length) {
  body.push(h2(LABELS.scopeHead));
  body.push(para(LABELS.scopeIntro));
  for (const t of passScope) body.push(para(LANG === 'en' ? `${t.id} — ${t.scopeQuestion || ''}` : `${t.id} — ${t.title || ''}`, { bullet: true }));
}

// ---------------------------------------------------------------- package
const DOC =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
  `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
  `<w:body>${body.join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>` +
  `<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body></w:document>`;

const CONTENT_TYPES =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
  `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
  `<Default Extension="xml" ContentType="application/xml"/>` +
  `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
  `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>` +
  `<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>` +
  `</Types>`;

const RELS =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
  `</Relationships>`;

const DOC_RELS =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
  `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>` +
  `</Relationships>`;

const style = (id, name, sz, bold, color, after) =>
  `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/>` +
  `<w:pPr><w:spacing w:before="240" w:after="${after}"/><w:keepNext/></w:pPr>` +
  `<w:rPr>${bold ? '<w:b/>' : ''}<w:sz w:val="${sz}"/><w:color w:val="${color}"/></w:rPr></w:style>`;

const STYLES =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
  `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
  `<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>` +
  `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>` +
  style('Heading1', 'heading 1', 36, true, '1F3864', 240) +
  style('Heading2', 'heading 2', 28, true, '2E5496', 160) +
  `<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/></w:style>` +
  `</w:styles>`;

const NUMBERING =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
  `<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
  `<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/>` +
  `<w:lvlText w:val="•"/><w:pPr><w:ind w:left="360" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>` +
  `<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`;

const stage = join(tmpdir(), `qa-docx-${process.pid}`);
rmSync(stage, { recursive: true, force: true });
const put = (rel, content) => {
  const p = join(stage, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
};
put('[Content_Types].xml', CONTENT_TYPES);
put('_rels/.rels', RELS);
put('word/document.xml', DOC);
put('word/_rels/document.xml.rels', DOC_RELS);
put('word/styles.xml', STYLES);
put('word/numbering.xml', NUMBERING);

mkdirSync(dirname(out), { recursive: true });
rmSync(out, { force: true });
execFileSync('zip', ['-q', '-X', '-r', out, '.'], { cwd: stage });
rmSync(stage, { recursive: true, force: true });

console.log(`[gen-docx] wrote ${out} — ${devFacing.length} dev-facing defect(s) of ${counts.total} tickets, derived from the ledger.`);
