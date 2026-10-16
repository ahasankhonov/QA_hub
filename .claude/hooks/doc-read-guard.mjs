#!/usr/bin/env node
// PreToolUse guard for Read (R-17): documents are read as Markdown, converted by markitdown.
//
// A Read of .pdf/.docx/.pptx/.xlsx/.xls/.epub/.msg is converted (lib/doc-convert.mjs, cached in a
// sibling _md/ folder) and DENIED with the path of the Markdown to Read instead. Allowed through:
//   - the conversion has no text layer (scanned PDF, image-only deck) → the native Read is the fallback;
//   - a PDF Read with `pages` once a fresh Markdown exists → looking at a page's layout after the text;
//   - the converter is missing, crashed, or failed on this file → the native Read is better than nothing.
// A slow conversion (> QA_DOC_HOOK_TIMEOUT_MS, default 45 s) is denied with the CLI command to run.
//
// This is an efficiency guard, not a safety gate: it fails OPEN. It never exits 2 and never prints
// "allow" — silence means the normal permission flow runs.

import { readFileSync } from 'node:fs';
import { convert, describe, isDoc, isFresh, mdPathFor, LARGE_CHARS } from '../../lib/doc-convert.mjs';

function deny(reason) {
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } })
  );
  process.exit(0);
}
const passthrough = () => process.exit(0);

try {
  let input = {};
  try {
    input = JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    passthrough();
  }
  if (input.tool_name !== 'Read') passthrough();
  const file = input.tool_input?.file_path;
  if (!file || !isDoc(file)) passthrough();

  const mdPath = mdPathFor(file);
  if (input.tool_input?.pages && /\.pdf$/i.test(file) && isFresh(file, mdPath)) passthrough();

  const res = convert(file, { timeoutMs: Number(process.env.QA_DOC_HOOK_TIMEOUT_MS) || 45_000 });
  switch (res.status) {
    case 'converted':
    case 'cached':
      deny(
        `R-17: documents are read as Markdown. ${describe(res)}\n` +
          `Read ${res.mdPath}${res.chars > LARGE_CHARS ? ' with offset/limit, or grep it' : ''} instead. ` +
          (/\.pdf$/i.test(file) ? 'To see a page\'s layout or figures afterwards, Read the PDF again with `pages`.' : '')
      );
    case 'timeout':
      deny(`R-17: ${describe(res)}`);
    default:
      // empty / failed / no-converter / missing / unsupported → native Read.
      passthrough();
  }
} catch {
  passthrough();
}
