#!/usr/bin/env node
// render-figma.mjs — rasterize Figma SVG exports to bounded PNGs for token-lean reads.
//
// WHY: a raw Figma .svg export is XML text (some are 18–30MB ≈ millions of tokens).
// Reading one into an agent's context is the single worst token event in qa-hub.
// This renders each SVG once to a PNG capped at 1600×1600 (≈1,600 image tokens),
// cached in <figmaDir>/_rendered/. Agents read the PNG, NEVER the raw SVG.
//
// USAGE:
//   node scripts/render-figma.mjs [figmaDir]     # one project's figma dir
//   node scripts/render-figma.mjs                # auto-scan projects/*/delivery_handoff/figma
//   node scripts/render-figma.mjs <dir> --force  # re-render even if up to date
//
// Idempotent: skips an SVG whose _rendered PNG is newer than the source.
// Requires `sharp` (ships with appium; else `npm i -g sharp`).

import { createRequire } from "node:module";
import { readdirSync, statSync, mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, relative, dirname, basename, resolve } from "node:path";
import { execSync, execFileSync } from "node:child_process";
import { tmpdir } from "node:os";

const require = createRequire(import.meta.url);
const MAX_EDGE = 1600;

// Chrome fallback for SVGs libvips rejects (huge multi-artboard flow boards that
// blow the libxml buffer limit). Renders the SVG scaled-to-fit a bounded window.
function findChrome() {
  const c = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  ];
  return c.find((p) => existsSync(p));
}

function svgIntrinsicSize(src) {
  const head = readFileSync(src, { encoding: "utf8" }).slice(0, 4000);
  const vb = head.match(/viewBox\s*=\s*"([\d.\s-]+)"/);
  if (vb) { const p = vb[1].trim().split(/\s+/).map(Number); if (p.length === 4 && p[2] > 0 && p[3] > 0) return { w: p[2], h: p[3] }; }
  const w = head.match(/\bwidth\s*=\s*"([\d.]+)/), h = head.match(/\bheight\s*=\s*"([\d.]+)/);
  if (w && h) return { w: +w[1], h: +h[1] };
  return { w: MAX_EDGE, h: MAX_EDGE };
}

function renderViaChrome(src, out, chrome) {
  const { w, h } = svgIntrinsicSize(src);
  const scale = Math.min(1, MAX_EDGE / Math.max(w, h));
  const tw = Math.max(1, Math.round(w * scale)), th = Math.max(1, Math.round(h * scale));
  const wrap = join(tmpdir(), `figrender_${process.pid}_${Math.round(w)}x${Math.round(h)}.html`);
  writeFileSync(wrap,
    `<!doctype html><meta charset="utf-8"><body style="margin:0">` +
    `<img src="file://${encodeURI(resolve(src))}" style="width:${tw}px;height:${th}px;display:block">`);
  try {
    execFileSync(chrome, [
      "--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1",
      `--window-size=${tw},${th}`, "--default-background-color=00000000",
      `--screenshot=${out}`, `file://${wrap}`,
    ], { stdio: "ignore", timeout: 60000 });
  } finally { try { rmSync(wrap); } catch {} }
  if (!existsSync(out)) throw new Error("Chrome produced no output");
  return { width: tw, height: th };
}

function loadSharp() {
  const candidates = [];
  try { candidates.push(execSync("npm root -g", { encoding: "utf8" }).trim()); } catch {}
  candidates.push("/opt/homebrew/lib/node_modules/appium/node_modules");
  candidates.push("/usr/local/lib/node_modules/appium/node_modules");
  for (const dir of candidates) {
    try { return require(join(dir, "sharp")); } catch {}
  }
  try { return require("sharp"); } catch {}
  console.error(
    "ERROR: could not load `sharp`.\n" +
    "  It normally ships inside appium's node_modules. Install a copy with:\n" +
    "    npm i -g sharp\n" +
    "  then re-run."
  );
  process.exit(1);
}

function findSvgs(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === "_rendered" || name.startsWith(".")) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...findSvgs(p));
    else if (name.toLowerCase().endsWith(".svg")) out.push(p);
  }
  return out;
}

function figmaDirs(arg) {
  if (arg) return [resolve(arg)];
  const root = resolve("projects");
  if (!existsSync(root)) return [];
  const dirs = [];
  for (const slug of readdirSync(root)) {
    const d = join(root, slug, "delivery_handoff", "figma");
    if (existsSync(d) && statSync(d).isDirectory()) dirs.push(d);
  }
  return dirs;
}

const args = process.argv.slice(2);
const force = args.includes("--force");
const dirArg = args.find((a) => !a.startsWith("--"));

const sharp = loadSharp();
const targets = figmaDirs(dirArg);
if (targets.length === 0) {
  console.error("No figma dirs found. Pass one explicitly: node scripts/render-figma.mjs <dir>");
  process.exit(1);
}

const chrome = findChrome();
let rendered = 0, skipped = 0, failed = 0, viaChrome = 0;
for (const figmaDir of targets) {
  const svgs = findSvgs(figmaDir);
  if (svgs.length === 0) continue;
  console.log(`\n${figmaDir}  (${svgs.length} svg)`);
  for (const src of svgs) {
    const rel = relative(figmaDir, src).replace(/\.svg$/i, ".png");
    const out = join(figmaDir, "_rendered", rel);
    if (!force && existsSync(out) && statSync(out).mtimeMs >= statSync(src).mtimeMs) {
      skipped++; continue;
    }
    mkdirSync(dirname(out), { recursive: true });
    const inMB = (statSync(src).size / 1048576).toFixed(1);
    try {
      const info = await sharp(src, { limitInputPixels: false })
        .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: "inside", withoutEnlargement: true })
        .png({ compressionLevel: 9 })
        .toFile(out);
      const outKB = (statSync(out).size / 1024).toFixed(0);
      console.log(`  ✓ ${basename(src).padEnd(34)} ${inMB.padStart(5)}MB → ${info.width}×${info.height}px ${outKB.padStart(5)}KB`);
      rendered++;
    } catch (e) {
      // libvips can't parse some huge multi-artboard boards (XML buffer limit) — fall back to Chrome.
      if (chrome) {
        try {
          const info = renderViaChrome(src, out, chrome);
          const outKB = (statSync(out).size / 1024).toFixed(0);
          console.log(`  ✓ ${basename(src).padEnd(34)} ${inMB.padStart(5)}MB → ${info.width}×${info.height}px ${outKB.padStart(5)}KB  [chrome]`);
          rendered++; viaChrome++;
          continue;
        } catch (e2) {
          console.error(`  ✗ ${basename(src)}: sharp(${e.message.split("\n")[0]}) + chrome(${e2.message})`);
          failed++;
          continue;
        }
      }
      console.error(`  ✗ ${basename(src)}: ${e.message.split("\n")[0]}  (no Chrome for fallback)`);
      failed++;
    }
  }
}

console.log(`\nDone. rendered=${rendered} (chrome=${viaChrome}) skipped(up-to-date)=${skipped} failed=${failed}`);
console.log("Agents: read from <figma>/_rendered/*.png — never the raw .svg.");
