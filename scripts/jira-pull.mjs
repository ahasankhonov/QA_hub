#!/usr/bin/env node
// GET-only Jira pull for projects whose profile carries a `jira` block (beta / BET).
//
// Why a script and not the intake agent: the raw intake file is the ground truth that H-1
// (intake-assert.mjs) checks the emitted spec against, so it has to be a VERBATIM copy of what the
// tracker holds. Forty BET bug bodies are ~110 KB; copying that through a model's context is neither
// verbatim nor cheap — the MCP search already overflowed the tool limit once (2026-09-10).
//
// This script never performs a write call of any kind. Every Jira write stays on the MCP tools so the
// R-01 PreToolUse gate sees it (lib/tracker-ops.mjs). The API token is read from profile.jira.tokenFile
// and is never printed — errors carry the HTTP status and the first bytes of the body only.
//
//   node scripts/jira-pull.mjs --project beta --run R-20260910-RFQ [--jql "<override>"] [--out-dir <dir>] [--verbose]
//   node scripts/jira-pull.mjs --project beta --run R-20260910-RFQ --from <mcp-search-dump.json>
//
// --from converts a saved MCP `searchJiraIssuesUsingJql` result (the harness writes oversized tool results
// to disk verbatim; shape {issues:{nodes:[...],pageInfo}} — or a REST {issues:[...]} page) into the same
// two files, without touching the network or the token. Use it when the REST token is unavailable: the
// bytes still never pass through a model's context, so the raw file stays verbatim.
//
// Writes into projects/<slug>/qa-reports/ (R-03):
//   _INTAKE-<run>-raw.json  [{ id, title, updatedAt, createdAt, state, priority, issueType, assignee, labels,
//                              body, comments:[{author, body, createdAt, updatedAt}],
//                              attachments:[{filename, url, mimeType, size, createdAt}], links:[...], url }]
//   _LIVE-<run>.json        [{ id, title, updatedAt, state, priority }]   ← the shape run-plan.mjs reads
//
// REST v2 is used on purpose: v2 returns description/comment bodies as text (wiki markup), v3 returns
// ADF trees the intake agent would have to flatten (and could flatten differently from the raw file).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { HUB, args, fail, loadProfile, reportsDir } from '../lib/profile.mjs';

const { flags } = args();
if (!flags.project || !flags.run)
  fail('usage: jira-pull.mjs --project <slug> --run <runId> [--jql "<jql>"] [--out-dir <dir>] [--verbose] [--from <mcp-dump.json>]', 2);

const profile = loadProfile(flags.project);
const jira = profile.jira;
if (!jira || !jira.site || !jira.cloudId)
  fail(`[jira-pull] profiles/${flags.project}.json has no jira.site / jira.cloudId — this puller is for Jira-tracked projects only`, 2);

const jql = typeof flags.jql === 'string' ? flags.jql : jira.jql;
if (!jql) fail('[jira-pull] no JQL: set profile.jira.jql or pass --jql', 2);

const outDir =
  typeof flags['out-dir'] === 'string'
    ? isAbsolute(flags['out-dir']) ? flags['out-dir'] : join(HUB, flags['out-dir'])
    : reportsDir(flags.project);

// --- credentials (never printed) — only loaded for the REST path ---------------------------------
function loadAuthHeader() {
  if (!jira.tokenFile) fail('[jira-pull] profile.jira.tokenFile is not set', 2);
  const tokenPath = isAbsolute(jira.tokenFile) ? jira.tokenFile : join(HUB, jira.tokenFile);
  if (!existsSync(tokenPath)) fail(`[jira-pull] token file missing: ${jira.tokenFile}`, 2);
  const txt = readFileSync(tokenPath, 'utf8');
  const pick = (label) => {
    for (const raw of txt.split('\n')) {
      const line = raw.replace(/[*`]/g, '');
      const m = line.match(new RegExp(`^\\s*-?\\s*${label}\\s*:\\s*(\\S+)`, 'i'));
      if (m) return m[1];
    }
    return null;
  };
  const email = pick('Email');
  const token = pick('Token');
  if (!email || !token) fail('[jira-pull] could not parse the Email / Token lines of the token file (values are never printed)', 2);
  return 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');
}
const authHeader = flags.from ? null : loadAuthHeader();

// Basic auth is accepted on the site host; the api.atlassian.com gateway is the documented OAuth base and
// is kept as a fallback only. Try in order, stop at the first host that answers 2xx.
const site = String(jira.site).replace(/\/$/, '');
const BASES = [site, `https://api.atlassian.com/ex/jira/${jira.cloudId}`];

async function getJson(path, params) {
  let lastErr = null;
  for (const base of BASES) {
    const u = new URL(`${base}${path}`);
    for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
    let res;
    try {
      res = await fetch(u, { method: 'GET', headers: { Authorization: authHeader, Accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
    } catch (e) {
      lastErr = `${base}${path}: ${e.message}`;
      continue;
    }
    if (res.ok) {
      const json = await res.json();
      if (flags.verbose)
        console.error(`  [verbose] GET ${base}${path} ${JSON.stringify(Object.fromEntries(u.searchParams))} → ${res.status} keys=${Object.keys(json || {}).join(',')} issues=${json?.issues?.length ?? '-'} total=${json?.total ?? '-'} isLast=${json?.isLast ?? '-'}`);
      return { base, status: res.status, json };
    }
    const snippet = (await res.text()).replace(/\s+/g, ' ').slice(0, 200);
    lastErr = `${base}${path} → HTTP ${res.status} ${snippet}`;
    if (flags.verbose) console.error(`  [verbose] ${lastErr}`);
    // 404/410 = the endpoint itself is gone on this deployment → let the caller pick another endpoint.
    if (res.status === 404 || res.status === 410) return { base, status: res.status, json: null, error: lastErr };
    // 401/403/429/5xx → try the next base.
  }
  return { base: null, status: 0, json: null, error: lastErr || 'no base answered' };
}

const FIELDS = 'summary,status,priority,updated,created,description,comment,labels,attachment,issuelinks,assignee,issuetype';

async function searchAll() {
  // Preferred: the token-paginated /search/jql endpoint (the offset-paginated /search was deprecated in 2025).
  let issues = [];
  let nextPageToken;
  let endpoint = null;
  for (;;) {
    const r = await getJson('/rest/api/2/search/jql', { jql, fields: FIELDS, maxResults: 100, nextPageToken });
    if (r.error) {
      if (r.status === 404 || r.status === 410) { endpoint = null; break; }
      fail(`[jira-pull] search failed: ${r.error}`, 1);
    }
    endpoint = `${r.base}/rest/api/2/search/jql`;
    issues.push(...(r.json.issues || []));
    if (r.json.isLast !== false || !r.json.nextPageToken) break;
    nextPageToken = r.json.nextPageToken;
  }
  if (endpoint) return { issues, endpoint };

  // Legacy fallback.
  issues = [];
  let startAt = 0;
  for (;;) {
    const r = await getJson('/rest/api/2/search', { jql, fields: FIELDS, maxResults: 100, startAt });
    if (r.error) fail(`[jira-pull] search failed: ${r.error}`, 1);
    const page = r.json.issues || [];
    issues.push(...page);
    startAt += page.length;
    endpoint = `${r.base}/rest/api/2/search`;
    if (!page.length || startAt >= (r.json.total ?? 0)) break;
  }
  return { issues, endpoint };
}

async function allComments(issue) {
  const c = issue.fields?.comment;
  const have = c?.comments || [];
  if (!c || (c.total ?? have.length) <= have.length) return have;
  // The search payload truncates long comment threads — page the rest from the issue endpoint.
  const out = [];
  let startAt = 0;
  for (;;) {
    const r = await getJson(`/rest/api/2/issue/${issue.key}/comment`, { startAt, maxResults: 100, orderBy: 'created' });
    if (r.error) fail(`[jira-pull] comments for ${issue.key} failed: ${r.error}`, 1);
    const page = r.json.comments || [];
    out.push(...page);
    startAt += page.length;
    if (!page.length || startAt >= (r.json.total ?? 0)) break;
  }
  return out;
}

function mapIssue(it, comments) {
  const f = it.fields || {};
  const linked = (l) => l.outwardIssue || l.inwardIssue;
  return {
    id: it.key,
    title: f.summary ?? '',
    updatedAt: f.updated ?? null,
    createdAt: f.created ?? null,
    state: f.status?.name ?? null,
    priority: f.priority?.name ?? null,
    issueType: f.issuetype?.name ?? null,
    assignee: f.assignee?.displayName ?? null,
    labels: Array.isArray(f.labels) ? f.labels : [],
    body: f.description ?? null, // verbatim: a Jira issue with no description stays null (BET-34)
    comments: comments.map((c) => ({
      author: c.author?.displayName ?? null,
      body: c.body ?? '',
      createdAt: c.created ?? null,
      updatedAt: c.updated ?? null,
    })),
    attachments: (f.attachment || []).map((a) => ({
      filename: a.filename,
      url: a.content,
      mimeType: a.mimeType,
      size: a.size,
      createdAt: a.created,
    })),
    links: (f.issuelinks || []).map((l) => ({
      type: l.type?.name ?? null,
      relation: l.outwardIssue ? l.type?.outward : l.type?.inward,
      key: linked(l)?.key ?? null,
      state: linked(l)?.fields?.status?.name ?? null,
    })),
    url: `${site}/browse/${it.key}`,
  };
}

const keyNum = (k) => Number(String(k).split('-').pop()) || 0;

let issues, endpoint, source;
if (flags.from) {
  const fromPath = isAbsolute(flags.from) ? flags.from : join(process.cwd(), flags.from);
  if (!existsSync(fromPath)) fail(`[jira-pull] --from file missing: ${flags.from}`, 2);
  const dump = JSON.parse(readFileSync(fromPath, 'utf8'));
  issues = Array.isArray(dump) ? dump : Array.isArray(dump.issues) ? dump.issues : dump.issues?.nodes || [];
  if (dump.issues?.pageInfo?.hasNextPage) fail('[jira-pull] the MCP dump is only the first page (pageInfo.hasNextPage=true) — pull the rest before converting', 1);
  endpoint = `mcp dump ${fromPath}`;
  source = 'mcp-dump';
} else {
  ({ issues, endpoint } = await searchAll());
  source = 'rest';
}
if (!issues.length) fail(`[jira-pull] JQL matched no issues: ${jql}`, 1);

const raw = [];
for (const it of issues.sort((a, b) => keyNum(a.key) - keyNum(b.key))) {
  // A dump already carries every comment (comment.total is asserted below); REST pages the rest when truncated.
  const c = it.fields?.comment;
  if (flags.from && c && (c.total ?? 0) > (c.comments || []).length)
    fail(`[jira-pull] ${it.key}: dump holds ${(c.comments || []).length} of ${c.total} comments — a truncated raw file is not verbatim`, 1);
  raw.push(mapIssue(it, flags.from ? c?.comments || [] : await allComments(it)));
}

const live = raw.map(({ id, title, updatedAt, state, priority }) => ({ id, title, updatedAt, state, priority }));

mkdirSync(outDir, { recursive: true });
const rawPath = join(outDir, `_INTAKE-${flags.run}-raw.json`);
const livePath = join(outDir, `_LIVE-${flags.run}.json`);
writeFileSync(rawPath, JSON.stringify(raw, null, 2) + '\n');
writeFileSync(livePath, JSON.stringify(live, null, 2) + '\n');
const pullPath = join(outDir, `_PULL-${flags.run}.json`);
writeFileSync(
  pullPath,
  JSON.stringify(
    { run: flags.run, project: flags.project, source, endpoint: endpoint.replace(/^https?:\/\//, ''), jql, pulledAt: new Date().toISOString(), count: raw.length, keys: raw.map((t) => t.id) },
    null,
    2
  ) + '\n'
);

const states = {};
for (const t of raw) states[t.state] = (states[t.state] || 0) + 1;
const offQueue = jira.queueStatus ? raw.filter((t) => t.state !== jira.queueStatus).map((t) => `${t.id}(${t.state})`) : [];
const updated = raw.map((t) => t.updatedAt).filter(Boolean).sort();

console.log(`[jira-pull] ${raw.length} issue(s) via ${endpoint.replace(/^https?:\/\//, '')} (GET only)`);
console.log(`  jql:      ${jql}`);
console.log(`  states:   ${Object.entries(states).map(([s, n]) => `${s}=${n}`).join(' · ')}`);
console.log(`  updated:  ${updated[0] || '?'} … ${updated[updated.length - 1] || '?'}`);
console.log(`  comments: ${raw.reduce((n, t) => n + t.comments.length, 0)} · attachments: ${raw.reduce((n, t) => n + t.attachments.length, 0)} · body bytes: ${raw.reduce((n, t) => n + Buffer.byteLength(t.body || ''), 0)}`);
console.log(`  keys:     ${raw.map((t) => t.id).join(' ')}`);
if (offQueue.length) console.log(`  ⚠ not in "${jira.queueStatus}": ${offQueue.join(' ')}`);
console.log(`  raw  → ${rawPath}`);
console.log(`  live → ${livePath}`);
console.log(`  meta → ${pullPath}`);
