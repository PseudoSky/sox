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
 * --tsconfig is optional. If omitted, the nearest tsconfig.json is derived by
 * walking up from --entry's directory (stopping short of the workspace root —
 * BL-214). Pass --tsconfig explicitly to override, or if the extension has no
 * tsconfig.json of its own; omitting it with no discoverable tsconfig.json is
 * a hard error, not a silent fallback to some other extension's config.
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
  const args = { entry: null, outdir: null, externals: [], tsconfig: null, workers: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--entry' && argv[i + 1]) {
      args.entry = path.resolve(REPO_ROOT, argv[++i]);
    } else if (argv[i] === '--outdir' && argv[i + 1]) {
      args.outdir = path.resolve(argv[++i]);
    } else if (argv[i] === '--external' && argv[i + 1]) {
      args.externals.push(argv[++i]);
    } else if (argv[i] === '--tsconfig' && argv[i + 1]) {
      args.tsconfig = path.resolve(REPO_ROOT, argv[++i]);
    } else if (argv[i] === '--worker' && argv[i + 1]) {
      // Additional worker_thread entry. Bundled to <outdir>/<basename>.js as its own
      // self-contained CJS file, so a `new Worker(path.join(__dirname,'<basename>.js'))`
      // at runtime resolves. esbuild does NOT trace runtime-string Worker paths, so a
      // worker referenced that way MUST be emitted explicitly here or it is missing from
      // the bundle (the BL-87/BL-89 root cause: embedWorker.js was never emitted).
      args.workers.push(path.resolve(REPO_ROOT, argv[++i]));
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
// BL-214: derive the tsconfig from the extension being bundled when
// --tsconfig is not passed explicitly.
//
// Previously this defaulted unconditionally to memory-server's tsconfig.json,
// so every extension bundled without --tsconfig silently compiled against
// memory-server's compiler options. Instead, walk up from the entry point's
// directory looking for the nearest tsconfig.json, stopping *before* the
// workspace root (REPO_ROOT/tsconfig.json is a references-only workspace
// config, not any single extension's own config — falling back to it would
// be exactly the same class of silent-wrong-config bug this fixes).
//
// Returns the resolved tsconfig path, or null if none was found.
// ---------------------------------------------------------------------------
function findTsconfig(startDir, stopDir) {
  let dir = startDir;
  for (;;) {
    if (dir === stopDir) return null; // never silently fall back to the workspace root config
    const candidate = path.join(dir, 'tsconfig.json');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null; // reached filesystem root
    dir = parent;
  }
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

  // [BL-235] ATOMIC BUILD — never destroy a working artifact.
  //
  // The old contract was: `rm -rf <outdir>` in project.json, then bundle into it.
  // A failed bundle (broken source, a concurrent agent mid-edit, BL-231) therefore
  // left `<outdir>` EMPTY and unrecoverable — the only way back was a successful
  // build, which was precisely what was impossible. This destroyed the live
  // memory-server bundle twice on 2026-07-08, once merely from a diagnostic build.
  //
  // Now: bundle into a fresh staging dir, and swap it into place only after every
  // entry (and the package.json sidecar) has been written successfully. Clean-output
  // semantics are preserved because staging always starts empty — a file that is no
  // longer produced disappears on swap. On failure, `<outdir>` is untouched.
  const stageDir = `${args.outdir}.staging-${process.pid}`;
  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(stageDir, { recursive: true });

  console.log(`bundle-extension: bundling ${args.entry}`);
  console.log(`bundle-extension: outdir   ${args.outdir} (atomic; staged via ${path.basename(stageDir)})`);
  console.log(`bundle-extension: external ${args.externals.join(', ') || '(none)'}`);
  if (args.workers.length) {
    console.log(`bundle-extension: workers  ${args.workers.join(', ')}`);
  }

  const tsconfig =
    args.tsconfig || findTsconfig(path.dirname(args.entry), REPO_ROOT);

  if (!tsconfig) {
    console.error(`bundle-extension: no tsconfig.json found for entry ${args.entry}`);
    console.error(
      `  Searched upward from ${path.dirname(args.entry)} to ${REPO_ROOT} (exclusive of the workspace root).`,
    );
    console.error(
      `  Fix: add a tsconfig.json to the extension directory, or pass --tsconfig <path> explicitly.`,
    );
    process.exit(1);
  }
  console.log(`bundle-extension: tsconfig ${tsconfig}${args.tsconfig ? '' : ' (auto-derived)'}`);

  // Build a single entry → <outfile> as a self-contained CJS bundle.
  async function buildOne(entry, outfile) {
    await esbuild.build({
      entryPoints: [entry],
      outfile,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      // BL-155: shim import.meta.url for CJS output. esbuild replaces `import.meta`
      // with `{}` in cjs format, so `import.meta.url` becomes undefined and any
      // `fileURLToPath(import.meta.url)` at module scope (e.g. embedding-provider's
      // `const __dirname = dirname(fileURLToPath(import.meta.url))`, used to locate
      // the sibling embedWorker.js) throws "The path argument must be of type string
      // ... Received undefined" at init — crashing the whole extension. Point it at
      // this bundle's own file so __dirname-style sibling resolution works.
      banner: {
        js: `const __soxImportMetaUrl = require('url').pathToFileURL(__filename).href;`,
      },
      define: {
        'import.meta.url': '__soxImportMetaUrl',
      },
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
      tsconfig,
      // Source maps: linked produces a separate .map sidecar.
      // Node.js picks it up automatically with --enable-source-maps.
      sourcemap: 'linked',
      // Suppress "require() of ES Module" warnings for .js ext imports
      mainFields: ['main', 'module'],
      conditions: ['require', 'node'],
      // Resolve .js extensions from TypeScript sources
      resolveExtensions: ['.ts', '.js', '.cjs', '.mjs'],
    });

    if (!fs.existsSync(outfile)) {
      console.error(`bundle-extension: esbuild succeeded but ${outfile} not found`);
      process.exit(1);
    }
    const size = fs.statSync(outfile).size;
    const mapSize = fs.existsSync(outfile + '.map') ? fs.statSync(outfile + '.map').size : 0;
    console.log(
      `bundle-extension: OK — ${outfile} (${(size / 1024).toFixed(1)} KB)` +
      (mapSize > 0 ? ` + ${(mapSize / 1024).toFixed(1)} KB sourcemap` : ''),
    );
  }

  try {
    await buildOne(args.entry, path.join(stageDir, 'index.js'));

    // Worker entries: each bundled to <outdir>/<basename>.js so a runtime
    // `new Worker(path.join(__dirname,'<basename>.js'))` resolves (BL-87/BL-89).
    for (const worker of args.workers) {
      const base = path.basename(worker).replace(/\.(ts|mts|cts|js|mjs|cjs)$/i, '') + '.js';
      await buildOne(worker, path.join(stageDir, base));
    }

    // Emit a package.json sidecar so Node.js loads this CJS bundle correctly
    // even when the repo root package.json has "type":"module".
    // Without this, Node.js v12+ rejects module.exports in .js files under an
    // ESM-root package and throws "ReferenceError: module is not defined in ES module scope".
    const pkgSidecar = path.join(stageDir, 'package.json');
    fs.writeFileSync(pkgSidecar, JSON.stringify({ type: 'commonjs' }, null, 2) + '\n', 'utf8');
  } catch (err) {
    // [BL-235] The staged build failed. `<outdir>` was never touched — the previous
    // working artifact is still there. Drop staging and surface the real error.
    fs.rmSync(stageDir, { recursive: true, force: true });
    console.error('bundle-extension: build failed — existing output left intact at');
    console.error(`  ${args.outdir}`);
    console.error(err.message || err);
    process.exit(1);
  }

  // [BL-235] COMMIT — swap staging into place. Everything below succeeded, so this is
  // the only window in which `<outdir>` is not a valid artifact, and it is bounded by
  // two renames within one directory rather than a bundle's worth of compilation.
  const prevDir = `${args.outdir}.prev-${process.pid}`;
  const hadPrev = fs.existsSync(args.outdir);
  try {
    if (hadPrev) fs.renameSync(args.outdir, prevDir);
    fs.renameSync(stageDir, args.outdir);
  } catch (err) {
    // Roll back to the previous artifact rather than leaving a hole.
    if (hadPrev && !fs.existsSync(args.outdir) && fs.existsSync(prevDir)) {
      fs.renameSync(prevDir, args.outdir);
    }
    fs.rmSync(stageDir, { recursive: true, force: true });
    console.error('bundle-extension: could not swap staged output into place');
    console.error(err.message || err);
    process.exit(1);
  }
  fs.rmSync(prevDir, { recursive: true, force: true });
  console.log(`bundle-extension: committed → ${args.outdir}`);
}

// ---------------------------------------------------------------------------
// Exports for regression tests (BL-214, BL-225). Only run main() when
// invoked directly as `node tools/bundle-extension.cjs ...` — requiring this
// module (e.g. from a test script) must not trigger a build.
// ---------------------------------------------------------------------------
module.exports = { findTsconfig, parseArgs, REPO_ROOT };

if (require.main === module) {
  main();
}
