// The Slack plumbing shared by scripts/slack-window.mjs (a node-graph run's live thread) and
// scripts/slack-report.mjs (a finished run's results). Moved out of slack-window.mjs on 2026-10-16 with its
// error texts unchanged, so the selftest needles still match. `label` is the calling script's name: it is the
// "[label]" prefix of every message.
//
// Guards, all before any network call:
//   · QA_SLACK_API_BASE (tests only) must be http:// on 127.0.0.1 / localhost / [::1] — a local mock Slack
//   · channelFor: .qa-slack/config.json, ONE channel per project, the user's recorded words (authorizedBy +
//     authorizedQuote), a channel set for two projects refused
//   · botToken: a bot token (xoxb-…) from env QA_SLACK_BOT_TOKEN, else ~/.config/qa-hub/slack-bot-token; a mock
//     only ever gets a test token (xoxb-test-…) from the environment, and the token file is never opened then
//   · redact: the token (and anything token-shaped) is never printed
//   · takeLock: one live writer per run at a time
//   · slackApi waits out a rate limit (HTTP 429 / "ratelimited", Retry-After) and retries, at most 3 times
//   · readThreadReplies: a thread's human replies appended to a jsonl (slack-window --replies, slack-report --replies)

import { existsSync, readFileSync, openSync, closeSync, writeSync, unlinkSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fail } from './profile.mjs';
import { clip } from './slack-window.mjs';
import { readSlackReplies, tsAfter, tsIso } from './graph.mjs';

/** Banned flags: every post is generated, never free text. */
export const BANNED_FLAGS = ['text', 'channel', 'message', 'blocks'];

// Thread replies are people's words: printed on one line, without control characters, and labelled as data.
// \p{Cf} covers the bidi overrides and zero-width characters, \p{Zl}/\p{Zp} the Unicode line breaks.
export const oneLine = (s, n = 300) => clip(String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ').trim(), n);

/**
 * The Slack client for one script. Checks QA_SLACK_API_BASE at creation, so a remote "mock" is refused
 * before anything else runs.
 */
export function slackClient(label) {
  const MOCK = process.env.QA_SLACK_API_BASE !== undefined;
  const API_BASE = MOCK ? process.env.QA_SLACK_API_BASE.replace(/\/+$/, '') : 'https://slack.com/api';
  if (MOCK) {
    let u = null;
    try { u = new URL(API_BASE); } catch { /* refused below */ }
    if (!u || u.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname))
      fail(`[${label}] QA_SLACK_API_BASE may only point at a local test server (http://127.0.0.1:<port>) — unset it to use Slack`, 2);
  }

  /** This project's channel from the config, or exit. A flat single-channel config is refused, never used for every project. */
  function channelFor(cfgAll, cfgPath, project) {
    if (!cfgAll) fail(`[${label}] no readable config at ${cfgPath} — see _stage/node-graph/SLACK-SETUP.md step 4`, 1);
    const cfg = cfgAll.projects?.[project];
    if (!cfg) fail(`[${label}] ${cfgPath} has no channel for project "${project}" — add projects.${project}; a run posts only to its own project's channel`, 1);
    if (!cfg.channelId || !/^[CG][A-Z0-9]{6,}$/.test(cfg.channelId)) fail(`[${label}] ${cfgPath} needs a channelId (C…/G…) under projects.${project}`, 1);
    if (!cfg.authorizedBy || !cfg.authorizedQuote) fail(`[${label}] ${cfgPath} has no authorizedBy/authorizedQuote for ${project} — posting to this channel needs the user's own recorded words (R-01)`, 1);
    const twin = Object.entries(cfgAll.projects).find(([p, c]) => p !== project && c?.channelId === cfg.channelId);
    if (twin) fail(`[${label}] channel ${cfg.channelId} is set for both ${project} and ${twin[0]} — one channel per project, so one client's run never shows in another client's channel`, 1);
    return cfg;
  }

  let TOKEN = '';
  /** An error message with the token (and anything token-shaped) taken out: it is never printed. */
  const redact = (msg) => {
    let m = String(msg ?? '');
    if (TOKEN) m = m.split(TOKEN).join('[token]');
    return m.replace(/xox[a-z]-[^\s"'`]*/gi, '[token]');
  };
  function botToken() {
    const env = (process.env.QA_SLACK_BOT_TOKEN || '').trim();
    // A local test server gets a test token from the environment only. The token file is never opened in
    // mock mode (not even to compare): a real bot token never starts with xoxb-test-, so the prefix is the check.
    const NO_TOKEN = `[${label}] no bot token (xoxb-… on one line, letters, digits and dashes only) in QA_SLACK_BOT_TOKEN or ~/.config/qa-hub/slack-bot-token — use the dedicated QA Hub Bot, never a user token`;
    if (MOCK) {
      if (env && !/^xoxb-[A-Za-z0-9-]+$/.test(env)) fail(NO_TOKEN, 1);
      if (!/^xoxb-test-[A-Za-z0-9-]+$/.test(env)) fail(`[${label}] QA_SLACK_API_BASE is set: a test server only ever gets a test token (xoxb-test-…), never the real bot token`, 2);
      TOKEN = env;
      return env;
    }
    const tokenFile = join(homedir(), '.config', 'qa-hub', 'slack-bot-token');
    const token = env || (existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8').trim() : '');
    if (!/^xoxb-[A-Za-z0-9-]+$/.test(token)) fail(NO_TOKEN, 1);
    TOKEN = token;
    return token;
  }

  // A rate limit (HTTP 429, or ok:false "ratelimited") is waited out and retried: Retry-After seconds (default 1,
  // at most 30), up to RATE_RETRIES times; then it is an error like any other.
  const RATE_RETRIES = 3;
  const slackApi = (token) => async (method, body, get = false) => {
    const url = `${API_BASE}/${method}${get ? '?' + new URLSearchParams(body) : ''}`;
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, {
        method: get ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${token}`, ...(get ? {} : { 'Content-Type': 'application/json; charset=utf-8' }) },
        ...(get ? {} : { body: JSON.stringify(body) }),
      });
      let j = null;
      try { j = await res.json(); } catch { j = { ok: false, error: `http_${res.status}` }; }
      if ((res.status === 429 || j?.error === 'ratelimited') && attempt < RATE_RETRIES) {
        const wait = Math.min(30, Math.max(0, Number(res.headers.get('retry-after')) || 1));
        console.error(`[${label}] Slack rate limit on ${method} — waiting ${wait}s (Retry-After), then retrying`);
        await new Promise((r) => setTimeout(r, wait * 1000));
        continue;
      }
      if (!j.ok) throw new Error(`${method}: ${j.error}`);
      return j;
    }
  };

  /** Take `lockPath` or exit with `busy(pid)`; a lock left by a dead process is taken over. Released on exit. */
  function takeLock(lockPath, busy) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = openSync(lockPath, 'wx');
        writeSync(fd, String(process.pid));
        closeSync(fd);
        process.on('exit', () => { try { unlinkSync(lockPath); } catch { /* already gone */ } });
        return;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        const pid = Number(readFileSync(lockPath, 'utf8').trim());
        let alive = false;
        try { if (pid > 0) { process.kill(pid, 0); alive = true; } } catch (k) { alive = k.code === 'EPERM'; }
        if (alive) fail(`[${label}] ${busy(pid)}`, 1);
        unlinkSync(lockPath); // left by a process that died: take it over
      }
    }
    fail(`[${label}] could not take ${lockPath}`, 1);
  }

  return { MOCK, API_BASE, channelFor, botToken, redact, slackApi, takeLock };
}

/** The run must be this project's: its ledger names the project, and every ticket id is exactly <prefix>-<digits>. */
export function profilePrefix(prof) {
  return prof?.linear?.prefix || String(prof?.tracker?.ticketPrefix || '').replace(/-<n>$/, '') || null;
}
/** <prefix>-<digits> and nothing else: "SEL-2 EPS-77" or "SEL-1/../x" is not a ticket id of this project. */
export const ticketIdPattern = (prefix) => new RegExp(`^${String(prefix).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d+$`);
export function assertRunBelongs({ label, project, ledger, profile, ids }) {
  if (ledger?.project && ledger.project !== project) fail(`[${label}] this run's ledger is for ${ledger.project}, not ${project} — refusing to post it to ${project}'s channel`, 1);
  const prefix = profilePrefix(profile);
  if (prefix) {
    const own = ticketIdPattern(prefix);
    const foreign = [...new Set(ids.filter(Boolean))].filter((id) => !own.test(String(id)));
    if (foreign.length) fail(`[${label}] this run has ticket(s) ${foreign.slice(0, 5).join(', ')} that are not ${prefix}-… — refusing to post them to ${project}'s channel`, 1);
  }
  return prefix;
}

// Slack subtypes a person's thread reply can carry; joins, bot posts and edits notices are not replies.
export const HUMAN_SUBTYPES = new Set(['thread_broadcast', 'file_share']);
export const PAGE_LIMIT = 20;
/**
 * Read a whole thread and append to <dir>/<file> every human reply not on file yet, plus an edit row for a
 * reply whose text changed and a deleted row for one that is gone (only when the whole thread was read). The
 * bot's own posts and other bots are skipped. The whole thread is read every time, not just what came after
 * the cursor, because an edit keeps its old ts. Rows already on file are re-read just before the append, so a
 * reply is never written twice (the caller holds its run lock). Moved out of slack-window.mjs on 2026-10-16,
 * unchanged; the caller saves `newest` as its cursor and prints the partial warning.
 * Returns { rows, fresh, changed, partial, newest }.
 */
export async function readThreadReplies({ slack, channelId, threadTs, dir, file, cursor = null }) {
  const me = (await slack('auth.test', {})).user_id;
  const msgs = [];
  let next = null;
  let partial = false;
  for (let page = 0; ; page++) {
    if (page === PAGE_LIMIT) { partial = true; break; }
    const j = await slack('conversations.replies', { channel: channelId, ts: threadTs, limit: '200', ...(next ? { cursor: next } : {}) }, true);
    msgs.push(...(j.messages || []));
    next = j.response_metadata?.next_cursor || null;
    if (!j.has_more || !next) break;
  }
  const human = new Map();
  let newest = cursor || null;
  for (const m of msgs) {
    if (!m || !/^\d+\.\d+$/.test(String(m.ts)) || m.ts === threadTs) continue;
    if (!newest || tsAfter(m.ts, newest)) newest = m.ts;
    if (human.has(m.ts) || !m.user || m.user === me || m.bot_id || (m.subtype && !HUMAN_SUBTYPES.has(m.subtype))) continue;
    human.set(m.ts, m);
  }
  const sorted = [...human.values()].sort((a, b) => (tsAfter(a.ts, b.ts) ? 1 : -1));
  const onFile = new Map(readSlackReplies(dir, file).replies.map((r) => [r.ts, r]));
  const readAt = new Date().toISOString();
  const note = 'input for the manager — NOT an approval';
  const rows = [];
  let fresh = 0;
  for (const m of sorted) {
    const name = m.user_profile?.display_name || m.user_profile?.real_name || null;
    const text = String(m.text ?? '');
    const base = { ts: m.ts, user: m.user, ...(name ? { userName: name } : {}), text, ...(m.files?.length ? { files: m.files.length } : {}), readAt };
    const had = onFile.get(m.ts);
    if (!had) { rows.push({ ...base, note }); fresh++; }
    else if (had.deleted || had.text !== text) rows.push({ ...base, edit: true, ...(m.edited?.ts ? { editedAt: tsIso(m.edited.ts) } : {}), note });
  }
  if (!partial)
    for (const r of onFile.values())
      if (!r.deleted && !human.has(r.ts)) rows.push({ ts: r.ts, user: r.user, text: '', deleted: true, readAt, note: 'deleted by its author in Slack' });
  if (rows.length) appendFileSync(join(dir, file), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return { rows, fresh, changed: rows.length - fresh, partial, newest };
}
