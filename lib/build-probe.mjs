// R-06 — turning a fetched page into a build id.
//
// This is a separate module for one reason: the extraction is where the probe went wrong in the
// field (2026-08-12, Alpha). The profile carried `buildProbe.pattern` once for the whole probe
// set, build-id.mjs read `probe.pattern` only, and `new RegExp(undefined)` is /(?:)/ — which
// matches the empty string at offset 0. Every probe reported ok:true with value:"" and the run was
// keyed on a build id of "". A probe that fails OPEN is worse than no probe, because the id it
// invents is the one thing nobody thinks to doubt. Keeping this pure means the selftest can feed it
// known-bad input directly, with no network and no fixture server.

/** The pattern may be given per-probe or once for the whole set. Never defaults to "match anything". */
export function resolvePattern(probe = {}, buildProbe = {}) {
  return probe.pattern || buildProbe.pattern || null;
}

/**
 * @returns {{ok: true, value: string} | {ok: false, error: string}}
 */
export function extractBuildId(body, pattern) {
  if (!pattern) return { ok: false, error: 'no pattern (probe or buildProbe.pattern)' };
  let re;
  try {
    re = new RegExp(pattern);
  } catch (e) {
    return { ok: false, error: `pattern /${pattern}/ is not a valid regex: ${e.message}` };
  }
  const m = re.exec(body ?? '');
  if (!m) return { ok: false, error: `pattern /${pattern}/ did not match` };
  const value = m[1] ?? m[0];
  if (!value) return { ok: false, error: `pattern /${pattern}/ matched but captured nothing` };
  return { ok: true, value };
}

/** One surface → the bare id; several → `name=id` pairs, so a partial redeploy is visible. */
export function composeBuildId(parts) {
  const ok = parts.filter((p) => p.ok);
  if (ok.length === 0) return '';
  return ok.map((p) => (parts.length > 1 ? `${p.name}=${p.value}` : p.value)).join(' ');
}

// --- apk probe (kind:"apk") ---------------------------------------------------------------------
// A native build has no fetchable bundle id; identity comes from the manifest (package + versionCode)
// plus a content hash, so a same-versionCode resign/rebuild still shows up as a different id. This
// half stays pure (parses a string) so the selftest can feed it fixed `aapt2 dump badging` output —
// running aapt2 itself, and hashing the file, are the impure half in scripts/build-id.mjs, same split
// as fetch()/extractBuildId() above.

/**
 * @param {string} output — the stdout of `aapt2 dump badging <apk>`
 * @returns {{ok:true, package:string, versionCode:string} | {ok:false, error:string}}
 */
export function parseApkBadging(output) {
  const m = /package:\s*name='([^']+)'[^\n]*?\bversionCode='(\d+)'/.exec(output ?? '');
  if (!m) return { ok: false, error: `aapt2 badging output has no "package: name=... versionCode=..." line` };
  return { ok: true, package: m[1], versionCode: m[2] };
}

/** `<package>@<versionCode>+<sha256[:8]>` — the format build-id.mjs writes for an APK probe. */
export function composeApkBuildId(pkg, versionCode, sha256Hex) {
  const prefix = String(sha256Hex || '').slice(0, 8);
  if (!pkg || !versionCode || prefix.length < 8) return null;
  return `${pkg}@${versionCode}+${prefix}`;
}

// --- ios-app probe (kind:"ios-app") -------------------------------------------------------------
// Same idea as the apk probe for an unpacked simulator/device `.app` directory: identity is
// CFBundleIdentifier + CFBundleVersion (from Info.plist, converted to JSON by `plutil -convert json`)
// plus a content hash. Pure half only; reading the plist and hashing the binaries is in build-id.mjs.
//
// Hash input: a Debug build's main executable is a ~40KB launcher stub, and the app code lives in
// `<exe>.debug.dylib` (Xcode previews / debug dylib). A stub-only hash would stay the same across
// rebuilds, so build-id.mjs hashes the executable followed by its `.debug.dylib` when one exists.

/**
 * @param {string} plistJson — stdout of `plutil -convert json -o - <app>/Info.plist`
 * @returns {{ok:true, bundleId:string, shortVersion:string, buildVersion:string, executable:string} | {ok:false, error:string}}
 */
export function parseIosInfoPlist(plistJson) {
  let o;
  try {
    o = JSON.parse(plistJson ?? '');
  } catch (e) {
    return { ok: false, error: `Info.plist is not valid JSON: ${e.message}` };
  }
  const bundleId = o?.CFBundleIdentifier;
  const buildVersion = o?.CFBundleVersion;
  const executable = o?.CFBundleExecutable;
  if (!bundleId || !buildVersion || !executable) {
    return { ok: false, error: 'Info.plist lacks CFBundleIdentifier / CFBundleVersion / CFBundleExecutable' };
  }
  return { ok: true, bundleId: String(bundleId), shortVersion: String(o.CFBundleShortVersionString || ''), buildVersion: String(buildVersion), executable: String(executable) };
}

/** `<CFBundleIdentifier>@<CFBundleVersion>+<sha256[:8]>` — mirrors composeApkBuildId. */
export function composeIosBuildId(bundleId, buildVersion, sha256Hex) {
  return composeApkBuildId(bundleId, buildVersion, sha256Hex);
}
