#!/usr/bin/env node
// Convert documents to Markdown with markitdown and print where the Markdown is (R-17).
//
//   node scripts/read-doc.mjs <file|dir> [more…] [--force] [--print] [--json]
//
//   <file>    .pdf .docx .pptx .xlsx .xls .epub .msg — converted once, cached next to it in _md/<name>.md
//             (outside the hub: .doc-cache/). Re-converted only when the file's size/mtime changed.
//   <dir>     every document under it (recursive; skips _md/, node_modules/, dot-dirs).
//   --force   re-convert even when the cached Markdown is fresh.
//   --print   also print the Markdown of a single small (< 120k chars) document to stdout.
//   --json    one JSON object per line instead of the text summary.
//
// Prints one line per document — never the content unless --print. Then Read / grep the .md path.
// Exit 1 if any document failed or the converter is missing.

import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { convert, describe, isDoc, LARGE_CHARS } from '../lib/doc-convert.mjs';

const argv = process.argv.slice(2);
const flags = { force: argv.includes('--force'), print: argv.includes('--print'), json: argv.includes('--json') };
const targets = argv.filter((a) => !a.startsWith('--'));
if (!targets.length) {
  console.error('usage: node scripts/read-doc.mjs <file|dir> [more…] [--force] [--print] [--json]');
  process.exit(2);
}

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === '_md' || e.name === 'node_modules') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (isDoc(p)) out.push(p);
  }
  return out;
}

const files = [];
for (const t of targets) {
  const p = resolve(t);
  let st = null;
  try { st = statSync(p); } catch {}
  if (st?.isDirectory()) files.push(...walk(p));
  else files.push(p);
}
if (!files.length) {
  console.log('no documents found');
  process.exit(0);
}

let bad = 0;
const results = [];
for (const f of files) {
  const r = convert(f, { force: flags.force });
  results.push(r);
  if (['failed', 'no-converter', 'missing'].includes(r.status)) bad++;
  console.log(flags.json ? JSON.stringify(r) : describe(r));
  if (r.status === 'no-converter') break;
}

if (flags.print && results.length === 1 && ['converted', 'cached'].includes(results[0].status)) {
  if (results[0].chars > LARGE_CHARS) console.log(`(--print skipped: ${results[0].chars} chars — grep or Read with offset/limit)`);
  else process.stdout.write('\n' + readFileSync(results[0].mdPath, 'utf8'));
}
if (files.length > 1 && !flags.json) {
  const by = results.reduce((a, r) => ((a[r.status] = (a[r.status] || 0) + 1), a), {});
  console.log(`— ${files.length} documents: ${Object.entries(by).map(([k, v]) => `${v} ${k}`).join(', ')}`);
}
process.exit(bad ? 1 : 0);
