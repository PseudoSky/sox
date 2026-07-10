#!/usr/bin/env node
/**
 * [BL-231] Regression guard for the CommonJS/ESM boundary of `@adhd/sox-ingest`.
 *
 * WHAT BROKE
 * ----------
 * Commit `c01ddeb` ("P1(ast-chunker): real tree-sitter AST chunker") added a
 * genuine module-scope `await Parser.init()` to `ast-chunker.ts` — legitimate
 * ESM, and necessary because `AstChunker.chunk()`/`.estimate()` are synchronous
 * by contract while `web-tree-sitter@0.25.10` exposes no `initSync`.
 *
 * But `ingest/src/index.ts` statically re-exports `AstChunker`, so ANY import of
 * the package root dragged that top-level await into the module graph. And
 * `@adhd/sox-memory-core` compiles to CommonJS and `require()`s it. Result:
 *
 *   Error [ERR_REQUIRE_ASYNC_MODULE]: require() cannot be used on an ESM graph
 *   with top-level await.
 *
 * That took `nx test memory-server`, `nx test memory-flush`, `nx build
 * memory-server`, and `scripts/smoke-test.mjs` (repo-wide) to zero, silently,
 * for two days. It shipped because BL-115 was marked RESOLVED with no test
 * proving the CJS boundary still held. See BL-225.
 *
 * THE FIX
 * -------
 * `ingest/src/core.ts` holds the pure surface (`ingest`, `hexSha256`,
 * `splitIntoChunksSentence`) with ZERO chunker imports, published as the
 * `@adhd/sox-ingest/core` subpath. CJS consumers import that. The package root
 * stays ESM-only and keeps the full chunker surface, unchanged.
 *
 * WHAT THIS GUARDS
 * ----------------
 *  1. `require()` of the CJS-safe subpath succeeds.
 *  2. `require()` of `@adhd/sox-memory-core` succeeds (the actual regression).
 *  3. The compiled memory-core CJS references `@adhd/sox-ingest/core`, never the
 *     package root — so nobody "helpfully" reverts the import and re-arms it.
 *  4. `core.js`'s emitted graph contains no top-level await.
 *
 * This script FAILS LOUDLY when the dist artifacts are absent. It must never
 * skip-and-pass — that is the `verify-native-abi.mjs` bug (BL-222), where a
 * missing install made the checker report "all OK" having verified nothing.
 */

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const REPO_ROOT = path
  .resolve(
    execFileSync('git', ['rev-parse', '--git-common-dir'], { encoding: 'utf8' }).trim(),
    '..',
  );

const require_ = createRequire(path.join(REPO_ROOT, 'noop.cjs'));

const INGEST_CORE = path.join(REPO_ROOT, 'libs/data/ingest/ingest/dist/core.js');
const MEMORY_CORE = path.join(REPO_ROOT, 'libs/memory-core/dist/index.js');
const MC_EXTRACTIVE = path.join(REPO_ROOT, 'libs/memory-core/dist/extractive.js');
const MC_WRITE = path.join(REPO_ROOT, 'libs/memory-core/dist/write.js');

let failures = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m) => {
  failures++;
  console.error(`  FAIL  ${m}`);
};

console.log('test-bl231-cjs-boundary — @adhd/sox-ingest CJS/ESM boundary\n');

// Precondition: never silently pass on a missing build (BL-222's lesson).
const missing = [INGEST_CORE, MEMORY_CORE, MC_EXTRACTIVE, MC_WRITE].filter((p) => !existsSync(p));
if (missing.length > 0) {
  console.error('FATAL: required build artifacts are missing — cannot verify anything.\n');
  for (const m of missing) console.error(`  missing: ${path.relative(REPO_ROOT, m)}`);
  console.error('\nBuild first:  npx nx build ingest && npx nx build memory-core');
  console.error('Refusing to report success without checking. (BL-222)');
  process.exit(1);
}

// 1. The CJS-safe subpath must be require()-able.
try {
  const core = require_(INGEST_CORE);
  if (typeof core.ingest === 'function' && typeof core.hexSha256 === 'function') {
    ok('require() of ingest/dist/core.js succeeds and exports the pure surface');
  } else {
    bad('ingest/dist/core.js loaded but is missing ingest()/hexSha256()');
  }
} catch (err) {
  bad(`require() of ingest/dist/core.js threw: ${err.code ?? err.message}`);
}

// 2. The actual BL-231 regression: memory-core must be require()-able from CJS.
try {
  const mc = require_(MEMORY_CORE);
  if (typeof mc.hexSha256 === 'function') {
    ok('require() of memory-core/dist/index.js succeeds (BL-231 regression)');
  } else {
    bad('memory-core/dist/index.js loaded but hexSha256 is not exported');
  }
} catch (err) {
  if (err.code === 'ERR_REQUIRE_ASYNC_MODULE') {
    bad('BL-231 HAS REGRESSED: memory-core CJS require hit ERR_REQUIRE_ASYNC_MODULE. '
      + 'Something re-introduced a top-level await into the require graph.');
  } else {
    bad(`require() of memory-core/dist/index.js threw: ${err.code ?? err.message}`);
  }
}

// 3. Compiled memory-core must target the subpath, never the ESM-only root.
for (const [label, file] of [['extractive.js', MC_EXTRACTIVE], ['write.js', MC_WRITE]]) {
  const src = readFileSync(file, 'utf8');
  const rootReq = /require\(["']@adhd\/sox-ingest["']\)/.test(src);
  const coreReq = /require\(["']@adhd\/sox-ingest\/core["']\)/.test(src);
  if (rootReq) {
    bad(`memory-core/dist/${label} require()s the ESM-only package root — re-arms BL-231`);
  } else if (coreReq) {
    ok(`memory-core/dist/${label} require()s @adhd/sox-ingest/core`);
  } else {
    ok(`memory-core/dist/${label} does not require @adhd/sox-ingest at all`);
  }
}

// 4. core.js's own emitted output must be free of top-level await.
{
  const src = readFileSync(INGEST_CORE, 'utf8');
  // Match `await` at statement position with no enclosing async function on the line's indent 0.
  const tla = /^\s*await\s/m.test(src) || /^await\s/m.test(src);
  if (tla) bad('ingest/dist/core.js contains a top-level await — the CJS boundary is unsafe');
  else ok('ingest/dist/core.js emitted graph has no top-level await');
}

console.log('');
if (failures > 0) {
  console.error(`test-bl231-cjs-boundary: ${failures} failure(s).`);
  process.exit(1);
}
console.log('test-bl231-cjs-boundary: CJS/ESM boundary intact.');
