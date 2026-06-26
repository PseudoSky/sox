/**
 * tools/bundle-extension.cjs
 *
 * esbuild-based bundler for Sox extensions.
 * Produces a self-contained Node.js CJS bundle from a TypeScript entry point.
 *
 * Usage:
 *   node tools/bundle-extension.cjs \
 *     --entry <file.ts> \
 *     --outdir <dir> \
 *     --external <pkg> [--external <pkg2> ...]
 *
 * All @adhd/sox-* packages are inlined (not external) — resolved to their pre-built
 * dist directories so the bundle runs without the monorepo on $NODE_PATH.
 *
 * Native addons (better-sqlite3, sqlite-vec) must be declared --external and
 * are loaded lazily at first use (not at module-load time) via a virtual stub
 * plugin, so the bundle can start up in environments where they are absent.
 */

'use strict';

const path = require('path');
const fs   = require('fs');

// ---------------------------------------------------------------------------
// Resolve esbuild from the pnpm store (the .bin shim is a bash script that
// Node 24 cannot exec directly).
// ---------------------------------------------------------------------------
const REPO_ROOT = path.resolve(__dirname, '..');
const ESBUILD_PATH = path.join(
  REPO_ROOT,
  'node_modules/.pnpm/node_modules/esbuild',
);
const esbuild = require(ESBUILD_PATH);

// ---------------------------------------------------------------------------
// @adhd/sox-* alias map — point every workspace package to its pre-built dist.
// These are NOT in node_modules so esbuild cannot resolve them automatically.
// ---------------------------------------------------------------------------
const SOX_ALIASES = {
  '@adhd/sox-mcp-runtime':    path.join(REPO_ROOT, 'libs/mcp-runtime/dist/index.js'),
  '@adhd/sox-memory-core':    path.join(REPO_ROOT, 'libs/memory-core/dist/index.js'),
  '@adhd/sox-memory-enrich':  path.join(REPO_ROOT, 'libs/memory-enrich/dist/index.js'),
  '@adhd/sox-install-engine': path.join(REPO_ROOT, 'libs/install-engine/dist/index.js'),
  '@adhd/sox-host-runtime':   path.join(REPO_ROOT, 'libs/host-runtime/dist/index.js'),
  '@adhd/sox-manifest':       path.join(REPO_ROOT, 'libs/manifest/dist/index.js'),
  '@adhd/sox-authoring':      path.join(REPO_ROOT, 'libs/authoring/dist/index.js'),
  '@adhd/sox-registry':       path.join(REPO_ROOT, 'libs/registry/dist/index.js'),
  '@adhd/sox-host-registry':  path.join(REPO_ROOT, 'libs/host-registry/dist/index.js'),
  '@adhd/sox-tokenguard-core': path.join(REPO_ROOT, 'libs/tokenguard-core/dist/index.js'),
  '@adhd/sox-service-proxy':  path.join(REPO_ROOT, 'libs/service-proxy/dist/index.js'),
};

// ---------------------------------------------------------------------------
// Parse CLI arguments
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = { entry: null, outdir: null, externals: [], tsconfig: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--entry' && argv[i + 1]) {
      args.entry = path.resolve(REPO_ROOT, argv[++i]);
    } else if (argv[i] === '--outdir' && argv[i + 1]) {
      args.outdir = path.resolve(argv[++i]);
    } else if (argv[i] === '--external' && argv[i + 1]) {
      args.externals.push(argv[++i]);
    } else if (argv[i] === '--tsconfig' && argv[i + 1]) {
      args.tsconfig = path.resolve(REPO_ROOT, argv[++i]);
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// esbuild plugin: resolve @adhd/sox-* to pre-built dist dirs
// ---------------------------------------------------------------------------
function soxAliasPlugin() {
  return {
    name: 'sox-alias',
    setup(build) {
      // Intercept any import path that starts with @adhd/sox-
      build.onResolve({ filter: /^@adhd\// }, (args) => {
        const resolved = SOX_ALIASES[args.path];
        if (resolved) {
          return { path: resolved };
        }
        // Unknown @adhd/sox-* — let esbuild error naturally
        return null;
      });
    },
  };
}

// ---------------------------------------------------------------------------
// esbuild plugin: make external native addons lazy (loaded on first property
// access, not at module-load time). This allows the bundle to start up in
// environments where the native addon is absent (e.g. /tmp on a CI runner)
// as long as no tool handler is actually called.
//
// The plugin intercepts the IMPORT of the package (which esbuild resolves to
// a virtual module) and replaces it with a Proxy-based lazy loader. The real
// require() is deferred until a property of the module is first accessed.
// ---------------------------------------------------------------------------
function lazyExternalPlugin(externalPkgs) {
  return {
    name: 'lazy-external',
    setup(build) {
      // For each external package, intercept its resolution and redirect to
      // a virtual namespace that emits a lazy-require stub.
      const filter = new RegExp(
        '^(' + externalPkgs.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')$'
      );

      build.onResolve({ filter }, (args) => {
        return { path: args.path, namespace: 'lazy-external' };
      });

      build.onLoad({ filter: /.*/, namespace: 'lazy-external' }, (args) => {
        const pkg = JSON.stringify(args.path);
        // Emit a CJS module that returns a Proxy.
        // The Proxy defers require() until the first property access or call.
        //
        // IMPORTANT: We must avoid esbuild rewriting our require() call to
        // __require (the bundle wrapper), which would cause infinite recursion
        // when loading the external package.
        //
        // Solution: use require('module').createRequire(__filename).
        //   - require('module') stays as-is (Node built-in, always external on
        //     the 'node' platform, esbuild does not rewrite it).
        //   - createRequire(__filename) produces a real Node.js require that
        //     resolves packages by walking up the directory tree from the bundle
        //     file. This means if the store dir (.sox/ext/<id>/) lives inside a
        //     monorepo, require() will find the monorepo's node_modules —
        //     including native addons like better-sqlite3 — without any copying.
        //   - new Function('m','return require(m)') is intentionally avoided:
        //     it runs in global scope where require is undefined (CJS module
        //     wrapper doesn't inject globals).
        // Emit a simple eager-load stub: use createRequire so Node.js walks
        // node_modules/ up from this bundle file, finding the monorepo's native
        // addons without any copying. No Proxy needed — the real module object
        // is returned directly, so __toESM sees all named exports correctly.
        const contents = `
"use strict";
// createRequire resolves relative to this bundle file, walking up to find
// node_modules/better-sqlite3 (or sqlite-vec) in the nearest ancestor dir.
var _cr = require('module').createRequire(typeof __filename !== 'undefined' ? __filename : __dirname + '/index.js');
module.exports = _cr(${pkg});
`;
        return { contents, loader: 'js' };
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.entry) {
    console.error('bundle-extension: --entry <file> is required');
    process.exit(1);
  }
  if (!args.outdir) {
    console.error('bundle-extension: --outdir <dir> is required');
    process.exit(1);
  }

  if (!fs.existsSync(args.entry)) {
    console.error(`bundle-extension: entry not found: ${args.entry}`);
    process.exit(1);
  }

  fs.mkdirSync(args.outdir, { recursive: true });

  console.log(`bundle-extension: bundling ${args.entry}`);
  console.log(`bundle-extension: outdir   ${args.outdir}`);
  console.log(`bundle-extension: external ${args.externals.join(', ') || '(none)'}`);

  try {
    await esbuild.build({
      entryPoints: [args.entry],
      outfile: path.join(args.outdir, 'index.js'),
      bundle: true,
      platform: 'node',
      format: 'cjs',
      // Target a broad Node.js version range
      target: 'node18',
      // Do NOT mark @adhd/sox-* external — they must be inlined.
      // External list contains only native addons passed via --external.
      // (We intercept them in lazyExternalPlugin above.)
      external: [],
      // Plugins: first resolve @adhd/sox-* aliases, then make externals lazy
      plugins: [
        soxAliasPlugin(),
        lazyExternalPlugin(args.externals),
      ],
      // tsconfig for TypeScript compilation (--tsconfig flag or default to memory-server)
      tsconfig: args.tsconfig || path.join(REPO_ROOT, 'extensions/bundles/sox-memory-bundle/members/memory-server/tsconfig.json'),
      // Source maps: linked produces a separate index.js.map sidecar.
      // Node.js picks it up automatically with --enable-source-maps.
      sourcemap: 'linked',
      // Suppress "require() of ES Module" warnings for .js ext imports
      mainFields: ['main', 'module'],
      conditions: ['require', 'node'],
      // Resolve .js extensions from TypeScript sources
      resolveExtensions: ['.ts', '.js', '.cjs', '.mjs'],
    });

    const outfile = path.join(args.outdir, 'index.js');
    if (!fs.existsSync(outfile)) {
      console.error('bundle-extension: esbuild succeeded but index.js not found');
      process.exit(1);
    }

    // Emit a package.json sidecar so Node.js loads this CJS bundle correctly
    // even when the repo root package.json has "type":"module".
    // Without this, Node.js v12+ rejects module.exports in .js files under an
    // ESM-root package and throws "ReferenceError: module is not defined in ES module scope".
    const pkgSidecar = path.join(args.outdir, 'package.json');
    fs.writeFileSync(pkgSidecar, JSON.stringify({ type: 'commonjs' }, null, 2) + '\n', 'utf8');

    const size = fs.statSync(outfile).size;
    const mapSize = fs.existsSync(outfile + '.map') ? fs.statSync(outfile + '.map').size : 0;
    console.log(
      `bundle-extension: OK — ${outfile} (${(size / 1024).toFixed(1)} KB)` +
      (mapSize > 0 ? ` + ${(mapSize / 1024).toFixed(1)} KB sourcemap` : ''),
    );
  } catch (err) {
    console.error('bundle-extension: build failed');
    console.error(err.message || err);
    process.exit(1);
  }
}

main();
