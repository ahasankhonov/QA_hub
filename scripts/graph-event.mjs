#!/usr/bin/env node
// The manager's only pen for run state: append ONE event to <run>-graph/_EVENTS.jsonl (append-only, R-15).
// Workers never call this; the orchestrator does, after every dispatch and every collected handoff.
//
//   node scripts/graph-event.mjs --project gamma --run R-20261013-SQ7 --node verify-GAM-114 --event dispatched \
//        --job Verifier --runtime claude-code --model claude-opus-5-5 [--ref <path>] [--tokens-total n] [--tokens-out n] [--text "…"]
//   … --node manager --event started --text "<goal>" --runtime claude-code --model <actual model> [--session <id>]
//   … --event next --text "dispatch verify-GAM-212 after executor-GAM-212 hands off"
//   … --event note --ref slack:1729000000.000100 --text "TC-1 marked out of scope" --quote "<the user's own words>"
//
// Refuses a third dispatch of the same node (2 attempts, then the manager rescues or marks it blocked).
// A rescue buys 2 more attempts, once: a second rescue and a third post-rescue dispatch are refused.
// A Slack reply (_SLACK-REPLIES.jsonl) is decided by ONE note with --ref slack:<ts> and --quote: the user's
// answer in the terminal, never the reply's own text. --text says what was decided, in the manager's words: it
// goes into the Slack digest, so it must not repeat the reply or the quote. A reply is input, never an
// approval (R-01).

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { args, fail, reportsDir } from '../lib/profile.mjs';
import { EVENTS, MAX_ATTEMPTS, graphDir, readEvents, attemptsSinceRescue, slackTs, slackReplyStatus, quoteEchoes, decisionTextEchoes } from '../lib/graph.mjs';

const { flags } = args();
if (!flags.project || !flags.run || !flags.event)
  fail('usage: graph-event.mjs --project <slug> --run <runId> --event <' + EVENTS.join('|') + '> [--node <id>] [--job] [--runtime] [--model] [--ref] [--tokens-total] [--tokens-out] [--text] [--quote] [--session] [--reports-dir]', 2);
if (!EVENTS.includes(flags.event)) fail(`[graph-event] unknown event "${flags.event}" — one of ${EVENTS.join(', ')}`, 2);
if (!['next', 'note'].includes(flags.event) && !flags.node) fail(`[graph-event] --node is required for "${flags.event}"`, 2);
if (flags.node && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(flags.node)) fail(`[graph-event] bad node id "${flags.node}"`, 2);
if (['next', 'note', 'started'].includes(flags.event) && typeof flags.text !== 'string') fail(`[graph-event] "${flags.event}" needs --text`, 2);
for (const k of ['tokens-total', 'tokens-out'])
  if (flags[k] !== undefined && !/^\d+$/.test(String(flags[k]))) fail(`[graph-event] --${k} must be a whole number (unknown stays unknown: omit it)`, 2);

const rdir = typeof flags['reports-dir'] === 'string' ? flags['reports-dir'] : reportsDir(flags.project);
const dir = graphDir(rdir, flags.run);
mkdirSync(join(dir, 'handoffs'), { recursive: true });

const prior = readEvents(dir);
const rescued = prior.some((e) => e.node === flags.node && e.event === 'rescued');
if (flags.event === 'dispatched') {
  // count since the last rescue: a rescue buys MAX_ATTEMPTS more, once — never unlimited
  const n = attemptsSinceRescue(prior, flags.node);
  if (n >= MAX_ATTEMPTS)
    fail(rescued
      ? `[graph-event] ${flags.node} was already rescued once and had ${n} attempt(s) since — mark it blocked (--event blocked), no further dispatch.`
      : `[graph-event] ${flags.node} already had ${n} attempt(s). After ${MAX_ATTEMPTS} the manager rescues it (--event rescued) or marks it blocked — no third dispatch.`, 1);
}
if (flags.event === 'rescued' && rescued) fail(`[graph-event] ${flags.node} was already rescued once — mark it blocked (--event blocked), no second rescue.`, 1);

// a decision on a Slack reply: one note per reply, with the user's own words from the terminal
const replyTs = slackTs(flags.ref);
if (typeof flags.ref === 'string' && flags.ref.startsWith('slack:') && !replyTs) fail(`[graph-event] bad ref "${flags.ref}" — a Slack reply is named slack:<ts>, the ts printed by slack-window.mjs`, 2);
if (flags.quote !== undefined && !replyTs) fail('[graph-event] --quote records the user\'s answer about one Slack reply, so it needs --ref slack:<ts>', 2);
if (replyTs) {
  if (flags.event !== 'note') fail(`[graph-event] a decision on a Slack reply is a note (--event note), not "${flags.event}"`, 2);
  const quote = typeof flags.quote === 'string' ? flags.quote.trim() : '';
  if (quote.length < 2) fail('[graph-event] --quote is required: the user\'s own words in the terminal, deciding what to do with this reply. A Slack reply is never an approval (R-01): ask the user first.', 2);
  const st = slackReplyStatus(dir, prior);
  const reply = st.replies.find((r) => r.ts === replyTs);
  if (!reply) fail(`[graph-event] slack:${replyTs} is not in ${flags.run}-graph/_SLACK-REPLIES.jsonl — read the thread first (slack-window.mjs --send or --replies)`, 1);
  const echo = quoteEchoes(quote, st.replies);
  if (echo) fail(`[graph-event] ${echo}. --quote is the user's answer in the terminal, not a Slack message: ask the user, and record their own words.`, 1);
  const textEcho = decisionTextEchoes(flags.text, quote, st.replies);
  if (textEcho) fail(`[graph-event] ${textEcho}. --text goes into the Slack digest: say what was decided in a few words of your own, without the reply or the quote.`, 1);
  const first = st.decided.find((r) => r.ts === replyTs);
  if (first) fail(`[graph-event] slack:${replyTs} was already decided (${first.decision.t}: "${first.decision.text}") — one decision per reply`, 1);
  if (reply.deleted) fail(`[graph-event] slack:${replyTs} was deleted by its author — there is nothing left to decide`, 1);
}

const ev = { t: new Date().toISOString(), event: flags.event };
if (flags.node) ev.node = flags.node;
for (const [k, key] of [['job', 'job'], ['runtime', 'runtime'], ['model', 'model'], ['ref', 'ref'], ['text', 'text'], ['session', 'session']])
  if (typeof flags[k] === 'string') ev[key] = flags[k];
if (replyTs) ev.quote = flags.quote.trim();
if (flags['tokens-total'] !== undefined) ev.tokensTotal = Number(flags['tokens-total']);
if (flags['tokens-out'] !== undefined) ev.tokensOut = Number(flags['tokens-out']);

appendFileSync(join(dir, '_EVENTS.jsonl'), JSON.stringify(ev) + '\n');
console.log(`[graph-event] ${flags.run} ${ev.node || '-'} ${ev.event}`);
