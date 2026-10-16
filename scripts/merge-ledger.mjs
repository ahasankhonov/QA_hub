#!/usr/bin/env node
/**
 * merge-ledger.mjs — combine per-shard verifier ledgers into the run ledger.
 *
 * Large runs are verified in shards (one verifier agent per group of parts), each writing
 * `_LEDGER-<run>-G<n>.json`. The counts/summary/docx generators (R-11) all take a SINGLE
 * `--ledger`, so the shards must be merged before reporting. Doing that by hand means typing
 * ticket rows, which is precisely what R-11 forbids — hence this script.
 *
 * It is a pure concatenation with integrity checks. It NEVER edits a verdict, invents a ticket,
 * or reconciles a disagreement: if two shards claim the same ticket, that is a real problem
 * (two verifiers adjudicated the same work) and it is a hard error, not something to paper over.
 *
 * usage:
 *   node scripts/merge-ledger.mjs --out <merged.json> <shard.json> [shard.json ...]
 *   node scripts/merge-ledger.mjs --out <merged.json> --glob <dir> --run R4
 *
 * Verify the result with ledger-validate.mjs; this script deliberately does not re-implement
 * schema validation.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) flags[argv[i].slice(2)] = argv[++i];
  else positional.push(argv[i]);
}

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

if (!flags.out) fail('usage: merge-ledger.mjs --out <merged.json> <shard.json ...>  |  --glob <dir> --run <runId>');

let shardPaths = positional;
if (flags.glob) {
  if (!flags.run) fail('[merge-ledger] --glob requires --run so sibling runs are not swept in');
  // Match _LEDGER-<run>-G<n>.json only. The un-sharded _LEDGER-<run>.json is the OUTPUT of this
  // script; including it would double every ticket on a re-run.
  const pat = new RegExp(`^_LEDGER-${flags.run}-[A-Za-z0-9]+\\.json$`);
  shardPaths = readdirSync(flags.glob).filter((f) => pat.test(f)).sort().map((f) => join(flags.glob, f));
}
if (!shardPaths.length) fail('[merge-ledger] no shard ledgers given/found');

const shards = shardPaths.map((p) => {
  if (!existsSync(p)) fail(`[merge-ledger] missing shard: ${p}`);
  try {
    return { path: p, json: JSON.parse(readFileSync(p, 'utf8')) };
  } catch (e) {
    fail(`[merge-ledger] ${p} is not valid JSON: ${e.message}`);
  }
});

// Every shard must describe the SAME run on the SAME build. A build mismatch means one shard
// adjudicated a different deploy (R-06) and merging would silently mix them.
const head = shards[0].json;
for (const { path, json } of shards) {
  for (const k of ['schemaVersion', 'runId', 'project', 'build']) {
    if (JSON.stringify(json[k]) !== JSON.stringify(head[k])) {
      fail(
        `[merge-ledger] ${k} mismatch — ${shards[0].path} has ${JSON.stringify(head[k])}, ` +
          `${path} has ${JSON.stringify(json[k])}. Refusing to merge ledgers from different runs/builds (R-06).`,
      );
    }
  }
  if (!Array.isArray(json.tickets)) fail(`[merge-ledger] ${path} has no tickets[]`);
}

const tickets = [];
const seen = new Map();
for (const { path, json } of shards) {
  for (const t of json.tickets) {
    if (seen.has(t.id)) {
      fail(
        `[merge-ledger] ${t.id} appears in BOTH ${seen.get(t.id)} and ${path}. ` +
          `Two verifiers adjudicated the same ticket — resolve which verdict is authoritative before merging.`,
      );
    }
    seen.set(t.id, path);
    tickets.push(t);
  }
}

tickets.sort((a, b) => String(a.id).localeCompare(String(b.id), 'en', { numeric: true }));

// Top-level fields beyond the run identity used to come from the FIRST shard only, so a later
// shard's candidateBugs never reached linear-plan (R12, 2026-10-01: C1's 2 bugs were dropped
// silently). candidateBugs is now the union of every shard's list, each tagged with its source
// shard; every other per-shard top-level field is kept verbatim under shardMeta[path].
const IDENTITY = new Set(['schemaVersion', 'runId', 'project', 'build', 'tickets', 'candidateBugs', 'generatedAt']);
const candidateBugs = [];
const shardMeta = {};
for (const { path, json } of shards) {
  if (json.candidateBugs !== undefined && !Array.isArray(json.candidateBugs)) {
    fail(`[merge-ledger] ${path} has a non-array candidateBugs — refusing to guess its shape`);
  }
  for (const b of json.candidateBugs || []) candidateBugs.push({ ...b, sourceShard: path });
  const meta = {};
  for (const [k, v] of Object.entries(json)) if (!IDENTITY.has(k)) meta[k] = v;
  if (Object.keys(meta).length) shardMeta[path] = meta;
}

const merged = {
  schemaVersion: head.schemaVersion,
  runId: head.runId,
  project: head.project,
  build: head.build,
  tickets,
  candidateBugs,
  shardMeta,
};
merged.generatedAt = head.generatedAt;
merged.mergedFrom = shards.map((s) => s.path);

writeFileSync(flags.out, JSON.stringify(merged, null, 2) + '\n');
console.log(
  `[merge-ledger] ${shards.length} shard(s) → ${tickets.length} ticket(s), ${candidateBugs.length} candidate bug(s) → ${flags.out}\n` +
    shards.map((s) => `  ${s.json.tickets.length.toString().padStart(3)}  ${s.path}`).join('\n'),
);
