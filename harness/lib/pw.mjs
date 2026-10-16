// Playwright resolution. Playwright is a hub devDependency (package.json, pinned) installed in
// qa-hub/node_modules, so `import('playwright')` resolves from anywhere in the hub. Until 2026-10-08
// the hub borrowed ~/ai-test-agent's copy; that fallback is gone so the hub depends on nothing
// outside itself. Every harness script still imports through here:
//
//   import { chromium } from '../lib/pw.mjs';

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const CANDIDATES = [
  process.env.QA_PLAYWRIGHT_PATH,
].filter(Boolean);

async function resolvePlaywright() {
  try {
    return await import('playwright');
  } catch { /* not resolvable from here — try the known installs */ }

  for (const dir of CANDIDATES) {
    if (!existsSync(dir)) continue;
    try {
      const require = createRequire(join(dir, 'package.json'));
      const entry = require.resolve('playwright');
      return await import(pathToFileURL(entry).href);
    } catch { /* next candidate */ }
  }
  throw new Error(
    'playwright is not installed anywhere this harness can see.\n' +
      'Fix with one of:\n' +
      '  npm install                # inside ~/Desktop/qa-hub (installs the pinned devDependency)\n' +
      '  export QA_PLAYWRIGHT_PATH=/path/to/node_modules/playwright\n' +
      `Searched: ${CANDIDATES.join(', ')}`
  );
}

const mod = await resolvePlaywright();
// Two different shapes can come back here. A native `import('playwright')` (found on the module
// resolution path) exposes chromium/firefox/webkit as top-level named exports directly. The
// CANDIDATES fallback resolves a real file path with createRequire and dynamically `import()`s it —
// that is a CJS entry, so Node's ESM/CJS interop only gives a synthetic `default`; the actual
// Playwright instance carrying .chromium/.firefox/.webkit as properties is one level deeper, at
// mod.default. Found 2026-08-13 (Alpha R4 harness smoke test): launch() threw "Cannot read
// properties of undefined (reading 'launch')" because chromium destructured as undefined from the
// outer module-namespace object.
const pw = mod.chromium ? mod : mod.default ?? mod;
export const { chromium, firefox, webkit, devices, request } = pw;

/**
 * chromium.launch({headless:true}), but tolerant of a cache that only has the FULL chromium browser
 * downloaded and not the separate `chromium_headless_shell` build modern Playwright versions prefer
 * for headless mode. Found 2026-09-29 (Beta web-inventory script, fresh headless launch):
 * "Executable doesn't exist at .../chromium_headless_shell-1243/..." even though a full chromium
 * browser (a different revision, e.g. chromium-1234) was already cached — `npx playwright install`
 * wasn't run for this exact revision pin. Rather than requiring a fresh install every time the pinned
 * revision drifts, fall back to the newest cached FULL chromium build's own executable, which renders
 * identically for DOM/route work (only headless_shell's slightly different rendering internals are
 * skipped, which nothing in this hub's checks currently depends on).
 */
export async function launchChromium(opts = {}) {
  try {
    return await chromium.launch({ headless: true, ...opts });
  } catch (e) {
    if (!/Executable doesn't exist.*chromium_headless_shell/is.test(String(e && e.message))) throw e;
    const cacheDir = join(homedir(), 'Library', 'Caches', 'ms-playwright');
    const { readdirSync } = await import('node:fs');
    const revDirs = existsSync(cacheDir)
      ? readdirSync(cacheDir).filter((d) => /^chromium-\d+$/.test(d)).sort()
      : [];
    for (const rev of revDirs.reverse()) {
      const appPath = join(cacheDir, rev, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
      if (existsSync(appPath)) {
        return chromium.launch({ headless: true, executablePath: appPath, ...opts });
      }
    }
    throw e; // no fallback found — surface the original, more actionable error
  }
}

export default pw;
