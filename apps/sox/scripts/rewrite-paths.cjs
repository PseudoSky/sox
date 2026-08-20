/**
 * Post-build path rewriter for dist/apps/sox/*.js.
 *
 * TypeScript compiles @adhd/sox-* imports to require('@adhd/sox-...') but there are no
 * node_modules symlinks for these workspace libs. This script rewrites the
 * compiled output to use relative paths that CJS can resolve at runtime.
 *
 * BUG-SOX-VERIFYARTIFACT-PASSES-FILEURL-TO-FS-001: originally rewrote ONLY
 * dist/apps/sox/main.js. That was correct while main.ts was the sole source
 * file under apps/sox/src importing an @adhd/sox-* package — every other
 * module (bundle-init.ts, path-safety.ts, serve-shutdown.ts, ...) had none of
 * these aliases to rewrite, so main.js being the only rewritten file happened
 * to be sufficient. Extracting verify-artifact.ts out of main.ts (so it can
 * be unit-tested without main.ts's `void main()` module-top-level side
 * effect) broke that: tsc now emits dist/apps/sox/verify-artifact.js with its
 * own un-rewritten '@adhd/sox-host-runtime' / '@adhd/sox-install-engine'
 * requires, and dist/apps/sox/main.js — the real entrypoint bin/soxe execs,
 * and the one every apps/sox/src/*.spec.ts CLI-driving test spawns — threw
 * MODULE_NOT_FOUND the moment it required verify-artifact.js. Rewrite every
 * compiled .js in dist/apps/sox now, not just main.js, so this can't recur
 * the next time a helper module is split out of main.ts.
 *
 * Run from $ROOT: node apps/sox/scripts/rewrite-paths.cjs
 */
'use strict';
const fs = require('fs');
const path = require('path');

const distDir = path.resolve(__dirname, '../../../dist/apps/sox');

// Map: @adhd alias → relative path from dist/apps/sox/
const aliases = {
  '@adhd/sox-install-engine': '../../../libs/install-engine/dist/index.js',
  '@adhd/sox-host-registry':  '../../../libs/host-registry/dist/index.js',
  '@adhd/sox-host-runtime':   '../../../libs/host-runtime/dist/index.js',
  '@adhd/sox-manifest':       '../../../libs/manifest/dist/index.js',
  '@adhd/sox-authoring':      '../../../libs/authoring/dist/index.js',
  '@adhd/sox-registry':       '../../../libs/registry/dist/index.js',
  '@adhd/sox-service-proxy':  '../../../libs/service-proxy/dist/index.js',
  '@adhd/sox-telemetry':      '../../../libs/observability/sox-telemetry/dist/index.js',
};

let rewritten = 0;
for (const entry of fs.readdirSync(distDir, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
  const file = path.join(distDir, entry.name);
  let src = fs.readFileSync(file, 'utf8');
  const before = src;
  for (const [alias, rel] of Object.entries(aliases)) {
    // Replace both double-quoted and single-quoted forms
    src = src.replaceAll(`"${alias}"`, `"${rel}"`);
    src = src.replaceAll(`'${alias}'`, `'${rel}'`);
  }
  if (src !== before) {
    fs.writeFileSync(file, src, 'utf8');
    rewritten++;
  }
}

console.log(`rewrite-paths: OK (${rewritten} file(s) rewritten)`);
