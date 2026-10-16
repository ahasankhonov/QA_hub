#!/usr/bin/env node
// Lint requirements-analyst test plans (_PLAN-<run>-<ticket>.json) before the executor runs them.
//
//   node scripts/plan-lint.mjs <plan.json|dir> [...]          lint files / every _PLAN-*.json in a dir
//   node scripts/plan-lint.mjs --project <slug> --run <runId> lint that run's plans
//   [--strict]   warnings fail too        [--json]   machine-readable output
//   [--profile <file>]  the profile whose `accounts` a mutatesAccount case is checked against (default:
//                       --project, else the projects/<slug>/ in the plan's path, else the plan's `project`)
//
// Errors (exit 1) — a runnable case the verifier cannot judge:
//   no caseId / duplicate caseId · no expected result.
// Errors (exit 1) — a runnable case that would break a shared account (2026-10-16, see SHARED ACCOUNTS):
//   mutatesAccount with no `account` · mutatesAccount on a profile `accounts` entry · no profile to check.
// Warnings (exit 0 unless --strict) — test-design gaps, calibrated on the 305 plans on disk
// (2026-10-16) so each one stays rare and means something:
//   no-oracle (no verifyBy and no evidence) · vague-expected · unbounded-wait · vague-data · expected-restates-action · no-precond
//   no-negative-case · mutating-no-persistence · implied-no-question
//   asserts-trigger · confirm-as-check · check-needs-navigation   (2026-10-16; 0 hits on the 1,949 runnable
//   cases on disk, so a hit means something)
//
// Ideas from petrkindlmann/qa-skills (MIT): test-case-management/references/linting.md (ambiguous
// steps, non-observable expected results), ai-test-generation (every rule gets a negative case,
// persistence oracle after a write, explicit vs implied requirements). Rewritten for our plan schema,
// which also spells fields as precond|preconditions, actions|action, verifyBy|evidence.
// The last three are from LambdaTest/agent-skills (MIT, kanecli-skill/references/objectives-cookbook.md
// §1.1): end on a look at the resulting state, never on the control that caused it, a UI "confirm", or a
// check that has to travel somewhere first.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HUB = join(dirname(fileURLToPath(import.meta.url)), '..');

const text = (v) => (v == null ? '' : Array.isArray(v) ? v.map(text).join(' \n ') : typeof v === 'object' ? JSON.stringify(v) : String(v));
const blank = (v) => text(v).trim() === '' || text(v).trim().toLowerCase() === 'null';

// An expected result that names nothing observable. Only fires when that is ALL it says.
const VAGUE_EXPECTED = /^(it |the (page|screen|feature|flow|app) )?(works|work|functions|behaves|loads|displays|is displayed|is shown|shows|renders|succeeds|passes)?\s*(correctly|properly|fine|as expected|as intended|as designed|normally|successfully|ok|okay)?\.?$|^(as expected|correct|ok|okay|success|successful|no (errors?|issues|problems))\.?$/i;
const VAGUE_EXPECTED_SHORT = /\b(as expected|as intended|works (correctly|properly|fine)|behaves correctly|displays? (correctly|properly)|is correct|should work)\b/i;
// "wait a bit", "wait some time", a bare trailing "wait" — no number, no condition.
const UNBOUNDED_WAIT = /\bwait(ing)?\s+(a (bit|moment|while|little|few (seconds|moments))|some (time|seconds)|briefly|for a while|long enough)\b|\bwait\s*[.;]?\s*$/i;
// "enter valid data", "use some test values" — the case is not reproducible without the value.
const VAGUE_DATA = /\b(enter|type|fill( in)?|input|use|provide|submit)\s+(some|any|valid|invalid|appropriate|random|test|dummy|sample|correct|proper)\s+(data|value|values|info|information|details|input|text|credentials)\b/i;
// A case that is about failure, refusal or absence. Used only to decide whether a plan has ANY.
const NEGATIVE = /negative|invalid|reject|error|refus|denied|forbidden|\b40[0134]\b|\b422\b|cannot|can't|must not|should not|does not|doesn't|never|not (shown|visible|allowed|saved|possible|accepted)|no longer|empty|blank|missing|wrong|duplicate|expired|unauthori|disabled|block|limit|exceed|too (long|short|many)|boundary|edge/i;
// After a write: proof it stuck (reload, re-open, read it back) — the persistence oracle.
const PERSIST = /reload|refresh|re-?open|re-?visit|log ?out|relaunch|re-?login|re-?fetch|\bGET\b|persist|after navigat|navigate (away|back)|come back|kill|read (it )?back|database|\bDB\b|still (shows|there|present|saved)/i;

// The expected result is only the control that triggers the action ("Submit button is visible"). Paired
// with an interaction in the actions: on success that control often disappears, so the check fails when
// the feature works and passes when it did nothing. A pure presence case (open a page, see a button) is fine.
const TRIGGER_ONLY = /^(the |a |an )?([\w"'“”‘’ .&/+-]{1,40} )?(button|btn|link|tab|icon|menu( item)?|option|toggle|switch|checkbox|cta|control|dropdown)( ["'“‘][^"'”’]{1,40}["'”’])?( is| are| remains?| stays?)? (still )?(visible|displayed|shown|present|enabled|clickable|tappable|available|appears?|exists?|rendered)\.?$/i;
const INTERACT = /\b(click|tap|press|submit|save|send|confirm|upload|place|pay|delete|remove|apply)\b/i;
// The expected result is pressing a commit control ("Confirm the dialog", "Click OK to confirm") — an
// action, not an observation of the outcome.
const CONFIRM_ONLY = /^(then |and )?(user )?(confirms?|confirmed|accepts?|accepted|dismiss(es)?|click(s|ed)? (on )?["'“]?(ok|okay|yes|confirm|continue|done|accept)["'”]?|tap(s|ped)? ["'“]?(ok|okay|yes|confirm|continue|done)["'”]?|press(es)? ["'“]?(ok|okay|yes|confirm)["'”]?)\b[^.;]{0,50}\.?$/i;
// The expected result hides a trip ("verify by checking Order History", "open Orders and check …"): the
// route belongs in the actions, so it is the same on every run and a FAIL can be told from a wrong turn.
// Checked on `expected` only — a verifyBy naming where the evidence is recorded is normal.
const NAV_CHECK = /\b(by (checking|opening|going to|navigating to|visiting|looking (at|in)|switching to|re-?opening)|(go(es|ing)? (back )?to|navigat(e|ing) to|open(ing)?|visit(ing)?|switch(ing)? to|re-?open(ing)?) (the )?[\w"'“”‘’ /&-]{1,40}? (and|then) (check|verify|confirm|see|look|assert|observe|find)|(check|verify|confirm|look|assert)(ed|s)? (it |this |that |the [\w ]{1,20} )?(appears |shows |is listed |exists )?(in|on|via|under) (the )?[\w"'“”‘’ /&-]{1,30}? (page|screen|tab|section|history|list|inbox|dashboard|drawer|panel|view|menu))\b/i;

const stop = new Set('the a an to of on in and or is be it its this that then with for at by as from into click tap press select open enter type'.split(' '));
// crude stem so "Click Save" / "Save clicked" compare equal
const words = (s) => text(s).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).map((w) => w.replace(/(ed|ing|es|s)$/, '')).filter((w) => w.length > 2 && !stop.has(w));

// ── SHARED ACCOUNTS (2026-10-16, qa-skills second read, idea D) ─────────────────────────────────────
// A case that changes the account it logs in with (password, email, phone, profile fields, plan or
// subscription, payment method, settings, onboarding state, deletion) breaks every later case and run on
// that account; Zeta lost its shared A/B accounts that way. Such a case sets
// `mutatesAccount: true` and names in `account` the account it changes (normally the one it logs in with;
// for an admin editing a user, the user). It is an ERROR when it names none (the check would be
// vacuous) or when that account is an entry of the profile's `accounts` block: by key (`staging_dealer`;
// case, spaces, _ and - folded) or by an email, phone or username inside the entry. A `+alias` of a listed
// email is a different, disposable account and passes. An `account` that names an alias the plan defines
// (plan.accounts / actors / personas, e.g. "student_paid" → "A +998…") is checked through that alias.
// Not accounts: arrays (roles, test cards), note / pattern / password / test_cards keys, and an object
// entry with no identifier and no credential (epsilon `guest`: "no login"). Messages name the key and
// mask emails and phones; secrets are never read into the result. Plans without the field are unchanged.
const NOT_ACCOUNT_KEY = /^notes?$|note$|pattern$|password$|secret|token|^roles$|^test_?cards/i;
const ID_FIELDS = ['email', 'emails', 'phone', 'phones', 'username', 'user', 'login', 'handle'];
const NO_ACCOUNT = /^(n\/?a|none|null|tbd|tba|unknown|-+|—|\?+)$/i;
const EMAILS = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi;
const strs = (v) => (v == null ? [] : Array.isArray(v) ? v.flatMap(strs) : typeof v === 'object' ? Object.values(v).flatMap(strs) : [String(v)]);
const foldKey = (s) => String(s).toLowerCase().replace(/[\s_-]+/g, ' ').trim();
const digitsOf = (s) => String(s).replace(/\D/g, '');
const emailsIn = (s) => (String(s).match(EMAILS) || []).map((e) => e.toLowerCase());
// Phones in free text: digit runs of 7+ once emails are cut out (epoch-stamped aliases would read as phones).
const phonesIn = (s, re = /\+?\d[\d\s().-]{5,}\d/g) => (String(s).replace(EMAILS, ' ').match(re) || []).map(digitsOf).filter((d) => d.length >= 7);
const samePhone = (a, b) => a === b || (Math.min(a.length, b.length) >= 9 && (a.endsWith(b) || b.endsWith(a)));
const maskEmail = (e) => e.replace(/^([^@]{0,2})[^@]*@/, '$1***@');
const maskPhone = (d) => `+${d.slice(0, 3)}***${d.slice(-2)}`;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The names an `account` value can mean: the whole value, each "/ , ; | or and then"-separated part, the
// head of each part before "(" "[" ":" or " — ", and (outside an email) each "+"-joined name ("free+premium").
// Exact matches only, so "A (harness role …)" and "B" hit key A / B but "a fresh alias" does not.
function accountNames(v) {
  const out = new Set();
  const add = (s) => { const n = foldKey(s); if (n) out.add(n); };
  add(v);
  for (const part of String(v).split(/[/,;|]|\s(?:or|and|then|vs)\s/i)) {
    add(part);
    const head = part.split(/\s*[([{:]|\s[—–-]\s/)[0];
    add(head);
    if (!head.includes('@')) for (const p of head.split('+')) add(p);
  }
  return out;
}

// The shared accounts a profile lists: [{ key, fold, emails:Set, phones:[digits], usernames:[] }].
export function sharedAccounts(profile) {
  const block = profile && typeof profile === 'object' ? profile.accounts : null;
  if (!block || typeof block !== 'object' || Array.isArray(block)) return [];
  const out = [];
  for (const [key, v] of Object.entries(block)) {
    if (NOT_ACCOUNT_KEY.test(key) || v == null || Array.isArray(v) || !['string', 'object'].includes(typeof v)) continue;
    const a = { key, fold: foldKey(key), emails: new Set(), phones: [], usernames: [] };
    if (typeof v === 'string') {
      // "admin@host / Password1! (note)": the email, and only a +international phone (a date is not one)
      emailsIn(v).forEach((e) => a.emails.add(e));
      a.phones.push(...phonesIn(v, /\+\d[\d\s().-]{6,}\d/g));
    } else {
      for (const f of ID_FIELDS) for (const s of strs(v[f])) {
        const em = emailsIn(s);
        em.forEach((e) => a.emails.add(e));
        if (/^phones?$/.test(f)) { const d = digitsOf(s); if (d.length >= 7) a.phones.push(d); }
        else if (/^(username|user|login|handle)$/.test(f) && !em.length && s.trim().length >= 3) a.usernames.push(s.trim().toLowerCase());
      }
      const credential = Object.keys(v).some((k) => /pass|token|secret/i.test(k));
      if (!a.emails.size && !a.phones.length && !a.usernames.length && !credential) continue; // "guest: no login"
    }
    out.push(a);
  }
  return out;
}

// Which listed accounts a mutating case changes. Only `account` is read (+ what a plan-level alias maps it
// to): `actor` is who logs in, and an admin on the shared admin account resetting a fixture's password
// (alpha 612-7) changes the fixture, not the admin.
function sharedHits(s, plan, accounts) {
  const named = strs(s.account).map((x) => x.trim()).filter((x) => x && !NO_ACCOUNT.test(x));
  const viaPlan = [];
  for (const m of ['accounts', 'actors', 'personas']) {
    const map = plan[m];
    if (!map || typeof map !== 'object' || Array.isArray(map)) continue;
    for (const [k, mv] of Object.entries(map)) if (named.some((v) => accountNames(v).has(foldKey(k)))) viaPlan.push(...strs(mv));
  }
  const keyVals = [...named, ...viaPlan];
  const names = new Set(keyVals.flatMap((v) => [...accountNames(v)]));
  const idText = keyVals.join(' \n ');
  const emails = new Set(emailsIn(idText));
  const phones = phonesIn(idText);
  const low = idText.toLowerCase();
  const hits = [];
  for (const a of accounts) {
    if (names.has(a.fold)) { hits.push(`"${a.key}" (by key)`); continue; }
    const e = [...a.emails].find((x) => emails.has(x));
    if (e) { hits.push(`"${a.key}" (by email ${maskEmail(e)})`); continue; }
    const p = a.phones.find((x) => phones.some((y) => samePhone(x, y)));
    if (p) { hits.push(`"${a.key}" (by phone ${maskPhone(p)})`); continue; }
    if (a.usernames.some((u) => new RegExp(`(?<![a-z0-9._@+-])${escapeRe(u)}(?![a-z0-9._@+-])`).test(low))) hits.push(`"${a.key}" (by username)`);
  }
  return { named, hits };
}

export function lintPlan(plan, file = '<plan>', opts = {}) {
  const errors = [];
  const warnings = [];
  const E = (code, caseId, msg) => errors.push({ file, code, caseId, msg });
  const W = (code, caseId, msg) => warnings.push({ file, code, caseId, msg });
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    E('not-a-plan', null, 'plan is not a JSON object');
    return { errors, warnings, cases: 0 };
  }
  const steps = Array.isArray(plan.steps) ? plan.steps.filter((s) => s && typeof s === 'object') : null;
  if (!steps) {
    W('no-steps', null, 'no steps[] — nothing for the executor to run (fine for a hold/notes-only plan, otherwise re-plan)');
    return { errors, warnings, cases: 0 };
  }
  const planPrecond = ['commonPrecond', 'fixtures', 'preconditions', 'precond', 'accountRole', 'harness'].some((k) => !blank(plan[k]));
  // runnable:false, a hold, or an EPS-style disposition of DEFERRED / NA / HELD is not run this pass.
  const runnable = steps.filter((s) => s.runnable !== false && s.runnable !== 'false' && !s.hold && !/^(DEFERRED|NA|HELD)\b/.test(text(s.disposition)));
  const seen = new Set();
  for (const s of steps) {
    const id = s.caseId;
    if (blank(id)) E('no-caseId', null, 'a step has no caseId — the verifier cannot record a verdict for it');
    else if (seen.has(id)) E('duplicate-caseId', id, 'caseId used twice in one plan — the second verdict overwrites the first');
    else seen.add(id);
  }
  // opts.profile: the profile object, or a function returning it — called only when a case mutates its account.
  let shared;
  const sharedList = () => {
    if (shared === undefined) {
      const p = typeof opts.profile === 'function' ? opts.profile() : opts.profile;
      shared = p && typeof p === 'object' ? { list: sharedAccounts(p), alias: !blank(p.accounts?.aliasPattern) } : null;
    }
    return shared;
  };
  for (const s of runnable) {
    const id = s.caseId || '?';
    if (s.mutatesAccount === true || s.mutatesAccount === 'true') {
      const acc = sharedList();
      const { named, hits } = sharedHits(s, plan, acc ? acc.list : []);
      if (!named.length)
        E('mutates-account-no-account', id, 'case changes an account (mutatesAccount) but names no `account` — name the account it changes (a disposable +alias), so the shared-account check is not vacuous');
      else if (!acc)
        E('mutates-account-no-profile', id, 'case changes its account (mutatesAccount) but no profile was found to check it against — run with --project <slug> or --profile <file>');
      else if (hits.length)
        E('mutates-shared-account', id, `case changes an account (mutatesAccount) and that account is the shared profile account ${hits.join(', ')} — every later case and run on it inherits the change; use a fresh disposable +alias account${acc.alias ? ' (profile accounts.aliasPattern)' : ''}`);
    }
    const expected = text(s.expected).trim();
    const actions = text(s.actions ?? s.action);
    if (!expected) { E('no-expected', id, 'runnable case with no expected result — nothing to compare the run against'); continue; }
    if (blank(s.verifyBy) && blank(s.evidence)) W('no-oracle', id, 'runnable case with neither verifyBy nor evidence — say what the executor records and how the verifier judges it (R-09)');
    if (VAGUE_EXPECTED.test(expected) || (expected.length < 60 && VAGUE_EXPECTED_SHORT.test(expected)))
      W('vague-expected', id, `expected "${expected.slice(0, 80)}" names nothing observable — state the text, value, state or status code that proves it`);
    if (UNBOUNDED_WAIT.test(actions)) W('unbounded-wait', id, 'an action waits with no bound — wait for a named condition, with a timeout');
    if (VAGUE_DATA.test(actions)) W('vague-data', id, `vague test data ("${actions.match(VAGUE_DATA)[0]}") — give the exact value so the case reproduces`);
    if (actions) {
      const a = new Set(words(actions));
      const e = words(expected);
      if (e.length && e.length <= 4 && e.every((w) => a.has(w))) W('expected-restates-action', id, `expected "${expected.slice(0, 80)}" only repeats the action — what should be observable after it?`);
    }
    if (TRIGGER_ONLY.test(expected) && INTERACT.test(actions))
      W('asserts-trigger', id, `expected "${expected.slice(0, 80)}" only checks the control the action uses — on success it often disappears; assert the outcome (the saved value, the new row, the message)`);
    if (CONFIRM_ONLY.test(expected))
      W('confirm-as-check', id, `expected "${expected.slice(0, 80)}" is a click, not a check — move it to the actions and state what the screen shows after it`);
    if (NAV_CHECK.test(expected))
      W('check-needs-navigation', id, `expected hides a navigation ("${expected.match(NAV_CHECK)[0]}") — put the route in the actions and keep expected a look at the page you land on`);
    if (!planPrecond && blank(s.precond) && blank(s.preconditions) && blank(s.account) && blank(s.actor) && blank(s.who))
      W('no-precond', id, 'no precondition (account, data, starting screen) on the case or the plan');
    if (s.basis === 'implied' && !(Array.isArray(plan.scopeQuestions) && plan.scopeQuestions.length) && blank(s.scopeQuestion))
      W('implied-no-question', id, 'case tests an implied requirement but the plan asks no scope question — a FAIL on it cannot be a Reopen on its own');
  }
  if (runnable.length >= 3) {
    const planNeg = ['negativeEdge', 'edgeCases', 'edgeVariations'].some((k) => !blank(plan[k]) && plan[k] !== false);
    const anyNeg = planNeg || runnable.some((s) => s.negativeEdge === true || s.kind === 'negative' || NEGATIVE.test(text([s.caseId, s.title, s.actions ?? s.action, s.expected])));
    if (!anyNeg) W('no-negative-case', null, `${runnable.length} runnable cases and not one negative/edge case — add one per rule-bearing AC (invalid input, refusal, empty state, boundary)`);
  }
  const writes = runnable.filter((s) => s.mutating === true);
  if (writes.length && !runnable.some((s) => PERSIST.test(text([s.actions ?? s.action, s.expected, s.verifyBy, s.evidence]))))
    W('mutating-no-persistence', writes[0].caseId || null, `${writes.length} case(s) change data and none checks it stuck — add a reload / re-open / read-back oracle`);
  return { errors, warnings, cases: runnable.length };
}

function collect(args, flags) {
  const files = [];
  if (flags.project && flags.run) {
    const dir = join(HUB, 'projects', flags.project, 'qa-reports');
    if (existsSync(dir)) for (const e of readdirSync(dir)) if (e.startsWith(`_PLAN-${flags.run}-`) && e.endsWith('.json')) files.push(join(dir, e));
  }
  for (const a of args) {
    if (!existsSync(a)) { console.error(`[plan-lint] no such path: ${a}`); process.exit(2); }
    if (statSync(a).isDirectory()) { for (const e of readdirSync(a)) if (/^_PLAN-.*\.json$/.test(e)) files.push(join(a, e)); }
    else files.push(a);
  }
  return files.sort();
}

// The profile a plan's mutatesAccount cases are checked against: --profile, else --project, else the
// projects/<slug>/ in the plan's path (what qa-gates passes), else the plan's own `project` slug.
const readJson = (p) => { try { return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null; } catch { return null; } };
function profileFor(file, plan, flags) {
  if (flags.profile) return readJson(resolve(flags.profile));
  const fromPath = [...resolve(file).matchAll(/[\\/]projects[\\/]([^\\/]+)[\\/]/g)].pop()?.[1];
  for (const slug of [flags.project, fromPath, typeof plan.project === 'string' ? plan.project : null]) {
    if (!slug || !/^[\w.-]+$/.test(slug)) continue;
    const p = readJson(join(HUB, 'profiles', `${slug}.json`));
    if (p) return p;
  }
  return null;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argv = process.argv.slice(2);
  const flags = {};
  const args = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--strict' || a === '--json') flags[a.slice(2)] = true;
    else if (a === '--project' || a === '--run' || a === '--profile') flags[a.slice(2)] = argv[++i];
    else args.push(a);
  }
  if (flags.profile && !readJson(resolve(flags.profile))) {
    console.error(`[plan-lint] --profile ${flags.profile}: not found or not JSON`);
    process.exit(2);
  }
  const files = collect(args, flags);
  if (!files.length) {
    console.error('usage: plan-lint.mjs <plan.json|dir> … | --project <slug> --run <runId>  [--profile <file>] [--strict] [--json]  (no plans found)');
    process.exit(2);
  }
  const all = { errors: [], warnings: [], plans: files.length, cases: 0 };
  for (const f of files) {
    let plan;
    try { plan = JSON.parse(readFileSync(f, 'utf8')); } catch (e) { all.errors.push({ file: f, code: 'bad-json', caseId: null, msg: e.message }); continue; }
    const r = lintPlan(plan, f, { profile: () => profileFor(f, plan, flags) });
    all.errors.push(...r.errors); all.warnings.push(...r.warnings); all.cases += r.cases;
  }
  if (flags.json) console.log(JSON.stringify(all, null, 1));
  else {
    for (const x of all.errors) console.log(`✗ ${basename(x.file)}${x.caseId ? ` ${x.caseId}` : ''} [${x.code}] ${x.msg}`);
    for (const x of all.warnings) console.log(`⚠ ${basename(x.file)}${x.caseId ? ` ${x.caseId}` : ''} [${x.code}] ${x.msg}`);
    console.log(`[plan-lint] ${all.plans} plan(s), ${all.cases} runnable case(s): ${all.errors.length} error(s), ${all.warnings.length} warning(s)`);
  }
  if (all.errors.length || (flags.strict && all.warnings.length)) process.exit(1);
}
