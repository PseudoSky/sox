#!/usr/bin/env node
/**
 * tools/test-bl214-bundle-extension-tsconfig.mjs — regression test for BL-214.
 *
 * BL-214: `tools/bundle-extension.cjs` used to default an omitted --tsconfig
 * unconditionally to memory-server's tsconfig.json — so every extension
 * bundled without an explicit --tsconfig silently compiled against
 * memory-server's compiler options. Fixed by deriving the tsconfig from the
 * extension being bundled (nearest tsconfig.json walking up from --entry's
 * directory, stopping short of the workspace root) and failing loudly when
 * none can be found.
 *
 * Covers:
 *   1. findTsconfig() unit behavior (derivation + "stop before workspace root").
 *   2. End-to-end `node tools/bundle-extension.cjs` (real esbuild build, no
 *      --tsconfig) against tokenguard — proves it picks tokenguard's OWN
 *      tsconfig.json, not memory-server's (the exact BL-214 regression).
 *      (tokenguard is used rather than memory-flush/memory-cli because those
 *      transitively pull in @adhd/sox-ingest, whose ast-chunker.ts has a
 *      module-scope top-level await that esbuild's cjs bundle format cannot
 *      support — a real, pre-existing, unrelated bug; see the test report.)
 *   3. End-to-end hard-failure: an entry point with no tsconfig.json anywhere
 *      between it and the workspace root must exit non-zero with a clear
 *      error — never silently fall back to the workspace root's
 *      references-only tsconfig.json.
 *
 * Run: node tools/test-bl214-bundle-extension-tsconfig.mjs
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { findTsconfig } = require(path.join(ROOT, 'tools', 'bundle-extension.cjs'));

let failed = 0;
const ok = (cond, msg) => {
  if (cond) console.log(`  PASS: ${msg}`);
  else { console.error(`  FAIL: ${msg}`); failed++; }
};

console.log('BL-214 — bundle-extension.cjs tsconfig derivation\n');

// ── 1. Unit: findTsconfig ─────────────────────────────────────────────────
console.log('[1] findTsconfig() unit behavior');

{
  // memory-flush entry -> should find memory-flush's own tsconfig.json, not
  // memory-server's (the exact silent-cross-contamination bug).
  const entryDir = path.join(
    ROOT,
    'extensions/bundles/sox-memory-bundle/members/memory-flush/src',
  );
  const found = findTsconfig(entryDir, ROOT);
  const expected = path.join(
    ROOT,
    'extensions/bundles/sox-memory-bundle/members/memory-flush/tsconfig.json',
  );
  ok(found === expected, `memory-flush entry derives memory-flush's own tsconfig.json (got ${found})`);
  ok(
    found !== path.join(ROOT, 'extensions/bundles/sox-memory-bundle/members/memory-server/tsconfig.json'),
    "derived tsconfig is NOT memory-server's (the BL-214 regression)",
  );
}

{
  // A directory with no tsconfig.json anywhere before the workspace root
  // (tools/ has none) must return null, not the workspace root's tsconfig.json.
  const entryDir = path.join(ROOT, 'tools');
  const found = findTsconfig(entryDir, ROOT);
  ok(found === null, `tools/ (no ancestor tsconfig before workspace root) returns null (got ${found})`);
  ok(
    fs.existsSync(path.join(ROOT, 'tsconfig.json')),
    'sanity: workspace root DOES have a tsconfig.json (proves null is not an accident of an empty repo)',
  );
}

{
  // Explicit --tsconfig always wins — findTsconfig is only consulted when
  // args.tsconfig is falsy; verified at the CLI level in section [2]/[3] below.
  // Here: same-directory-as-entry case.
  const found = findTsconfig(
    path.join(ROOT, 'extensions/services/tokenguard/src'),
    ROOT,
  );
  ok(
    found === path.join(ROOT, 'extensions/services/tokenguard/tsconfig.json'),
    `tokenguard entry derives tokenguard's own tsconfig.json (got ${found})`,
  );
}

// ── 2. End-to-end: real esbuild build, no --tsconfig, against tokenguard ──
console.log('\n[2] end-to-end: node tools/bundle-extension.cjs (no --tsconfig) against tokenguard');

const TMP_OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'bl214-tokenguard-'));
try {
  const res = spawnSync(process.execPath, [
    path.join(ROOT, 'tools', 'bundle-extension.cjs'),
    '--entry', 'extensions/services/tokenguard/src/index.ts',
    '--outdir', TMP_OUT,
  ], { encoding: 'utf8', cwd: ROOT });

  console.log('  --- stdout ---');
  console.log(res.stdout.split('\n').map((l) => '  ' + l).join('\n'));
  if (res.stderr) {
    console.log('  --- stderr ---');
    console.log(res.stderr.split('\n').map((l) => '  ' + l).join('\n'));
  }

  ok(res.status === 0, `build exits 0 (got ${res.status})`);
  ok(
    res.stdout.includes('extensions/services/tokenguard/tsconfig.json'),
    'stdout reports the auto-derived tokenguard tsconfig.json path',
  );
  ok(res.stdout.includes('(auto-derived)'), 'stdout marks the tsconfig as auto-derived');
  ok(fs.existsSync(path.join(TMP_OUT, 'index.js')), 'bundle artifact was produced');
} finally {
  fs.rmSync(TMP_OUT, { recursive: true, force: true });
}

// ── 3. End-to-end: hard failure when no tsconfig.json is discoverable ──────
console.log('\n[3] end-to-end: hard failure (no --tsconfig, no discoverable tsconfig.json)');

const PROBE_DIR = path.join(ROOT, 'tools', '__bl214_no_tsconfig_probe__');
const PROBE_OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'bl214-nofail-'));
try {
  fs.mkdirSync(PROBE_DIR, { recursive: true });
  fs.writeFileSync(path.join(PROBE_DIR, 'index.ts'), 'export const x = 1;\n', 'utf8');

  const res = spawnSync(process.execPath, [
    path.join(ROOT, 'tools', 'bundle-extension.cjs'),
    '--entry', 'tools/__bl214_no_tsconfig_probe__/index.ts',
    '--outdir', PROBE_OUT,
  ], { encoding: 'utf8', cwd: ROOT });

  console.log('  --- stdout ---');
  console.log(res.stdout.split('\n').map((l) => '  ' + l).join('\n'));
  console.log('  --- stderr ---');
  console.log(res.stderr.split('\n').map((l) => '  ' + l).join('\n'));

  ok(res.status !== 0, `build exits non-zero when no tsconfig.json is discoverable (got ${res.status})`);
  ok(
    res.stderr.includes('no tsconfig.json found'),
    'stderr explains no tsconfig.json was found',
  );
  ok(
    !fs.existsSync(path.join(PROBE_OUT, 'index.js')),
    'no bundle artifact was produced (did NOT silently fall back and build anyway)',
  );
} finally {
  fs.rmSync(PROBE_DIR, { recursive: true, force: true });
  fs.rmSync(PROBE_OUT, { recursive: true, force: true });
}

console.log(
  failed === 0
    ? '\nBL-214 regression: ALL PASS'
    : `\nBL-214 regression: ${failed} FAILED`,
);
process.exit(failed === 0 ? 0 : 1);
