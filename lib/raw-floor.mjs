// H-1 raw floor — does the raw intake read like the tracker's text, or like a model's summary of it?
//
// intake-assert.mjs checks the emitted spec against the raw pull, never the raw pull against the tracker.
// When a cheap model writes the "verbatim" raw itself it compresses: Alpha R7 (2026-09-10) got 50–200-char
// bodies for 1,000–3,000-char tickets and 0–1 comments for 3–9; R4-B got 33 bodies reading
// "[Ticket ALP-n - see raw fetched data]"; R4-C stitched fragments together with "...". The AC/TC counts
// of a thin raw are tiny, so H-1 passed against its own truncated reference. These checks look for the
// fingerprints of a summary instead of trusting the file.
//
// Calibrated 2026-10-15 on every _INTAKE-*-raw.json in projects/ (28 files, ~700 tickets):
//   · median body — genuine batches ran 95 / 136 / 174 / 262 chars (Alpha "Done when …" tickets, audit
//     findings, Delta) up to 8k; the summaries were 39 and 78. ~300 would refuse four genuine batches, so
//     the floor is 150: it still catches both known summaries and a 50–200 spread like R7's, and the two
//     genuine batches under it are what --allow-thin-raw is for;
//   · spec text over raw text — the highest genuine ratio was 0.96 (BET-138); R4-B was 4.5. Extracted text
//     longer than its source is impossible for a verbatim raw, so 1.25× (and ≥ 80 chars) is generous;
//   · mid-word elisions ("takeover...API's") — 30 of 33 tickets in R4-C, at most 3 of 44 (7 %) anywhere real;
//   · identical lengths — all 33 R4-B bodies were 39 chars; no genuine batch of ≥ 5 shares one length;
//   · comments (Linear/Jira `comments[]`, not Asana system stories) — genuine medians 296–851 chars.
// Every finding names the tickets and the numbers. None of these can prove a raw verbatim; they only make
// the cheap way of faking one expensive.

/** Thresholds — change them here, and re-run the calibration above and `npm run selftest`. */
export const FLOOR = {
  minTickets: 3, // the median floor needs a batch; one short ticket is just a short ticket
  medianBody: 150, // chars
  sameLenTickets: 5, // ≥ this many non-empty bodies …
  sameLenShare: 0.8, // … with this share on one exact length
  elisionTickets: 3, // ≥ this many tickets …
  elisionShare: 0.5, // … and this share of the batch with a mid-word "..." / "…"
  minComments: 8, // the comment median needs this many comments
  medianComment: 100, // chars
  sameLenComments: 5, // ≥ this many comments all on one exact length
  specOverRaw: 1.25, // spec AC/TC text > this × (title + body + comments) …
  specOverRawMinChars: 80, // … and longer by at least this much
};

const MARKER_RE =
  /\bsee (?:the )?raw\b|\braw fetched data\b|[[(]\s*(?:truncated|omitted|abridged|summari[sz]ed|summary|body omitted|content truncated)\s*[\])]/i;
const ELISION_RE = /[\p{L}\p{N}](?:\.\.\.|…)[\p{L}\p{N}]/u;
const SPEC_META_KEYS = new Set(['id', 'caseId', 'type', 'surface', 'priority', 'status', 'kind', 'verdict']);

/** The ticket body across tracker shapes — Linear/Jira `body`, Asana `task.notes`. */
export const bodyOf = (t) => String(t?.body || t?.description || t?.task?.notes || t?.notes || '');
/** Human comment bodies (Linear/Jira). Asana `stories` are mostly system events and are left out. */
export const commentsOf = (t) =>
  (Array.isArray(t?.comments) ? t.comments : []).map((c) => String(typeof c === 'string' ? c : c?.body ?? c?.text ?? ''));

export function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  if (!s.length) return 0;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const squash = (s) => String(s).replace(/\s+/g, ' ').trim();
const textOf = (v) =>
  typeof v === 'string'
    ? v
    : Array.isArray(v)
      ? v.map(textOf).join(' ')
      : v && typeof v === 'object'
        ? Object.entries(v).filter(([k]) => !SPEC_META_KEYS.has(k)).map(([, x]) => textOf(x)).join(' ')
        : '';
/** The criterion / test-case text a spec claims to have extracted, ids stripped. */
export const specTextOf = (s) => squash(textOf([s?.acs || [], s?.testCases || []]).replace(/\b(?:AC|TC)[-\s]?\d+(?:\.\d+)?\b/gi, ''));

const list = (rows, n = 8) => rows.slice(0, n).join(', ') + (rows.length > n ? ` … (+${rows.length - n})` : '');

/**
 * @param {object[]} rawList  the raw pull
 * @param {{ specById?: Map<string, object> }} [opts]  pass the spec to run the spec-over-raw check
 * @returns {{ findings: string[], stats: { tickets:number, medianBody:number, comments:number, medianComment:number } }}
 */
export function rawFloor(rawList, { specById } = {}) {
  const findings = [];
  const tickets = rawList.map((t) => ({ id: t.id, title: String(t.title ?? t.task?.name ?? ''), body: bodyOf(t), comments: commentsOf(t) }));
  const bodyLens = tickets.map((t) => t.body.length);
  const allComments = tickets.flatMap((t) => t.comments.map((c) => ({ id: t.id, len: c.length })));
  const stats = {
    tickets: tickets.length,
    medianBody: median(bodyLens),
    comments: allComments.length,
    medianComment: median(allComments.map((c) => c.len)),
  };

  // 1. a summarisation marker written into the text
  const marked = tickets
    .map((t) => ({ id: t.id, m: MARKER_RE.exec([t.body, ...t.comments].join('\n')) }))
    .filter((x) => x.m)
    .map((x) => `${x.id} ("${x.m[0]}")`);
  if (marked.length) findings.push(`summarisation marker in the raw text of ${marked.length} ticket(s): ${list(marked)} — a verbatim pull never says it was shortened`);

  // 2. a thin batch
  if (tickets.length >= FLOOR.minTickets && stats.medianBody < FLOOR.medianBody) {
    const thin = tickets.filter((t) => t.body.length < FLOOR.medianBody).sort((a, b) => a.body.length - b.body.length).map((t) => `${t.id} ${t.body.length}`);
    findings.push(
      `median body is ${stats.medianBody} chars across ${tickets.length} tickets (floor ${FLOOR.medianBody}) — thinnest: ${list(thin)}. Summarised raws ran 39–200 chars; spot-check one ticket's get_issue length`
    );
  }

  // 3. every body the same length
  const nonEmpty = bodyLens.filter((n) => n > 0);
  if (nonEmpty.length >= FLOOR.sameLenTickets) {
    const counts = new Map();
    for (const n of nonEmpty) counts.set(n, (counts.get(n) || 0) + 1);
    const [len, n] = [...counts].sort((a, b) => b[1] - a[1])[0];
    if (n / nonEmpty.length >= FLOOR.sameLenShare)
      findings.push(`${n} of ${nonEmpty.length} bodies are exactly ${len} chars long — real tickets do not share a length; that is a placeholder or a template filled in by a model`);
  }

  // 4. fragments stitched together with "..."
  const elided = tickets.filter((t) => ELISION_RE.test([t.body, ...t.comments].join('\n'))).map((t) => t.id);
  if (elided.length >= FLOOR.elisionTickets && elided.length / tickets.length >= FLOOR.elisionShare)
    findings.push(`${elided.length} of ${tickets.length} tickets have text elided mid-sentence ("word...word"): ${list(elided)} — that is an excerpt, not a copy`);

  // 5. thin or uniform comments
  if (allComments.length >= FLOOR.minComments && stats.medianComment < FLOOR.medianComment)
    findings.push(`median comment is ${stats.medianComment} chars across ${allComments.length} comments (floor ${FLOOR.medianComment}) — QA/dev comments are paragraphs; one-liners are a summary`);
  if (allComments.length >= FLOOR.sameLenComments && new Set(allComments.map((c) => c.len)).size === 1)
    findings.push(`all ${allComments.length} comments are exactly ${allComments[0].len} chars long (tickets ${list([...new Set(allComments.map((c) => c.id))])}) — written, not copied`);

  // 6. the spec holds more text than the raw it was extracted from
  if (specById) {
    const over = [];
    for (const t of tickets) {
      const s = specById.get(t.id);
      if (!s) continue;
      const specLen = specTextOf(s).length;
      const rawLen = squash([t.title, t.body, ...t.comments].join(' ')).length;
      if (specLen > rawLen * FLOOR.specOverRaw && specLen - rawLen >= FLOOR.specOverRawMinChars) over.push(`${t.id} spec ${specLen} > raw ${rawLen}`);
    }
    if (over.length)
      findings.push(
        `the spec's AC/test-case text is longer than the raw ticket it was extracted from on ${over.length} ticket(s): ${list(over)} — impossible for a verbatim raw: the raw was shortened (or the spec padded)`
      );
  }

  return { findings, stats };
}
