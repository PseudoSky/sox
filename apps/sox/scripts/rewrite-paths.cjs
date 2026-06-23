/**
 * Post-build path rewriter for dist/apps/sox/main.js.
 *
 * TypeScript compiles @adhd/sox-* imports to require('@adhd/sox-...') but there are no
 * node_modules symlinks for these workspace libs. This script rewrites the
 * compiled output to use relative paths that CJS can resolve at runtime.
 *
 * Run from $ROOT: node apps/sox/scripts/rewrite-paths.cjs
 */
'use strict';
const fs = require('fs');
const path = require('path');

const file = path.resolve(__dirname, '../../../dist/apps/sox/main.js');
let src = fs.readFileSync(file, 'utf8');

// Map: @adhd alias → relative path from dist/apps/sox/
const aliases = {
  '@adhd/sox-install-engine': '../../../libs/install-engine/dist/index.js',
  '@adhd/sox-host-registry':  '../../../libs/host-registry/dist/index.js',
  '@adhd/sox-host-runtime':   '../../../libs/host-runtime/dist/index.js',
  '@adhd/sox-manifest':       '../../../libs/manifest/dist/index.js',
  '@adhd/sox-authoring':      '../../../libs/authoring/dist/index.js',
  '@adhd/sox-registry':       '../../../libs/registry/dist/index.js',
};

for (const [alias, rel] of Object.entries(aliases)) {
  // Replace both double-quoted and single-quoted forms
  src = src.replaceAll(`"${alias}"`, `"${rel}"`);
  src = src.replaceAll(`'${alias}'`, `'${rel}'`);
}

fs.writeFileSync(file, src, 'utf8');
console.log('rewrite-paths: OK');
