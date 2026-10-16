// Beta (Beta) surfaces, credentials and the wrong-surface tripwire. R-05 / R-13 / R-14.
//
// Hosts + the build-id pattern come from profiles/beta.json so the profile stays the single
// source of truth; this file adds what a profile cannot express (viewports, timeouts, the guard,
// and the credentials-table parser). Never hardcode a host here as a workaround for a stale profile
// — if `surfaces`/`buildProbe` are ever missing, that is a profile bug, not something to patch here.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadProfile, harnessDir, HUB } from '../../lib/profile.mjs';

export const profile = loadProfile('beta');

const { forbidden: FORBIDDEN = [], ...SURFACES } = profile.surfaces || {};
/** Named surfaces only (student/admin/api) — `forbidden` is kept out so nothing ever loops it in as "allowed". */
export { SURFACES };

export const HOSTS = {
  student: `https://${SURFACES.student}`,
  admin: `https://${SURFACES.admin}`,
  api: `https://${SURFACES.api}/api/v1`,
};

/** Where saved sessions live, so a multi-ticket run logs in once per role, not once per ticket. Created lazily by auth.mjs — never at import time. */
export const STATE_DIR = join(harnessDir('beta'), '.state');

export const TIMEOUTS = {
  /** Short, so a wrong selector fails in 10s instead of hanging 30. */
  default: 10_000,
  navigation: 45_000,
  /** The Vue app is slow to hydrate after first paint; anything asserting on client-rendered content needs this. */
  hydrate: 3_000,
  screenshot: 30_000,
};

// A real mobile UA matters here: this app is a Vue SPA that may branch on UA sniffing in addition to
// (or instead of) CSS media queries, and `isMobile`/`hasTouch` alone can leave `window.innerWidth` at
// the desktop value — see _SESSION-STATE.md and ui.mjs's assertViewport(), which exists because of it.
const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';

/**
 * Ready-to-spread `browser.newContext()` option fragments. `admin` (test.beta-admin.example) is desktop-only
 * (profile.safety.admin) — auth.mjs's contextFor() refuses to combine role:'admin' with mobile/landscape.
 */
export const VIEWPORTS = {
  desktop: { viewport: { width: 1440, height: 900 } },
  mobile: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3, userAgent: MOBILE_UA },
  landscape: { viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3, userAgent: MOBILE_UA },
};

/** R-06 — the regex build-id.mjs already validated; readBuildId()/captureAtBuild() read the live page with the same pattern the run's buildId was captured with. */
export const BUILD_ID_PATTERN = new RegExp(profile.buildProbe.pattern);

/**
 * R-13-style tripwire (R-05 here, since Beta has no prod-sharing risk like Alpha's — the point
 * is simply that a verdict taken on the wrong host is a wrong verdict). `forbidden` is checked BEFORE
 * `allowed` so a host that is somehow in both lists can never pass.
 * @throws if the URL is not a known Beta surface.
 */
export function assertSurface(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`assertSurface: "${url}" is not a URL`);
  }
  // studentAlias (D4, the QA lead 2026-09-29: "It's safe to open") is `web.beta.example` with NO port — a
  // distinct host string from `student` (`web.beta.example:8443`) and from the forbidden
  // `beta.example`/`www.beta.example`. `android` is not a URL host at all; the app's evidence uses
  // `android-app://<package>/<screen>` and `new URL(...).host` on that scheme returns the bare
  // package id, so the package id doubles as the "host" to allow here.
  const allowed = [SURFACES.student, SURFACES.studentAlias, SURFACES.admin, SURFACES.api, SURFACES.android, SURFACES.ios].filter(Boolean);
  const isForbidden = FORBIDDEN.includes(u.host);
  if (!isForbidden && allowed.includes(u.host)) return url;
  throw new Error(
    `R-05 BLOCKED: ${u.host} is ${isForbidden ? 'a forbidden production host' : 'not a known Beta surface'}. ` +
      `Allowed: ${allowed.join(', ')}. If a ticket genuinely needs another host, ask the QA lead first.`
  );
}

/** Convenience: build a guarded absolute URL for one of the named roles ('student'|'admin'|'api'). */
export function url(role, path = '/') {
  const base = HOSTS[role];
  if (!base) throw new Error(`url(): unknown role "${role}" — expected one of ${Object.keys(HOSTS).join(', ')}`);
  const full = path.startsWith('http') ? path : base + path;
  return assertSurface(full);
}

/**
 * R-06 — the run's declared buildId may be a composite `student=hash admin=hash` (build-id.mjs /
 * composeBuildId), while a single page capture only ever returns the bare hash for whichever bundle
 * that one page served. A byte-compare of the two fails even when the hash IS one of the composite's
 * own parts. Normalize a bare hash up to the composite string when it genuinely is a component of it;
 * a hash that is NOT one of the composite's parts is left unchanged so a real drift still fails loudly.
 */
export function reconcileBuildId(pageBuildId, runBuildId) {
  if (!pageBuildId || !runBuildId || pageBuildId === runBuildId) return pageBuildId;
  const parts = runBuildId.split(/\s+/).map((p) => (p.includes('=') ? p.slice(p.indexOf('=') + 1) : p));
  return parts.includes(pageBuildId) ? runBuildId : pageBuildId;
}

// --- credentials --------------------------------------------------------------------------------
// SENSITIVE: this section reads projects/beta/_reference/credentials.md at runtime so the one
// file stays the single source of truth for phone/password values — nothing here ever contains a
// literal secret. Never print/log/echo a `.phone` or `.password`; refer to accounts by role name.

const CREDENTIALS_PATH = join(HUB, 'projects', 'beta', '_reference', 'credentials.md');

/** role key -> exact "Role" column label in credentials.md's "App auth — JWT (per role)" table. */
const ROLE_LABELS = {
  admin: 'Admin (superuser)',
  moderator: 'Moderator',
  author_courses: 'Author 1 (courses)',
  author_packs: 'Author 2 (packs)',
  author_exams: 'Author 3 (exams)',
  student_paid: 'Student — has purchases',
  student_fresh: 'Student — fresh/no access',
  referrer: 'Referrer',
  referral1: 'Referral 1',
  referral2: 'Referral 2',
  bulk: 'Bulk students (leaderboard)',
  // 2026-10-12 (R-20261012-IOS IOS-06, AMENDMENT 1): F-IOS-PROFEDIT could not be registered (SMS OTP bypass inactive), so role profedit_ios is the
  // QA-owned self-registered user 5648. It is NOT in the credentials table: supply QA_PX_PROFEDIT_IOS_PHONE / _PASSWORD (from the
  // 'Self-registered QA user' section of credentials.md) in the environment.
  profedit_ios: 'Self-registered QA user (env only)',
};

let _table = null; // parsed lazily, once per process — never at import time

function loadCredentialsTable() {
  if (_table) return _table;
  if (!existsSync(CREDENTIALS_PATH)) {
    throw new Error(`account(): credentials file not found at ${CREDENTIALS_PATH}`);
  }
  const text = readFileSync(CREDENTIALS_PATH, 'utf8');
  const table = {};
  for (const line of text.split('\n')) {
    const m = /^\|([^|]+)\|([^|]+)\|([^|]+)\|\s*$/.exec(line.trim());
    if (!m) continue;
    const role = m[1].trim();
    if (role === 'Role' || /^:?-+:?$/.test(role)) continue; // header / separator row
    table[role] = { phone: m[2].trim(), password: m[3].trim() };
  }
  _table = table;
  return table;
}

/** Hide a value from JSON.stringify/console.log/util.inspect while leaving it fully readable via dot-access. */
function hidden(obj, key, value) {
  Object.defineProperty(obj, key, { value, enumerable: false, configurable: false, writable: false });
}

/**
 * One account for `role` (see ROLE_LABELS for the full set). Reads credentials.md unless overridden
 * by `QA_PX_<ROLE>_PHONE` / `QA_PX_<ROLE>_PASSWORD` env vars. Throws on an unknown role or a missing
 * row. The returned object's `phone`/`password` are non-enumerable — `JSON.stringify(acct)`,
 * `console.log(acct)` and the default `util.inspect` all show only `{ role }`.
 */
export function account(role) {
  const label = ROLE_LABELS[role];
  if (!label) throw new Error(`account(): unknown role "${role}" — expected one of ${Object.keys(ROLE_LABELS).join(', ')}`);

  const envKey = role.toUpperCase();
  let phone = process.env[`QA_PX_${envKey}_PHONE`];
  let password = process.env[`QA_PX_${envKey}_PASSWORD`];

  if (!phone || !password) {
    const row = loadCredentialsTable()[label];
    if (!row) throw new Error(`account(): role "${role}" (label "${label}") not found in credentials.md — has the table changed?`);
    phone = phone || row.phone;
    password = password || row.password;
  }

  const acct = { role };
  hidden(acct, 'phone', phone);
  hidden(acct, 'password', password);
  hidden(acct, Symbol.for('nodejs.util.inspect.custom'), () => `[beta account: ${role}]`);
  hidden(acct, 'toString', () => `[beta account: ${role}]`);
  return acct;
}
