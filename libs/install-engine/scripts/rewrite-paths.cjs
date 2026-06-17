/**
 * Post-build path rewriter for libs/install-engine/dist.
 *
 * TypeScript compiles `require('@sox/host-registry')` to a bare specifier, but
 * there are no node_modules symlinks for these workspace libs at runtime. This
 * script rewrites the compiled dist to relative paths CJS can resolve, so the
 * SOURCE stays C7-clean (scoped import) while the running code resolves the
 * sibling lib's dist. Mirrors apps/sox/scripts/rewrite-paths.cjs.
 *
 * Run from $ROOT: node libs/install-engine/scripts/rewrite-paths.cjs
 */
'use strict';
const fs = require('fs');
const path = require('path');

const distDir = path.resolve(__dirname, '../dist');
const libsDir = path.resolve(__dirname, '../../'); // .../libs

// @sox alias → absolute path of the sibling lib's built entrypoint
const targets = {
  '@sox/host-registry': path.join(libsDir, 'host-registry/dist/index.js'),
  '@sox/host-runtime': path.join(libsDir, 'host-runtime/dist/index.js'),
  '@sox/manifest': path.join(libsDir, 'manifest/dist/index.js'),
  '@sox/registry': path.join(libsDir, 'registry/dist/index.js'),
  '@sox/memory-core': path.join(libsDir, 'memory-core/dist/index.js'),
};

function rewriteFile(file) {
  let src = fs.readFileSync(file, 'utf8');
  let changed = false;
  for (const [alias, absTarget] of Object.entries(targets)) {
    let rel = path.relative(path.dirname(file), absTarget);
    if (!rel.startsWith('.')) rel = './' + rel;
    for (const q of ['"', "'"]) {
      const from = q + alias + q;
      if (src.includes(from)) {
        src = src.split(from).join(q + rel + q);
        changed = true;
      }
    }
  }
  if (changed) fs.writeFileSync(file, src, 'utf8');
  return changed;
}

function walk(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) n += walk(p);
    else if (e.name.endsWith('.js')) n += rewriteFile(p) ? 1 : 0;
  }
  return n;
}

if (!fs.existsSync(distDir)) {
  console.error('rewrite-paths: dist not found at ' + distDir);
  process.exit(1);
}
const count = walk(distDir);
console.log('rewrite-paths: OK (install-engine, ' + count + ' file(s) rewritten)');
