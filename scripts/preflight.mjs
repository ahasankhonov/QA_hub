#!/usr/bin/env node
// Preflight — is the environment ready for this run? Read-only. The orchestrator runs it BEFORE intake.
//
//   node scripts/preflight.mjs --project <slug> [--run <runId>] [--write] [--json]
//        [--platforms web,android,ios]   default: the profile's platform(s)
//        [--surfaces customer,dealer]    only these profile.surfaces keys (default: all of them)
//        [--device emulator-5556]        only this adb serial / Simulator udid or name
//        [--only gate,build,surfaces,android,ios,tracker]   [--timeout ms]  (per request, default 8000)
//
// Each check prints OK, WARN, STOP or a dash for "not part of this run". Any STOP exits 1: the run
// would only record harness failures, so fix it first. --write (needs --run) saves
// projects/<slug>/qa-reports/_PREFLIGHT-<run>.json, and qa-gates fails the run while that file holds
// a STOP. After a fix, rerun with --write; the file is a snapshot, not an archive.
//
// The checks, and what each one has already cost us:
//   gate     R-01: the tracker-write gate config is unsafe. The gate fails closed, so this otherwise
//            surfaces only at the end, when the approved plan is denied.
//   build    R-06: _BUILD-<run>.json when present, else build-id.mjs. Every probe failed = STOP.
//   surfaces Each host in profile.surfaces answers GET /. Redirects are NOT followed and a host in
//            surfaces.forbidden is never requested (R-13). 5xx / DNS / refused / timeout = STOP.
//   android  An adb device is online and resolves DNS inside the emulator (ping google.com). Not
//            `getprop net.dns1`: it is empty on API 34 even when DNS works (both emulators, 2026-10-16).
//   ios      A Simulator is booted, and the .app is not `linker-signed`. A linker-signed build cannot
//            write the Keychain (-34018), so the app looks logged out (beta build 27, 2026-10-08).
//   tracker  The Jira REST token is accepted (/myself). Linear and Asana are MCP tools, which a script
//            cannot see, so they get a ToolSearch line under "next" instead
//            (see the linear-connector-session-registry memory).
//
// Idea from LambdaTest/agent-skills (MIT): each of their skills opens with a ready check that refuses
// to start on a missing prerequisite. These are the prerequisites that have actually cost us a run.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, isAbsolute, dirname } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HUB = join(dirname(fileURLToPath(import.meta.url)), '..');
export const CHECKS = ['gate', 'build', 'surfaces', 'android', 'ios', 'tracker'];
const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:\d+)?$/i;
// surfaces also holds prose notes, the forbidden list and app ids (com.beta looks like a host).
const NOT_A_HOST_KEY = /^(forbidden|android|ios)$|Note$|Disabled$|Package$|Bundle(Id)?$/;
const oneLine = (t) => String(t || '').replace(/\s+/g, ' ').trim();
const out = (r) => `${r?.stdout || ''}${r?.stderr || ''}`;
const hostOf = (u, base) => { try { return new URL(u, `https://${base}/`).host.toLowerCase(); } catch { return null; } };

export function platformsOf(profile) {
  const p = profile.platform ?? profile.platforms ?? 'web';
  return (Array.isArray(p) ? p : String(p).split(/[,\s]+/)).map((x) => String(x).toLowerCase()).filter(Boolean);
}

/** The hosts preflight may request: profile.surfaces values that are hosts, minus surfaces.forbidden. */
export function surfaceHosts(profile, onlyNames = null) {
  const s = profile.surfaces || {};
  const forbidden = new Set((Array.isArray(s.forbidden) ? s.forbidden : []).map((h) => String(h).toLowerCase()));
  const hosts = [];
  const clashes = [];
  const seen = new Set();
  for (const [name, v] of Object.entries(s)) {
    if (NOT_A_HOST_KEY.test(name) || typeof v !== 'string') continue;
    if (onlyNames && !onlyNames.includes(name)) continue;
    const host = v.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase();
    if (!HOST.test(host) || seen.has(host)) continue;
    seen.add(host);
    if (forbidden.has(host)) clashes.push({ name, host });
    else hosts.push({ name, host });
  }
  return { hosts, clashes, forbidden };
}

export function netError(e, timeoutMs) {
  const code = e?.cause?.code || e?.code || '';
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return `did not answer in ${Math.round(timeoutMs / 1000)} s`;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `does not resolve in DNS (${code})`;
  if (code === 'ECONNREFUSED') return 'refused the connection';
  if (/CERT|SSL|TLS/i.test(code)) return `failed TLS (${code})`;
  return `is unreachable (${code || oneLine(e?.message || e).slice(0, 80)})`;
}

/** One surface's answer → a check row. `res` is {status, location} or {error}. */
export function evalSurface({ name, host }, res, forbidden) {
  const fix = 'every case on it would be recorded as an infrastructure failure — wait for it, or take it out of scope with --surfaces';
  if (res.error) return { level: 'stop', msg: `${name} (${host}) ${res.error}`, fix };
  if (res.status >= 500) return { level: 'stop', msg: `${name} (${host}) answers ${res.status}`, fix };
  if (res.status >= 300 && res.status < 400 && res.location) {
    const to = hostOf(res.location, host);
    if (to && forbidden.has(to))
      return { level: 'warn', msg: `${name} (${host}) redirects to ${to}, which is in surfaces.forbidden — the harness guard will refuse it (R-13); drive the listed host, never the redirect` };
    return { level: 'ok', msg: `${name} ${res.status} → ${to && to !== host ? to : res.location}` };
  }
  return { level: 'ok', msg: `${name} ${res.status}` };
}

export function parseAdbDevices(text) {
  return String(text || '').split('\n')
    .map((l) => l.trim().match(/^(\S+)\s+(device|offline|unauthorized|no permissions|recovery|sideload|bootloader)\b/))
    .filter((m) => m && m[1] !== 'List')
    .map((m) => ({ serial: m[1], state: m[2] }));
}

/** `adb shell ping -c 1 -W 3 google.com` → resolved, or not. Packet loss is fine; "unknown host" is not. */
export function evalPing(serial, r) {
  const o = out(r);
  if (/unknown host|bad address|Name or service not known|cannot resolve/i.test(o))
    return { level: 'stop', msg: `${serial} cannot resolve DNS (ping google.com: unknown host)`, fix: 'cold-restart the emulator with -dns-server 8.8.8.8; runtime fixes do not stick (android-emulator-dns-restart memory)' };
  if (/PING \S+ \(\d+\.\d+\.\d+\.\d+\)/.test(o)) return { level: 'ok', msg: `${serial} resolves DNS` };
  return { level: 'warn', msg: `${serial}: DNS could not be checked (${oneLine(o).slice(0, 100) || `exit ${r?.status}`})` };
}

export function parseBooted(json) {
  try {
    return Object.values(JSON.parse(json).devices || {}).flat()
      .filter((d) => d && d.state === 'Booted').map((d) => ({ udid: d.udid, name: d.name }));
  } catch { return null; }
}

/** `codesign -dv <App>.app` (it prints to stderr) → a check row. */
export function evalCodesign(name, path, r) {
  const o = out(r);
  const fix = 'ask the dev to rebuild for the Simulator with signing on (not CODE_SIGNING_ALLOWED=NO) and zip it with ditto -c -k --keepParent; do not test this build';
  if (/not signed at all/i.test(o))
    return { level: 'stop', msg: `${name}: ${path} is not code-signed — the Simulator cannot keep a Keychain entry`, fix };
  const flags = (o.match(/flags=0x[0-9a-f]+\(([^)]*)\)/i) || [])[1];
  if (flags && /linker-signed/.test(flags))
    return { level: 'stop', msg: `${name}: ${path} is linker-signed only (flags ${flags}) — Keychain writes fail with -34018 and the app behaves logged out (beta build 27, 2026-10-08)`, fix };
  if (!flags) return { level: 'warn', msg: `${name}: could not read the signature of ${path} (${oneLine(o).slice(0, 100) || `exit ${r?.status}`})` };
  return { level: 'ok', msg: `${name} build signed (${flags})` };
}

export function evalJira(res, tokenFile) {
  if (res.error) return { level: 'warn', msg: `Jira REST ${res.error} — intake can still read through the Atlassian MCP tools` };
  if (res.status === 200) return { level: 'ok', msg: 'Jira REST token accepted' };
  if (res.status === 401 || res.status === 403)
    return { level: 'warn', msg: `Jira REST token rejected (${res.status}) — intake still works through the MCP search dump + jira-pull.mjs --from, but screenshot upload (jira-attach-apply.mjs) will fail`, fix: `refresh ${tokenFile} (the value is never printed)` };
  return { level: 'warn', msg: `Jira REST /myself answered ${res.status}` };
}

/** Basic auth from profile.jira.tokenFile — the same `Email:` / `Token:` lines jira-pull.mjs reads. Never printed. */
export function jiraAuthHeader(jira, hub = HUB) {
  if (!jira?.tokenFile) return { error: 'profile.jira.tokenFile is not set' };
  const p = isAbsolute(jira.tokenFile) ? jira.tokenFile : join(hub, jira.tokenFile);
  if (!existsSync(p)) return { error: `token file missing: ${jira.tokenFile}` };
  const txt = readFileSync(p, 'utf8');
  const pick = (label) => {
    for (const raw of txt.split('\n')) {
      const m = raw.replace(/[*`]/g, '').match(new RegExp(`^\\s*-?\\s*${label}\\s*:\\s*(\\S+)`, 'i'));
      if (m) return m[1];
    }
    return null;
  };
  const email = pick('Email');
  const token = pick('Token');
  if (!email || !token) return { error: `could not parse the Email / Token lines of ${jira.tokenFile}` };
  return { header: 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64') };
}

function adbPath() {
  const sdk = join(homedir(), 'Library/Android/sdk/platform-tools/adb');
  return process.env.ADB || ['/opt/homebrew/bin/adb', sdk].find((p) => existsSync(p)) || 'adb';
}

export async function runPreflight(opts, deps = {}) {
  const { profile, slug, runId = null, onlyChecks = null, surfaceNames = null, device = null, timeout = 8000, hub = HUB } = opts;
  const platforms = opts.platforms || platformsOf(profile);
  const exec = deps.exec || ((cmd, args, o = {}) => spawnSync(cmd, args, { encoding: 'utf8', timeout: o.timeout || 20000 }));
  const fetchFn = deps.fetch || globalThis.fetch;
  const configProblem = deps.configProblem || (await import('../lib/tracker-ops.mjs')).configProblem;
  const rd = opts.reportsDir || join(hub, 'projects', slug, 'qa-reports');
  const checks = [];
  const next = [];
  const row = (check, r) => checks.push({ check, ...r });
  const want = (c) => !onlyChecks || onlyChecks.includes(c);
  const get = async (url, headers = {}) => {
    try {
      const res = await fetchFn(url, { method: 'GET', redirect: 'manual', headers, signal: AbortSignal.timeout(timeout) });
      res.body?.cancel?.().catch?.(() => {});
      return { status: res.status, location: res.headers?.get?.('location') || null };
    } catch (e) {
      return { error: netError(e, timeout) };
    }
  };

  if (want('gate')) {
    let problem;
    try { problem = configProblem({ hub, home: process.env.HOME || homedir(), env: process.env }); } catch (e) { problem = `config check threw: ${e.message}`; }
    row('gate', problem
      ? { level: 'stop', msg: oneLine(problem).slice(0, 300), fix: 'fix the settings it names first — the tracker-write gate fails closed and would deny the approved plan at the end of the run' }
      : { level: 'ok', msg: 'tracker-write gate config is safe (R-01)' });
  }

  if (want('build')) {
    const buildFile = runId ? join(rd, `_BUILD-${runId}.json`) : null;
    const kindOf = (p) => (p.kind === 'apk' ? 'android' : p.kind === 'ios-app' ? 'ios' : 'web');
    const describe = (b, src) => {
      const failed = (b.parts || []).filter((p) => p && p.ok === false).map((p) => p.name || '?');
      return b.incomplete || failed.length
        ? { level: 'warn', msg: `${b.buildId} (${src}) is INCOMPLETE — failed probe(s): ${failed.join(', ') || '?'}; verdicts on those parts cannot be carried forward (R-06)` }
        : { level: 'ok', msg: `${b.buildId} (${src})` };
    };
    if (buildFile && existsSync(buildFile)) {
      let b = null;
      try { b = JSON.parse(readFileSync(buildFile, 'utf8')); } catch { /* below */ }
      row('build', b?.buildId ? describe(b, `_BUILD-${runId}.json`) : { level: 'stop', msg: `_BUILD-${runId}.json is unreadable or has no buildId`, fix: `node scripts/build-id.mjs ${slug} --write ${buildFile}` });
    } else {
      const probes = profile.buildProbe?.probes || [];
      const inScope = probes.filter((p) => platforms.includes(kindOf(p)) || (kindOf(p) === 'web' && platforms.includes('api')));
      if (!probes.length) row('build', { level: 'warn', msg: 'no buildProbe in the profile — results cannot be tied to a build (R-06); record the build by hand in _BUILD-<run>.json' });
      else if (!inScope.length) row('build', { level: 'warn', msg: `no build probe for ${platforms.join(', ')} (profile has: ${probes.map((p) => p.name).join(', ')})` });
      else {
        const args = [join(hub, 'scripts/build-id.mjs'), slug, '--timeout', String(timeout)];
        if (inScope.length < probes.length) args.push('--only', inScope.map((p) => p.name).join(','));
        const r = exec(process.execPath, args, { timeout: timeout * (inScope.length + 1) + 5000 });
        let b = null;
        try { b = JSON.parse(r.stdout); } catch { /* below */ }
        if (r.status === 1) row('build', { level: 'stop', msg: `every build probe failed: ${oneLine(r.stderr).slice(-200)}`, fix: 'the app is down or the build file is missing — check the surfaces row below' });
        else if (b?.buildId) row('build', describe(b, 'build-id.mjs'));
        else row('build', { level: 'warn', msg: `build-id.mjs gave no build id (exit ${r.status}): ${oneLine(out(r)).slice(-200)}` });
      }
    }
  }

  if (want('surfaces')) {
    const { hosts, clashes, forbidden } = surfaceHosts(profile, surfaceNames);
    for (const c of clashes) row('surfaces', { level: 'warn', msg: `${c.name} (${c.host}) is also in surfaces.forbidden — not requested; fix the profile` });
    if (!hosts.length) row('surfaces', { level: 'skip', msg: 'no web hosts in profile.surfaces' });
    const answers = await Promise.all(hosts.map((h) => get(`https://${h.host}/`)));
    hosts.forEach((h, i) => row('surfaces', evalSurface(h, answers[i], forbidden)));
  }

  if (want('android')) {
    if (!platforms.includes('android')) row('android', { level: 'skip', msg: 'android is not in this run' });
    else {
      const adb = adbPath();
      const r = exec(adb, ['devices']);
      if (r.error?.code === 'ENOENT') row('android', { level: 'stop', msg: 'adb not found (set ADB=<path>)', fix: 'install platform-tools or point ADB at it' });
      else {
        const all = parseAdbDevices(r.stdout).filter((d) => !device || d.serial === device);
        const online = all.filter((d) => d.state === 'device');
        for (const d of all.filter((x) => x.state !== 'device')) row('android', { level: 'warn', msg: `${d.serial} is ${d.state}` });
        if (!online.length) row('android', { level: 'stop', msg: `no Android device online${device ? ` matching ${device}` : ''} (adb devices: ${oneLine(r.stdout).slice(0, 120) || 'empty'})`, fix: 'boot the AVD with -dns-server 8.8.8.8' });
        const pkg = typeof profile.surfaces?.android === 'string' ? profile.surfaces.android.trim() : null;
        for (const d of online) {
          row('android', evalPing(d.serial, exec(adb, ['-s', d.serial, 'shell', 'ping', '-c', '1', '-W', '3', 'google.com'], { timeout: 15000 })));
          if (pkg && /^[a-z][\w]*(\.[a-z][\w]*)+$/i.test(pkg)) {
            const installed = /package:/.test(exec(adb, ['-s', d.serial, 'shell', 'pm', 'path', pkg]).stdout || '');
            row('android', installed ? { level: 'ok', msg: `${pkg} installed on ${d.serial}` } : { level: 'warn', msg: `${pkg} is not installed on ${d.serial} — install the run's build first` });
          }
        }
      }
    }
  }

  if (want('ios')) {
    if (!platforms.includes('ios')) row('ios', { level: 'skip', msg: 'ios is not in this run' });
    else {
      const r = exec('xcrun', ['simctl', 'list', 'devices', 'booted', '-j']);
      const booted = (parseBooted(r.stdout) || []).filter((d) => !device || d.udid === device || d.name === device);
      if (r.error?.code === 'ENOENT') row('ios', { level: 'stop', msg: 'xcrun not found — Xcode command-line tools are missing' });
      else if (!booted.length) row('ios', { level: 'stop', msg: `no booted Simulator${device ? ` matching ${device}` : ''}`, fix: 'xcrun simctl boot <udid>' });
      else row('ios', { level: 'ok', msg: `booted: ${booted.map((d) => d.name).join(', ')}` });
      for (const p of (profile.buildProbe?.probes || []).filter((x) => x.kind === 'ios-app' && x.path)) {
        const abs = isAbsolute(p.path) ? p.path : join(hub, p.path);
        if (!existsSync(abs)) { row('ios', { level: 'stop', msg: `${p.name}: build missing at ${p.path}`, fix: 'unpack the build there, or update buildProbe' }); continue; }
        row('ios', evalCodesign(p.name, p.path, exec('codesign', ['-dv', abs])));
      }
      const bundle = typeof profile.surfaces?.ios === 'string' ? profile.surfaces.ios.trim() : null;
      if (bundle && booted.length) {
        const on = booted.filter((d) => exec('xcrun', ['simctl', 'get_app_container', d.udid, bundle]).status === 0);
        row('ios', on.length ? { level: 'ok', msg: `${bundle} installed on ${on.map((d) => d.name).join(', ')}` } : { level: 'warn', msg: `${bundle} is not installed on any booted Simulator — install the run's build first` });
      }
    }
  }

  if (want('tracker')) {
    const kind = profile.tracker?.kind || (profile.jira ? 'jira' : profile.linear?.team && !/^\(/.test(profile.linear.team) ? 'linear' : null);
    if (kind === 'jira') {
      const auth = jiraAuthHeader(profile.jira, hub);
      const site = String(profile.jira.site || '').replace(/\/$/, '');
      if (auth.error || !site) row('tracker', { level: 'warn', msg: `Jira REST not checked: ${auth.error || 'profile.jira.site is not set'}` });
      else row('tracker', evalJira(await get(`${site}/rest/api/3/myself`, { Authorization: auth.header, Accept: 'application/json' }), profile.jira.tokenFile));
      next.push('ToolSearch "atlassian" — intake reads Jira through the MCP search tools');
    } else if (kind === 'linear' || kind === 'asana') {
      row('tracker', { level: 'skip', msg: `${kind} is reached through MCP tools, which a script cannot see — see next` });
      next.push(`ToolSearch "${kind}" and confirm the read tools are listed before intake — a connector shown as connected is not necessarily registered in this session (linear-connector-session-registry)`);
    } else row('tracker', { level: 'skip', msg: 'no tracker in the profile' });
  }

  return { schemaVersion: 1, project: slug, runId, at: new Date().toISOString(), platforms, checks, next, ready: !checks.some((c) => c.level === 'stop') };
}

export function formatCard(r) {
  const mark = { ok: '✓', warn: '⚠', stop: '✗', skip: '–' };
  const lines = [`[preflight] ${r.project}${r.runId ? ` · run ${r.runId}` : ''} · platforms ${r.platforms.join(', ')}`];
  for (const c of r.checks) {
    lines.push(`  ${mark[c.level] || '?'} ${c.level === 'stop' ? 'STOP ' : c.level === 'warn' ? 'WARN ' : ''}${c.check.padEnd(9)}${c.msg}`);
    if (c.fix && c.level !== 'ok') lines.push(`               fix: ${c.fix}`);
  }
  for (const n of r.next) lines.push(`  → next: ${n}`);
  const stops = r.checks.filter((c) => c.level === 'stop').length;
  const warns = r.checks.filter((c) => c.level === 'warn').length;
  lines.push(`[preflight] ${r.ready ? 'READY' : 'NOT READY'} — ${stops} stop(s), ${warns} warning(s)`);
  return lines.join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { args, loadProfile, reportsDir } = await import('../lib/profile.mjs');
  const { flags } = args();
  const list = (v) => (typeof v === 'string' ? v.split(',').map((x) => x.trim()).filter(Boolean) : null);
  if (typeof flags.project !== 'string') {
    console.error('usage: preflight.mjs --project <slug> [--run <runId>] [--write] [--json] [--platforms a,b] [--surfaces k,k] [--device <serial>] [--only ' + CHECKS.join(',') + '] [--timeout ms]');
    process.exit(2);
  }
  if (flags.write && typeof flags.run !== 'string') { console.error('[preflight] --write needs --run <runId>'); process.exit(2); }
  const onlyChecks = list(flags.only);
  const bad = (onlyChecks || []).filter((c) => !CHECKS.includes(c));
  if (bad.length) { console.error(`[preflight] unknown check(s): ${bad.join(', ')} (have: ${CHECKS.join(', ')})`); process.exit(2); }
  let profile;
  try { profile = loadProfile(flags.project); } catch (e) { console.error(`[preflight] ${e.message}`); process.exit(2); }
  const r = await runPreflight({
    profile, slug: flags.project, runId: typeof flags.run === 'string' ? flags.run : null,
    platforms: list(flags.platforms), onlyChecks, surfaceNames: list(flags.surfaces),
    device: typeof flags.device === 'string' ? flags.device : null,
    timeout: Number(flags.timeout) > 0 ? Number(flags.timeout) : 8000,
    reportsDir: reportsDir(flags.project),
  });
  if (flags.write) {
    const p = join(reportsDir(flags.project), `_PREFLIGHT-${flags.run}.json`);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(r, null, 2) + '\n');
    if (!flags.json) console.log(`[preflight] wrote ${p}`);
  }
  console.log(flags.json ? JSON.stringify(r, null, 2) : formatCard(r));
  process.exit(r.ready ? 0 : 1);
}
