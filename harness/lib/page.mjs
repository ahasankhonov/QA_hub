// Page helpers shared by every project's harness: "is the page done loading?" and "what is on the
// screen, as text?". Both exist to stop false FAILs — a capture taken while a spinner is still up, or a
// FAIL whose only record is "selector did not resolve" with nothing about what WAS on screen.
//
// Ideas from vostride/agent-qa (packages/web/src/smart-wait.ts, dom-extractor.ts; FSL-1.1, read
// 2026-10-16), re-written. Two fixes over theirs: only VISIBLE loaders count (a hidden spinner left in
// the DOM made theirs wait the full 3 s on every call), and infinite CSS animations are ignored (a
// pulsing badge never "settles", so theirs always waited the full 2 s).
//
//   import { waitForPageReady, pageOutline } from '../lib/page.mjs';
//   const ready = await waitForPageReady(page);       // { ms, pending: [] } — pending names what never cleared
//   const text  = await pageOutline(page);            // compact visible-text tree, ≤ 3000 chars

// Loaders seen in our apps plus the common UI kits. Alpha: .animate-spin + [data-loading="true"]
// (harness/alpha/ui.mjs settle()); Beta admin/student are Vue; the rest are React + Tailwind/MUI.
export const LOADING_SELECTORS = [
  '[aria-busy="true"]',
  '[role="progressbar"]:not([aria-valuenow])',
  'progress:not([value])',
  // Not .animate-pulse or [class*=skeleton]: Tailwind pulse is also used for permanent "live" dots, and
  // a substring match hits wrapper components — either would hold every capture for the full timeout.
  '.animate-spin',
  '.spinner', '.loading', '.loader', '.skeleton',
  '[data-loading="true"]', '[data-loading=""]', '[data-testid*="loading" i]', '[aria-label*="loading" i]',
  '.MuiCircularProgress-root', '.MuiSkeleton-root', '.ant-spin-spinning', '.v-progress-circular', '.v-skeleton-loader',
];

// Runs in the browser. Returns the selectors that currently match at least one VISIBLE element.
function visibleLoaders(selectors) {
  const doc = globalThis.document;
  const win = globalThis.window;
  const visible = (el) => {
    if (!el.getClientRects().length) return false;
    const st = win.getComputedStyle(el);
    return st.visibility !== 'hidden' && st.opacity !== '0';
  };
  return selectors.filter((sel) => {
    try { return [...doc.querySelectorAll(sel)].some(visible); } catch { return false; }
  });
}

// Runs in the browser. Finite animations still running (an infinite pulse never ends, so it is ignored).
function finiteAnimationsRunning() {
  const doc = globalThis.document;
  if (!doc.getAnimations) return 0;
  return doc.getAnimations().filter((a) => {
    if (a.playState !== 'running') return false;
    const it = a.effect?.getComputedTiming?.().iterations;
    return it !== Infinity;
  }).length;
}

/**
 * Wait until the page has loaded, the network is quiet, visible loaders are gone and finite animations
 * have finished — each step bounded, never throws, never waits longer than `timeout` in total.
 * @returns {Promise<{ms:number, pending:string[]}>} pending = what had NOT cleared when we gave up
 *          ('network', 'animations', or loader selectors). Record it: a FAIL captured with a pending
 *          loader is a timing suspect, not a bug.
 */
export async function waitForPageReady(page, { timeout = 10000, loaders = LOADING_SELECTORS } = {}) {
  const t0 = Date.now();
  const left = () => Math.max(0, timeout - (Date.now() - t0));
  const pending = [];

  await page.waitForLoadState('domcontentloaded', { timeout: Math.min(5000, left()) }).catch(() => {});
  // SPAs with websockets / long polling never go idle — bounded, then move on.
  const idle = await page.waitForLoadState('networkidle', { timeout: Math.min(5000, left()) }).then(() => true, () => false);
  if (!idle) pending.push('network');

  try {
    let showing = await page.evaluate(visibleLoaders, loaders);
    while (showing.length && left() > 0) {
      await page.waitForTimeout(Math.min(250, left()));
      showing = await page.evaluate(visibleLoaders, loaders);
    }
    pending.push(...showing);
  } catch { /* navigation in progress / context gone — the capture will say so */ }

  try {
    let running = await page.evaluate(finiteAnimationsRunning);
    const until = Date.now() + Math.min(2000, left());
    while (running && Date.now() < until) {
      await page.waitForTimeout(100);
      running = await page.evaluate(finiteAnimationsRunning);
    }
    if (running) pending.push('animations');
  } catch { /* as above */ }

  return { ms: Date.now() - t0, pending };
}

// Runs in the browser. Indented tree of visible elements that carry meaning: text, headings, controls
// with their role/label/state. Scripts, styles, SVG paths and hidden subtrees are skipped.
function outlineInBrowser({ maxDepth, maxText, maxChars }) {
  const doc = globalThis.document;
  const win = globalThis.window;
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'LINK', 'META', 'SVG', 'PATH', 'IFRAME']);
  const CONTROL = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'OPTION', 'LABEL', 'IMG']);
  const lines = [];
  let size = 0;
  const cut = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);
  const push = (line) => {
    if (size > maxChars) return;
    lines.push(line);
    size += line.length + 1;
  };
  const hidden = (el) => {
    if (el.getAttribute('aria-hidden') === 'true') return true;
    const st = win.getComputedStyle(el);
    return st.display === 'none' || st.visibility === 'hidden' || (!el.getClientRects().length && st.position !== 'fixed');
  };
  const describe = (el) => {
    const tag = el.tagName.toLowerCase();
    const bits = [];
    const role = el.getAttribute('role');
    const label = el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('alt') || el.getAttribute('placeholder');
    if (role) bits.push(`role=${role}`);
    if (label) bits.push(`"${cut(label.trim(), maxText)}"`);
    if (tag === 'input') {
      bits.push(`type=${el.type}`);
      if (el.type === 'checkbox' || el.type === 'radio') bits.push(el.checked ? 'checked' : 'unchecked');
      else if (el.type !== 'password' && el.value) bits.push(`value="${cut(el.value, maxText)}"`);
    }
    if ((tag === 'select' || tag === 'textarea') && el.value) bits.push(`value="${cut(String(el.value), maxText)}"`);
    if (tag === 'a' && el.getAttribute('href')) bits.push(`href=${cut(el.getAttribute('href'), 80)}`);
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') bits.push('disabled');
    if (el.getAttribute('aria-expanded')) bits.push(`expanded=${el.getAttribute('aria-expanded')}`);
    if (el.getAttribute('aria-selected') === 'true' || el.getAttribute('aria-current')) bits.push('selected');
    if (el.getAttribute('aria-invalid') === 'true') bits.push('invalid');
    return `[${tag}${bits.length ? ' ' + bits.join(' ') : ''}]`;
  };
  const walk = (node, depth) => {
    if (size > maxChars) return;
    for (let c = node.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3) {
        const t = c.textContent.replace(/\s+/g, ' ').trim();
        if (t) push('  '.repeat(depth) + cut(t, maxText));
        continue;
      }
      if (c.nodeType !== 1 || SKIP.has(c.tagName) || hidden(c)) continue;
      const tag = c.tagName;
      const meaningful = CONTROL.has(tag) || /^H[1-6]$/.test(tag) || c.getAttribute('role') || c.getAttribute('aria-label');
      if (depth >= maxDepth) { push('  '.repeat(depth) + '…'); continue; }
      if (meaningful) {
        push('  '.repeat(depth) + describe(c));
        walk(c, depth + 1);
      } else {
        walk(c, depth); // layout wrappers add depth, not meaning
      }
    }
  };
  walk(doc.body, 0);
  // Collapse consecutive duplicate lines (repeated list rows), keeping the count — "3 rows" can be the assertion.
  const merged = [];
  for (const l of lines) {
    const last = merged[merged.length - 1];
    if (last && last.line === l) last.n++;
    else merged.push({ line: l, n: 1 });
  }
  const out = merged.map(({ line, n }) => (n > 1 ? `${line} ×${n}` : line)).join('\n');
  return size > maxChars ? out + '\n… [outline truncated]' : out;
}

/**
 * Compact text outline of what is visible on the page — what the verifier reads instead of opening a
 * screenshot. ~1 token per 4 chars, so the default cap is ~750 tokens against ~1600 for one image.
 * Never throws; returns null when the page cannot be read.
 */
export async function pageOutline(page, { maxChars = 3000, maxDepth = 30, maxText = 120 } = {}) {
  try {
    return await page.evaluate(outlineInBrowser, { maxChars, maxDepth, maxText });
  } catch {
    return null;
  }
}

// ── One element, the right element (2026-10-16) ─────────────────────────────────────────────────────
// Ideas from petrkindlmann/qa-skills (MIT): selector-drift-recovery (act only on a unique match),
// playwright-automation anti-patterns (no .first()/nth()/force to make a test pass, re-read what you
// filled), selector-strategies (assert a link's href instead of clicking it). Rewritten for our harness.

const asLocator = (page, target) => (typeof target === 'string' ? page.locator(target) : target);

/** How many elements matching `target` (selector or Locator) are visible right now (counts up to `max`). */
export async function visibleMatches(page, target, { max = 20 } = {}) {
  const loc = asLocator(page, target);
  const n = Math.min(await loc.count(), max);
  let visible = 0;
  for (let i = 0; i < n; i++) if (await loc.nth(i).isVisible().catch(() => false)) visible++;
  return visible;
}

/**
 * Click `target` only when exactly one visible element matches it. Two matches is how a hidden
 * duplicate chip or a second listing ends up being the thing tested. Narrow the locator (a region
 * plus filter({ hasText })) instead of reaching for .first(), nth() or force:true.
 */
export async function clickUnique(page, target, { timeout = 10000, ...clickOpts } = {}) {
  const loc = asLocator(page, target);
  await loc.first().waitFor({ state: 'visible', timeout }).catch(() => {});
  const n = await visibleMatches(page, loc);
  if (n !== 1) throw new Error(`clickUnique: ${n} visible matches for ${typeof target === 'string' ? target : String(loc)} — expected exactly 1; narrow it to a region + filter({ hasText }), never .first()/nth()/force`);
  for (let i = 0, c = await loc.count(); i < c; i++) {
    const el = loc.nth(i);
    if (await el.isVisible().catch(() => false)) { await el.click({ timeout, ...clickOpts }); return; }
  }
}

/**
 * Fill fields in order, then read every one back. A later fill or a re-render that clears an earlier
 * field (Alpha's "fill this one last" fields) throws here, naming the field, instead of surfacing
 * as a confusing validation error at submit.
 * @param {Array<[string|import('playwright').Locator, string]>} fields
 */
export async function fillAndConfirm(page, fields) {
  for (const [target, value] of fields) await asLocator(page, target).fill(String(value));
  const lost = [];
  for (const [target, value] of fields) {
    const got = await asLocator(page, target).inputValue().catch((e) => `«${e.message.split('\n')[0]}»`);
    if (got !== String(value)) lost.push(`${typeof target === 'string' ? target : String(target)}: wanted "${value}", has "${got}"`);
  }
  if (lost.length) throw new Error(`fillAndConfirm: ${lost.length} field(s) lost their value after the form was filled — ${lost.join('; ')}`);
}

/**
 * Read a link's href and check its host WITHOUT clicking it. For links that may point at production
 * (app banners, legal rows, emailed links): assert the href, never follow it.
 * @returns {Promise<{href:string|null, host:string|null, ok:boolean, why?:string}>}
 */
export async function assertLinkHost(page, target, { allow = [], forbid = [] } = {}) {
  const href = await asLocator(page, target).first().getAttribute('href').catch(() => null);
  let host = null;
  try { host = new URL(href, page.url()).hostname; } catch { /* no or bad href */ }
  const match = (h, list) => list.some((d) => h === d || h.endsWith('.' + d));
  if (!host) return { href, host, ok: false, why: 'no resolvable href' };
  if (match(host, forbid)) return { href, host, ok: false, why: `host ${host} is on the forbidden (production) list` };
  if (allow.length && !match(host, allow)) return { href, host, ok: false, why: `host ${host} is not one of the allowed surfaces` };
  return { href, host, ok: true };
}
