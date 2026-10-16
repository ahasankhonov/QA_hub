// Selftest section for qa-skills second read, idea D "accounts" (2026-10-16, see _IDEAS-FROM-REPOS.md):
// a plan case that changes its account (`mutatesAccount: true`) must name that `account`, and it must not be
// one of the profile's shared `accounts` (by key, or by an email / phone / username inside the entry).
// scripts/plan-lint.mjs is the gate (qa-gates runs it on every run that has plans).
// Run alone: node scripts/selftest/run-section.mjs scripts/selftest/qaskills2-accounts.mjs
//
// Every bad input is a fixture profile + plan in TMP with one mutation; the good inputs prove the check
// stays out of the way of disposable +alias accounts, non-mutating cases and every plan without the field.

import { mkdirSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { lintPlan, sharedAccounts } from '../plan-lint.mjs';

export default function section(h) {
  const { check, assert, mustReject, mustAccept, run, w, TMP, HUB } = h;
  const SUB = 'qaskills2-accounts';
  rmSync(join(TMP, SUB), { recursive: true, force: true });
  mkdirSync(join(TMP, SUB), { recursive: true });

  // Shapes copied from the live profiles: a alpha-style "email / password" string, a beta-style phone
  // object, an email+password object, a username gate, and the entries that are NOT accounts.
  const SECRETS = ['Secret123!', 'HUNTER2-not-printed', 'gatepass-not-printed', 'Pw!2026-not-printed'];
  const profile = {
    slug: 'fixture',
    accounts: {
      note: 'shared fixtures; support@shared.example is the inbox',
      staging_dealer: 'dealer@shared.example / Secret123! (Test Dealer, subdomain test-dealer)',
      A: { phone: '+998 90 123 45 67', role: 'student (has purchases)' },
      owner: { email: 'Owner.QA@Shared.Example', password: 'HUNTER2-not-printed', note: 'real account' },
      gate: { username: 'fixture-gate', password: 'gatepass-not-printed' },
      guest: { note: 'no login — Continue as Guest' },
      aliasPattern: 'qa+<tag>@shared.example — disposable',
      sharedPassword: 'Pw!2026-not-printed',
      test_cards_uat: ['1363840922445543', '1973028358426285'],
      roles: ['admin', 'viewer'],
    },
  };
  const PROFILE = w(`${SUB}/profile.json`, profile);
  const step = (caseId, extra = {}) => ({
    caseId,
    surface: 'app.shared.example',
    precond: 'logged in on /settings',
    actions: 'Set the display name to "QA 7", click Save, reload the page',
    expected: 'The display name reads "QA 7" after the reload',
    verifyBy: '[data-test=display-name] text after reload',
    ...extra,
  });
  const plan = (steps, extra = {}) => ({ ticketId: 'SELF-D', runId: 'R-SELF-D', steps, ...extra });
  let n = 0;
  const put = (p, dir = SUB) => w(`${dir}/_PLAN-R-SELF-D-${++n}.json`, p);
  const lint = (p, argv = ['--profile', PROFILE]) => run('plan-lint.mjs', [...argv, put(p)]);
  const errCodes = (p) => lintPlan(p, 'x', { profile }).errors.map((e) => e.code);
  const noSecrets = (res, what) => {
    const out = (res.stdout || '') + (res.stderr || '');
    for (const s of SECRETS) assert(!out.includes(s), `${what}: printed a secret value`);
    assert(!/owner\.qa@|dealer@shared|998901234567|\+998 90 123 45 67/i.test(out), `${what}: printed an unmasked email or phone`);
  };

  console.log('\nRepo ideas (qa-skills 2nd read): accounts — a case that changes its account must not use a shared one');

  check('accounts: the fixture profile parses to exactly the four accounts (note/aliasPattern/password/test_cards/roles/guest are not)', () => {
    const keys = sharedAccounts(profile).map((a) => a.key);
    assert(JSON.stringify(keys) === JSON.stringify(['staging_dealer', 'A', 'owner', 'gate']), `parsed: ${keys.join(', ')}`);
    const json = JSON.stringify(sharedAccounts(profile), (k, v) => (v instanceof Set ? [...v] : v));
    for (const s of SECRETS) assert(!json.includes(s), 'a secret value was read into the account list');
  });

  // ── known-bad: each must be rejected ──────────────────────────────────────────────────────────────
  check('accounts: mutating case on a listed KEY → mutates-shared-account (also "A (harness role …)" and "Staging Dealer")', () => {
    for (const account of ['staging_dealer', 'Staging Dealer', 'A (harness role student_paid)', 'free / staging-dealer']) {
      const res = lint(plan([step('D-1', { mutatesAccount: true, account })]));
      mustReject(res, '[mutates-shared-account]', `account "${account}"`);
      noSecrets(res, `account "${account}"`);
    }
  });

  check('accounts: mutating case on a listed EMAIL in different case → rejected, named by key, email masked', () => {
    const res = lint(plan([step('D-2', { mutatesAccount: true, account: '  OWNER.qa@shared.EXAMPLE  (real one)' })]));
    mustReject(res, '[mutates-shared-account]', 'listed email, other case');
    assert(res.stdout.includes('"owner" (by email ow***@shared.example)'), `not named by key with a masked email:\n${res.stdout.slice(0, 400)}`);
    noSecrets(res, 'listed email');
    const str = lint(plan([step('D-2b', { mutatesAccount: true, account: 'Dealer@Shared.Example' })]));
    mustReject(str, '"staging_dealer" (by email de***@shared.example)', 'email inside a alpha-style "email / password" string');
    noSecrets(str, 'string entry');
  });

  check('accounts: mutating case on a listed PHONE (spaced, compact, local format) → rejected, phone masked', () => {
    for (const account of ['+998901234567', '998 90 123-45-67', '90 123 45 67 (student)']) {
      const res = lint(plan([step('D-3', { mutatesAccount: true, account })]));
      mustReject(res, '"A" (by phone +998***67)', `phone "${account}"`);
      noSecrets(res, `phone "${account}"`);
    }
  });

  check('accounts: mutating case naming NO account (missing, blank, "n/a") → mutates-account-no-account', () => {
    for (const extra of [{}, { account: '  ' }, { account: 'n/a' }, { account: [] }]) {
      const res = lint(plan([step('D-4', { mutatesAccount: true, actor: 'dealer', ...extra })]));
      mustReject(res, '[mutates-account-no-account]', `account ${JSON.stringify(extra.account)}`);
    }
  });

  check('accounts: a listed username and a plan alias that maps to a listed account are rejected too', () => {
    mustReject(lint(plan([step('D-5', { mutatesAccount: true, account: 'fixture-gate' })])), '"gate" (by username)', 'username');
    const viaAlias = plan([step('D-6', { mutatesAccount: 'true', account: 'student_paid' })], { accounts: { student_paid: 'A +998901234567', student_fresh: 'qa+fresh@shared.example' } });
    mustReject(lint(viaAlias), '"A"', 'plan.accounts alias → A');
  });

  check('accounts: a mutating case with no profile to check against → mutates-account-no-profile', () => {
    const res = run('plan-lint.mjs', [put(plan([step('D-7', { mutatesAccount: true, account: 'qa+r22@shared.example' })]))]);
    mustReject(res, '[mutates-account-no-profile]', 'TMP path, no --profile');
    assert(errCodes(plan([step('D-7', { mutatesAccount: true, account: 'x' })])).length === 0, 'fixture profile should accept "x"');
    assert(lintPlan(plan([step('D-7', { mutatesAccount: true, account: 'x' })]), 'x').errors.some((e) => e.code === 'mutates-account-no-profile'), 'lintPlan with no profile accepted a mutating case');
  });

  check('accounts: the profile is found from projects/<slug>/ in the plan path (what qa-gates passes)', () => {
    const live = readdirSync(join(HUB, 'profiles')).filter((f) => f.endsWith('.json'))
      .map((f) => ({ slug: f.slice(0, -5), list: sharedAccounts(JSON.parse(readFileSync(join(HUB, 'profiles', f), 'utf8'))) }))
      .find((p) => p.list.length && /^[\w.-]+$/.test(p.slug));
    assert(live, 'no live profile with an accounts block to infer');
    const key = live.list[0].key;
    const dir = `${SUB}/projects/${live.slug}/qa-reports`;
    const res = run('plan-lint.mjs', [put(plan([step('D-8', { mutatesAccount: true, account: key })]), dir)]);
    mustReject(res, `"${key}" (by key)`, `inferred profile ${live.slug}`);
    mustAccept(run('plan-lint.mjs', [put(plan([step('D-8b', { mutatesAccount: true, account: 'qa+selftest-d8b@nowhere.example' })]), dir)]), 'inferred profile, disposable alias');
  });

  check('accounts: --profile that does not exist is a usage error (exit 2), not a silent pass', () => {
    const res = run('plan-lint.mjs', ['--profile', join(TMP, SUB, 'missing.json'), put(plan([step('D-9')]))]);
    assert(res.status === 2, `exit ${res.status}: ${(res.stdout + res.stderr).slice(0, 300)}`);
  });

  // ── known-good: each must be accepted ─────────────────────────────────────────────────────────────
  check('accounts: mutating case on a +alias of a listed email (and on the aliasPattern) → accepted', () => {
    for (const account of ['owner.qa+r22-t3@shared.example', 'Dealer+r22@Shared.Example', 'qa+r22-t3@shared.example (fresh, per profile aliasPattern)', 'a fresh +alias account qa+r22@shared.example']) {
      mustAccept(lint(plan([step('G-1', { mutatesAccount: true, account })])), `alias "${account}"`);
    }
  });

  check('accounts: a NON-mutating case on a shared account → accepted (also mutatesAccount:false, and a held mutating case)', () => {
    mustAccept(lint(plan([step('G-2', { account: 'staging_dealer' })])), 'no mutatesAccount');
    mustAccept(lint(plan([step('G-3', { mutatesAccount: false, account: 'owner.qa@shared.example' })])), 'mutatesAccount:false');
    mustAccept(lint(plan([step('G-4', { mutatesAccount: true, account: 'A', runnable: false, probePlan: 'n/a' })])), 'runnable:false is not run this pass');
  });

  check('accounts: entries that are not accounts never match (guest, aliasPattern, test cards, roles, note)', () => {
    for (const account of ['guest', 'aliasPattern', 'test_cards_uat', 'admin', 'support@shared.example', '1363840922445543']) {
      const c = errCodes(plan([step('G-5', { mutatesAccount: true, account })]));
      assert(!c.length, `account "${account}" → ${c.join(', ')}`);
    }
  });

  check('accounts: an old plan without the field lints exactly as before and never reads the profile', () => {
    const old = plan([step('O-1', { account: 'staging_dealer', mutating: true }), step('O-2', { account: 'A' }), step('O-3', { expected: 'Error "Name is required" under the field' })]);
    const thrower = () => { throw new Error('profile read for a plan with no mutatesAccount case'); };
    const a = lintPlan(old, 'o');
    const b = lintPlan(old, 'o', { profile: thrower });
    assert(JSON.stringify(a) === JSON.stringify(b), 'lint result changed when a profile was supplied');
    assert(!a.errors.length, `old plan errors: ${a.errors.map((e) => e.code).join(', ')}`);
    mustAccept(run('plan-lint.mjs', [put(old)]), 'old plan, no profile anywhere');
    mustAccept(lint(old), 'old plan with --profile');
  });
}
