// Jira screenshot attachments: the checks shared by scripts/jira-attach-plan.mjs and
// scripts/jira-attach-apply.mjs. R-01 / R-10.
//
// Attachments go to Jira over REST (POST /rest/api/3/issue/{key}/attachments) because the Atlassian
// MCP connector has no upload tool. The PreToolUse write gate only sees MCP calls, so a REST
// uploader is invisible to it. That is why every check lives here and runs TWICE: once when the plan
// is generated and again in the uploader immediately before each send. A check that only ran at plan
// time could be voided by a file swapped on disk after approval.
//
// What a file must be, to go in a plan or be sent:
//   · a regular file (not a symlink) whose realpath is inside
//     projects/<project>/qa-reports/_JIRA-ATTACHMENTS-<run>/, named by a canonical hub-relative path
//     (no "..", no absolute path);
//   · an image by its MAGIC BYTES (PNG / JPEG / GIF / WEBP), with an extension that agrees;
//   · 1 byte .. 10 MB;
//   · not on the PII blocklist: built from EVERY _PII-SCAN-<run>-*.json — the sha256 (or ≥12-hex
//     prefix) of each flagged entry (`flagged: true`, or any severity other than "none"), the content
//     hash of the path/file such an entry names (so an entry without a sha256 is still blocked by
//     hash), and the hard-coded hashes below. No scan at all, or a scan that does not parse, is a
//     problem (fail closed). The plan generator records a PII hit as refused ("PII-flagged (<scan>)")
//     and leaves it out; the uploader treats the same hit as fatal.

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const ATTACH_TOOL = 'jira-rest-attach';
export const ATTACH_ENDPOINT = 'POST /rest/api/3/issue/{issueKey}/attachments';
export const MAX_ATTACH_BYTES = 10 * 1024 * 1024;

/**
 * Images that must never leave the machine, whatever a scan file says. R-20261006-EXP
 * PAR-X06-2/s05-profile-edit-recovered.png: an unmasked student phone number (the in-place mask was
 * denied on 2026-10-06, so the file on disk is still unmasked).
 */
export const KNOWN_PII_SHA256 = ['1f829b8f3ecc8ff90a3fad7d631f39144f8ef3de782655c299720aacd3875a01'];

export const RUN_ID_RE = /^[A-Za-z0-9._-]+$/;

export const sha256Buf = (buf) => createHash('sha256').update(buf).digest('hex');

/** hub-relative folder that holds the run's review copies, and its absolute path. */
export function attachDirRel(project, sourceRunId) {
  if (!RUN_ID_RE.test(project || '') || !RUN_ID_RE.test(sourceRunId || '')) throw new Error(`bad project/run id "${project}" / "${sourceRunId}"`);
  return join('projects', project, 'qa-reports', `_JIRA-ATTACHMENTS-${sourceRunId}`);
}

const IMAGE_TYPES = [
  { contentType: 'image/png', exts: ['.png'], test: (b) => b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { contentType: 'image/jpeg', exts: ['.jpg', '.jpeg'], test: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { contentType: 'image/gif', exts: ['.gif'], test: (b) => b.length >= 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString('latin1')) },
  { contentType: 'image/webp', exts: ['.webp'], test: (b) => b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
];

/** Content type from the magic bytes, or null. The extension is NOT consulted here. */
export function sniffImage(buf) {
  const t = IMAGE_TYPES.find((x) => x.test(buf));
  return t ? { contentType: t.contentType, exts: t.exts } : null;
}

/** Scan files for a run: _PII-SCAN-<run>-*.json (and a bare _PII-SCAN-<run>.json). Another run that only shares a prefix is not matched. */
export function piiScanNames(reportsDir, sourceRunId) {
  if (!existsSync(reportsDir)) return [];
  const pre = `_PII-SCAN-${sourceRunId}`;
  return readdirSync(reportsDir).filter((f) => f.startsWith(pre) && f.endsWith('.json') && (f === `${pre}.json` || f.startsWith(`${pre}-`))).sort();
}

/**
 * Is a scan entry flagged? An explicit boolean `flagged` wins (the iOS image-by-image scan lists
 * every image, flagged or not). Otherwise any severity other than "none" counts, and an entry with
 * neither field counts too (fail closed).
 */
export function isFlaggedEntry(e) {
  if (!e || typeof e !== 'object') return false;
  if (typeof e.flagged === 'boolean') return e.flagged;
  return String(e.severity ?? '').trim().toLowerCase() !== 'none';
}

const HEX_RE = /^[0-9a-f]{12,64}$/i;

/**
 * The PII blocklist for one run, built from every _PII-SCAN-<run>-*.json in the run's reports dir.
 * Entries are read from the scan's `images` and `findings` arrays. For each FLAGGED entry the
 * blocklist takes its `sha256` (full, or a ≥12-hex prefix) and, when it names a `path` (absolute or
 * hub-relative) or a `file` (relative to _E2E-<run>_attachments/, comma lists allowed), the content
 * hash of that file — so an entry without a sha256 is still blocked by hash, and a renamed copy is
 * caught. A hash written in prose inside a flagged entry (e.g. "sha256 1f829b8f3ecc…") is taken too.
 * Fail closed: no scan file, a scan that does not parse, a scan with no entry arrays, a flagged
 * entry with no usable hash, or a flagged file that is not on disk is a problem, never a skip.
 * `origin` maps each full hash / prefix to the scan file(s) that flagged it, for the refusal reason.
 * @returns {{full:Set<string>, prefixes:Set<string>, origin:Map<string,string[]>, scans:{file:string,sha256:string}[], flagged:string[], flaggedBy:Map<string,string[]>, problems:string[]}}
 */
export function piiBlocklist(hub, project, sourceRunId) {
  const reports = join(hub, 'projects', project, 'qa-reports');
  const full = new Set();
  const prefixes = new Set();
  const origin = new Map();
  const scans = [];
  const flagged = [];
  const flaggedBy = new Map();
  const problems = [];
  const addTo = (m, k, v) => {
    const a = m.get(k) || [];
    if (!a.includes(v)) a.push(v);
    m.set(k, a);
  };
  const block = (h, src) => {
    h = String(h).toLowerCase();
    if (h.length === 64) full.add(h);
    else prefixes.add(h);
    addTo(origin, h, src);
  };
  for (const h of KNOWN_PII_SHA256) block(h, 'lib/jira-attach.mjs KNOWN_PII_SHA256');
  const names = piiScanNames(reports, sourceRunId);
  if (!names.length) problems.push(`no _PII-SCAN-${sourceRunId}-*.json in ${relative(hub, reports)} — cannot prove the images are free of PII (fail closed)`);
  const e2e = join(reports, `_E2E-${sourceRunId}_attachments`);
  const hashFile = (abs) => {
    try {
      const st = lstatSync(abs);
      if (!st.isFile()) return null;
      return sha256Buf(readFileSync(abs));
    } catch {
      return null;
    }
  };
  for (const name of names) {
    const raw = readFileSync(join(reports, name));
    scans.push({ file: relative(hub, join(reports, name)), sha256: sha256Buf(raw) });
    let scan;
    try {
      scan = JSON.parse(raw.toString('utf8'));
    } catch (e) {
      problems.push(`${name} is unparseable (${e.message}) — fail closed`);
      continue;
    }
    if (!scan || typeof scan !== 'object' || Array.isArray(scan)) {
      problems.push(`${name} is not a JSON object — fail closed`);
      continue;
    }
    const arrays = ['images', 'findings'].filter((k) => k in scan);
    if (!arrays.length) {
      problems.push(`${name} has neither an "images" nor a "findings" array — cannot tell what it flags (fail closed)`);
      continue;
    }
    for (const k of arrays) if (!Array.isArray(scan[k])) problems.push(`${name}: "${k}" is not an array — fail closed`);
    // A hash quoted anywhere outside the entry arrays (summary prose etc.) is blocked as well.
    const rest = { ...scan };
    for (const k of arrays) delete rest[k];
    for (const m of JSON.stringify(rest).matchAll(/sha256[^0-9a-f]{0,20}([0-9a-f]{12,64})/gi)) block(m[1], name);

    const entries = arrays.flatMap((k) => (Array.isArray(scan[k]) ? scan[k].map((e, i) => ({ e, at: `${k}[${i}]` })) : []));
    for (const { e, at } of entries) {
      if (!isFlaggedEntry(e)) continue;
      let hashes = 0;
      if (e.sha256 !== undefined && e.sha256 !== null && e.sha256 !== '') {
        if (HEX_RE.test(String(e.sha256))) (block(e.sha256, name), hashes++);
        else problems.push(`${name} ${at}: sha256 "${String(e.sha256).slice(0, 80)}" is not a ≥12-hex hash — fail closed`);
      }
      // Hashes quoted in the entry's prose (actionTaken etc.).
      const { sha256: _s, ...prose } = e;
      for (const m of JSON.stringify(prose).matchAll(/sha256[^0-9a-f]{0,20}([0-9a-f]{12,64})/gi)) (block(m[1], name), hashes++);
      // A hub-relative or absolute path: hash it (the only hash, when the entry has no sha256).
      if (typeof e.path === 'string' && e.path) {
        const abs = isAbsolute(e.path) ? e.path : resolve(hub, e.path);
        const h = hashFile(abs);
        if (h) (block(h, name), hashes++);
        else if (!e.sha256) problems.push(`${name} ${at}: flagged path ${e.path} has no sha256 and is not a readable file — its hash cannot be blocked`);
        if (!isAbsolute(e.path)) addTo(flaggedBy, e.path, name); // a plan path equal to a flagged path is refused even if re-hashed
      }
      // A file relative to the E2E attachments dir (android scans; "a/b.png, c.png" lists allowed).
      const parts = String(e.file || '').split(/\s*,\s*/).filter(Boolean);
      let lastDir = '';
      for (const p of parts) {
        const rel = p.includes('/') ? p : lastDir ? `${lastDir}/${p}` : p;
        lastDir = dirname(rel) === '.' ? lastDir : dirname(rel);
        flagged.push(rel);
        addTo(flaggedBy, rel, name);
        const h = hashFile(resolve(e2e, rel));
        if (h) (block(h, name), hashes++);
        else problems.push(`${name}: flagged file ${rel} is not on disk, so its content hash cannot be blocked`);
      }
      for (const c of Array.isArray(e.unmaskedCopies) ? e.unmaskedCopies : []) {
        const h = c?.path ? hashFile(c.path) : null;
        if (h) block(h, name);
      }
      if (!hashes && !parts.length) problems.push(`${name} ${at}: flagged entry has no sha256, path or file — cannot block it by hash (fail closed)`);
    }
  }
  return { full, prefixes, origin, scans, flagged, flaggedBy, problems };
}

/** The scan file(s) whose flag blocks this hash, or null. */
export function blockedBy(sha, blocklist) {
  const out = [];
  if (blocklist.full.has(sha)) out.push(...(blocklist.origin?.get(sha) || ['PII blocklist']));
  for (const p of blocklist.prefixes) if (sha.startsWith(p)) out.push(...(blocklist.origin?.get(p) || ['PII blocklist']));
  return out.length ? [...new Set(out)] : null;
}

export function isBlocked(sha, blocklist) {
  return blockedBy(sha, blocklist) !== null;
}

/** "PII-flagged (<scan file>)" — the reason a refused image is recorded with. */
export const piiReason = (scanFiles) => `PII-flagged (${[...new Set(scanFiles)].join(', ')})`;

/** sourcePath (relative to the E2E attachments dir) of a review copy, from the folder's INDEX.json. */
export function indexSources(hub, project, sourceRunId) {
  const dir = join(hub, attachDirRel(project, sourceRunId));
  const idx = join(dir, 'INDEX.json');
  const out = new Map();
  if (!existsSync(idx)) return out;
  const e2e = join(hub, 'projects', project, 'qa-reports', `_E2E-${sourceRunId}_attachments`);
  const j = JSON.parse(readFileSync(idx, 'utf8'));
  for (const a of j.attachments || []) for (const f of a.files || []) {
    if (!f?.sourcePath) continue;
    out.set(join(attachDirRel(project, sourceRunId), a.folder || a.rcId || '', f.file), relative(e2e, f.sourcePath));
  }
  return out;
}

/**
 * Every per-file check. Reads the file once; the returned `buf` is the exact bytes that were hashed,
 * so an uploader that sends `buf` cannot send something other than what it checked.
 * @returns {{ok:boolean, problems:string[], piiHit:boolean, rel:string, buf?:Buffer, sha256?:string, bytes?:number, contentType?:string}}
 */
export function checkAttachmentFile(hub, rel, { project, sourceRunId, blocklist, sources }) {
  const problems = [];
  const res = { ok: false, problems, piiHit: false, rel };
  if (typeof rel !== 'string' || !rel) return problems.push('no path'), res;
  if (isAbsolute(rel)) return problems.push(`path "${rel}" is absolute — plans carry hub-relative paths only`), res;
  if (rel.split(/[\\/]/).some((s) => s === '..' || s === '.' || s === '')) return problems.push(`path "${rel}" has a "..", "." or empty segment`), res;
  const dirRel = attachDirRel(project, sourceRunId);
  const abs = join(hub, rel);
  let st;
  try {
    st = lstatSync(abs);
  } catch {
    return problems.push(`${rel} does not exist`), res;
  }
  if (st.isSymbolicLink()) return problems.push(`${rel} is a symlink — refused`), res;
  if (!st.isFile()) return problems.push(`${rel} is not a regular file`), res;
  let realHub, realDir, realFile;
  try {
    realHub = realpathSync(hub);
    realDir = realpathSync(join(hub, dirRel));
    realFile = realpathSync(abs);
  } catch (e) {
    return problems.push(`${rel}: cannot resolve its real path (${e.code || e.message})`), res;
  }
  if (!realFile.startsWith(realDir + sep)) return problems.push(`${rel} resolves outside ${dirRel}/ (${realFile})`), res;
  if (relative(realHub, realFile) !== rel) return problems.push(`${rel} is not the canonical path of the file it names (${relative(realHub, realFile)})`), res;
  if (st.size === 0) return problems.push(`${rel} is empty (0 bytes)`), res;
  if (st.size > MAX_ATTACH_BYTES) return problems.push(`${rel} is ${st.size} bytes, over the ${MAX_ATTACH_BYTES}-byte limit`), res;
  const buf = readFileSync(abs);
  const sha = sha256Buf(buf);
  res.sha256 = sha;
  res.bytes = buf.length;
  const piiScans = [];
  const by = blockedBy(sha, blocklist);
  if (by) {
    piiScans.push(...by);
    problems.push(`${rel} matches a ${piiReason(by)} image (sha256 ${sha.slice(0, 12)}…) — never uploaded`);
  }
  const byPath = blocklist.flaggedBy?.get(rel);
  if (byPath) {
    piiScans.push(...byPath);
    problems.push(`${rel} is itself named by a flagged scan entry — ${piiReason(byPath)}`);
  }
  const src = sources?.get(rel);
  if (src && blocklist.flagged.includes(src)) {
    const bySrc = blocklist.flaggedBy?.get(src) || ['PII scan'];
    piiScans.push(...bySrc);
    problems.push(`${rel} is a copy of ${src}, which the PII scan flags — ${piiReason(bySrc)}`);
  }
  if (piiScans.length) {
    res.piiHit = true;
    res.piiScans = [...new Set(piiScans)];
  }
  const img = sniffImage(buf);
  if (!img) problems.push(`${rel} is not an image by its magic bytes (PNG/JPEG/GIF/WEBP)`);
  else if (!img.exts.includes(extname(rel).toLowerCase())) problems.push(`${rel}: extension "${extname(rel)}" does not match its content (${img.contentType})`);
  else res.contentType = img.contentType;
  res.buf = buf;
  res.ok = problems.length === 0;
  return res;
}

export const attachOpId = (issueKey, sha) => `att-${issueKey}-${sha.slice(0, 12)}`;
export const attachFilename = (rel) => basename(rel);
