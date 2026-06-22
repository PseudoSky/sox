/**
 * Post-build path rewriter for dist/apps/sox/main.js.
 *
 * TypeScript compiles @sox/* imports to require('@sox/...') but there are no
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

// Map: @sox alias → relative path from dist/apps/sox/
const aliases = {
  '@sox/install-engine': '../../../libs/install-engine/dist/index.js',
  '@sox/host-registry':  '../../../libs/host-registry/dist/index.js',
  '@sox/host-runtime':   '../../../libs/host-runtime/dist/index.js',
  '@sox/manifest':       '../../../libs/manifest/dist/index.js',
  '@sox/authoring':      '../../../libs/authoring/dist/index.js',
  '@sox/registry':       '../../../libs/registry/dist/index.js',
};

for (const [alias, rel] of Object.entries(aliases)) {
  // Replace both double-quoted and single-quoted forms
  src = src.replaceAll(`"${alias}"`, `"${rel}"`);
  src = src.replaceAll(`'${alias}'`, `'${rel}'`);
}

fs.writeFileSync(file, src, 'utf8');
console.log('rewrite-paths: OK');
