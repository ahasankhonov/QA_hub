// Fixed formats for the Slack window (scripts/slack-window.mjs). Pure functions, no I/O, so the
// selftest can check them without a token or a network. Every line is built from the trace, the grades
// and the derived run status — never from free model text beyond the clipped event fields.

import { attemptsSinceRescue, MAX_ATTEMPTS, slackTs } from './graph.mjs';

export const DIGEST_MAX = 3500; // a Slack message over ~4,000 characters is cut in the client

/** Slack mrkdwn control characters: "<!channel>" must arrive as text, never as a mention. */
export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const clip = (s, n = 140) => { const t = String(s ?? ''); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

// A canary is a planted FALSE claim about a real ticket (scripts/canary.mjs). Its text never reaches Slack: a
// reader skimming the channel would take it for a finding. The grader's canary reasons quote the claim or the
// value the reviewer read, so they become one fixed line; a literal claim is masked in every other line.
const CANARY_REASON = /(?:(?:confirmed|repeats) the planted canary|priorNote rejected it but read)[\s\S]*$/;
export function withhold(s, claims = []) {
  let t = String(s ?? '').replace(CANARY_REASON, 'failed the canary check (the planted claim is not shown here; see _GRAPH)');
  for (const c of claims) if (c) t = t.split(c).join('[canary claim withheld]');
  return t;
}

const ICON = { started: '🧪', dispatched: '🤖', handoff: '📥', 'needs-fix': '🔁', blocked: '⛔', rescued: '🛟', done: '✅', next: '➡️', note: '📝' };
const BAD = (g) => g === 'NO-VERDICT' || g === 'DISCOUNTED';

export function formatEvent(e, { events, i, grades = {}, claims = [] }) {
  const icon = ICON[e.event] || '•';
  const say = (s, n) => esc(clip(withhold(s, claims), n)); // withhold before clip, or a cut claim slips past the mask
  if (e.event === 'next') return `${icon} *Next:* ${say(e.text, 300)}`;
  // a decision on a thread reply: what was decided, never the user's quote (their words stay in the terminal)
  if (e.event === 'note' && slackTs(e.ref)) return `${icon} *Decision on a reply:* ${say(e.text, 300)}`;
  if (e.event === 'note') return `${icon} *Note:* ${say(e.text, 300)}`;
  if (e.event === 'started') return `${icon} *Run started* · ${say(e.text)}`;
  const who = `*${esc(e.node)}*${e.job ? ` (${esc(e.job)}${e.model ? ' · ' + esc(e.model) : ''})` : e.model ? ` (${esc(e.model)})` : ''}`;
  if (e.event === 'dispatched') {
    const rescued = events.slice(0, i).some((x) => x.node === e.node && x.event === 'rescued');
    return `${icon} ${who} · working · attempt ${attemptsSinceRescue(events, e.node, i)}/${MAX_ATTEMPTS}${rescued ? ' after rescue' : ''}`;
  }
  if (e.event === 'handoff') {
    const g = grades[e.node];
    if (!g) return `${icon} ${who} · handed off · not graded yet`;
    const mark = BAD(g.grade) ? '❌' : g.grade === 'pass' ? '✅' : '⚠️';
    const canary = g.reviewer ? (g.canaryChecked ? ` · canary ${g.canary || 'checked'}` : ' · no canary') : '';
    return `${icon} ${who} · ${mark} *${esc(g.grade)}* · checks ${g.checks} · findings ${g.findings}${canary}${g.reasons?.length ? `\n> ${say(g.reasons[0], 200)}` : ''}`;
  }
  return `${icon} ${who} · *${esc(e.event)}*${e.ref ? ` · ${esc(clip(e.ref, 80))}` : ''}`;
}

/** The thread's parent message: the run's current state, updated in place on every send. `waiting`: thread replies with no decision yet. */
export function headerText({ run, project, events, status, claims = [], waiting = null }) {
  const started = events.find((e) => e.event === 'started');
  return [
    `🧪 *QA run ${esc(run)}* · ${esc(project)}`,
    started?.text ? `_${esc(clip(withhold(started.text, claims), 200))}_` : null,
    `*Done* ${status.done.length} · *Running* ${status.running.length} · *To do* ${status.todo.length} · *Waiting on a human* ${status.human.length}`,
    `Bad handoffs ${status.badGrades} · Review disagreements ${status.disagreements}${waiting === null ? '' : ` · Replies waiting ${waiting}`}`,
    `Full state: \`_GRAPH-${esc(run)}.md\` · replies in this thread are read as input, never as approval`,
  ].filter(Boolean).join('\n');
}

/** The one line that answers the people who replied: how many replies were read, never what they said. */
// `changed`: how many of them are edits or deletions of earlier replies; `partial`: the read stopped at its
// page limit, so the count is a floor, not the whole thread.
export const repliesLine = ({ read, waiting, changed = 0, partial = false }) =>
  `📨 *${partial ? 'at least ' : ''}${read} new repl${read === 1 ? 'y' : 'ies'} read*${changed ? ` (${changed} edited or deleted)` : ''} · ${waiting} waiting on the QA lead · nothing changes until they decide (a reply is never an approval)`;

/**
 * ONE reply per send: every event since the cursor, then what waits on a human, then (when the send read
 * new thread replies) one count-only line. Clipped to `max` characters with "+N more" pointing at _GRAPH,
 * so a long wave never floods the thread.
 */
export function digestText({ run, events, from, grades = {}, status, at = new Date(), max = DIGEST_MAX, claims = [], replies = null }) {
  const lines = events.slice(from).map((e, k) => formatEvent(e, { events, i: from + k, grades, claims }));
  const head = `*Update ${at.toISOString().slice(11, 16)}Z* · ${lines.length} event${lines.length === 1 ? '' : 's'}`;
  const waiting = status?.human?.length ? [`👀 *Waiting on a human (${status.human.length}):*`, ...status.human.slice(0, 5).map((h) => `• ${esc(clip(withhold(h, claims), 200))}`), ...(status.human.length > 5 ? [`• +${status.human.length - 5} more`] : [])] : [];
  const out = [head];
  let used = head.length;
  const tail = [...waiting, ...(replies?.read ? [repliesLine(replies)] : [])];
  const tailLen = tail.join('\n').length + 80;
  let shown = 0;
  for (const l of lines) {
    if (used + l.length + 1 + tailLen > max) break;
    out.push(l);
    used += l.length + 1;
    shown++;
  }
  if (shown < lines.length) out.push(`… +${lines.length - shown} more in \`_GRAPH-${esc(run)}.md\``);
  out.push(...tail);
  return { text: out.join('\n').slice(0, max), events: lines.length, shown };
}
