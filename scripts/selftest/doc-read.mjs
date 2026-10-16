// Selftest section for R-17 — documents are read as Markdown: lib/doc-convert.mjs,
// scripts/read-doc.mjs and .claude/hooks/doc-read-guard.mjs.
//
// The hook decision logic is tested against stub converters (QA_MARKITDOWN_BIN): one that echoes
// text and counts its calls, one that prints nothing (scanned PDF), one that fails, one that hangs.
// One last check runs the real installed markitdown on a generated .xlsx end to end — if the
// converter is not installed that check FAILS, because R-17 without a converter is not in force.
// Fixtures live under TMP/doc-read (inside the hub, so Markdown lands in sibling _md/ folders).

import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { compactTables, mdPathFor, readHeader, markitdownBin } from '../../lib/doc-convert.mjs';

export default function section(h) {
  const { check, assert, TMP, HUB } = h;
  const DIR = join(TMP, 'doc-read');
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  const HOOK = join(HUB, '.claude', 'hooks', 'doc-read-guard.mjs');
  const CALLS = join(DIR, 'calls.log');

  const stub = (name, body) => {
    const p = join(DIR, name);
    writeFileSync(p, `#!/bin/sh\n${body}\n`);
    chmodSync(p, 0o755);
    return p;
  };
  const OK = stub('ok.sh', `echo "$1" >> "${CALLS}"\necho "# Converted"\necho\necho "Body of $(basename "$1") with enough words to count as text."`);
  const EMPTY = stub('empty.sh', 'echo ""');
  const FAIL = stub('fail.sh', 'echo "boom: unsupported" >&2; exit 3');
  const SLOW = stub('slow.sh', 'sleep 5; echo late');
  const calls = () => (existsSync(CALLS) ? readFileSync(CALLS, 'utf8').trim().split('\n').filter(Boolean).length : 0);

  const doc = (name, content = 'fixture') => {
    const p = join(DIR, name);
    writeFileSync(p, content);
    return p;
  };
  const hook = (input, env = {}) => {
    const r = spawnSync('node', [HOOK], {
      input: typeof input === 'string' ? input : JSON.stringify(input),
      encoding: 'utf8',
      env: { ...process.env, QA_MARKITDOWN_BIN: OK, ...env },
    });
    let out = null;
    try { out = r.stdout ? JSON.parse(r.stdout) : null; } catch {}
    return { status: r.status, stdout: r.stdout, decision: out?.hookSpecificOutput?.permissionDecision || null, reason: out?.hookSpecificOutput?.permissionDecisionReason || '' };
  };
  const read = (file_path, extra = {}) => ({ tool_name: 'Read', tool_input: { file_path, ...extra } });

  console.log('\n  R-17 documents as Markdown (doc-read-guard, read-doc, doc-convert)');

  check('doc-convert: spreadsheet noise (NaN / Unnamed: N) blanked, empty columns and rows dropped', () => {
    const md = ['| Unnamed: 0 | Name | Unnamed: 2 | Qty |', '| --- | --- | --- | --- |', '| NaN | apple | NaN | 3 |', '| NaN | NaN | NaN | NaN |', '| NaN | pear | NaN | 5 |'].join('\n');
    const out = compactTables(md);
    assert(out === ['| Name | Qty |', '| --- | --- |', '| apple | 3 |', '| pear | 5 |'].join('\n'), `got:\n${out}`);
  });
  check('doc-convert: a ragged table (unequal cell counts) is left untouched', () => {
    const md = '| a | NaN |\n| --- | --- |\n| x | y | z |';
    assert(compactTables(md) === md, 'ragged table was rewritten');
  });

  check('hook DENIES a Read of .docx and names the converted Markdown (known-bad input)', () => {
    const f = doc('spec.docx');
    const r = hook(read(f));
    assert(r.decision === 'deny', `expected deny, got ${r.decision} / ${r.stdout}`);
    assert(r.reason.includes(mdPathFor(f)) && /R-17/.test(r.reason), `reason lacks the .md path: ${r.reason}`);
    const hd = readHeader(mdPathFor(f));
    assert(hd && hd.empty === 'false' && Number(hd.chars) > 0, `bad header: ${JSON.stringify(hd)}`);
  });
  check('hook denies .xlsx / .pptx / .pdf too (case-insensitive extension)', () => {
    for (const n of ['sheet.XLSX', 'deck.pptx', 'frs.pdf']) assert(hook(read(doc(n))).decision === 'deny', `${n} not denied`);
  });
  check('hook stays silent for .md / .png / .json / non-Read tools', () => {
    for (const n of ['notes.md', 'shot.png', 'plan.json']) {
      const r = hook(read(doc(n)));
      assert(r.decision === null && r.status === 0, `${n}: ${r.stdout}`);
    }
    assert(hook({ tool_name: 'Bash', tool_input: { command: 'cat x.docx' } }).decision === null, 'Bash was judged');
  });
  check('second Read is served from cache — converter not run again', () => {
    const f = doc('cached.docx');
    hook(read(f));
    const n = calls();
    const r = hook(read(f));
    assert(r.decision === 'deny' && /CACHED/.test(r.reason), `second read: ${r.reason}`);
    assert(calls() === n, 'converter ran again on an unchanged file');
  });
  check('a changed source is re-converted (stale Markdown never served)', () => {
    const f = doc('changing.docx', 'v1');
    hook(read(f));
    const n = calls();
    writeFileSync(f, 'version two, longer');
    const r = hook(read(f));
    assert(calls() === n + 1 && /CONVERTED/.test(r.reason), `not re-converted: ${r.reason}`);
  });
  check('no text layer (scanned PDF) → native Read allowed through, recorded empty=true', () => {
    const f = doc('scan.pdf');
    const r = hook(read(f), { QA_MARKITDOWN_BIN: EMPTY });
    assert(r.decision === null, `expected passthrough, got ${r.decision}`);
    assert(readHeader(mdPathFor(f))?.empty === 'true', 'empty conversion not recorded');
  });
  check('converter failure or missing converter → fails OPEN (passthrough), never exit 2', () => {
    const a = hook(read(doc('broken.docx')), { QA_MARKITDOWN_BIN: FAIL });
    const b = hook(read(doc('nobin.docx')), { QA_MARKITDOWN_BIN: join(DIR, 'does-not-exist') });
    const c = hook('{not json');
    for (const [k, r] of Object.entries({ fail: a, missing: b, garbage: c })) assert(r.decision === null && r.status === 0, `${k}: status ${r.status} ${r.stdout}`);
  });
  check('slow conversion → denied with the read-doc command to run (not a silent native Read)', () => {
    const r = hook(read(doc('huge.pdf')), { QA_MARKITDOWN_BIN: SLOW, QA_DOC_HOOK_TIMEOUT_MS: '300' });
    assert(r.decision === 'deny' && /TIMEOUT/.test(r.reason) && r.reason.includes('scripts/read-doc.mjs'), `got ${r.decision}: ${r.reason}`);
  });
  check('PDF Read with `pages`: denied before the text is read, allowed once fresh Markdown exists', () => {
    const f = doc('layout.pdf');
    const first = hook(read(f, { pages: '2' }));
    assert(first.decision === 'deny', `first pages read not denied: ${first.decision}`);
    const second = hook(read(f, { pages: '2' }));
    assert(second.decision === null, `pages read after conversion was denied: ${second.reason}`);
  });

  check('read-doc CLI: converts a folder, prints one line each, exits 1 when a document fails', () => {
    const sub = join(DIR, 'cli');
    mkdirSync(join(sub, 'nested'), { recursive: true });
    writeFileSync(join(sub, 'a.docx'), 'a');
    writeFileSync(join(sub, 'nested', 'b.pptx'), 'b');
    writeFileSync(join(sub, 'skip.txt'), 'c');
    const ok = spawnSync('node', [join(HUB, 'scripts', 'read-doc.mjs'), sub], { encoding: 'utf8', env: { ...process.env, QA_MARKITDOWN_BIN: OK } });
    assert(ok.status === 0 && /2 documents: 2 converted/.test(ok.stdout), `ok run: ${ok.status} ${ok.stdout}${ok.stderr}`);
    const bad = spawnSync('node', [join(HUB, 'scripts', 'read-doc.mjs'), join(sub, 'a.docx'), '--force'], { encoding: 'utf8', env: { ...process.env, QA_MARKITDOWN_BIN: FAIL } });
    assert(bad.status === 1 && /FAILED/.test(bad.stdout), `failing run: ${bad.status} ${bad.stdout}`);
  });

  check('real markitdown installed and converts an .xlsx end to end (R-17 in force)', () => {
    const bin = markitdownBin({});
    assert(existsSync(bin), `converter missing at ${bin} — install per README "Reading documents"`);
    const py = join(HUB, '.tools', 'markitdown', 'bin', 'python');
    const f = join(DIR, 'real.xlsx');
    const g = spawnSync(py, ['-c', 'import openpyxl,sys;wb=openpyxl.Workbook();ws=wb.active;ws.title="Stores";ws["B2"]="Chain";ws["C2"]="City";ws["B3"]="Store";ws["C3"]="Springfield";wb.save(sys.argv[1])', f], { encoding: 'utf8' });
    assert(g.status === 0, `fixture build failed: ${g.stderr}`);
    const r = spawnSync('node', [join(HUB, 'scripts', 'read-doc.mjs'), f], { encoding: 'utf8', env: { ...process.env, QA_MARKITDOWN_BIN: '' } });
    const md = existsSync(mdPathFor(f)) ? readFileSync(mdPathFor(f), 'utf8') : '';
    assert(r.status === 0 && /## Stores/.test(md) && /\| Store \| Springfield \|/.test(md) && !/NaN|Unnamed/.test(md), `real conversion: ${r.stdout}${r.stderr}\n${md.slice(0, 400)}`);
  });
}
