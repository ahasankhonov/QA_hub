// harness/lib/adb.mjs — generic Android/uiautomator driver (R-14).
//
// Lifted out of harness/delta/adb.mjs (2026-09-29, Beta Android session 1) so a second
// Android project (Beta / com.beta) does not re-derive the same primitives from scratch.
// Everything here is project-agnostic: no Delta package name, activity, safety notes or UI
// quirks live in this file. A project module (e.g. harness/delta/adb.mjs, harness/beta/android/
// config+auth.mjs) supplies its own PKG/ACTIVITY and either re-exports these directly or wraps the
// few functions that need a package/activity (dump's ANR recovery, relaunch) with its own constants
// bound in, so existing call sites keep their original two-arg shape.
//
// Every gotcha encoded below was paid for once on Delta's Flutter app; nothing here is proven yet
// against a Compose Multiplatform app (Beta) — re-confirm behavior (dump timing, IME handling,
// coordinate drift) on the new app rather than assuming it transfers, and push new gotchas back into
// this file (not a per-ticket script) so the next project inherits the fix too.
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const ADB = process.env.QA_ADB || '/opt/homebrew/bin/adb';

// ── TAP GATE (R-13, 2026-10-06, Beta Android). A project can install ONE gate with installTapGate(); from then on EVERY way
// this library can touch the screen goes through it: tapXY(), tap() / fillVerified() / dismissRuntimeDialogs() (they call tapXY), a
// <20px swipe (a swipe with no travel IS a tap), and any raw `input tap|swipe|motionevent|…` passed to sh()/shell(). The gate is a
// sync function (serial,x,y) that throws to refuse. installTapGate() returns `rawTap(serial,x,y)`, the ONLY un-gated tap — the
// installer keeps it private. No gate installed (Delta etc.) = behaviour unchanged. The dump() ANR "Wait/Close app" tap is a
// system dialog and uses the bypass so the gate's own dump cannot recurse.
let _gate = null, _bypass = 0;
const RAW_INPUT_RE = /\binput\s+(?:(?:touchscreen|touchpad|touchnavigation|mouse|stylus|trackball|joystick|gamepad|dpad)\s+)?(?:tap|swipe|motionevent|draganddrop|press|roll)\b/;
export function installTapGate(gate) {
  _gate = gate;
  return (serial, x, y) => { _bypass++; try { return sh(serial, ['shell', `input tap ${x} ${y}`], 60000); } finally { _bypass--; } };
}
export const tapGateInstalled = () => !!_gate;

export const sh = (serial, args, timeout = 60000) => {
  if (_gate && !_bypass && args[0] === 'shell' && RAW_INPUT_RE.test(args.slice(1).join(' '))) {
    throw new Error(`tap gate: raw '${args.slice(1).join(' ').slice(0, 60)}' is blocked on this project — use the guarded tap/tapXY in harness/beta/android/ui.mjs (R-13)`);
  }
  return execFileSync(ADB, ['-s', serial, ...args], { encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024 });
};

export const shell = (serial, cmd, timeout = 60000) => sh(serial, ['shell', cmd], timeout);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * HARNESS FIX (R-20260929-AND, MOB-11 rerun, 2026-09-30): `emu <command>` (gsm call/accept/cancel,
 * sms, power, etc.) is a HOST-side adb subcommand that talks to the emulator's console — it is
 * `adb -s <serial> emu <args...>`, NOT `adb -s <serial> shell emu <args...>`. A2's original MOB-11
 * ran it through `shell(serial, 'emu gsm call ...')`, i.e. `adb shell emu ...`, which tries to find
 * an `emu` binary INSIDE the device's own shell — there isn't one
 * ("/system/bin/sh: emu: inaccessible or not found", confirmed live in the superseded
 * _RESULT-R-20260929-AND-MOB-11.json 'app' case) — so the simulated call never actually happened and
 * every later "the state survived the call" assertion was vacuous. Fixed here, once, so no later
 * ticket re-derives the same host-vs-device distinction: call sh() directly with 'emu' as the first
 * arg (bypassing shell()'s 'shell' prefix), confirmed live against emulator-5554
 * (`adb -s emulator-5554 emu gsm call 5551234` -> "OK").
 */
export const emu = (serial, args, timeout = 15000) => sh(serial, ['emu', ...args], timeout);
export const gsmCall = (serial, number) => emu(serial, ['gsm', 'call', number]);
export const gsmAccept = (serial, number) => emu(serial, ['gsm', 'accept', number]);
export const gsmCancel = (serial, number) => emu(serial, ['gsm', 'cancel', number]);
export const gsmList = (serial) => emu(serial, ['gsm', 'list']);

/**
 * uiautomator writes attribute values XML-ESCAPED, so a multi-line content-desc arrives
 * as the literal 7 characters `&#10;` — which is why a naive regex matcher silently never
 * fires on a multi-line label. Decode once, here, so every matcher in every module sees the
 * string the app actually set.
 */
const unxml = (s) => String(s)
  .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&amp;/g, '&');

/** Dump the semantics tree. Returns [{cls, text, desc, bounds:{x1,y1,x2,y2}, cx, cy, focused}] */
export function dumpOnce(serial) {
  // Delete any previous dump FIRST. Under CPU load (several emulators driven at once)
  // `uiautomator dump` can fail silently — stderr is thrown away and it still exits 0 —
  // and without this the `cat` below would silently replay the PREVIOUS screen's XML.
  // That stale-read bug was caught 2026-08-25 on Delta: right after an account switch did
  // `pm clear` + relaunch, a waitFor() saw the OLD screen's dump instead of the new one and
  // threw a bogus timeout. Deleting first turns a failed dump into a MISSING file, so `cat`
  // throws and dump()'s existing empty-nodes recovery loop handles it instead of a caller
  // being fed a screen that no longer exists.
  // HARNESS FIX (R-20260929-AND, Batch B3, found live 2026-09-30): shell()'s default 60000ms timeout
  // on these two calls, multiplied across dump()'s retry ladder under real multi-emulator CPU
  // contention, produced a ~4-hour hang (many bounded-but-large waits, not a true infinite loop) —
  // killed pid 71241. A legitimate dump completes in 2-3s; 15s is generous headroom without paying
  // the full 60s per failed attempt.
  shell(serial, 'rm -f /sdcard/ui.xml', 15000);
  shell(serial, 'uiautomator dump /sdcard/ui.xml >/dev/null 2>&1', 15000);
  const xml = shell(serial, 'cat /sdcard/ui.xml', 15000);
  const out = [];
  for (const n of xml.match(/<node[^>]*>/g) || []) {
    const g = (k) => unxml((n.match(new RegExp(`${k}="([^"]*)"`)) || [, ''])[1]);
    const b = n.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    if (!b) continue;
    const [x1, y1, x2, y2] = b.slice(1).map(Number);
    out.push({ cls: g('class'), text: g('text'), desc: g('content-desc'),
      // rid/pkg (additive, 2026-10-06 R-20261006-EXP tap guard): resource-id + owning package, so a guard can tell a
      // Chrome/system-dialog node from an app node and match a testTag when the app exposes one.
      rid: g('resource-id'), pkg: g('package'),
      focused: g('focused') === 'true', clickable: g('clickable') === 'true',
      // enabled (additive, R-20261007-RFQ AND-04): needed to record 'Faollashtirish' disabled/enabled state (BET-128).
      enabled: g('enabled') !== 'false', password: g('password') === 'true',
      // checked/selected/checkable: the ONLY machine-readable state a toggle exposes.
      // A false here can mean "not reported" rather than "off" on some widget toolkits
      // (confirmed on Delta's Flutter chips) — check the class before trusting it.
      checked: g('checked') === 'true', checkable: g('checkable') === 'true',
      selected: g('selected') === 'true',
      bounds: { x1, y1, x2, y2 }, cx: (x1 + x2) >> 1, cy: (y1 + y2) >> 1 });
  }
  return out;
}

/**
 * A dump that survives the two ways this environment eats the window:
 *  - the display sleeps (mCurrentFocus=null, "null root node returned by UiTestAutomationBridge")
 *  - the app ANRs under CPU starvation when several emulators are driven at once
 * Both look identical to a caller — an empty node list — so recover here rather than
 * letting every step invent its own retry.
 *
 * `pkg`/`activity` are optional: pass them (a project wrapper normally binds its own constants) to
 * let the recovery force-stop a hung package and/or relaunch its activity; omitted, recovery falls
 * back to just waking the screen and dismissing the keyguard.
 */
export function dump(serial, tries = 3, { pkg, activity, maxMs = 90000 } = {}) {
  // HARNESS FIX (R-20260929-AND, Batch B3, found live 2026-09-30): wall-clock deadline on top of the
  // existing tries/sleep ladder — a consecutive-failure counter that force-stops the shell UI after
  // repeated total misses, cheaper than restructuring the retry shape mid-batch while lane A edits
  // this same file concurrently. maxMs=90000 comfortably covers legitimate slow-but-real recovery
  // (wake+dismiss-keyguard+relaunch) while still cutting off a multi-hour hang.
  const deadline = Date.now() + maxMs;
  let consecutiveEmpty = 0;
  for (let i = 0; i < tries; i++) {
    if (Date.now() > deadline) throw new Error(`dump(): exceeded ${maxMs}ms wall-clock cap after ${consecutiveEmpty} consecutive empty dumps`);
    let nodes = [];
    try { nodes = dumpOnce(serial); } catch { /* fall through to recovery */ }
    if (nodes.length) {
      const anr = nodes.find((n) => /^(Wait|Close app)$/i.test(n.text || n.desc));
      if (anr && nodes.some((n) => /isn.t responding|Application Not Responding/i.test(`${n.text} ${n.desc}`))) {
        _bypass++; try { sh(serial, ['shell', `input tap ${anr.cx} ${anr.cy}`]); } finally { _bypass--; } // ANR system dialog: bypass (see TAP GATE)
        execFileSync('sleep', ['3']);
        continue;
      }
      return nodes;
    }
    consecutiveEmpty++;
    try {
      shell(serial, 'input keyevent KEYCODE_WAKEUP');
      shell(serial, 'wm dismiss-keyguard');
      const focus = shell(serial, 'dumpsys window | grep -m1 mCurrentFocus');
      const notResponding = /Not Responding/i.test(focus);
      if (notResponding && pkg) shell(serial, `am force-stop ${pkg}`);
      const pkgInFocus = pkg ? new RegExp(pkg.replace(/[.]/g, '\\.')).test(focus) : true;
      if (activity && (!pkgInFocus || notResponding)) shell(serial, `am start -n ${activity}`);
      // 3+ total misses in a row: the uiautomator service itself (not the app) is likely wedged —
      // restart it (com.android.shell hosts the uiautomator process), a stronger recovery than
      // wake+dismiss-keyguard alone.
      if (consecutiveEmpty >= 3) shell(serial, 'am force-stop com.android.shell', 10000);
    } catch { /* ignore */ }
    execFileSync('sleep', ['8']);
  }
  // GOTCHA (Delta lane F, 2026-08-26, 4 emulators driven concurrently): this final call used to be
  // unguarded, so once `tries` attempts all came back empty, a LAST `cat /sdcard/ui.xml` that also
  // missed (uiautomator dump silently failing under CPU load from other lanes) threw an uncaught
  // ENOENT straight out of dump() instead of going through the recovery loop above — observed
  // repeatedly as "cat: /sdcard/ui.xml: No such file or directory" crashing whole ticket scripts.
  // Give it the same wake/dismiss-keyguard/retry treatment instead of a bare last try.
  for (let i = 0; i < 2; i++) {
    if (Date.now() > deadline) throw new Error(`dump(): exceeded ${maxMs}ms wall-clock cap in final fallback loop`);
    try { return dumpOnce(serial); } catch { /* one more breath before the real throw */ }
    try {
      shell(serial, 'input keyevent KEYCODE_WAKEUP');
      shell(serial, 'wm dismiss-keyguard');
    } catch { /* ignore */ }
    execFileSync('sleep', ['5']);
  }
  return dumpOnce(serial);
}

const label = (n) => `${n.desc || ''} ${n.text || ''}`.trim();
const rx = (m) => (m instanceof RegExp ? m : new RegExp(m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));

/** All nodes whose desc/text matches. */
export const findAll = (serial, matcher, nodes = null) =>
  (nodes || dump(serial)).filter((n) => rx(matcher).test(label(n)));

export const find = (serial, matcher, nodes = null) => findAll(serial, matcher, nodes)[0] || null;

/**
 * Among several matches, prefer a CLICKABLE one.
 *
 * Some apps draw a screen's TITLE with the same words as its CTA (observed on Delta: "Upload
 * documents" title + "Upload Documents" button), and the title node comes first in the dump. A
 * plain first-match tap then silently hits the non-clickable title and the screen never advances —
 * no error, just a stall. Falls back to the first match when nothing matched is clickable (many
 * toolkits emit clickable=false on nodes that are, in fact, tappable via a parent).
 */
const preferClickable = (hits) => hits.find((n) => n.clickable) || hits[0] || null;

/**
 * Wait until a label appears. Returns the node, or throws with what WAS on screen.
 * `clickable: true` prefers a clickable match — tap() passes it by default.
 */
export async function waitFor(serial, matcher, { timeout = 25000, interval = 1500, clickable = false, pkg, activity } = {}) {
  const started = Date.now();
  let last = [];
  while (Date.now() - started < timeout) {
    last = dump(serial, 3, { pkg, activity });
    const hits = findAll(serial, matcher, last);
    const hit = clickable ? preferClickable(hits) : hits[0] || null;
    if (hit) return hit;
    await sleep(interval);
  }
  const seen = last.map(label).filter(Boolean).slice(0, 30);
  throw new Error(`waitFor(${matcher}) timed out on ${serial}. On screen: ${JSON.stringify(seen)}`);
}

export const tapXY = (serial, x, y) => {
  if (_gate) _gate(serial, x, y); // throws to refuse (R-13)
  _bypass++; try { return sh(serial, ['shell', `input tap ${x} ${y}`], 60000); } finally { _bypass--; }
};

/** Tap a node found by label. Waits for it first, so callers don't sprinkle sleeps. */
export async function tap(serial, matcher, opts = {}) {
  // uiautomator dumps the APP window only, so a node's coordinates stay "visible" even when the
  // IME is drawn over them. Tapping then hits a keyboard key instead of the button — this
  // silently corrupted a text field on Delta more than once. So: always close the keyboard before
  // tapping anything below the fold.
  if (opts.keepKeyboard !== true && keyboardUp(serial)) { back(serial); await sleep(1200); }
  const n = await waitFor(serial, matcher, { clickable: true, ...opts });
  tapXY(serial, n.cx, n.cy);
  await sleep(opts.settle ?? 1200);
  return n;
}

/** Type into the currently focused field. Some toolkits drop chars sent too fast, so chunk it. */
export async function typeText(serial, text, { chunk = 4, pause = 350 } = {}) {
  for (const part of String(text).match(new RegExp(`.{1,${chunk}}`, 'gs')) || []) {
    // The payload is already inside double quotes, so escape ONLY what double quotes do not
    // neutralise. Escaping spaces/globs here types LITERAL backslashes into the field.
    const esc = part.replace(/(["\\$`])/g, '\\$1');
    shell(serial, `input text "${esc}"`);
    await sleep(pause);
  }
}

/** Tap a field by its label, then type. The commonest two-step in any form-driving flow. */
export async function fill(serial, matcher, value, opts = {}) {
  await tap(serial, matcher, opts);
  await typeText(serial, value);
  await sleep(400);
  return value;
}

export const back = (serial) => shell(serial, 'input keyevent KEYCODE_BACK');
export const enter = (serial) => shell(serial, 'input keyevent KEYCODE_ENTER');
/** BACK closes the keyboard ONLY when the IME is actually up — otherwise it pops the route and
 *  silently throws the whole flow back a screen. Always ask the IME first. */
export function keyboardUp(serial) {
  try { return /mInputShown=true/.test(shell(serial, 'dumpsys input_method | grep mInputShown')); }
  catch { return false; }
}
export function closeKeyboard(serial) {
  if (keyboardUp(serial)) back(serial);
}
export const hideKeyboard = closeKeyboard;
export const swipe = (serial, x1, y1, x2, y2, ms = 400) => {
  if (_gate && Math.hypot(x2 - x1, y2 - y1) < 20) _gate(serial, x1, y1); // a swipe with no travel is a tap
  _bypass++; try { return sh(serial, ['shell', `input swipe ${x1} ${y1} ${x2} ${y2} ${ms}`], 60000); } finally { _bypass--; }
};
export const scrollDown = (serial) => swipe(serial, 540, 1800, 540, 900, 500);
export const scrollUp = (serial) => swipe(serial, 540, 900, 540, 1800, 500);

/**
 * HARNESS FIX (R-20260929-AND, Beta Android batch B1): a caller that takes a screenshot into a
 * per-case attachments directory BEFORE that directory has been created by anything else (e.g. a
 * P-EXT case's pre-tap screenshot, taken before evidence.mjs's capture() has ever run for that
 * caseId) hit `sh: <path>: No such file or directory` — the shell redirect can't open a file whose
 * parent dir doesn't exist, execFileSync throws, and RunResult.case() silently records that as a
 * ranOk:false error, discarding everything else the case had already done. mkdirSync here (like
 * capture()'s own opts.screenshot handling) makes this primitive safe to call directly, not just
 * through capture().
 */
export function screenshot(serial, outPath) {
  mkdirSync(dirname(outPath), { recursive: true });
  execFileSync('sh', ['-c', `${ADB} -s ${serial} exec-out screencap -p > "${outPath}"`], { timeout: 60000 });
  return outPath;
}

/**
 * Force-stop (and optionally clear data for) `pkg`, then start `activity`. A project wrapper
 * normally binds its own PKG/ACTIVITY so callers keep the original `relaunch(serial, {clear})`
 * two-arg shape.
 */
export async function relaunch(serial, pkg, activity, { clear = false } = {}) {
  shell(serial, `am force-stop ${pkg}`);
  if (clear) shell(serial, `pm clear ${pkg}`); // wipes local session — a fresh signup/login surface
  shell(serial, `am start -n ${activity}`);
  await sleep(clear ? 14000 : 9000);
  await dismissRuntimeDialogs(serial);
}

/** Dismiss a first-launch runtime-permission dialog (notifications/location/mic/etc). Grant it —
 *  a denied permission poisons whatever later test depends on it having been granted. */
export async function dismissRuntimeDialogs(serial, rounds = 3) {
  for (let i = 0; i < rounds; i++) {
    const n = dump(serial);
    const hit = n.find((x) => /^(Allow|While using the app|OK)$/i.test(x.desc || x.text));
    if (!hit) return;
    tapXY(serial, hit.cx, hit.cy);
    await sleep(1800);
  }
}

/** Compact one-line view of the screen — for logs, so we never paste a whole XML dump. */
export const describe = (serial, nodes = null) =>
  (nodes || dump(serial)).map(label).filter(Boolean).map((s) => s.replace(/\s*\n\s*/g, ' / ')).join(' | ');

/**
 * Close the IME and let the layout settle. MUST be called before any raw tapXY.
 * uiautomator dumps the APP window only, so a node under the keyboard still reports "visible"
 * coordinates — tapping it hits a keyboard key. Anything that taps by coordinate goes through here.
 */
export async function ensureNoKeyboard(serial) {
  for (let i = 0; i < 3 && keyboardUp(serial); i++) { back(serial); await sleep(1200); }
  await sleep(400);
  return !keyboardUp(serial);
}

/**
 * Empty the focused text field. KEYCODE_MOVE_END only reaches end-of-LINE, so on a multi-line
 * field backspaces alone leave the tail behind — send FORWARD_DEL too and the cursor position
 * stops mattering. Batched: one adb call per 60 keycodes.
 */
export function clearField(serial, chars = 120) {
  const n = Math.min(400, Math.max(20, chars));
  shell(serial, 'input keyevent 123');                       // MOVE_END
  for (const code of ['67', '112']) {                        // DEL, then FORWARD_DEL
    for (let sent = 0; sent < n; sent += 60) {
      shell(serial, 'input keyevent ' + Array(Math.min(60, n - sent)).fill(code).join(' '));
    }
  }
}

// ── Scrolling ─────────────────────────────────────────────────────────────────
// A long form's content height changes with the account/data shown, so hard-coded swipe counts
// rot. Scroll CLOSED-LOOP — swipe until the thing you want is on screen, and stop early when the
// view no longer moves (that is the end of the list, not a reason to keep swiping).

/** A cheap fingerprint of what is currently rendered, to detect "the view didn't move". */
const screenSig = (nodes) =>
  nodes.map((n) => `${n.desc || n.text || n.cls}@${n.bounds.y1}`).join('|');

/**
 * Swipe within the scrollable area until `matcher` is on screen.
 * Returns the matched node, or null if the list bottomed out without it.
 *  - dir: 'down' (default, reveals content further down) | 'up'
 *  - safe: keeps the gesture inside the content area, well clear of a bottom tab bar (a swipe that
 *    starts on the nav bar switches tabs instead of scrolling).
 */
export async function scrollTo(serial, matcher, { dir = 'down', max = 12, settle = 1400 } = {}) {
  await ensureNoKeyboard(serial);
  let stale = 0, prev = '';
  for (let i = 0; i <= max; i++) {
    const nodes = dump(serial);
    const hit = find(serial, matcher, nodes);
    // Only accept a hit that is actually inside the viewport and not under the tab bar.
    if (hit && hit.cy > 200 && hit.cy < 2000) return hit;
    const sig = screenSig(nodes);
    if (sig === prev && ++stale >= 2) return null;   // list bottomed out
    if (sig !== prev) stale = 0;
    prev = sig;
    if (dir === 'down') swipe(serial, 540, 1750, 540, 950, 450);
    else swipe(serial, 540, 950, 540, 1750, 450);
    await sleep(settle);
  }
  return find(serial, matcher);
}

/** Scroll a ScrollView back to the top (cheap, bounded). */
export async function scrollToTop(serial, rounds = 8) {
  await ensureNoKeyboard(serial);
  let prev = '';
  for (let i = 0; i < rounds; i++) {
    const sig = screenSig(dump(serial));
    if (sig === prev) return;
    prev = sig;
    swipe(serial, 540, 950, 540, 1800, 400);
    await sleep(900);
  }
}

// ── Verified text entry ───────────────────────────────────────────────────────
// `input text` can silently drop characters on a loaded host (observed on Delta with several
// emulators sharing a CPU: an email and a 10-digit phone both came out truncated). Never trust a
// blind type into a field that matters: read it back and repair.

export const editFields = (serial) => dump(serial).filter((n) => /EditText$/.test(n.cls));

/** What the field currently holds, as the semantics tree reports it. */
export function fieldValue(serial, idx) {
  const f = editFields(serial)[idx];
  if (!f) return null;
  return f.desc || f.text || '';
}

const digits = (s) => String(s).replace(/\D/g, '');

/**
 * Type `value` into EditText #idx and PROVE it landed.
 *  - opts.secret: the widget renders bullets, so verify the COUNT of characters
 *  - opts.digits: phone-style field; compare digits only and tolerate a country prefix
 * Repairs by appending when the current value is a prefix of the target, and only falls back to a
 * bounded backspace-clear when it has actually diverged.
 */
export async function fillVerified(serial, idx, value, opts = {}) {
  const target = String(value);
  for (let attempt = 0; attempt < 4; attempt++) {
    let f = editFields(serial)[idx];
    if (!f) throw new Error(`field ${idx} not on screen (${editFields(serial).length} EditTexts)`);
    tapXY(serial, f.cx, f.cy);
    await sleep(600);

    const raw = fieldValue(serial, idx) || '';
    let ok = false, remainder = target;

    if (opts.secret) {
      const n = (raw.match(/[•*·]/g) || []).length;
      ok = n === target.length;
      remainder = n < target.length ? target.slice(n) : null;
      if (n > target.length) remainder = null;
    } else if (opts.digits) {
      const got = digits(raw);
      ok = got.endsWith(target);
      remainder = !ok && target.startsWith(got.replace(/^1/, '')) ? target.slice(digits(got.replace(/^1/, '')).length) : null;
      if (!ok && got === '') remainder = target;
    } else {
      ok = raw === target;
      remainder = !ok && target.startsWith(raw) ? target.slice(raw.length) : null;
    }

    if (ok) { closeKeyboard(serial); await sleep(900); return { ok: true, attempts: attempt, value: raw }; }

    if (remainder === null) {
      // diverged — clear it. Multiple keycodes go in ONE adb call, so this is cheap.
      clearField(serial, Math.max(raw.length, target.length) + 10);
      await sleep(600);
      remainder = target;
    }
    shell(serial, 'input keyevent KEYCODE_MOVE_END');
    await sleep(200);
    await typeText(serial, remainder, { chunk: attempt === 0 ? 4 : 2, pause: 350 + attempt * 250 });
    await sleep(500);
  }
  const final = fieldValue(serial, idx);
  throw new Error(`field ${idx} would not accept "${target}" — reads "${final}"`);
}
