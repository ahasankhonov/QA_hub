#!/usr/bin/env node
// A finished run's RESULTS in its project's Slack channel, written for the developers and the PM who read it
// (the QA lead, 2026-10-16: "report results to slack for both EPS and gamma project via my bot, it should do it
// automatically"; then: "it is posting very small details, it should make the report as good as possible: repro
// steps, why bug? and scope, it needs also ask questions"). One thread per run:
//
//   parent      the run summary (run, build, date, ticket + case counts in short verdict words, "QA checks: all
//               passed" or "N passed, M skipped (…)", "tracker not changed") and "Details per ticket in the thread ↓"
//   per ticket  one reply per ticket, FAIL → PARTIAL:mixed → BLOCKED → PARTIAL:coverage-gap → other PARTIAL:
//               header (*ID · title* — verdict → proposed state, + severity; "PARTIAL (nothing could be tested this
//               round)" / "PARTIAL (all cases descoped)" when that is what happened), *Scope* (surface label or the
//               platforms of a bundle id, the build only when it differs from the parent's, counts, a *Passed (n)*
//               list with titles and "(fixed since the last round)", then what was not tested grouped by reason:
//               "Waiting on: …", "Not built yet: …", "Blocked by …", "Not in this round's re-test scope (last
//               result: PASS / FAIL / not tested in an earlier round either)", descoped cases apart), then every
//               failing case: id + title + "(new)" / "(still failing since an earlier round)" / "(regression)" when
//               the ticket has an earlier round, acceptance criterion, *Expected*, *Actual*, *Why it's a bug* ("same
//               cause as TC-x" when shared), numbered *Steps to reproduce*. PASS / PASS_SCOPE tickets share one
//               compact reply. A reply over 3,500 characters goes out as parts marked "(continued)".
//   questions   *Questions for the team*, numbered Qn, each addressed to the person it names: the run's recorded
//               open questions (ledger questions[], the ticket's scopeQuestion, the plan's scopeQuestions with
//               the "if …" / "is X a FAIL" / "The plan …" sentences taken out — a verdict is never re-asked) and
//               questions GENERATED from the not-tested cases, grouped by what is needed and merged across tickets
//               ("QA needs <x> to test these cases — when can QA have it?", "Please <x>." for a held case, one for a
//               case with no recorded reason). A need a recorded question already covers, a reason that cites a
//               recorded question ("see question Qn below"), a QA-side restriction, a deferred / descoped /
//               placeholder case and a hardware-only case ask nothing. The numbers are STABLE: state.qNumbers keeps
//               id → n across re-runs, a new question gets max+1, an answered one with a number shows as "~Qn~
//               answered" (answered: answered/answer/status on the question, or { "id", "status": "answered" } in
//               <reports-dir>/_QUESTIONS-ANSWERED.jsonl — the dry run prints Qn → id). The dry run reads the
//               numbers and writes nothing; --send saves them.
//
// Everything is GENERATED: counts by computeCounts / caseCounts (the numbers gen-counts prints), routing by
// route / stateFor, per-case detail by lib/case-detail.mjs (the functions gen-docx uses: the verifier's plain
// sidecar _PLAIN-<run>[-G<n>].json first, then the ledger, then the run's own _PLAN-<run>-<ticket>.json), titles
// from the run's intake. There is no --text, --channel, --message or --blocks flag. NEEDS-MANUAL items are left
// out entirely (R-02: never Slack — no reply, id, count or sentence); a needs-manual ticket id inside other text
// becomes "a related ticket", a needs-manual or hardware-only case id "another case" (hardware-only NOT_TESTED
// cases get no line and no question), and placeholder cases are not posted or counted.
//
// Leak guard, on every RAW source value (NFKC-normalised, \p{Cf} deleted, and again on a percent-decoded copy) and
// on every outgoing message:
//   · an email of a profile account becomes that account's role ("the administrator test account"); any other
//     email, a token or secret shape (JWT, Bearer, sk_/pk_/rk_ keys, xox*, AWS keys, long hex/base64, a ?token=
//     value), a value from profile.accounts/credentials (and a code-shaped token in an account note) or a
//     forbidden (production) host REFUSES the whole post (exit 1, nothing sent, what matched is never printed)
//   · a password in prose becomes "a test password", a phone number "a test phone number"
//   · internal paths and file names (/Users/…, harness/…, rules/…, *.png, *.json, *.md, *.mjs, *.log, generated
//     *.txt/*.csv, _RESULT…, qa-reports/, …_attachments) and QA-hub jargon (R-0x, run ids, question ids,
//     verifier/ledger/orchestrator, harness as a bare word; case-insensitive) are taken out of the sentence
//   · a link keeps origin + path (+ ?mode=); the fragment and every other query parameter go; a staging host from
//     profile.surfaces (not surfaces.forbidden) is kept; a ticket's own app host becomes its label ("Luna web
//     app", stderr names the failing cases whose steps lost it); any other host or link → "[host left out]" /
//     "[link left out]"; the outgoing check refuses a link with any other query parameter or a fragment
//   · ticket titles keep the old rule: a title with a host name, a path or a file name is dropped, the reply
//     goes without it
// Every text passes esc(), so "<!channel>" arrives as text.
//
//   node scripts/slack-report.mjs --project gamma --run R-20261015-RT1            # dry run: every message in full
//   node scripts/slack-report.mjs --project gamma --run R-20261015-RT1 --send     # gates, then post / edit / delete
//   node scripts/slack-report.mjs --project gamma --run R-20261015-RT1 --replies  # read people's thread replies
//
// --send runs `qa-gates.mjs --project --run --reports-dir` first and refuses on a failed gate. It refuses a profile
// without linear.stateMap (R-04) and a config entry without resultsAuthorizedBy/Quote/At. A project with no entry in
// .qa-slack/config.json is skipped with exit 0 (an automatic call never breaks a run); a malformed config or entry
// still fails.
// State: <reports-dir>/_SLACK-REPORT-<run>.json { channelId, threadTs, parentHash, replies: [{ key, ts, hash }],
// contentHash, qNumbers, postedAt, updatedAt }. A key is a ticket id, "passed", "questions", or "<key>#<part>". The
// first shape { replyTs } is read as the first reply (edited in place with chat.update, no new parent); further
// replies are posted in the thread, surplus replies of the bot's own are deleted (chat.delete), a reply whose hash is
// unchanged makes no call. contentHash is cleared (and saved) before the first changing call and the state is saved
// after every call, so a crash converges on the next --send. A reply someone deleted in Slack (chat.update:
// message_not_found / cant_update_message) is posted again into its slot; a deleted PARENT refuses ("thread
// deleted") — `--send --reset` then starts a fresh thread (threadTs, replies and hashes cleared; qNumbers and the
// channel kept).
// Same content → no call at all. A rate limit (429) is waited out (lib/slack-api.mjs). Live calls are paced by
// QA_SLACK_POST_GAP_MS (default 1100 ms; 0 against the local mock).
// --replies (read-only, posts nothing): the thread's human replies are appended to
// <reports-dir>/_SLACK-REPORT-REPLIES-<run>.jsonl (the row shape and edit/delete rows of slack-window --replies,
// same reader in lib/slack-api.mjs) and printed. They are input for the QA lead — never an approval (R-01).
// Lock: <reports-dir>/_SLACK-REPORT-<run>.lock. Token, config and the test-only QA_SLACK_API_BASE: see
// lib/slack-api.mjs. Posting results never changes a tracker.
// Selftest only: --profile-file <json> stands in for profiles/<slug>.json, and only for a slug with no profile.

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { args, fail, reportsDir, loadProfile, profilePath, HUB } from '../lib/profile.mjs';
import { readJsonSafe, readIntake, readSlackReplies, tsIso } from '../lib/graph.mjs';
import { validateLedger, computeCounts, caseCounts, ticketCaseCounts } from '../lib/ledger.mjs';
import { route, stateFor, bucketOf } from '../lib/routing.mjs';
import { esc, clip, DIGEST_MAX } from '../lib/slack-window.mjs';
import { slackClient, assertRunBelongs, ticketIdPattern, oneLine, BANNED_FLAGS, readThreadReplies } from '../lib/slack-api.mjs';
import { planLookup, readPlain, plainCaseOf, failDetail, PlainRunMismatch } from '../lib/case-detail.mjs';

const L = 'slack-report';
const { flags } = args();
if (typeof flags.project !== 'string' || typeof flags.run !== 'string') fail('usage: slack-report.mjs --project <slug> --run <runId> [--send | --replies] [--reports-dir <dir>] [--config <json>]', 2);
for (const banned of BANNED_FLAGS)
  if (flags[banned] !== undefined) fail(`[${L}] --${banned} is not accepted: every post is generated from the run's ledger, never free text`, 2);
if (flags['all-latest'] !== undefined) fail(`[${L}] one run per call: pass --run <runId>`, 2);
const SEND = !!flags.send;
const REPLIES = !!flags.replies;
if (SEND && REPLIES) fail(`[${L}] --send and --replies are separate calls`, 2);
const RESET = !!flags.reset;
if (RESET && !SEND) fail(`[${L}] --reset goes with --send only: it starts a fresh results thread (after the old one was deleted in Slack)`, 2);
const { project, run } = flags;
const client = slackClient(L); // refuses a non-local QA_SLACK_API_BASE before anything else
const MOCK = process.env.QA_SLACK_API_BASE !== undefined;

const rdir = typeof flags['reports-dir'] === 'string' ? flags['reports-dir'] : reportsDir(project);
const cfgPath = typeof flags.config === 'string' ? flags.config : join(HUB, '.qa-slack', 'config.json');

// ── config: an unconfigured project is skipped (exit 0); a malformed config fails ─────────────
const cfgAll = existsSync(cfgPath) ? readJsonSafe(cfgPath) : undefined;
if (cfgAll === null || (cfgAll && (typeof cfgAll.projects !== 'object' || cfgAll.projects === null || Array.isArray(cfgAll.projects))))
  fail(`[${L}] ${cfgPath} is malformed — it needs { "projects": { "<slug>": { "channelId": … } } }`, 1);
// only an ABSENT key means "not configured"; a key that is present but null/""/false/a bare string is broken
const hasEntry = !!cfgAll && Object.hasOwn(cfgAll.projects, project);
const entry = hasEntry ? cfgAll.projects[project] : undefined;
if (hasEntry && (typeof entry !== 'object' || entry === null || Array.isArray(entry)))
  fail(`[${L}] ${cfgPath}: malformed entry for ${project} — it must be an object { "channelId": …, "resultsAuthorizedQuote": … }`, 1);
const configured = hasEntry;
if ((SEND || REPLIES) && !configured) {
  console.log(`[${L}] no Slack channel configured for ${project} — ${REPLIES ? 'nothing to read' : 'skipped'}`);
  process.exit(0);
}

// ── profile, ledger (the merged one only), validation, ownership ─────────────────────────────
let profile;
if (existsSync(profilePath(project))) {
  if (flags['profile-file'] !== undefined) fail(`[${L}] --profile-file is for the selftest only: ${project} has a real profile`, 2);
  profile = loadProfile(project);
} else if (typeof flags['profile-file'] === 'string') {
  profile = readJsonSafe(flags['profile-file']);
  if (!profile) fail(`[${L}] --profile-file ${flags['profile-file']} is not readable JSON`, 1);
} else fail(`[${L}] no profile for "${project}" at ${profilePath(project)}`, 1);

const ledgerPath = join(rdir, `_LEDGER-${run}.json`);
if (!existsSync(ledgerPath)) {
  const shards = existsSync(rdir) ? readdirSync(rdir).filter((n) => n.startsWith(`_LEDGER-${run}-`) && n.endsWith('.json')) : [];
  fail(shards.length
    ? `[${L}] ${run} has only shard ledgers (${shards.join(', ')}) — merge them first (scripts/merge-ledger.mjs --run ${run} …); shard counts are never added up`
    : `[${L}] no ledger at ${ledgerPath}`, 1);
}
const ledger = readJsonSafe(ledgerPath);
if (!ledger) fail(`[${L}] ${ledgerPath} is not valid JSON`, 1);
if (ledger.shard) fail(`[${L}] ${ledgerPath} is a shard (shard: ${String(ledger.shard)}) — post the merged run ledger only`, 1);
if (ledger.runId && ledger.runId !== run) fail(`[${L}] ${ledgerPath} is for run ${ledger.runId}, not ${run}`, 1);
const { errors } = validateLedger(ledger, { profile, currentBuildId: ledger.build?.buildId });
if (errors.length) fail(`[${L}] refusing to report an invalid ledger (${errors.length} error(s); run scripts/ledger-validate.mjs for the list) — nothing is posted from a broken run`, 1);
const prefix = assertRunBelongs({ label: L, project, ledger, profile, ids: (ledger.tickets || []).map((t) => t.id || t.identifier) });
if (!prefix) fail(`[${L}] profile ${project} has no ticket prefix (linear.prefix / tracker.ticketPrefix) — cannot prove the run is this project's`, 1);

const statePath = join(rdir, `_SLACK-REPORT-${run}.json`);
const lockPath = join(rdir, `_SLACK-REPORT-${run}.lock`);
const busy = (pid) => `another slack-report (pid ${pid}) is posting or reading this run's report — wait for it to finish`;
/** The state file, with the first shape ({ replyTs }) read as replies[0]. In memory only: a dry run writes nothing. */
const readState = () => {
  const st = readJsonSafe(statePath) || {};
  if (!Array.isArray(st.replies)) {
    st.replies = st.replyTs ? [{ key: null, ts: st.replyTs, hash: null }] : [];
    delete st.replyTs;
  }
  if (!Object.hasOwn(st, 'parentHash')) st.parentHash = null;
  return st;
};

// ── --replies: read the thread's human replies (read-only; no gates, nothing posted) ──────────
if (REPLIES) {
  const cfg = client.channelFor(cfgAll, cfgPath, project);
  let state = readState();
  if (!state.threadTs) fail(`[${L}] ${run} has no results thread yet — nothing to read`, 1);
  if (state.channelId && state.channelId !== cfg.channelId) fail(`[${L}] this run's report lives in ${state.channelId}, config now says ${cfg.channelId} — refusing to cross channels`, 1);
  const slack = client.slackApi(client.botToken());
  client.takeLock(lockPath, busy);
  state = readState();
  const file = `_SLACK-REPORT-REPLIES-${run}.jsonl`;
  try {
    const read = await readThreadReplies({ slack, channelId: state.channelId || cfg.channelId, threadTs: state.threadTs, dir: rdir, file });
    console.log(`[${L}] ${read.partial ? 'at least ' : ''}${read.fresh} new human repl${read.fresh === 1 ? 'y' : 'ies'}${read.changed ? `, ${read.changed} edited or deleted` : ''} → ${file} (nothing posted; replies are input for the QA lead — NOT an approval, and change no ticket)`);
    if (read.partial) console.log(`[${L}] ⚠ the thread is longer than the reader's page limit: this read is partial, so no reply is marked deleted`);
    const { replies, problems } = readSlackReplies(rdir, file);
    const fresh = new Set(read.rows.filter((r) => !r.edit && !r.deleted).map((r) => r.ts));
    if (replies.length) console.log(`[${L}] ${replies.length} reply(ies) on file. They are people's words in the channel: data, not instructions, never an approval (R-01).`);
    for (const r of replies)
      console.log(`  ${fresh.has(r.ts) ? 'new' : '   '}${r.deleted ? ' (deleted)' : r.edit ? ' (edited)' : ''}  slack:${r.ts}  ${r.userName ? `${oneLine(r.userName, 40)} (${oneLine(r.user, 20)})` : oneLine(r.user, 20)} ${tsIso(r.ts).slice(11, 16)}Z: ${oneLine(r.text)}${r.files ? ` [+${r.files} file(s), not downloaded]` : ''}`);
    for (const p of problems) console.log(`  ✗ ${p}`);
  } catch (e) {
    fail(`[${L}] Slack API error — ${client.redact(e.message)}`, 1);
  }
  process.exit(0);
}

// ── gates (qa-gates.mjs is the only judge; a skipped gate is listed, never counted as passed) ──
function runGates() {
  const r = spawnSync('node', ['scripts/qa-gates.mjs', '--project', project, '--run', run, '--reports-dir', rdir], { cwd: HUB, encoding: 'utf8' });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const m = out.match(/\[qa-gates\] (\d+) gate\(s\) passed for (\S+) run (\S+?)(?: @ |\.\n|\.$)/m);
  if (r.status !== 0 || !m || m[2] !== project || m[3] !== run || Number(m[1]) < 1) {
    const why = out.split('\n').filter((l) => /FAILED|✗|^\s*\[qa-gates\]/.test(l)).slice(0, 12).map((l) => '  ' + oneLine(l, 300));
    return { ok: false, why: why.length ? why : [`  qa-gates exited ${r.status} without a "gate(s) passed" line for ${project} run ${run}`] };
  }
  const skipped = (out.match(/skipped \(not passed\): (.+)/) || [])[1]?.split(' · ').map((s) => s.trim()).filter(Boolean) || [];
  return { ok: true, passed: Number(m[1]), skipped };
}
const gates = runGates();
if (!gates.ok) {
  console.error(`[${L}] the gates FAILED for ${project} run ${run} — nothing ${SEND ? 'was' : 'would be'} posted:`);
  for (const l of gates.why) console.error(l);
  process.exit(1);
}

// ── what is posted ────────────────────────────────────────────────────────────────────────
// R-02: a NEEDS-MANUAL item is "never Slack" — it is for the QA lead only. NEEDS_MANUAL tickets are left out
// of the post entirely (no reply, no id, no count), and so are NEEDS_MANUAL cases inside other tickets. Every
// number below is computeCounts/caseCounts over the posted tickets, so the parent and the replies always agree.
const stateMapRaw = profile?.linear?.stateMap;
const stateMap = stateMapRaw || {};
if (!stateMapRaw) {
  const msg = `[${L}] ${project} has no linear.stateMap — proposed states would be DEFAULT names, not this board's (R-04)`;
  if (SEND) fail(`${msg}; refusing to post them. Add linear.stateMap to the profile.`, 1);
  console.error(`${msg}; --send will refuse.`);
}
const norm = (s) => String(s ?? '').normalize('NFKC').replace(/\p{Cf}+/gu, '');
const squash = (s) => norm(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const reEsc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// R-02 hardware: a NOT_TESTED case that needs SMS, a real device, camera, mic, GPS, biometrics, NFC, push on
// hardware, a CAPTCHA or a manual OAuth is the needs-manual kind — left out like a NEEDS_MANUAL case (no line,
// no question). A placeholder case ("so the ticket carries an auditable case") is not a test: left out too.
const HARDWARE_RE = /\b(?:SMS|real (?:device|handset|phone)|handsets?|physical device|camera|microphone|mic|GPS|biometrics?|Face ?ID|Touch ?ID|fingerprint|NFC|push (?:notifications? )?on (?:a )?(?:real )?(?:hardware|device)|CAPTCHA|manual OAuth)\b/i;
const isHardware = (c) => c?.verdict === 'NOT_TESTED' && HARDWARE_RE.test(norm(`${c.notTestedReason || ''} ${c.blockedOn || ''} ${c.note || ''} ${c.reason || ''}`));
const isPlaceholder = (c) => c?.verdict === 'NOT_TESTED' && /^\s*Placeholder\b/i.test(norm(c.note || c.reason || ''));
const manualIds = (ledger.tickets || []).filter((t) => t.verdict === 'NEEDS_MANUAL').map((t) => String(t.id || t.identifier));
/** ticket id → the ids of its cases that are left out (needs-manual / hardware), as written and without "<ticket>/" */
const hiddenCases = new Map();
const posted = (ledger.tickets || []).filter((t) => t.verdict !== 'NEEDS_MANUAL').map((t) => {
  const hide = new Set();
  const keep = [];
  for (const c of t.cases || []) {
    if (c?.verdict === 'NEEDS_MANUAL' || isHardware(c)) { if (c?.caseId) hide.add(String(c.caseId)); continue; }
    if (isPlaceholder(c)) continue;
    keep.push(c);
  }
  if (hide.size) hiddenCases.set(String(t.id), hide);
  return { ...t, cases: keep };
});
const postedLedger = { ...ledger, tickets: posted };
const counts = computeCounts(postedLedger, { stateMap });
const cases = caseCounts(postedLedger);
const own = ticketIdPattern(prefix);

// titles: the canonical _INTAKE-<run>.json first, then the run's other intake files; a plan's title last
const titles = new Map();
const addTitles = (list) => { for (const t of list) { const id = t?.id || t?.identifier; if (typeof id === 'string' && typeof t.title === 'string' && t.title.trim() && !titles.has(id)) titles.set(id, t.title); } };
try {
  const canon = readJsonSafe(join(rdir, `_INTAKE-${run}.json`));
  addTitles(Array.isArray(canon) ? canon : Array.isArray(canon?.tickets) ? canon.tickets : []);
  addTitles(readIntake(rdir, run));
} catch (e) { console.error(`[${L}] could not read the intake titles (${oneLine(e.message, 200)}) — tickets go out without titles`); }
const titleOf = (id) => {
  if (titles.has(id)) return titles.get(id);
  if (!own.test(String(id))) return ''; // never a path built from a malformed id
  const p = resolve(rdir, `_PLAN-${run}-${id}.json`);
  if (dirname(p) !== resolve(rdir)) return '';
  const t = readJsonSafe(p)?.title;
  return typeof t === 'string' ? t : '';
};

// per-case detail: the same plan / plain lookups gen-docx uses, but only this run's own plans, and the
// plain sidecar with its -G<n> shards merged (the sharded Gamma layout keeps them per group)
const plans = planLookup(rdir, { planRun: run });
let PLAIN;
try { PLAIN = readPlain(rdir, run, { shards: true }); } catch (e) {
  if (e instanceof PlainRunMismatch) fail(`[${L}] ${e.message}`, 1);
  fail(`[${L}] the plain-language sidecar of ${run} is not valid JSON (${oneLine(e.message, 200)})`, 1);
}
const plainCase = plainCaseOf(PLAIN);

// ── leak guard ─────────────────────────────────────────────────────────────────────────────
// Normalised first: NFKC folds fullwidth "＠"/"．", and \p{Cf} (soft hyphen, zero-width, bidi) is DELETED, not
// turned into a space. Account values are matched whole and as tokens, and also with every non-alphanumeric
// character squashed out, so "Hunter2-SEL­pw-7731" still matches "Hunter2-SEL-pw-7731".
// Only secret-bearing values: role names, tiers, notes and hosts under accounts are not secrets (Gamma lists
// roles such as "viewer" that real ticket titles name). An unknown key counts as secret-bearing.
const NON_SECRET_KEY = /^(roles?|tiers?|notes?|\w*Note|hosts?|label|description)$/i;
const EMAIL_G = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}/gu;
const accountValues = new Set();
const addSecret = (v) => {
  const whole = norm(v).trim();
  if (whole.length >= 4) accountValues.add(whole);
  // a combined value ("ops@example.com / Sup3rS3cretZ9", a prose value with a password in it): each token of 6+
  // characters that carries a digit, an "@" or a symbol is matched on its own; plain words ("Decipher") are not
  for (const tok of whole.split(/[\s/:,;|()]+/)) {
    const t = tok.replace(/^[.'"`-]+|[.'"`-]+$/g, '');
    if (t.length >= 6 && /[\d@]|[^A-Za-z.'-]/.test(t)) accountValues.add(t);
  }
};
// a note under accounts is prose, not a secret — except a code-shaped token in it ("temp code Zq7!xT9-mm"):
// 8+ characters with a letter, a digit and a symbol, that is not a host, a file, a run id, a date or a ticket id
const noteTokens = (v) => {
  for (const tok of norm(v).split(/[\s,;()]+/)) {
    const t = tok.replace(/^[.'"`:,;!?]+|[.'"`:,;]+$/g, '');
    if (t.length < 8 || !/\p{L}/u.test(t) || !/\d/.test(t) || !/[^\p{L}\p{N}]/u.test(t)) continue;
    if (/[@/]|https?:/i.test(t) || /^[\w.-]+\.[a-z]{2,5}$/i.test(t) || /^R-\d{8}/.test(t) || /^\d{4}-\d{2}-\d{2}/.test(t) || /^[A-Z]{2,}-\d+/.test(t)) continue;
    accountValues.add(t);
  }
};
(function walk(v, inside, key) {
  if (inside && key && /note/i.test(key)) {
    const each = (x) => (typeof x === 'string' ? noteTokens(x) : Array.isArray(x) ? x.forEach(each) : x && typeof x === 'object' ? Object.values(x).forEach(each) : null);
    return each(v);
  }
  if (inside && key && NON_SECRET_KEY.test(key)) return;
  if (typeof v === 'string') { if (inside) addSecret(v); return; }
  if (typeof v === 'number' && inside) { addSecret(String(v)); return; }
  if (Array.isArray(v)) return v.forEach((x) => walk(x, inside, null));
  if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, inside || /^(accounts|credentials)$/i.test(k), k);
})(profile, false, null);
const secrets = [...accountValues].map((v) => ({ low: v.toLowerCase(), sq: squash(v) }));

// account emails → the account's role ("the administrator test account"); a +alias tag with a digit in it
// (it names the account on its own, e.g. in "signed in as <tag>") is replaced the same way
const accountLabels = [];
(function walkAccounts(v, key, holder) {
  if (typeof v === 'string') {
    for (const m of norm(v).matchAll(EMAIL_G)) {
      const role = holder && !Array.isArray(holder) && (holder.role || holder.tier || holder.label);
      const label = `the ${typeof role === 'string' && role.trim() ? role.trim() : key || 'test'} test account`;
      accountLabels.push({ re: new RegExp(reEsc(m[0]), 'giu'), label });
      const tag = (m[0].split('@')[0].split('+')[1] || '').trim();
      if (tag.length >= 4 && /\d/.test(tag)) accountLabels.push({ re: new RegExp(`(?<![\\p{L}\\p{N}])${reEsc(tag)}(?![\\p{L}\\p{N}])`, 'giu'), label });
    }
    return;
  }
  if (Array.isArray(v)) return v.forEach((x) => walkAccounts(x, key, holder));
  if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walkAccounts(x, x && typeof x === 'object' ? k : key, x && typeof x === 'object' ? x : v);
})(profile?.accounts ?? {}, null, null);
// emails first, longest first, so "a+b@x" is never half-replaced by "b@x"
accountLabels.sort((a, b) => b.re.source.length - a.re.source.length);
// a fresh "+alias" of an account's own mailbox (a sign-up made during the run) is the same QA inbox: it is
// described, never posted; any other address still refuses
const mailboxOf = (e) => { const [local, domain] = String(e).toLowerCase().split('@'); return `${local.split('+')[0]}@${domain}`; };
const accountMailboxes = new Set();
(function walkMail(v) {
  if (typeof v === 'string') { for (const m of norm(v).matchAll(EMAIL_G)) accountMailboxes.add(mailboxOf(m[0])); return; }
  if (Array.isArray(v)) return v.forEach(walkMail);
  if (v && typeof v === 'object') Object.values(v).forEach(walkMail);
})(profile?.accounts ?? {});
const aliasOfAccount = (s) => s.replace(EMAIL_G, (e) => (e.includes('+') && accountMailboxes.has(mailboxOf(e)) ? 'a new test sign-up address' : e));

// hosts: the profile's staging surfaces are allowed in steps and links; surfaces.forbidden is production
const hostsIn = (s) => [...String(s).matchAll(/(?:[a-z0-9-]+\.)+[a-z]{2,}/gi)].map((m) => m[0].toLowerCase());
const allowedHosts = new Set();
const forbiddenHosts = new Set();
(function walkHosts(v, key, bad) {
  if (key && /Note$|^allowedPatterns$/i.test(key)) return;
  const isBad = bad || /^forbidden$/i.test(key || '');
  if (typeof v === 'string') { for (const h of hostsIn(v)) (isBad ? forbiddenHosts : allowedHosts).add(h); return; }
  if (Array.isArray(v)) return v.forEach((x) => walkHosts(x, null, isBad));
  if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walkHosts(x, k, isBad);
})(profile?.surfaces, null, false);
for (const h of forbiddenHosts) allowedHosts.delete(h);
const isForbidden = (h) => [...forbiddenHosts].some((f) => h === f || h.endsWith(`.${f}`));
const isAllowed = (h) => !isForbidden(h) && allowedHosts.has(h);
const TLD = 'com|net|org|io|app|dev|uz|ai|co|me|us|uk|ru|de|info|biz|xyz|site|online|cloud|tech|example|local|test|internal|so|gg|ly|sh|link|page|run|cc|tv|to';
const BARE_HOST = new RegExp(`(?:^|[^\\p{L}\\p{N}@._-])(?:[a-z0-9-]+\\.)+(?:${TLD})(?![\\p{L}\\p{N}-])`, 'iu');
const BARE_HOST_G = new RegExp(`(?<![\\p{L}\\p{N}@._/-])(?:[a-z0-9-]+\\.)+(?:${TLD})(?![\\p{L}\\p{N}-])`, 'giu');
const URL_G = /\b(?:https?:\/\/|www\.)[^\s<>()"'`\]]+/giu;
const hostOfUrl = (u) => { try { return new URL(/^www\./i.test(u) ? `https://${u}` : u).hostname.toLowerCase(); } catch { return ''; } };
const ABS_PATH = /(?:^|[\s=(:'"`])(?:~\/|\/(?:Users|private|tmp|home|var|etc|Volumes|opt|root|mnt)\/)/;
const INTERNAL_NAMES = 'RESULT|LEDGER|INTAKE|PLAN|PLAIN|VERIFY|VERDICT-NOTES|BUILD|PROBE|RUN-PLAN|SESSION-STATE|HISTORY|NEEDS-MANUAL|LIVE|DELTA|FIXTURES|SLACK|GRAPH|BRAIN-RECALL|LINEAR-PLAN|ASANA-PLAN|TESTPLAN|SUMMARY';
// a file name: data/recording files always; an image only when its name looks generated (a digit, "_", "@",
// "+" or a dot in it: "EPS-3_TC-3.4.png"), so a repro step's "a PDF renamed to photo.jpg" or ".jpg" survives
// (.md/.mjs/.cjs/.log are the hub's own files and always internal; .txt/.csv only when generated-looking)
const FILE_G = /[\w@+.-]*[\w@+-]\.(png|jpe?g|gif|webp|jsonl?|docx|webm|mp4|har|md|mjs|cjs|log|txt|csv)\b/gi;
const isInternalFile = (name, ext) => !/^(?:png|jpe?g|gif|webp|txt|csv)$/i.test(ext) || /[\d_@+.]/.test(name.slice(0, -(ext.length + 1)));
const hasInternalFile = (s) => [...String(s).matchAll(FILE_G)].some((m) => isInternalFile(m[0], m[1]));
const INTERNAL_FILE_RE = new RegExp(`(?<![\\w])_(?:${INTERNAL_NAMES})\\b|qa-reports\\/|_attachments\\b`, 'i');
const INTERNAL_FILE = { test: (s) => INTERNAL_FILE_RE.test(s) || hasInternalFile(s) };
const NEEDS_MANUAL_RE = /needs?[\s_-]*manual/i;
const manualIdRe = manualIds.length ? new RegExp(`(?<![\\p{L}\\p{N}-])(?:${manualIds.map(reEsc).join('|')})(?![\\p{N}])`, 'giu') : null;

// hard: refuse the whole post. soft (titles only): the title is left out, the reply stays
// token and secret shapes: a JWT, a bearer token, Stripe secret/restricted/publishable keys (a Checkout session id
// cs_test_… is NOT a secret and does not match), an AWS access key id, Slack tokens, GitHub tokens, and any
// "token=… / password: …" assignment. Run after links are reduced to origin + path, so a "?token=" link is stripped,
// not refused.
const SECRET_SHAPES = [
  /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/,
  /\bBearer\s+[\w.~+/-]{16,}/i,
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bx(?:ox[a-z]|app)-/i,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\b(?:token|secret|api[_-]?key|access[_-]?key|client[_-]?secret|password|passwd|pwd)\s*=\s*["']?[^\s"'&<>]{6,}/i,
];
/** a copy with every %XX run decoded, so an encoded address or secret in a path is seen too */
const safeDecode = (s) => String(s).replace(/(?:%[0-9A-Fa-f]{2})+/g, (m) => { try { return decodeURIComponent(m); } catch { return m; } });
const HARD = [
  ['a token or secret', (s) => SECRET_SHAPES.some((r) => r.test(s))],
  ['an email address', (s) => /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.[\p{L}]{2,}/u.test(s) || /[\p{L}\p{N}._%+-]+@\p{L}[\p{L}\p{N}-]*\.\p{L}/u.test(s)],
  ['a value from the profile\'s accounts/credentials', (s) => { const low = s.toLowerCase(); const sq = squash(s); return secrets.some((v) => low.includes(v.low) || (v.sq.length >= 6 && sq.includes(v.sq))); }],
  ['a forbidden (production) host', (s) => hostsIn(s).some(isForbidden)],
];
const OWN_HOST = ['one of the project\'s own hosts', (s) => { const low = s.toLowerCase(); return [...allowedHosts, ...forbiddenHosts].some((h) => low.includes(h)); }];
const PATH = ['a file path', (s) => ABS_PATH.test(s)];
const SOFT = [['a host name', (s) => BARE_HOST.test(s)], OWN_HOST, PATH, ['an internal file name', (s) => INTERNAL_FILE.test(s)]];
const hardLeaks = [];
const hits = (tests, raw) => { const s = norm(raw); return tests.filter(([, test]) => test(s)).map(([kind]) => kind); };
const guardHard = (where, raw) => {
  const s = norm(raw);
  const d = safeDecode(s);
  for (const k of new Set([...hits(HARD, s), ...(d !== s ? hits(HARD, d) : [])])) hardLeaks.push(`${where}: ${k}`);
};
const dropped = new Set();
const leftOut = new Set();
// R-02: the id of a needs-manual / hardware case that was left out is never named either — it reads "another case"
// (the short form "TC-MT21" only inside its own ticket's text; a long form "EPS-94/TC-30.3" anywhere)
const caseIdRe = (ids) => (ids.length ? new RegExp(`(?<![\\p{L}\\p{N}/.-])(?:${[...ids].sort((a, b) => b.length - a.length).map(reEsc).join('|')})(?![\\p{L}\\p{N}]|[.-][\\p{L}\\p{N}])`, 'gu') : null);
const hiddenLong = [];
const hiddenShortRe = new Map();
for (const [tid, set] of hiddenCases) {
  const short = new Set();
  for (const id of set) {
    if (id.includes('/') || id.startsWith(`${tid}-`)) hiddenLong.push(id);
    const sh = id.startsWith(`${tid}/`) ? id.slice(tid.length + 1) : id;
    short.add(sh);
    // the long forms another ticket's text uses: "SEL-5/TC-8", "SEL-5 TC-8"
    if (!sh.startsWith(`${tid}-`)) hiddenLong.push(`${tid}/${sh}`, `${tid} ${sh}`);
  }
  hiddenShortRe.set(tid, caseIdRe([...short]));
}
const hiddenLongRe = caseIdRe(hiddenLong);
const TICKET_IN = new RegExp(`\\b${reEsc(prefix)}-\\d+\\b`);
const ticketOfWhere = (where) => (String(where).match(TICKET_IN) || [''])[0];

// a ticket's own surface host that is not listed for posting (EPS: luna.cachevibes.com with no profile surfaces)
// is named by a derived label ("the Luna web app") instead of "[host left out]"; its link is never posted
const GENERIC_DNS = /^(?:www|app|apps|api|staging|stage|dev|web|m|test|qa)$/i;
const surfaceLabel = (h) => { const p = h.split('.').find((x) => !GENERIC_DNS.test(x)) || h.split('.')[0]; return `${p.charAt(0).toUpperCase()}${p.slice(1)} web app`; };
const surfaceHostOf = new Map();
for (const t of posted) {
  const h = hostsIn(String(t.surface || '')).find((x) => BARE_HOST.test(` ${x}`));
  if (h && !isAllowed(h) && !isForbidden(h)) surfaceHostOf.set(String(t.id), { host: h, label: surfaceLabel(h) });
}
const ARTICLE_BEFORE = /\b(?:the|a|an|this|that|its|their|our|your)\s+(?:[\w-]+\s+){0,2}$/i;
const labelAt = (label, before) => (ARTICLE_BEFORE.test(before) ? label : `the ${label}`);
const stepsLostHost = new Set(); // failing cases whose steps name the web app without its link (stderr)
const lostHost = (where) => {
  leftOut.add(`the web app's link in ${where}`);
  // "the steps of EPS-94 EPS-94/TC-30.1" → "EPS-94 TC-30.1"
  if (/^the steps of /.test(where)) stepsLostHost.add(where.slice('the steps of '.length).replace(/^(\S+) \1\//, '$1 '));
};

// cited questions: a recorded question id that is posted becomes "(see question Qn below)"; any other question id
// is taken out with its context ("per Q-REFUND:", "Q-UB1-EDIT (the backend dev):", "+ the client QA SQ-3"). Placeholders are
// private-use characters (they survive oneLine/esc) resolved once the questions are numbered.
const postedQ = new Set(); // full ids of the recorded questions that are posted — filled before any devText call
const citeIds = [];
const cite = (id) => { let i = citeIds.indexOf(id); if (i < 0) { citeIds.push(id); i = citeIds.length - 1; } return `\uE000${i}\uE001`; };
const CITE_G = /\uE000\d+\uE001/g;
const CITE_1 = /\uE000\d+\uE001/;
const clipQ = (s, n) => { const tags = (String(s).match(CITE_G) || []).join(''); return clip(String(s).replace(CITE_G, '').trimEnd(), n) + tags; };
const endTrim = (s) => String(s).replace(/[.\s]+((?:\uE000\d+\uE001)*)$/, '$1');
const lookupQ = (tid, id) => {
  if (tid && postedQ.has(`${tid}/${id}`)) return `${tid}/${id}`;
  if (/^Q\d+$/.test(id)) return null; // a bare "Q9" only inside its own ticket (it may be a survey question elsewhere)
  const m = [...postedQ].filter((k) => k.endsWith(`/${id}`));
  return m.length === 1 ? m[0] : null;
};
const Q_CTX_G = /(?:\s*[+&]\s*[A-Z][a-z]+\s+|\s*\b(?:per|see|in)\s+)?\b((?:Q|SQ)\d*-[A-Z0-9][A-Z0-9-]*\b|Q\d+(?![''\w]))(?:\s*\([^()]{1,40}\))?\s*:?/g;
function citeQuestions(s, tid) {
  const found = [];
  let t = s.replace(/\s*\(\s*(?:see\s+)?(?:the\s+)?question(?:\s+(?:to|for)\s+[^()]{1,40}?)?\s+in\s+(?:the\s+)?scopeQuestion\s*\)/gi, () => { if (postedQ.has(`${tid}/scope`)) found.push(`${tid}/scope`); return ''; });
  t = t.replace(Q_CTX_G, (m, id) => {
    const full = lookupQ(tid, id);
    if (!full) return /^Q\d+$/.test(id) ? m : ' ';
    found.push(full);
    return ' ';
  });
  return found.length ? `${t.trimEnd()}${[...new Set(found)].map(cite).join('')}` : t;
}

// links: origin + path only (and ?mode=), never a query or a fragment — a "?token=" link is stripped, not posted
const cleanUrl = (u) => {
  const www = /^www\./i.test(u);
  try {
    const x = new URL(www ? `https://${u}` : u);
    const mode = x.searchParams.get('mode');
    const hadPath = u.split(/[?#]/)[0].replace(/^[a-z][\w+.-]*:\/\//i, '').includes('/');
    const out = `${x.origin}${x.pathname === '/' && !hadPath ? '' : x.pathname}${mode !== null ? `?mode=${encodeURIComponent(mode)}` : ''}`;
    return www ? out.replace(/^https:\/\//, '') : out;
  } catch { return u.split(/[?#]/)[0]; }
};
const sanitizeUrls = (s) => s.replace(URL_G, (m) => { const trail = (m.match(/[.,;:!?]+$/) || [''])[0]; return cleanUrl(trail ? m.slice(0, -trail.length) : m) + trail; });
// a password or a phone number written in prose is described, never posted (an account's own values still refuse)
const PW_RE = /\b(?:password|passcode|passwd|pwd|pw)\b(?:\s*(?:is|was|=|:)\s*|\s+)["'`]?([A-Za-z0-9][^\s"'`,;()]{2,}[^\s"'`,;().!?:])["'`]?/gi;
// "logged in with password X" → "logged in with a test password"; "the password is X" → "the password is [not posted]"
const maskPw = (s) => s.replace(PW_RE, (m, tok) => (!/\d|[^A-Za-z]/.test(tok) ? m : /\b(?:is|was)\s|[=:]/.test(m.slice(0, m.indexOf(tok))) ? `${m.slice(0, m.indexOf(tok)).replace(/["'`]$/, '')}[not posted]` : 'a test password')).replace(/\b(?:the|a|an|their|its|this)\s+a test password\b/gi, 'a test password');
const PHONE_RES = [/(?<![\w+-])\+\d[\d\s().-]{8,16}\d(?![\w-])/g, /(?<![\w-])\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}(?![\w-])/g];
const maskPhones = (s) => PHONE_RES.reduce((x, r) => x.replace(r, 'a test phone number'), s);

// QA-hub words a developer does not need: run ids, rule ids, question ids, the agents' names (case-insensitive,
// except the question-id shapes, which are upper-case by construction)
const priorTags = new Set();
for (const t of ledger.tickets || []) for (const c of t.cases || []) for (const r of [c?.priorRun, c?.runId]) {
  const tag = String(r || '').match(/^R-\d{8}-([A-Z0-9]+)$/)?.[1];
  if (tag && tag.length >= 3 && /\d/.test(tag)) priorTags.add(tag);
}
const thisTag = String(run).match(/^R-\d{8}-([A-Z0-9]+)$/)?.[1] || '';
const DROP_SENTENCE = /^(?:Routing note\b|Prior(?: verdict)?:|Last prior verdict\b|Not a claim about the product\b|Nothing is claimed about the product\b|Placeholder so the ticket\b|Not double-counted\b)/i;
function dejargon(s) {
  let t = s;
  t = t.replace(/\b(?:the\s+)?(?:Claude Code\s+)?auto-mode classifier\b/gi, 'the QA tooling').replace(/\bClaude Code\b/gi, 'the QA tooling');
  t = t.replace(/\bali_qa\s+(?:\(read-only\)\s+|read-only\s+)?DB password\b/gi, 'the read-only database password for the QA login');
  t = t.replace(/(?:\s*\b(?:per|see|in)\s+)?\b(?:Q|SQ)\d*-[A-Z0-9][A-Z0-9-]*\b/g, '');
  t = t.replace(/\s*\((?:R-\d{2}(?:\s*[/,]\s*R-\d{2})*)\)/gi, '').replace(/\bR-\d{2}\b(?!-)/gi, '');
  t = t.replace(new RegExp(`\\b${reEsc(run)}\\b`, 'gi'), 'this round').replace(/\bR-\d{8}-[A-Z0-9]+\b/gi, 'an earlier QA round');
  if (thisTag.length >= 3 && /\d/.test(thisTag)) t = t.replace(new RegExp(`\\b${reEsc(thisTag)}\\b`, 'gi'), 'this round');
  for (const tag of priorTags) if (tag !== thisTag) t = t.replace(new RegExp(`\\b${reEsc(tag)}\\b`, 'gi'), 'an earlier QA round');
  t = t.replace(/\bscopeQuestions?\b/gi, 'the scope question').replace(/\bNOT_TESTED\b/gi, 'not tested').replace(/\bPASS_SCOPE\b/gi, 'pass (scoped)');
  t = t.replace(/\bPARTIAL:mixed\b/gi, 'partial (some cases fail)').replace(/\bPARTIAL:coverage-gap\b/gi, 'partial (not everything could be tested)')
    .replace(/\bPARTIAL:blocked-on-definition\b/gi, 'partial (waiting on a definition)').replace(/\bblocked-on-definition\b/gi, 'waiting on a definition').replace(/\bcoverage-gap\b/gi, 'coverage gap');
  t = t.replace(/\b(?:the\s+)?(?:verifier|executor)s?\b/gi, 'QA').replace(/\b(?:orchestrator|dispatcher)\b/gi, 'QA lead').replace(/\bledgers?\b/gi, 'QA record')
    .replace(/(?<![\w/.-])harness(?![\w/.-])/gi, 'test script').replace(/\bsubagents?\b/gi, 'QA');
  // "(the backend dev answer 9, 14 Oct)" → "(per the backend dev's answer, 14 Oct)": the answer numbers are the QA lead's own index
  t = t.replace(/\b([A-Z][a-z]+)\s+answer\s+\d+\b/g, "$1's answer").replace(/\((\s*)([A-Z][a-z]+'s answer)/g, '($1per $2').replace(/\bper per\b/g, 'per');
  t = t.replace(/\bAsana section Reopen on\b/gi, 'reopened on');
  // "the tokenless /luna page": a page opened without the property's guest link
  t = t.replace(/\b(the\s+)?tokenless\s+(\S+)\s+page\b/gi, (m, the, pg) => `${the ? (the[0] === 'T' ? 'The ' : 'the ') : ''}${pg} page without a property link`);
  return t;
}
function stripInternal(s) {
  return s
    .replace(/(?:~\/|\/(?:Users|private|tmp|home|var|etc|Volumes|opt|root|mnt)\/)[^\s"'`)\]]*/g, '')
    .replace(/(?:[\w.-]+\/)*qa-reports\/[^\s"'`)\]]*/g, '')
    .replace(/\bprojects\/[\w-]+\/[^\s"'`)\]]*/g, '')
    // the hub's own relative paths: harness/alpha/…, rules/RULES.md, profiles/x.json, evidence/…, .qa-approvals/…
    .replace(/(?<![\w/.-])(?:\.\/)?(?:harness|rules|profiles|evidence|\.qa-[\w-]+)\/[^\s"'`)\]]*/gi, '')
    .replace(/(?<![\w/.-])(?:\.\/)?(?:scripts|lib)\/[^\s"'`)\]]*\.(?:mjs|cjs|md|jsonl?|log)\b/gi, '')
    .replace(/[^\s"'`(\[]*_attachments\b\/?[^\s"'`)\]]*/g, '')
    .replace(new RegExp(`(?<![\\w])_(?:${INTERNAL_NAMES})\\b[^\\s"'\`)\\]]*`, 'g'), '')
    .replace(FILE_G, (m, ext) => (isInternalFile(m, ext) ? '' : m));
}
const tidy = (s) => s
  .replace(/\(\s*(?:also|see|e\.g\.|cf\.|in|at|per)?(?:\s|[;,:]|\b(?:and|or)\b)*\)|\[\s*\]/gi, '') // what is left of "(see <file> and <file>)"
  .replace(/\b(?:screenshots?|screen recording)(?: (?:at|in|of))?\s*(?=[;,)]|$)/gi, '') // "screenshot <path>;" without the path
  .replace(/\b(the|a|an) \1\b/gi, '$1')
  .replace(/[ \t]{2,}/g, ' ')
  .replace(/\s+([,.;:!?])(?=\s|$|)/g, '$1')
  .replace(/([,;:])(?=[,;:.])/g, '')
  .replace(/^[\s,;:.-]+/, '')
  .trim();

/**
 * One raw source value (ticket ledger, plan or plain sidecar) as dev-facing prose. Account emails become
 * the role; any other email, a token, an account secret or a forbidden host is recorded as a hard leak
 * (the whole post is refused); internal paths, file names and jargon are taken out of the sentence; links are cut
 * to origin + path, prose passwords and phone numbers are described; links and hosts outside the profile's staging
 * surfaces are replaced (a ticket's own app host by its label). Returns the text, not yet esc()-aped; a cited
 * question is a placeholder resolved once the questions are numbered.
 */
function devText(raw, where) {
  if (raw === null || raw === undefined) return '';
  let s = norm(typeof raw === 'string' ? raw : JSON.stringify(raw));
  const tid = ticketOfWhere(where);
  // R-02: a sentence about the needs-manual list never reaches Slack; nor does a needs-manual ticket's or case's id
  s = s.split(/(?<=[.!?])\s+/).filter((x) => !NEEDS_MANUAL_RE.test(x) && !DROP_SENTENCE.test(x.trim())).join(' ');
  if (manualIdRe) s = s.replace(manualIdRe, 'a related ticket');
  if (hiddenLongRe) s = s.replace(hiddenLongRe, 'another case');
  if (tid && hiddenShortRe.get(tid)) s = s.replace(hiddenShortRe.get(tid), 'another case');
  for (const a of accountLabels) s = s.replace(a.re, a.label);
  s = aliasOfAccount(s);
  s = sanitizeUrls(s);
  guardHard(where, s);
  s = maskPw(s);
  s = maskPhones(s);
  s = citeQuestions(s, tid);
  // allowed links are held aside first, so the path clean-up and the jargon rules never rewrite a real URL
  const keep = [];
  const hold = (x) => { keep.push(x); return `\u0000${keep.length - 1}\u0000`; };
  const surf = tid ? surfaceHostOf.get(tid) : null;
  const surfOf = (h) => (surf && surf.host === h ? surf : [...surfaceHostOf.values()].find((x) => x.host === h) || null);
  s = s.replace(URL_G, (m, off, all) => {
    const trail = (m.match(/[.,;:!?]+$/) || [''])[0];
    const u = trail ? m.slice(0, -trail.length) : m;
    const h = hostOfUrl(u);
    if (h && isAllowed(h)) return hold(u) + trail;
    if (h && isForbidden(h)) { hardLeaks.push(`${where}: a forbidden (production) host`); return trail; }
    const sf = h ? surfOf(h) : null;
    if (sf) { lostHost(where); return hold(labelAt(sf.label, all.slice(0, off))) + trail; }
    leftOut.add(`a link in ${where}`);
    return `[link left out]${trail}`;
  });
  s = stripInternal(s);
  s = dejargon(s);
  s = s.replace(new RegExp(`${BARE_HOST_G.source}(?:\\/[^\\s"'\`)\\]]*)?`, 'giu'), (m, off, all) => {
    const h = m.split('/')[0];
    const low = h.toLowerCase();
    if (isAllowed(low)) return hold(m);
    if (isForbidden(low)) { hardLeaks.push(`${where}: a forbidden (production) host`); return ''; }
    const sf = surfOf(low);
    if (sf) { lostHost(where); return hold(labelAt(sf.label, all.slice(0, off))); }
    leftOut.add(`a host name in ${where}`);
    return '[host left out]';
  });
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => keep[Number(i)]);
  return tidy(s);
}
const dev = (raw, where, n = 1200) => esc(clipQ(oneLine(devText(raw, where), 100000), n));

// ── compose ────────────────────────────────────────────────────────────────────────────────
const buildRaw = ledger.build?.buildId ? String(ledger.build.buildId) : '';
/** A build id, or '' when it carries a path or one of the project's hosts (bundle ids such as com.x.app are fine). */
function buildText(raw, where) {
  if (!raw) return '';
  guardHard(where, raw);
  const soft = hits([OWN_HOST, PATH], raw);
  if (soft.length) { dropped.add(`${where} (${soft.join(', ')}) — the build is left out`); return ''; }
  return esc(clip(oneLine(norm(raw), 400), 200));
}
const showBuild = buildText(buildRaw, 'the build id');

const ticketTitle = (t) => {
  const rawTitle = titleOf(t.id);
  guardHard(`the title of ${t.id}`, rawTitle);
  const soft = hits(SOFT, rawTitle);
  if (soft.length) { dropped.add(`the title of ${t.id} (${soft.join(', ')}) — it is posted without a title`); return ''; }
  return clip(oneLine(norm(rawTitle), 200).replace(new RegExp(`\\s*\\[${reEsc(String(t.id))}\\]$`), ''), 120); // drop a trailing " [GAM-114]"
};
const caseIdText = (t, c) => {
  const raw = String((typeof c === 'string' ? c : c?.caseId) ?? '');
  guardHard(`a case id of ${t.id}`, raw);
  for (const k of hits(SOFT, raw)) hardLeaks.push(`a case id of ${t.id}: ${k}`);
  return oneLine(norm(raw), 60).replace(new RegExp(`^${reEsc(String(t.id))}[/-](?=\\S)`), '');
};
const tag = (t) => { const ti = ticketTitle(t); return `*${esc(oneLine(t.id, 40))}${ti ? ` · ${esc(ti)}` : ''}*`; };
const VERDICT_WORDS = {
  FAIL: 'FAIL',
  'PARTIAL:mixed': 'PARTIAL (some cases fail)',
  'PARTIAL:coverage-gap': 'PARTIAL (what was tested passed; not everything could be tested)',
  'PARTIAL:blocked-on-definition': 'PARTIAL (waiting on a definition)',
  BLOCKED: 'BLOCKED',
  PASS: 'PASS',
  PASS_SCOPE: 'PASS (within the agreed scope)',
};
// the parent's one-line ticket summary uses the short words
const SHORT_WORDS = {
  FAIL: 'fail', 'PARTIAL:mixed': 'partial (some fail)', 'PARTIAL:coverage-gap': 'partial (not all tested)',
  'PARTIAL:blocked-on-definition': 'partial (waiting on a definition)', BLOCKED: 'blocked', PASS: 'pass', PASS_SCOPE: 'pass (scoped)',
};
const RANK = { FAIL: 0, 'PARTIAL:mixed': 1, BLOCKED: 2, 'PARTIAL:coverage-gap': 3, PASS_SCOPE: 6, PASS: 7 };
const rankOf = (t) => RANK[bucketOf(t)] ?? (t.verdict === 'PARTIAL' ? 4 : 5);
const stateOf = (t) => { try { return stateFor(route(t).route, stateMap); } catch { return 'INVALID'; } }; // the validator already refused
const idsList = (ids, n = 24) => (ids.length > n ? `${ids.slice(0, n).join(', ')} +${ids.length - n} more` : ids.join(', '));
const countLine = (n) => `${n.PASS} pass · ${n.FAIL} fail · ${n.NOT_TESTED} not tested`;
const descopedOf = (t) => (Array.isArray(t.descopedCases) ? t.descopedCases : []);
/** the verdict as a developer reads it: "nothing could be tested" and "all descoped" are said in so many words */
const verdictWord = (t) => {
  const n = ticketCaseCounts(t);
  const b = bucketOf(t);
  if (/^PARTIAL/.test(b) || t.verdict === 'PARTIAL') {
    if (n.PASS + n.FAIL + n.NOT_TESTED === 0 && descopedOf(t).length) return 'PARTIAL (all cases descoped)';
    if (n.PASS === 0 && n.FAIL === 0) return 'PARTIAL (nothing could be tested this round)';
  }
  return VERDICT_WORDS[b] || b;
};

// people the questions can be addressed to: every name a recorded question is sent to
const INTERNAL_TO = /\b(?:the QA lead|orchestrator|QA lead|dispatcher|verifier|executor)\b/i;
const PEOPLE = new Set();
for (const t of posted) {
  for (const q of Array.isArray(t.questions) ? t.questions : []) for (const w of String(q?.to || '').match(/\b[A-Z][a-z]{2,}\b/g) || []) PEOPLE.add(w);
  for (const q of Array.isArray(plans.plan(t.id)?.scopeQuestions) ? plans.plan(t.id).scopeQuestions : []) for (const w of String(q?.to || '').match(/\b[A-Z][a-z]{2,}\b/g) || []) PEOPLE.add(w);
  for (const m of String(t.scopeQuestion || '').matchAll(/^\s*For\s+([A-Z][a-z]{2,})\s*:/g)) PEOPLE.add(m[1]);
}
for (const w of ['the QA lead', 'Team', 'Backend', 'Frontend', 'Product', 'Gamma', 'Please', 'The', 'For']) PEOPLE.delete(w);
const personIn = (s) => { for (const m of String(s).matchAll(/\b([A-Z][a-z]{2,})(?:'s)?\b/g)) if (PEOPLE.has(m[1])) return m[1]; return ''; };

// why a case was not tested, in words a developer reads. `ask` → it may become a question for the team:
// `need` (what QA needs, raw), `held` (a "Held: X must Y" request) or `noReason`. A reason that already cites a
// recorded question, a QA-side restriction, a deferral or a descope asks nothing.
const QA_RESTRICT = /\bnot allowed (?:this|in this) round\b|\b(?:were|was|is|are) not allowed\b|\bnot permitted\b/i;
const NO_ASK = /\b(?:deferred|placeholder|descoped)\b/i;
function notTestedWhy(t, c) {
  const where = `the not-tested reason of ${t.id} ${c.caseId}`;
  const r = String(c.notTestedReason || '').toLowerCase();
  const rawOn = norm(c.blockedOn || '');
  const rawNote = norm(c.note || c.reason || '');
  if (/^needs-ok/.test(r) || /\bAli\b/.test(rawOn)) return { label: 'Held on the QA side (a QA-internal decision is pending)', ask: false };
  if (/classifier/.test(r)) return { label: 'Not run this round (a QA-side tooling limit; it will be re-run)', ask: false };
  const on = rawOn ? endTrim(devText(c.blockedOn, where)) : '';
  if (/^blocked-by-dependency/.test(r)) return { label: `Blocked by ${on || 'another ticket'}`, ask: false };
  if (/^out-of-scope/.test(r) && (!rawOn || /^re-?run on\b/i.test(rawOn))) {
    const pv = String(c.priorVerdict || '').toUpperCase();
    const sub = /^PASS/.test(pv) ? 'last result: PASS' : /^FAIL/.test(pv) ? 'last result: FAIL' : /^NOT_TESTED/.test(pv) ? 'not tested in an earlier round either' : '';
    return { label: "Not in this round's re-test scope (to be re-tested on the current build)", ask: false, sub };
  }
  if (on) {
    const cited = CITE_1.test(on);
    if (/^(?:no-ui-surface|no-operation)/.test(r) || /\bnot built yet\b/i.test(rawOn)) {
      const what = on.replace(/^(.*?)\s+not built yet\b\s*/i, (m, x) => `${x} `).trim();
      return { label: `Not built yet: ${clipQ(what, 400)}`, ask: false };
    }
    // "<context>, needs <X>" → "Waiting on: X — <context>"
    const nm = on.match(/^(.+?),?\s+needs\s+(.+)$/i);
    // "… needs X + the backend dev": the person is who it comes from
    const fromWho = (x) => x.replace(/\s*\+\s*([A-Z][a-z]{2,})\s*$/, (m, w) => (PEOPLE.has(w) ? ` (from ${w})` : m));
    const label = nm && !/^(?:no|not)\b/i.test(nm[2]) ? `Waiting on: ${fromWho(nm[2].replace(CITE_G, '').trim())} — ${nm[1]}${(on.match(CITE_G) || []).join('')}` : `Waiting on: ${on}`;
    if (QA_RESTRICT.test(rawOn) || cited) return { label: clipQ(label, 500), ask: false };
    return { label: clipQ(label, 500), ask: true, need: rawOn };
  }
  const note = rawNote ? endTrim(devText(rawNote, where)) : '';
  if (!note) return { label: 'No reason was recorded', ask: true, noReason: true };
  // "Held: needs one more account …" → "Needs one more account …" (the hold is said by the line itself)
  const label = clipQ(note.replace(/^Held\s*:\s*(?=[a-z])/, '').replace(/^[a-z]/, (ch) => ch.toUpperCase()), 400);
  if (QA_RESTRICT.test(rawNote) || NO_ASK.test(rawNote) || CITE_1.test(note)) { return { label, ask: false }; }
  // "Held: the reviewer must refund … before this half can be observed" → a request to the reviewer
  // (the colon may be gone: "Held per Q-REFUND: the reviewer must …" loses an unrecorded question id with its colon)
  const held = note.match(/^Held\b\s*:?\s*([A-Z][a-z]{2,})\s+must\s+(.+)$/);
  if (held) {
    // "refund in Stripe test mode before this half can be observed" names no object: say what is refunded
    const what = held[2].replace(/^(refund|void|cancel)\s+(in|on)\b/i, '$1 the test payment of this case $2').replace(/\bthis half\b/gi, 'the rest of this case');
    return { label: clipQ(`Waiting on ${held[1]} to ${what.replace(/\.$/, '')}`, 400), ask: true, held: { to: held[1], what } };
  }
  if (/\bdepends on\b/i.test(rawNote) && TICKET_IN.test(rawNote)) return { label: `Blocked by ${note.replace(/^(?:Held\s*:\s*)?depends on\s+/i, '')}`, ask: false };
  const nd = rawNote.match(/\b(?:needs?|requires?)\s+([^.;]+)/i);
  if (nd) return { label, ask: true, need: nd[1] };
  return { label, ask: false };
}

// ── questions: the recorded open ones, then the generated ones ──────────────────────────
const answeredIds = new Set();
try {
  const p = join(rdir, '_QUESTIONS-ANSWERED.jsonl');
  if (existsSync(p)) for (const l of readFileSync(p, 'utf8').split('\n')) {
    if (!l.trim()) continue;
    try { const r = JSON.parse(l); if (r?.id && /^(answered|moot|closed|resolved)$/i.test(String(r.status || 'answered'))) answeredIds.add(String(r.id)); } catch { /* a bad row answers nothing */ }
  }
} catch { /* no registry */ }
const isAnswered = (q, id) => answeredIds.has(id) || !!q?.answered || (typeof q?.answer === 'string' && !!q.answer.trim()) || /^(answered|moot|closed|resolved)$/i.test(String(q?.status || ''));
const toName = (to) => clip(oneLine(norm(to).split(/\s*(?:\(|->|→)/)[0], 60), 60);
const qid = (...parts) => createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 8);
const answeredShown = new Set(); // ids that were asked before (a stored number) and are answered now
/**
 * A recorded question as the team should read it: the QA-internal sentences out ("if X, is TC-10 a FAIL?", "The
 * plan accepts …", "Raise only if …"), a verdict aside out, "For the reviewer:" taken as the addressee. '' → not posted.
 */
function cleanQuestion(raw, t) {
  let s = norm(raw).trim();
  let to = '';
  const f = s.match(/^For\s+([A-Z][\w-]*(?:\s*\/\s*[A-Z][\w-]*)?)\s*:\s*/);
  if (f) { to = f[1]; s = s.slice(f[0].length); }
  const pre = (s.match(/^((?:(?:TC|SC|AC)-?[\w.]+)(?:\s*\/\s*[^:]{1,40})?)\s*:\s*/) || [''])[0];
  const body = s.slice(pre.length);
  const verdictOf = new Map((t.cases || []).map((c) => [String(c.caseId), c.verdict]));
  const keepS = body.split(/(?<=[.?!])\s+/).filter((x) => {
    const y = x.trim();
    if (!y) return false;
    if (/^if\b/i.test(y) || /^The plan\b/.test(y) || /^Raise only if\b/i.test(y)) return false;
    if (/\bis\s+(?:it|this|that|[A-Z]{2,3}-[\w.]+)\s+a\s+(?:FAIL|PASS)\b/i.test(y)) return false;
    return true;
  }).map((x) => x.replace(/\s*\((?:[^()]*\b(?:FAIL|PASS|PARTIAL)\b[^()]*)\)/g, '')).join(' ').trim();
  void verdictOf;
  if (!keepS || !/[\p{L}]/u.test(keepS)) return null;
  return { text: `${pre}${keepS}`, to };
}
const questions = []; // { id, ticket, to?, raw, text }
const recorded = []; // pass 1: what is posted, so a citation in any text can point at it
for (const t of posted) {
  const lq = Array.isArray(t.questions) ? t.questions : [];
  const add = (id, toRaw, raw) => {
    if (isAnswered(null, id)) { answeredShown.add(id); return; }
    if (toRaw && INTERNAL_TO.test(String(toRaw))) return;
    const cq = cleanQuestion(raw, t);
    if (!cq) return;
    const to = toRaw ? toName(toRaw) : cq.to;
    if (to && INTERNAL_TO.test(to)) return;
    recorded.push({ id, ticket: t.id, to, raw: cq.text });
  };
  for (const q of lq) {
    const text = q?.question || q?.text || q?.q;
    if (typeof text !== 'string' || !text.trim()) continue;
    const id = String(q?.id ? `${t.id}/${q.id}` : `R-${qid(project, t.id, text)}`);
    if (isAnswered(q, id)) { answeredShown.add(id); continue; }
    add(id, q.to, text);
  }
  if (typeof t.scopeQuestion === 'string' && t.scopeQuestion.trim()) add(`${t.id}/scope`, '', t.scopeQuestion);
  if (!lq.length) {
    const sq = plans.plan(t.id)?.scopeQuestions;
    for (const q of Array.isArray(sq) ? sq : []) {
      if (!q || typeof q !== 'object' || !q.to || /only if/i.test(`${q.to} ${q.question || q.q || ''}`)) continue;
      const text = q.question || q.q || q.text;
      if (typeof text !== 'string' || !text.trim()) continue;
      const id = String(q.id ? `${t.id}/${q.id}` : `P-${qid(project, t.id, text)}`);
      if (isAnswered(q, id)) { answeredShown.add(id); continue; }
      add(id, q.to, text);
    }
  }
}
for (const q of recorded) postedQ.add(q.id);
for (const q of recorded) questions.push({ ...q, text: devText(q.raw, `a question on ${q.ticket}`), to: q.to ? devText(q.to, `the addressee of a question on ${q.ticket}`) : '' });

// a need is covered when a posted recorded question already asks for it: every key word of one of its
// alternatives ("X or Y") is in that question. "a + b; c" are separate needs; ", needs X" narrows a part to X.
const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'per', 'via', 'also', 'are', 'was', 'has', 'have', 'its', 'one', 'some', 'any', 'all', 'ali', 'yet', 'real']);
const qCorpus = questions.map((q) => ({ id: q.id, words: new Set(`${norm(q.raw)} ${q.text}`.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []) }));
const keyWords = (s) => (norm(s).replace(/\([^()]*\)/g, ' ').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter((w) => w.length >= 3 && !STOP.has(w));
function coverage(rawNeed) {
  const uncovered = [];
  const covering = new Set();
  for (let part of norm(rawNeed).split(/\s+\+\s+|;\s*/)) {
    part = part.trim();
    if (!part || /^(?:no|not)\s/i.test(part)) continue;
    const nd = part.split(/,\s*(?:needs?|requires?)\s+/i);
    if (nd.length > 1) part = nd.slice(1).join(' ');
    if (!keyWords(part).some((w) => !PEOPLE.has(w.charAt(0).toUpperCase() + w.slice(1)))) continue; // a name only ("+ the backend dev")
    const alts = part.split(/,?\s+or\s+/i);
    let hit = null;
    for (const a of alts) {
      const kw = keyWords(a);
      if (!kw.length) continue;
      const q = qCorpus.find((x) => kw.every((w) => x.words.has(w)));
      if (q) { hit = q.id; break; }
    }
    if (hit) covering.add(hit); else uncovered.push(part);
  }
  return { uncovered, covering: [...covering] };
}
/** what QA needs, said to its addressee: "the client QA/Gamma ruling" → "the Gamma ruling", "the backend dev's run log" → "your run log" */
function needText(rawParts, to, where) {
  return rawParts.map((p) => {
    let x = p.replace(/\b([A-Z][a-z]{2,})\s*\/\s*(?=[A-Z])/g, (m, n) => (PEOPLE.has(n) ? '' : m));
    if (to) x = x.replace(new RegExp(`\\b${reEsc(to)}'s\\b`, 'g'), 'your');
    let d = endTrim(devText(x, where)).replace(/\s*\((?:pending with|with)\s+[A-Z][a-z]+\)/g, '');
    if (/^[A-Z]/.test(d) && !/^(?:A|An|The|Your|Our|QA)\b/.test(d)) d = `the ${d}`;
    return d;
  }).filter(Boolean).join(' and ');
}

// generated questions, merged across tickets by what is needed; caseCites: the questions a not-tested line points at
const generated = new Map(); // id → { id, to, text, refs: Map(ticket → [case ids]) }
const caseCites = new Map(); // `${ticket}\u0001${caseId}` → [question ids]
const citeCase = (t, c, id) => { const k = `${t.id}\u0001${c.caseId}`; if (!caseCites.has(k)) caseCites.set(k, []); if (!caseCites.get(k).includes(id)) caseCites.get(k).push(id); };
const order = posted.map((t, i) => ({ t, i })).sort((a, b) => rankOf(a.t) - rankOf(b.t) || a.i - b.i).map((x) => x.t);
for (const t of order) {
  for (const c of t.cases || []) {
    if (c?.verdict !== 'NOT_TESTED') continue;
    const w = notTestedWhy(t, c);
    if (!w.ask) continue;
    let id;
    let make;
    if (w.held) {
      id = `G-${qid(project, t.id, w.label)}`;
      const to = w.held.to;
      make = () => ({ to, text: `Please ${w.held.what.replace(/\s+before\s+(this|the|it)\b/i, ' so that $1')}${/[.?!]$/.test(w.held.what) ? '' : '.'}` });
    } else if (w.need) {
      const { uncovered, covering } = coverage(w.need);
      for (const q of covering) citeCase(t, c, q);
      if (!uncovered.length) continue;
      const key = uncovered.map((p) => squash(p.replace(/\([^()]*\)/g, ''))).join('+');
      id = `G-${qid(project, '*', key)}`;
      const to = personIn(uncovered.join(' '));
      make = (n) => ({ to, text: `QA needs ${needText(uncovered, to, `a question on ${t.id}`)} to test ${n === 1 ? 'this case' : 'these cases'} — when can QA have it?` });
    } else if (w.noReason) {
      id = `G-${qid(project, t.id, 'No reason was recorded')}`;
      make = (n) => ({ to: '', text: `No reason was recorded why ${n === 1 ? 'this case' : 'these cases'} could not be tested — is anything needed from the team to test ${n === 1 ? 'it' : 'them'}?` });
    } else continue;
    if (answeredIds.has(id)) { answeredShown.add(id); continue; }
    if (!generated.has(id)) generated.set(id, { id, make, refs: new Map() });
    const g = generated.get(id);
    if (!g.refs.has(t.id)) g.refs.set(t.id, []);
    g.refs.get(t.id).push(caseIdText(t, c));
    citeCase(t, c, id);
  }
}
for (const g of generated.values()) { const n = [...g.refs.values()].reduce((a, x) => a + x.length, 0); Object.assign(g, g.make(n)); g.ticket = [...g.refs.keys()][0]; }

// stable numbers: a question keeps its number across re-runs (state.qNumbers); a new one gets the next number
const prevState = readState();
const qNumbers = { ...(prevState.qNumbers && typeof prevState.qNumbers === 'object' ? prevState.qNumbers : {}) };
const allQuestions = [...questions, ...generated.values()];
let maxN = Math.max(0, ...Object.values(qNumbers).map(Number).filter(Number.isFinite));
for (const q of allQuestions) if (!Number.isFinite(Number(qNumbers[q.id]))) qNumbers[q.id] = ++maxN;
for (const q of allQuestions) q.n = Number(qNumbers[q.id]);
allQuestions.sort((a, b) => a.n - b.n);
const answeredLines = [...answeredShown].filter((id) => Number.isFinite(Number(qNumbers[id]))).map((id) => ({ n: Number(qNumbers[id]), id }));
const numberOf = (id) => (Number.isFinite(Number(qNumbers[id])) && allQuestions.some((q) => q.id === id) ? Number(qNumbers[id]) : null);
/** the citation placeholders → "(see question Q3 below)"; one that is not posted (answered) is dropped */
const resolveCites = (s, below = true) => String(s).replace(/(?:\d+)+/g, (m) => {
  const ns = [...new Set([...m.matchAll(/(\d+)/g)].map((x) => numberOf(citeIds[Number(x[1])])).filter((n) => n !== null))].sort((a, b) => a - b);
  if (!ns.length) return '';
  return ` (see question${ns.length > 1 ? 's' : ''} ${ns.map((n) => `Q${n}`).join(', ')}${below ? ' below' : ''})`;
});

// ── one reply per ticket ──────────────────────────────────────────────────────────────────
const LABELS = { precond: 'Precondition', check: 'Check' };
const stepLines = (steps, where) => {
  const out = [];
  let n = 0;
  for (const s of (Array.isArray(steps) ? steps : []).slice(0, 25)) {
    const txt = devText(String(s).replace(/^\s*\d+[.)]\s*/, ''), where);
    if (!txt) continue;
    if (/^(?:Result|Expected|Observed|Actual)\s*:/i.test(txt)) out.push(esc(clipQ(oneLine(txt, 100000), 700)));
    else out.push(`${++n}. ${esc(clipQ(oneLine(txt, 100000), 700))}`);
  }
  return out;
};
const hasPrior = (t) => (t.cases || []).some((c) => c?.priorVerdict);
const sinceTag = (t, c) => {
  if (!hasPrior(t)) return '';
  const pv = String(c.priorVerdict || '').toUpperCase();
  if (/^FAIL/.test(pv)) return ' _(still failing since an earlier round)_';
  if (/^PASS/.test(pv)) return ' _(regression: passed in an earlier round)_';
  return ' _(new)_';
};
const SAME_CAUSE = /\bnot a separate bug\b|\bside effect of\b/i;
function failBlock(t, c) {
  const d = failDetail(t, c, { planCase: plans.planCase, plainCase, labels: LABELS });
  const w = `${t.id} ${c.caseId}`;
  const title = d.title ? dev(d.title, `the case title of ${w}`, 300) : '';
  const lines = [`*${esc(caseIdText(t, c))}${title ? ` — ${title}` : ''}*${sinceTag(t, c)}`];
  if (d.ac) lines.push(`_Acceptance criterion:_ ${dev(d.ac, `the acceptance criterion of ${w}`, 600)}`);
  lines.push(`*Expected:* ${d.expected ? dev(d.expected, `the expected result of ${w}`) : '_not recorded for this case_'}`);
  lines.push(`*Actual:* ${d.actual ? dev(d.actual, `the actual result of ${w}`) : '_not recorded for this case_'}`);
  if (d.why) {
    const why = dev(d.why, `the reason of ${w}`);
    if (SAME_CAUSE.test(norm(d.why))) {
      // the case it points at ("see the TC-3.3 problem", "same cause as SC-2") first, else the first other id named
      const ID = /\b(?:TC|SC|AC)-[\w.]*\w/;
      const pointed = norm(d.why).match(new RegExp(`(?:\\bsee(?: the)?|\\bsame (?:root )?(?:cause|fault) as)\\s+(${ID.source})`, 'i'))?.[1];
      const named = pointed && pointed !== String(c.caseId) ? pointed : (norm(d.why).match(new RegExp(ID.source, 'g')) || []).find((x) => x !== String(c.caseId));
      const other = named ? devText(named, `the reason of ${w}`) : '';
      lines.push(`*Why it fails (same cause as ${other ? esc(other) : 'another case'}):* ${why}`);
    } else lines.push(`*Why it's a bug:* ${why}`);
  }
  const h = d.url ? hostOfUrl(String(d.url)) : '';
  if (h && isAllowed(h)) { const u = devText(String(d.url), `the evidence link of ${w}`); if (u) lines.push(`*Seen at:* ${esc(u)}`); }
  const steps = stepLines(d.steps, `the steps of ${w}`);
  lines.push('*Steps to reproduce:*', ...(steps.length ? steps : ['_no steps were recorded for this case_']));
  return lines.join('\n');
}
// the platforms of a bundle-id surface (com.x.app), from the build's keys: "android=… ios=… web=…" → Android · iOS · web
// build keys that are platforms; an "ota=" (over-the-air update id) or other build part is not one
const PLATFORM = { android: 'Android', ios: 'iOS', web: 'web', api: 'API', admin: 'admin web' };
const platformsOf = (t) => [...new Set([...String(t.buildId || buildRaw).matchAll(/(?:^|\s)([a-z]+)=/g)].map((m) => PLATFORM[m[1].toLowerCase()]).filter(Boolean))];
function scopeBlock(t) {
  const n = ticketCaseCounts(t);
  const surfRaw = t.surface ? String(t.surface) : '';
  let surface = '';
  if (surfRaw) {
    const hs = hostsIn(surfRaw).filter((h) => BARE_HOST.test(` ${h}`));
    const sf = surfaceHostOf.get(String(t.id));
    if (hs.some(isForbidden)) hardLeaks.push(`the surface of ${t.id}: a forbidden (production) host`);
    else if (sf && hs.every((h) => isAllowed(h) || h === sf.host)) surface = `${esc(sf.label)} (link not posted)`;
    else if (hs.length && !hs.every(isAllowed)) surface = 'web (a host that is not listed for posting)';
    else if (/^[a-z][\w-]*(?:\.[a-z0-9_-]+){2,}$/i.test(surfRaw.trim()) && !hs.length) {
      const pl = platformsOf(t);
      surface = pl.length ? esc(pl.join(' · ')) : 'the app';
    } else surface = esc(oneLine(devText(surfRaw, `the surface of ${t.id}`), 120));
  }
  const plat = t.platform ? esc(oneLine(devText(t.platform, `the platform of ${t.id}`), 60)) : '';
  // the run's build is in the parent; a ticket built elsewhere says so
  const build = t.buildId && String(t.buildId) !== buildRaw ? buildText(String(t.buildId), `the build id of ${t.id}`) : '';
  const scopeLine = [surface, plat, build ? `build \`${build}\`` : ''].filter(Boolean).join(' · ');
  const lines = [`*Scope:* ${scopeLine || 'not recorded'}`, `*Cases:* ${countLine(n)}`];
  const passes = (t.cases || []).filter((c) => c?.verdict === 'PASS');
  if (passes.length && passes.length < n.PASS + n.FAIL + n.NOT_TESTED) {
    lines.push(`*Passed (${passes.length}):*`);
    for (const c of passes) {
      const d = failDetail(t, c, { planCase: plans.planCase, plainCase, labels: LABELS });
      // a title that repeats its own id ("TC7 HTML entities: …") goes without the repeat
      const tiRaw = d.title ? oneLine(devText(d.title, `the case title of ${t.id} ${c.caseId}`), 100000).replace(/^(?:TC|SC|AC)-?\d+[a-z]?(?:\.\w+)?\s*[:.\u2014-]?\s+/i, '') : '';
      const ti = tiRaw ? esc(clipQ(tiRaw, 60).replace(CITE_G, '')) : '';
      const fixed = /^FAIL/i.test(String(c.priorVerdict || '')) ? ' _(fixed since the last round)_' : '';
      lines.push(`• ${esc(caseIdText(t, c))}${ti ? ` — ${ti}` : ''}${fixed}`);
    }
  }
  const groups = new Map();
  for (const c of t.cases || []) {
    if (c?.verdict !== 'NOT_TESTED') continue;
    const why = notTestedWhy(t, c);
    if (!groups.has(why.label)) groups.set(why.label, { ...why, ids: [], subs: new Map(), cites: [] });
    const g = groups.get(why.label);
    const cid = caseIdText(t, c);
    g.ids.push(cid);
    if (why.sub !== undefined) { if (!g.subs.has(why.sub)) g.subs.set(why.sub, []); g.subs.get(why.sub).push(cid); }
    for (const q of caseCites.get(`${t.id}\u0001${c.caseId}`) || []) if (!g.cites.includes(q)) g.cites.push(q);
  }
  const desc = descopedOf(t).map((c) => caseIdText(t, c)).filter(Boolean);
  if (groups.size || desc.length) {
    lines.push('*Not tested, and why:*');
    for (const g of groups.values()) {
      // a question the reason itself cites goes to the end of the line, with the others: "<reason> — <ids> (see question Qn below)"
      const tags = [...new Set([...(g.label.match(CITE_G) || []), ...g.cites.map(cite)])].join('');
      const label = g.label.replace(/\s*\uE000\d+\uE001/g, '').replace(/\s+([,.;:])/g, '$1').trim();
      const ids = g.subs.size > 1 || (g.subs.size === 1 && [...g.subs.keys()][0])
        ? [...g.subs].map(([sub, ids]) => `${idsList(ids)}${sub ? ` (${sub})` : ''}`).join('; ')
        : idsList(g.ids);
      lines.push(`• ${esc(label)} — ${esc(ids)}${tags}`);
    }
    if (desc.length) lines.push(`• Descoped by a product decision (not counted above) — ${esc(idsList(desc))}`);
  }
  return { text: lines.join('\n'), scopeLine };
}
function ticketReply(t) {
  const st = stateOf(t);
  const head = tag(t);
  const word = verdictWord(t);
  const line = `${head} — ${esc(word)} → ${esc(st)}${t.severity ? ` · severity ${esc(oneLine(norm(t.severity), 30))}` : ''}`;
  if (word === 'PARTIAL (all cases descoped)') {
    return { key: t.id, head: line, cont: `${head} (continued)`, blocks: [`*Descoped by a product decision:* ${esc(idsList(descopedOf(t).map((c) => caseIdText(t, c)).filter(Boolean)))}`] };
  }
  const scope = scopeBlock(t);
  const fails = (t.cases || []).filter((c) => c?.verdict === 'FAIL').map((c) => failBlock(t, c));
  return { key: t.id, head: line, cont: `${head} (continued)`, blocks: [scope.text, ...(fails.length ? [`*Failing case${fails.length === 1 ? '' : 's'} (${fails.length}):*`] : []), ...fails] };
}
const passedLine = (t) => {
  const n = ticketCaseCounts(t);
  const total = n.PASS + n.FAIL + n.NOT_TESTED;
  const scope = scopeBlock(t).scopeLine;
  const fixed = (t.cases || []).filter((c) => c?.verdict === 'PASS' && /^FAIL/i.test(String(c.priorVerdict || ''))).map((c) => caseIdText(t, c));
  return `• ${tag(t)} — ${esc(verdictWord(t))} → ${esc(stateOf(t))} · ${total === 1 ? 'the 1 case' : total === 2 ? 'both cases' : `all ${total} cases`} passed${scope ? ` · ${scope}` : ''}${fixed.length ? ` _(fixed since the last round: ${esc(idsList(fixed, 8))})_` : ''}`;
};

const isCompactPass = (t) => { const n = ticketCaseCounts(t); return (t.verdict === 'PASS' || t.verdict === 'PASS_SCOPE') && n.FAIL === 0 && n.NOT_TESTED === 0 && !descopedOf(t).length; };
const detailed = order.filter((t) => !isCompactPass(t)).map(ticketReply);
const passed = order.filter(isCompactPass);

const groupsOut = [...detailed];
if (passed.length) groupsOut.push({ key: 'passed', head: `*Passed* · ${passed.length} ticket${passed.length === 1 ? '' : 's'}`, cont: '*Passed* (continued)', blocks: [passed.map(passedLine).join('\n')] });
const refsText = (q) => [...q.refs].map(([tid, ids]) => `${esc(tid)} ${esc(idsList(ids, 12))}`).join(' · ');
const qEntries = [
  ...allQuestions.map((q) => ({ n: q.n, text: q.refs
    ? `*Q${q.n} · ${refsText(q)}*${q.to ? ` (for ${esc(q.to)})` : ''}: ${esc(clipQ(oneLine(q.text, 100000), 900))}`
    : `*Q${q.n} · ${esc(q.ticket)}*${q.to ? ` (for ${esc(q.to)})` : ''}: ${esc(clipQ(oneLine(q.text, 100000), 1000))}` })),
  ...answeredLines.map((a) => ({ n: a.n, text: `~Q${a.n}~ answered` })),
].sort((a, b) => a.n - b.n);
if (allQuestions.length || answeredLines.length) {
  groupsOut.push({ key: 'questions', head: `*Questions for the team* · \`${esc(run)}\` · ${allQuestions.length} open`, cont: '*Questions for the team* (continued)', blocks: [...qEntries.map((e) => e.text), '_Reply in this thread — answers are read by the QA lead; a reply does not change any ticket._'] });
}
for (const g of groupsOut) g.blocks = g.blocks.map((b) => resolveCites(b, g.key !== 'questions'));

// a message over DIGEST_MAX goes out in consecutive parts: block, then line, then character boundaries
function split({ key, head, cont, blocks }) {
  const limit = DIGEST_MAX;
  const room = limit - cont.length - 2; // what a continuation part has for content
  const pieces = [];
  for (const b of blocks) {
    if (b.length <= room) { pieces.push(b); continue; }
    let cur = '';
    for (const line of b.split('\n')) {
      const chunks = [];
      for (let i = 0; i < line.length; i += room - 50) chunks.push(line.slice(i, i + room - 50));
      for (const ch of chunks.length ? chunks : ['']) {
        if (cur && cur.length + 1 + ch.length > room) { pieces.push(cur); cur = ch; } else cur = cur ? `${cur}\n${ch}` : ch;
      }
    }
    if (cur) pieces.push(cur);
  }
  const parts = [];
  let cur = head;
  for (const p of pieces) {
    if (cur.length + 2 + p.length > limit) { parts.push(cur); cur = `${cont}\n\n${p}`; } else cur = `${cur}\n\n${p}`;
  }
  parts.push(cur);
  return parts.map((text, i) => ({ key: i ? `${key}#${i + 1}` : key, text }));
}
const desired = groupsOut.flatMap(split);

// the parent: the run summary, generated counts only
const join3 = (o) => Object.entries(o).map(([k, v]) => `${k} ${v}`).join(' · ');
const joinShort = (o) => Object.entries(o).map(([k, v]) => `${v} ${SHORT_WORDS[k] || k}`).join(' · ');
const blockedTickets = counts.buckets.BLOCKED || 0;
const skippedNames = gates.skipped.map((g) => g.replace(/\b[A-Z]-\d+(?:\/[A-Z]-\d+)*\s*/g, '').trim() || g);
const parent = [
  `🧪 *QA results* · ${esc(project)} · run \`${esc(run)}\``,
  [showBuild ? `Build \`${showBuild}\`` : null, ledger.generatedAt ? `${esc(String(ledger.generatedAt).slice(0, 10))}` : null].filter(Boolean).join(' · ') || null,
  `*Tickets* ${counts.total} — ${esc(joinShort(counts.buckets))}`,
  `*Proposed states* ${esc(join3(counts.byProposedState))}`,
  `*Cases* PASS ${cases.run.PASS} · FAIL ${cases.run.FAIL} · NOT-TESTED ${cases.run.NOT_TESTED}${blockedTickets ? ` (blocked tickets: ${blockedTickets})` : ''}`,
  gates.skipped.length ? `QA checks: ${gates.passed} passed, ${gates.skipped.length} skipped (${esc(skippedNames.join(' · '))})` : 'QA checks: all passed',
  "_Tracker not changed: proposed states wait for the QA lead's approval._",
  `Details per ticket in the thread ↓${allQuestions.length ? ` · ${allQuestions.length} question${allQuestions.length === 1 ? '' : 's'} for the team` : ''}`,
].filter(Boolean).join('\n');

// belt and braces: every outgoing text, hard checks + links + paths + "needs manual" (R-02) + left-out case ids
const outgoing = [['the parent', parent], ...desired.map((d) => [`the reply ${d.key}`, d.text])];
for (const [where, text] of outgoing) {
  guardHard(where, text);
  const s = norm(text);
  for (const m of s.matchAll(URL_G)) {
    const u = m[0].replace(/&amp;/g, '&').replace(/[.,;:!?]+$/, '');
    const h = hostOfUrl(u);
    if (!h || !isAllowed(h)) hardLeaks.push(`${where}: a link outside the staging surfaces`);
    try { const x = new URL(/^www\./i.test(u) ? `https://${u}` : u); if ([...x.searchParams.keys()].some((k) => k !== 'mode') || x.hash) hardLeaks.push(`${where}: a link with a query or fragment`); } catch { /* not a URL */ }
  }
  for (const k of hits([PATH], text)) hardLeaks.push(`${where}: ${k}`);
  if (INTERNAL_FILE.test(s)) hardLeaks.push(`${where}: an internal file name`);
  if (NEEDS_MANUAL_RE.test(s)) hardLeaks.push(`${where}: a needs-manual item (R-02: never Slack)`);
  if (manualIdRe && new RegExp(manualIdRe.source, 'iu').test(s)) hardLeaks.push(`${where}: a needs-manual ticket id (R-02: never Slack)`);
  if (hiddenLongRe && new RegExp(hiddenLongRe.source, 'u').test(s)) hardLeaks.push(`${where}: the id of a left-out needs-manual case (R-02: never Slack)`);
  if (/[\uE000\uE001]/.test(s)) hardLeaks.push(`${where}: an unresolved question reference (a generator bug)`);
}
for (const d of dropped) console.error(`[${L}] left out: ${d}. What matched is not printed.`);
if (leftOut.size) console.error(`[${L}] replaced link(s)/host name(s) outside the profile's staging surfaces ("[link left out]" / "[host left out]", or the app's name for its own host) in ${leftOut.size} place(s).`);
if (stepsLostHost.size) console.error(`[${L}] the steps of ${[...stepsLostHost].join(', ')} name the app without its link (the host is not in the profile's surfaces) — a developer has to know where to open it.`);
if (hardLeaks.length) {
  console.error(`[${L}] leak guard: refusing — nothing ${SEND ? 'was' : 'would be'} posted. What matched is not printed:`);
  for (const l of [...new Set(hardLeaks)]) console.error(`  ✗ ${l}`);
  console.error('  Fix the source (ticket title in the intake, ledger, plan, plain sidecar or profile); the message is generated, never edited by hand.');
  process.exit(1);
}

const sha = (s) => createHash('sha256').update(s).digest('hex');
for (const d of desired) d.hash = sha(d.text);
const parentHash = sha(parent);
const contentHash = sha(JSON.stringify([parent, ...desired.map((d) => d.text)]));
let state = readState();
const sameNumbers = (st) => JSON.stringify(st.qNumbers || {}) === JSON.stringify(qNumbers);
const unchanged = (st) => !!st.threadTs && st.contentHash === contentHash && sameNumbers(st) && st.replies.length === desired.length && st.replies.every((r) => r?.ts);
/** What --send would do against the state as it is now. */
function planOf(st) {
  if (!st.threadTs) return { post: 1 + desired.length, update: 0, del: 0, same: 0, fresh: true };
  const p = { post: 0, update: st.parentHash === parentHash ? 0 : 1, del: Math.max(0, st.replies.length - desired.length), same: 0, fresh: false };
  desired.forEach((d, i) => { const cur = st.replies[i]; if (!cur?.ts) p.post++; else if (cur.hash === d.hash && cur.key === d.key) p.same++; else p.update++; });
  return p;
}

// ── dry run ───────────────────────────────────────────────────────────────────────────────
if (!SEND) {
  const target = cfgAll?.projects?.[project];
  const p = planOf(state);
  const plan = !configured ? 'no channel configured — --send would skip'
    : !(target.resultsAuthorizedBy && target.resultsAuthorizedQuote && target.resultsAuthorizedAt) ? 'no results authorisation recorded (resultsAuthorizedQuote) — --send would refuse'
      : p.fresh ? `thread would be created (parent + ${desired.length} repl${desired.length === 1 ? 'y' : 'ies'})`
        : unchanged(state) ? 'already posted, unchanged — --send would do nothing'
          : `already posted — --send would edit ${p.update} message(s) in place, post ${p.post} more, delete ${p.del} and leave ${p.same} as they are (if the thread was deleted in Slack: --send --reset posts a fresh one)`;
  console.log(`[${L}] DRY RUN — nothing sent, nothing written. ${project} run ${run} → ${target ? target.channelName || target.channelId : 'no channel'}: ${plan}`);
  console.log(`[${L}] ${1 + desired.length} message(s): the parent + ${desired.length} thread repl${desired.length === 1 ? 'y' : 'ies'} (${detailed.length} ticket repl${detailed.length === 1 ? 'y' : 'ies'}${passed.length ? ', 1 for the passed tickets' : ''}${allQuestions.length ? `, the questions (${allQuestions.length})` : ''}; parts of a long reply count separately)\n`);
  console.log(`── parent (${parent.length} chars) ──`);
  console.log(parent.split('\n').map((l) => '  │ ' + l).join('\n'));
  desired.forEach((d, i) => {
    console.log(`\n── reply ${i + 1}/${desired.length} · ${d.key} (${d.text.length} chars) ──`);
    console.log(d.text.split('\n').map((l) => '  │ ' + l).join('\n'));
  });
  if (allQuestions.length || answeredLines.length) {
    console.log('\n── for the QA lead, not posted: question numbers → ids (mark one answered in _QUESTIONS-ANSWERED.jsonl) ──');
    for (const q of allQuestions) console.log(`  Q${q.n} = ${oneLine(q.id, 80)}${q.refs ? ' (generated from the not-tested cases)' : ''}`);
    for (const a of answeredLines) console.log(`  Q${a.n} = ${oneLine(a.id, 80)} (answered — shown struck through)`);
  }
  process.exit(0);
}

// ── live ──────────────────────────────────────────────────────────────────────────────────
const cfg = client.channelFor(cfgAll, cfgPath, project);
// the channel's own authorisation (authorizedQuote) was for the slack-window live thread; automatic RESULTS posts
// need their own recorded words (R-01): resultsAuthorizedBy + resultsAuthorizedQuote (+ resultsAuthorizedAt)
if (!cfg.resultsAuthorizedBy || !cfg.resultsAuthorizedQuote || !cfg.resultsAuthorizedAt)
  fail(`[${L}] ${cfgPath} has no resultsAuthorizedBy/resultsAuthorizedQuote/resultsAuthorizedAt for ${project} — posting results to this channel needs the user's own recorded words for results posts (R-01); _stage/slack-report/promote.py records them`, 1);
if (state.channelId && state.channelId !== cfg.channelId) fail(`[${L}] this run's report lives in ${state.channelId}, config now says ${cfg.channelId} — refusing to cross channels`, 1);
if (!RESET && unchanged(state)) {
  console.log(`[${L}] already posted, unchanged — nothing sent (${cfg.channelName || cfg.channelId}, thread ${state.threadTs})`);
  process.exit(0);
}
const slack = client.slackApi(client.botToken());
client.takeLock(lockPath, busy);
state = readState(); // under the lock: another send may have finished meanwhile
if (state.channelId && state.channelId !== cfg.channelId) fail(`[${L}] this run's report lives in ${state.channelId}, config now says ${cfg.channelId} — refusing to cross channels`, 1);
const save = () => writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
// --reset: the old thread was deleted in Slack — start a fresh one; the question numbers and the channel are kept
if (RESET && state.threadTs) {
  state = { channelId: state.channelId || cfg.channelId, qNumbers: state.qNumbers || {}, replies: [], parentHash: null, contentHash: null, resetAt: new Date().toISOString(), previousThreadTs: state.threadTs };
  save();
}
const GONE = /message_not_found|cant_update_message/;
const GAP = Number(process.env.QA_SLACK_POST_GAP_MS ?? (MOCK ? 0 : 1100)) || 0;
let calls = 0;
const call = async (method, body) => {
  if (calls++ && GAP > 0) await new Promise((r) => setTimeout(r, GAP));
  return slack(method, body);
};

try {
  if (unchanged(state)) {
    console.log(`[${L}] already posted, unchanged — nothing sent`);
    process.exit(0);
  }
  const did = { posted: 0, edited: 0, deleted: 0, same: 0 };
  const now = () => new Date().toISOString();
  state.qNumbers = qNumbers;
  if (state.threadTs) { state.contentHash = null; save(); } // mid-update: a crash below never reads as "unchanged"
  if (!state.threadTs) {
    const j = await call('chat.postMessage', { channel: cfg.channelId, text: parent, unfurl_links: false, unfurl_media: false });
    state = { channelId: cfg.channelId, threadTs: j.ts, parentHash, replies: [], contentHash: null, postedAt: now(), qNumbers, ...(state.previousThreadTs ? { previousThreadTs: state.previousThreadTs, resetAt: state.resetAt } : {}) };
    save(); // the thread exists now: a crash below must not create a second one
    did.posted++;
  } else if (state.parentHash !== parentHash) {
    try { await call('chat.update', { channel: cfg.channelId, ts: state.threadTs, text: parent }); } catch (e) {
      if (GONE.test(String(e.message))) fail(`[${L}] the results thread ${state.threadTs} was deleted in Slack (thread deleted) — nothing more was sent. Start a fresh thread with --send --reset (the question numbers are kept).`, 1);
      throw e;
    }
    state.parentHash = parentHash;
    state.updatedAt = now();
    save();
    did.edited++;
  }
  for (let i = 0; i < desired.length; i++) {
    const d = desired[i];
    const cur = state.replies[i];
    if (cur?.ts && cur.hash === d.hash && cur.key === d.key) { did.same++; continue; }
    let gone = false;
    if (cur?.ts) {
      try { await call('chat.update', { channel: cfg.channelId, ts: cur.ts, text: d.text }); } catch (e) {
        if (!GONE.test(String(e.message))) throw e;
        gone = true; // someone deleted this reply in Slack: post it again into the same slot
      }
      if (!gone) {
        state.replies[i] = { key: d.key, ts: cur.ts, hash: d.hash };
        state.updatedAt = now();
        did.edited++;
      }
    }
    if (!cur?.ts || gone) {
      const j = await call('chat.postMessage', { channel: cfg.channelId, thread_ts: state.threadTs, text: d.text, unfurl_links: false, unfurl_media: false });
      state.replies[i] = { key: d.key, ts: j.ts, hash: d.hash };
      did.posted++;
    }
    save();
  }
  // surplus replies (the ticket set shrank): the bot's own messages, deleted from the end
  for (let i = state.replies.length - 1; i >= desired.length; i--) {
    const cur = state.replies[i];
    if (cur?.ts) {
      try { await call('chat.delete', { channel: cfg.channelId, ts: cur.ts }); } catch (e) { if (!/message_not_found/.test(String(e.message))) throw e; }
      did.deleted++;
    }
    state.replies.splice(i, 1);
    state.updatedAt = now();
    save();
  }
  state.contentHash = contentHash;
  save();
  console.log(`[${L}] ${cfg.channelName || cfg.channelId} (thread ${state.threadTs}): posted ${did.posted}, edited ${did.edited} in place, deleted ${did.deleted}, unchanged ${did.same}. No tracker was changed.`);
} catch (e) {
  fail(`[${L}] Slack API error — ${client.redact(e.message)} (what was sent is saved; the next --send finishes the rest)`, 1);
}
