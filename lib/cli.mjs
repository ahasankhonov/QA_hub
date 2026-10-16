// Tiny CLI helpers shared by the hub's scripts (moved out of the retired lib/approval-provenance.mjs on 2026-10-09).
import { existsSync } from 'node:fs';
import { readRegularFile } from './tracker-ops.mjs';

/** argv → { positional, flags }: `--k v`, `--k=v`, and a bare `--k` (= true). */
export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 2) { flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else { flags[key] = next; i++; }
    } else positional.push(a);
  }
  return { positional, flags };
}

/** Parse a JSON file; null when it is missing or unreadable. */
export function readJson(path) {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readRegularFile(path)); } catch { return null; }
}
