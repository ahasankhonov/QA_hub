#!/usr/bin/env node
// R-06 — capture the identity of the build under test.
//
// Build identity is what makes a carried-forward verdict trustworthy. Without it, a redeploy
// silently turns every carried PASS into an unverified claim, and nobody investigates a pass.
//
//   node scripts/build-id.mjs alpha            # print JSON
//   node scripts/build-id.mjs alpha --write projects/alpha/qa-reports/_BUILD-<runId>.json
//   node scripts/build-id.mjs beta --only android,student --write ...   # probe a subset
//
// Profile shape (profiles/<slug>.json):
//   "buildProbe": { "probes": [
//     { "name": "web", "url": "...", "pattern": "assets/(index-[A-Za-z0-9_-]+\\.js)" },
//     { "name": "android", "kind": "apk", "path": "projects/<slug>/<file>.apk" },
//     { "name": "ios", "kind": "ios-app", "path": "projects/<slug>/ios-build/<App>.app" }
//   ] }
//
// An "apk" probe reads identity from the manifest (aapt2 dump badging: package + versionCode) plus
// a sha256 of the file, composed as `<package>@<versionCode>+<sha256[:8]>` — there is no fetchable
// bundle id for a native build, so this is the closest analogue to the web probes' bundle hash.
// An "ios-app" probe reads Info.plist (plutil) from an unpacked .app directory and composes
// `<CFBundleIdentifier>@<CFBundleVersion>+<sha256[:8]>`; the hash covers the main executable plus
// its `.debug.dylib` when present (a Debug build's executable is only a launcher stub).
// aapt2 path: profile `buildProbe.aapt2`, or env QA_AAPT2, or the probe's own `aapt2`, or the
// default Android SDK build-tools location under $HOME.

import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { loadProfile, HUB } from '../lib/profile.mjs';
import { resolvePattern, extractBuildId, composeBuildId, parseApkBadging, composeApkBuildId, parseIosInfoPlist, composeIosBuildId } from '../lib/build-probe.mjs';
import { sha256File } from '../lib/tracker-ops.mjs';

const [, , slug, ...rest] = process.argv;
if (!slug) {
  console.error('usage: build-id.mjs <project-slug> [--write <path>] [--timeout ms] [--only name,name]');
  process.exit(2);
}
const flag = (name) => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : null;
};
const outPath = flag('--write');
const timeout = flag('--timeout') ? Number(flag('--timeout')) : 20000;
const only = flag('--only') ? flag('--only').split(',').map((s) => s.trim()).filter(Boolean) : null;

const profile = loadProfile(slug);
let probes = profile.buildProbe?.probes || [];
if (probes.length === 0) {
  console.error(
    `[build-id] profile "${slug}" has no buildProbe.probes. R-06 cannot be enforced without one.\n` +
      `Add e.g.: "buildProbe": { "probes": [{ "name": "web", "url": "https://staging.example.com/", ` +
      `"pattern": "assets/(index-[A-Za-z0-9_-]+\\\\.js)" }] }`
  );
  process.exit(2);
}
if (only) {
  const names = new Set(probes.map((p) => p.name));
  const unknown = only.filter((n) => !names.has(n));
  if (unknown.length) {
    console.error(`[build-id] --only names probe(s) not in profile.buildProbe.probes: ${unknown.join(', ')} (have: ${[...names].join(', ')})`);
    process.exit(2);
  }
  probes = probes.filter((p) => only.includes(p.name));
}

const DEFAULT_AAPT2 = join(homedir(), 'Library', 'Android', 'sdk', 'build-tools', '36.1.0', 'aapt2');

/** Impure half of the apk probe: run aapt2, hash the file. Parsing/composing is pure (build-probe.mjs). */
function probeApk(p) {
  const apkPath = resolve(HUB, p.path);
  if (!existsSync(apkPath)) return { name: p.name, path: p.path, ok: false, error: `apk not found at ${apkPath}` };

  const aapt2 = p.aapt2 || profile.buildProbe?.aapt2 || process.env.QA_AAPT2 || DEFAULT_AAPT2;
  if (!existsSync(aapt2)) return { name: p.name, path: p.path, ok: false, error: `aapt2 not found at ${aapt2} (set profile.buildProbe.aapt2 or QA_AAPT2)` };

  const res = spawnSync(aapt2, ['dump', 'badging', apkPath], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (res.error || res.status !== 0) {
    return { name: p.name, path: p.path, ok: false, error: `aapt2 failed: ${res.error?.message || String(res.stderr || '').slice(0, 300) || `exit ${res.status}`}` };
  }
  const parsed = parseApkBadging(res.stdout);
  if (!parsed.ok) return { name: p.name, path: p.path, ok: false, error: parsed.error };

  const sha = sha256File(readFileSync(apkPath));
  const value = composeApkBuildId(parsed.package, parsed.versionCode, sha);
  if (!value) return { name: p.name, path: p.path, ok: false, error: 'could not compose an apk build id from package/versionCode/sha256' };
  return { name: p.name, path: p.path, ok: true, value, package: parsed.package, versionCode: parsed.versionCode, sha256: sha };
}

/** Impure half of the ios-app probe: plutil → Info.plist JSON, hash executable (+ .debug.dylib). */
function probeIosApp(p) {
  const appPath = resolve(HUB, p.path);
  const plist = join(appPath, 'Info.plist');
  if (!existsSync(plist)) return { name: p.name, path: p.path, ok: false, error: `Info.plist not found at ${plist}` };
  const res = spawnSync('plutil', ['-convert', 'json', '-o', '-', plist], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (res.error || res.status !== 0) {
    return { name: p.name, path: p.path, ok: false, error: `plutil failed: ${res.error?.message || String(res.stderr || '').slice(0, 300) || `exit ${res.status}`}` };
  }
  const parsed = parseIosInfoPlist(res.stdout);
  if (!parsed.ok) return { name: p.name, path: p.path, ok: false, error: parsed.error };
  const exe = join(appPath, parsed.executable);
  if (!existsSync(exe)) return { name: p.name, path: p.path, ok: false, error: `main executable not found at ${exe}` };
  const hashed = [parsed.executable];
  const bufs = [readFileSync(exe)];
  const dbg = `${exe}.debug.dylib`;
  if (existsSync(dbg)) {
    bufs.push(readFileSync(dbg));
    hashed.push(`${parsed.executable}.debug.dylib`);
  }
  const sha = sha256File(Buffer.concat(bufs));
  const value = composeIosBuildId(parsed.bundleId, parsed.buildVersion, sha);
  if (!value) return { name: p.name, path: p.path, ok: false, error: 'could not compose an ios build id from bundle id/CFBundleVersion/sha256' };
  return { name: p.name, path: p.path, ok: true, value, bundleId: parsed.bundleId, shortVersion: parsed.shortVersion, buildVersion: parsed.buildVersion, hashedFiles: hashed, sha256: sha };
}

const parts = [];
for (const p of probes) {
  if (p.kind === 'ios-app') {
    parts.push(probeIosApp(p));
    continue;
  }
  if ((p.kind || 'web') === 'apk') {
    parts.push(probeApk(p));
    continue;
  }
  const pattern = resolvePattern(p, profile.buildProbe);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(p.url, {
      signal: ctrl.signal,
      headers: { 'cache-control': 'no-cache', pragma: 'no-cache' },
    });
    const body = await res.text();
    const got = extractBuildId(body, pattern);
    if (!got.ok) {
      parts.push({ name: p.name, url: p.url, ok: false, error: `${got.error} (HTTP ${res.status})` });
      continue;
    }
    parts.push({ name: p.name, url: p.url, ok: true, httpStatus: res.status, value: got.value });
  } catch (e) {
    parts.push({ name: p.name, url: p.url, ok: false, error: String(e.message || e) });
  } finally {
    clearTimeout(t);
  }
}

const failed = parts.filter((p) => !p.ok);
if (failed.length === parts.length) {
  console.error('[build-id] every probe failed — refusing to emit an unknown build id (R-06 fails closed):');
  for (const f of failed) console.error(`  ${f.name}: ${f.error}`);
  process.exit(1);
}
for (const f of failed) console.error(`[build-id] WARN probe "${f.name}" failed: ${f.error}`);

const buildId = composeBuildId(parts);

const out = {
  project: slug,
  buildId,
  capturedAt: new Date().toISOString(),
  parts,
  incomplete: failed.length > 0,
};

const json = JSON.stringify(out, null, 2);
if (outPath) {
  const abs = resolve(HUB, outPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, json + '\n');
  console.error(`[build-id] wrote ${abs}`);
}
console.log(json);
