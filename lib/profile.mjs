// Profile loading + the paths every script agrees on. R-03: everything lives inside the hub.

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HUB = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function profilePath(slug) {
  return join(HUB, 'profiles', `${slug}.json`);
}

export function loadProfile(slug) {
  const p = profilePath(slug);
  if (!existsSync(p)) {
    throw new Error(`no profile for "${slug}" at ${p}`);
  }
  return JSON.parse(readFileSync(p, 'utf8'));
}

/** R-03 — the one place project output paths are computed. */
export function reportsDir(slug) {
  return join(HUB, 'projects', slug, 'qa-reports');
}

export function attachmentsDir(slug, ticketId) {
  return join(reportsDir(slug), `${ticketId}_attachments`);
}

export function harnessDir(slug) {
  return join(HUB, 'harness', slug);
}

/** Tiny argv helper — every script parses flags the same way. */
export function args(argv = process.argv.slice(2)) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 2) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
        continue;
      }
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else {
        flags[key] = next;
        i++;
      }
    } else positional.push(a);
  }
  return { positional, flags };
}

export function fail(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}
