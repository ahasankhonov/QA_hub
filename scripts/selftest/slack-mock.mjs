#!/usr/bin/env node
// A local mock of the six Slack Web API methods slack-window.mjs and slack-report.mjs call, for the selftest only. It runs in
// its own process because the selftest's checks are synchronous (spawnSync blocks the event loop a server
// needs). It listens on 127.0.0.1 only, runs each scenario step as a child process pointed at it through
// QA_SLACK_API_BASE, and prints one JSON result: per step the exit status, stdout, stderr and the requests
// it made. It never contacts Slack, and it records whether a request carried the test token, never the
// token itself.
//
//   node scripts/selftest/slack-mock.mjs <scenario.json>
//
// scenario: { token, bot: { user_id, user, team, bot_id }, channels: [ids the bot is in], pageSize?, env?,
//             steps: [{ label, cmd: [script, ...args] | null, env?, inject?: [message], edit?: [{ label, text }],
//                       remove?: [label], seed?: [{ label, text, thread?: label }], writeJson?: { path, merge },
//                       removeFromState?: { path, reply: n | 'parent' },
//                       failReplyOnce?: true | n, rateLimitOnce?: true | method }] }
// An injected message joins the thread of the first top-level post; "{{ts:<label>}}" in a later cmd is
// replaced with the ts the mock gave the injected message carrying that label. `edit` changes a labelled
// message's text the way Slack does (same ts, an `edited` stamp); `remove` deletes it from the thread. `seed` posts
// messages as the BOT, before the step runs (a top-level post, or a reply in the thread of the seeded message
// labelled `thread`): what an earlier version of a poster left behind. "{{ts:<label>}}" inside writeJson.merge
// string values is replaced the same way as in cmd.
// `failReplyOnce` makes one threaded chat.postMessage of that step fail (true: the first, n: the n-th) — a
// crash mid-sequence. `rateLimitOnce` answers the step's first request (or its first call of that method)
// with HTTP 429, Retry-After: 1 and { ok: false, error: "ratelimited" }, once. chat.delete removes the bot's
// own message (cant_delete_message for anyone else's, message_not_found when it is gone).
// `removeFromState` deletes, before the step runs, the message a poster's state file names (its reply n, or the
// thread parent): someone deleting the bot's message in Slack. A later chat.update of it gets message_not_found.

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HUB = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const sc = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const msgs = []; // { channel, ts, text, user, bot_id, thread_ts, subtype, user_profile }
const labels = {};
let n = 0;
const nextTs = () => { n++; return `${1760000000 + n}.${String(100 + n).padStart(6, '0')}`; };
let log = [];
let failAt = 0; // a step's failReplyOnce: the failAt-th threaded chat.postMessage of the step fails (crash tests)
let threaded = 0; // threaded chat.postMessage calls in this step
let rateLimit = null; // a step's rateLimitOnce: true (the next request) or a method name; cleared once used

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const method = url.pathname.replace(/^\/+/, '');
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    let body = {};
    if (req.method === 'GET') body = Object.fromEntries(url.searchParams);
    else try { body = raw ? JSON.parse(raw) : {}; } catch { body = { unparsed: raw }; }
    const authOk = req.headers.authorization === `Bearer ${sc.token}`;
    log.push({ method, http: req.method, authOk, body });
    const send = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (!authOk) return send({ ok: false, error: 'invalid_auth' });
    if (rateLimit === true || rateLimit === method) {
      rateLimit = null;
      log[log.length - 1].rateLimited = true;
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '1' });
      return res.end(JSON.stringify({ ok: false, error: 'ratelimited' }));
    }
    const inChannel = (c) => sc.channels.includes(c);
    switch (method) {
      case 'auth.test':
        return send({ ok: true, user: sc.bot.user, user_id: sc.bot.user_id, team: sc.bot.team, bot_id: sc.bot.bot_id });
      case 'chat.postMessage': {
        if (!inChannel(body.channel)) return send({ ok: false, error: 'not_in_channel' });
        if (body.thread_ts && ++threaded === failAt) return send({ ok: false, error: 'mock_reply_failure' });
        const m = { channel: body.channel, ts: nextTs(), text: body.text, user: sc.bot.user_id, bot_id: sc.bot.bot_id, ...(body.thread_ts ? { thread_ts: body.thread_ts } : {}) };
        msgs.push(m);
        return send({ ok: true, channel: body.channel, ts: m.ts });
      }
      case 'chat.update': {
        const m = msgs.find((x) => x.channel === body.channel && x.ts === body.ts);
        if (!m) return send({ ok: false, error: 'message_not_found' });
        m.text = body.text;
        return send({ ok: true, channel: body.channel, ts: m.ts });
      }
      case 'chat.delete': {
        const i = msgs.findIndex((x) => x.channel === body.channel && x.ts === body.ts);
        if (i < 0) return send({ ok: false, error: 'message_not_found' });
        if (msgs[i].user !== sc.bot.user_id) return send({ ok: false, error: 'cant_delete_message' });
        msgs.splice(i, 1);
        return send({ ok: true, channel: body.channel, ts: body.ts });
      }
      case 'conversations.history':
        return inChannel(body.channel) ? send({ ok: true, messages: [], has_more: false }) : send({ ok: false, error: 'not_in_channel' });
      case 'conversations.replies': {
        if (!inChannel(body.channel)) return send({ ok: false, error: 'not_in_channel' });
        const parent = msgs.find((x) => x.channel === body.channel && x.ts === body.ts && !x.thread_ts);
        if (!parent) return send({ ok: false, error: 'thread_not_found' });
        const key = (ts) => BigInt(ts.replace('.', ''));
        const after = body.oldest ? key(body.oldest) : -1n;
        // like Slack: the parent first, then the thread's replies oldest first
        const all = [parent, ...msgs.filter((x) => x.thread_ts === body.ts && key(x.ts) > after)].map(({ channel, ...m }) => m);
        const size = Number(sc.pageSize || body.limit || 200);
        const from = Number(body.cursor || 0);
        const page = all.slice(from, from + size);
        const more = from + size < all.length;
        return send({ ok: true, messages: page, has_more: more, ...(more ? { response_metadata: { next_cursor: String(from + size) } } : {}) });
      }
      default:
        return send({ ok: false, error: 'unknown_method' });
    }
  });
});

const runStep = (cmd, env) =>
  new Promise((done) => {
    const child = spawn('node', [join(HUB, cmd[0]), ...cmd.slice(1)], { cwd: HUB, env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
    child.on('close', (status) => { clearTimeout(timer); done({ status, stdout, stderr }); });
  });

server.listen(0, '127.0.0.1', async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const out = [];
  for (const step of sc.steps) {
    failAt = step.failReplyOnce === true ? 1 : Number(step.failReplyOnce) || 0;
    threaded = 0;
    rateLimit = step.rateLimitOnce || null;
    for (const m of step.inject || []) {
      const parent = msgs.find((x) => !x.thread_ts);
      if (!parent) throw new Error(`step "${step.label}": nothing to reply to yet`);
      const { label, ...rest } = m;
      const msg = { channel: parent.channel, ts: nextTs(), thread_ts: parent.ts, ...rest };
      msgs.push(msg);
      if (label) labels[label] = msg.ts;
    }
    for (const m of step.seed || []) {
      const parentTs = m.thread ? labels[m.thread] : null;
      if (m.thread && !parentTs) throw new Error(`step "${step.label}": no seeded message labelled ${m.thread}`);
      const msg = { channel: sc.channels[0], ts: nextTs(), text: m.text, user: sc.bot.user_id, bot_id: sc.bot.bot_id, ...(parentTs ? { thread_ts: parentTs } : {}) };
      msgs.push(msg);
      if (m.label) labels[m.label] = msg.ts;
    }
    for (const e of step.edit || []) {
      const m = msgs.find((x) => x.ts === labels[e.label]);
      if (!m) throw new Error(`step "${step.label}": no message labelled ${e.label}`);
      m.text = e.text;
      m.edited = { user: m.user, ts: nextTs() };
    }
    for (const l of step.remove || []) {
      const i = msgs.findIndex((x) => x.ts === labels[l]);
      if (i < 0) throw new Error(`step "${step.label}": no message labelled ${l}`);
      msgs.splice(i, 1);
    }
    if (step.removeFromState) {
      const st = JSON.parse(readFileSync(step.removeFromState.path, 'utf8'));
      const ts = step.removeFromState.reply === 'parent' ? st.threadTs : st.replies?.[step.removeFromState.reply]?.ts;
      const i = msgs.findIndex((x) => x.ts === ts);
      if (i < 0) throw new Error(`step "${step.label}": removeFromState found no message`);
      msgs.splice(i, 1);
    }
    if (step.writeJson) {
      const cur = existsSync(step.writeJson.path) ? JSON.parse(readFileSync(step.writeJson.path, 'utf8')) : {};
      const sub = (v) => (typeof v === 'string' ? v.replace(/\{\{ts:([^}]+)\}\}/g, (_, l) => labels[l] || `unknown-label-${l}`)
        : Array.isArray(v) ? v.map(sub) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sub(x)])) : v);
      writeFileSync(step.writeJson.path, JSON.stringify({ ...cur, ...sub(step.writeJson.merge) }, null, 2) + '\n');
    }
    if (!step.cmd) { out.push({ label: step.label, status: null, stdout: '', stderr: '', requests: [] }); continue; }
    const cmd = step.cmd.map((a) => String(a).replace(/\{\{ts:([^}]+)\}\}/g, (_, l) => labels[l] || `unknown-label-${l}`));
    log = [];
    const env = { ...process.env, ...(sc.env || {}), QA_SLACK_API_BASE: base, QA_SLACK_BOT_TOKEN: sc.token, ...(step.env || {}) };
    const r = await runStep(cmd, env);
    out.push({ label: step.label, ...r, requests: log });
    failAt = 0;
    rateLimit = null;
  }
  server.close();
  process.stdout.write(JSON.stringify({ steps: out, messages: msgs, labels }));
});
