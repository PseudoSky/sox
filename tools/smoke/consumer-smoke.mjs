#!/usr/bin/env node
// tools/smoke/consumer-smoke.mjs
//
// P1 substrate — publish-link state. PROVES dod.1: "a clean consumer can
// install and import every substrate package ASP needs."
//
// This script *is* the fresh consumer: on every run it bootstraps its own
// `node_modules/@adhd/*` symlink farm (created here, not by `pnpm install`,
// so it never touches the workspace lockfile) pointing at the real,
// already-built substrate packages, then resolves each package by its real
// `@adhd/sox-*` specifier through Node's normal module resolver (respecting
// each package's `package.json#exports`, exactly as a registry install or a
// `workspace:*` link would) and exercises one trivial, network-free,
// deterministic operation against its real public API.
//
// Design constraints (see contexts/publish-link.md + README.md dod.1):
//   - No `npm 404`: every package must resolve through Node's own resolver.
//   - No "private-dependency resolution error": every package's source
//     `package.json#private` must be `false`/absent (this is exactly the
//     dod.1 negative control -- see --negative-control below).
//   - "one trivial op" per package: intentionally network-free and
//     model-download-free. The heavy, real-ONNX / real-model paths
//     (fastembed warmup, cross-encoder rerank, claim-verification warmUp)
//     are proven end-to-end by the `integration` state's dod.2 fixture-repo
//     pipeline test, not here. This state proves *importability*, not deep
//     behavior -- conflating the two would make a hermetic, fast, CI-safe
//     link-smoke into a slow, network-dependent, flaky one.
//
// Usage:
//   node consumer-smoke.mjs --set @adhd/sox-* --assert exit0
//   node consumer-smoke.mjs --negative-control sox-ingest   # self-test only,
//                                                            # intentionally
//                                                            # exits non-zero
//
// Exit code: 0 iff every package in --set imports and its trivial op
// succeeds. Non-zero (with a clearly labelled error) otherwise.

import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..'); // sox-ecosystem/
const SMOKE_NODE_MODULES = path.join(HERE, 'node_modules', '@adhd');

// ── The @adhd/sox-* substrate set this state converges (publish-link.md
// depends_on: source-provider, task-queue, lancedb-backend, ast-chunker,
// ingest-public, cross-encoder, wire-blob-claim -- mapped to the 8 real
// packages those 7 tracks touch). ─────────────────────────────────────────
const SUBSTRATE_PACKAGES = [
  { key: 'source-provider', relPath: 'libs/source-provider' },
  { key: 'task-queue', relPath: 'libs/data/queue/task-queue' },
  { key: 'vector-store', relPath: 'libs/data/vectors/vector-store' },
  { key: 'ingest', relPath: 'libs/data/ingest/ingest' },
  { key: 'hybrid-search', relPath: 'libs/data/search/hybrid-search' },
  { key: 'embedding-provider', relPath: 'libs/data/embed/embedding-provider' },
  { key: 'blob-store', relPath: 'libs/data/store/blob-store' },
  { key: 'claim-verification', relPath: 'libs/data/verify/claim-verification' },
];

// ── CLI args ────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { set: '@adhd/sox-*', assert: null, negativeControl: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--set') out.set = argv[++i];
    else if (a === '--assert') out.assert = argv[++i];
    else if (a === '--negative-control') out.negativeControl = argv[++i] ?? true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

if (args.set !== '@adhd/sox-*') {
  console.error(`RED: unsupported --set "${args.set}" (only "@adhd/sox-*" -- the complete substrate set -- is supported)`);
  process.exit(1);
}

// ── Step 1: resolve + validate each package's real, on-disk manifest ───────
// This is the dod.1 "no private-dependency resolution error" gate: a
// `private: true` package can never be `npm install`-ed or registry-linked
// by a real external consumer, so we fail loudly and immediately, before
// ever attempting to import it.

function loadManifest(pkg) {
  const dir = path.join(REPO_ROOT, pkg.relPath);
  const pkgJsonPath = path.join(dir, 'package.json');
  if (!existsSync(pkgJsonPath)) {
    throw new SmokeError(pkg.key, `package.json not found at ${pkgJsonPath}`);
  }
  const manifest = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
  if (!manifest.name || !manifest.name.startsWith('@adhd/sox-')) {
    throw new SmokeError(pkg.key, `package name "${manifest.name}" is not in the @adhd/sox-* namespace`);
  }
  const shortName = manifest.name.replace('@adhd/', '');
  const forcedPrivate =
    args.negativeControl === manifest.name ||
    args.negativeControl === pkg.key ||
    args.negativeControl === shortName;
  const isPrivate = forcedPrivate ? true : manifest.private === true;
  if (isPrivate) {
    throw new SmokeError(
      manifest.name,
      `PRIVATE-DEPENDENCY RESOLUTION ERROR: "${manifest.name}" has private:true -- ` +
        'a real external consumer cannot npm-install or workspace-link this package. ' +
        (forcedPrivate ? '(forced by --negative-control -- this failure is expected)' : ''),
    );
  }
  if (!existsSync(path.join(dir, 'dist', 'index.js'))) {
    throw new SmokeError(manifest.name, `dist/index.js not built at ${dir}/dist -- package is not publishable in its current state`);
  }
  return { ...pkg, dir, manifest, name: manifest.name };
}

class SmokeError extends Error {
  constructor(pkgLabel, message) {
    super(`[${pkgLabel}] ${message}`);
    this.pkgLabel = pkgLabel;
  }
}

// ── Step 2: bootstrap the fresh-consumer node_modules/@adhd/* symlink farm ──
// Mechanically identical to what `pnpm install` produces for a
// `workspace:*` link (a symlink to the real package directory) -- but
// created here at runtime so this script never invokes `pnpm install` or
// touches pnpm-lock.yaml. Idempotent: only (re)writes a symlink if it is
// missing or stale.

function ensureWorkspaceLink(pkg) {
  mkdirSync(SMOKE_NODE_MODULES, { recursive: true });
  const shortName = pkg.name.replace('@adhd/', '');
  const linkPath = path.join(SMOKE_NODE_MODULES, shortName);
  const target = pkg.dir;

  let needsLink = true;
  if (existsSync(linkPath) || isDanglingSymlink(linkPath)) {
    try {
      const st = lstatSync(linkPath);
      if (st.isSymbolicLink() && path.resolve(path.dirname(linkPath), readlinkSync(linkPath)) === target) {
        needsLink = false;
      } else {
        rmSync(linkPath, { recursive: true, force: true });
      }
    } catch {
      rmSync(linkPath, { recursive: true, force: true });
    }
  }
  if (needsLink) {
    symlinkSync(target, linkPath, 'dir');
  }
  return `@adhd/${shortName}`;
}

function isDanglingSymlink(p) {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

// ── Step 3: one trivial, network-free op per package ───────────────────────

const TRIVIAL_OPS = {
  'source-provider': async (mod) => {
    const provider = mod.createLocalProvider();
    if (typeof provider.isAvailable !== 'function') throw new Error('createLocalProvider() did not return a SourceProvider');
    const available = provider.isAvailable();
    if (typeof available !== 'boolean') throw new Error('isAvailable() did not return a boolean');
    return `createLocalProvider() -> isAvailable()=${available}`;
  },

  'task-queue': async (mod) => {
    const queue = mod.createTaskQueue({ dbPath: ':memory:' });
    await queue.open();
    const stats = typeof queue.stats === 'function' ? await queue.stats() : null;
    await queue.close();
    return `createTaskQueue({dbPath:':memory:'}) -> open()/close() ok${stats ? `, stats=${JSON.stringify(stats)}` : ''}`;
  },

  'vector-store': async (mod) => {
    const backend = mod.openVectorStore(':memory:', { dim: 3, modelId: 'smoke-test' });
    backend.ensureSpace({ modelId: 'smoke-test', dim: 3 });
    backend.upsert(1, new Float32Array([1, 0, 0]), { modelId: 'smoke-test', dim: 3 });
    const hit = backend.get(1, 'smoke-test');
    if (!hit || hit.length !== 3) throw new Error('VectorBackend upsert/get round-trip failed');
    return 'openVectorStore(\':memory:\') -> ensureSpace()/upsert()/get() round-trip ok';
  },

  'ingest': async (mod) => {
    const chunker = mod.globalChunkerRegistry.get('ast:treesitter:ts');
    if (!chunker) throw new Error('ast:treesitter:ts chunker not registered');
    const chunks = chunker.chunk('export function smoke(): number {\n  return 1;\n}\n');
    if (!Array.isArray(chunks) || chunks.length === 0) throw new Error('AstChunker.chunk() returned no chunks');
    return `globalChunkerRegistry.get('ast:treesitter:ts').chunk() -> ${chunks.length} chunk(s)`;
  },

  'hybrid-search': async (mod) => {
    // Deliberately does NOT call .rerank()/.rerankBatch(): those lazily start
    // the shared ONNX worker on first use and would download the MiniCheck
    // model on a cold cache. Construction + metadata + dispose() is the same
    // network-free contract exercised by this package's own unit test
    // ("createCrossEncoder returns a CrossEncoder instance").
    //
    // NOTE (ADR-0019): createCrossEncoder() resolves @adhd/sox-embedding-provider
    // lazily on first call, so this probe requires embedding-provider to be
    // INSTALLED (it is an optionalDependency, installed by default). It does not
    // download a model — the provider module loads, but no inference runs. The
    // pure `fuse()` surface above needs neither heavy package.
    const encoder = await mod.createCrossEncoder({ modelId: 'MiniCheck' });
    if (!encoder.metadata || encoder.metadata.modelId !== 'MiniCheck') {
      throw new Error('createCrossEncoder() metadata mismatch');
    }
    await encoder.dispose();
    return `createCrossEncoder({modelId:'MiniCheck'}) -> metadata ok, dispose() ok (no rerank() call, no model download)`;
  },

  'embedding-provider': async (mod) => {
    // Uses the 'remote' provider type: a real, fully-local reference
    // implementation ("NOT wired to a live/paid endpoint -- proves
    // context-agnosticism without spend", per remote.ts) -- exercises the
    // real createEmbeddingProvider()/EmbeddingProvider contract with zero
    // network I/O and zero ONNX model download (unlike the 'fastembed'
    // path, which eagerly warms up a real local model on construction).
    const provider = await mod.createEmbeddingProvider({
      type: 'remote',
      model: 'smoke-remote-1',
      options: { endpoint: 'https://example.invalid/embed', apiKey: 'smoke-test-key-1234', dimensions: 3 },
    });
    const vec = await provider.embedSingle('smoke test');
    if (!(vec instanceof Float32Array) || vec.length !== 3) {
      throw new Error('RemoteProvider.embedSingle() did not return a 3-dim Float32Array');
    }
    return "createEmbeddingProvider({type:'remote'}) -> embedSingle() ok (simulated, no network)";
  },

  'blob-store': async (mod) => {
    const basePath = path.join(os.tmpdir(), `sox-smoke-blob-store-${process.pid}-${Date.now()}`);
    const store = mod.createBlobStore({ basePath });
    await store.open();
    const has = await store.has('0'.repeat(64));
    await store.close();
    rmSync(basePath, { recursive: true, force: true });
    return `createBlobStore({basePath: tmp}) -> open()/has()=${has}/close() ok`;
  },

  'claim-verification': async (mod) => {
    // Deliberately does NOT call createClaimVerifier(): that factory always
    // calls warmUp(), which unconditionally starts a real worker thread and
    // downloads/loads a real ONNX NLI model (MiniCheck) -- exactly the
    // real-inference path this package's own SPEC documents as
    // network/model-dependent ("The MiniCheck NLI model is downloaded on
    // first warmUp()"). That path is proven, with the real fixture-repo
    // pipeline, by the `integration` state's dod.2 test -- not here.
    // Instead we construct the package's other real, exported, network-free
    // primitives to prove the package resolves and its API executes.
    const registry = new mod.InMemoryModelRegistry();
    await registry.register({ modelId: 'smoke-model', version: '1', nliModel: true, loadedAt: new Date().toISOString() });
    const loaded = await registry.isLoaded('smoke-model');
    const normalizer = new mod.DefaultClaimNormalizer();
    const normalized = normalizer.normalizeClaim('This is a claim [1].');
    if (!loaded) throw new Error('InMemoryModelRegistry round-trip failed');
    if (normalized !== 'This is a claim.') throw new Error('DefaultClaimNormalizer.normalizeClaim() unexpected output');
    return `InMemoryModelRegistry register()/isLoaded() ok, DefaultClaimNormalizer.normalizeClaim() -> "${normalized}"`;
  },
};

// ── Driver ──────────────────────────────────────────────────────────────────

async function main() {
  const results = [];
  let failed = false;

  console.log(`[consumer-smoke] fresh-consumer import + trivial-op smoke -- set: ${args.set}`);
  console.log(`[consumer-smoke] repo root: ${REPO_ROOT}`);
  console.log(`[consumer-smoke] node: ${process.version}`);
  if (args.negativeControl) {
    console.log(`[consumer-smoke] NEGATIVE CONTROL MODE: forcing "${args.negativeControl}" to private:true (expect failure)`);
  }
  console.log('');

  for (const pkg of SUBSTRATE_PACKAGES) {
    const label = pkg.key;
    try {
      const resolved = loadManifest(pkg);
      const specifier = ensureWorkspaceLink(resolved);
      const mod = await import(specifier);
      const op = TRIVIAL_OPS[pkg.key];
      if (!op) throw new SmokeError(resolved.name, 'no trivial op defined for this package (smoke script bug)');
      const detail = await op(mod);
      console.log(`PASS  ${resolved.name.padEnd(28)} ${detail}`);
      results.push({ name: resolved.name, ok: true, detail });
    } catch (err) {
      failed = true;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`FAIL  ${label.padEnd(28)} ${message}`);
      results.push({ name: label, ok: false, detail: message });
      if (args.negativeControl) {
        // In negative-control mode a failure on the targeted package is the
        // expected, successful outcome of the self-test -- but the process
        // must still exit non-zero (it is proving a failure path), so we
        // stop here rather than attempting to import downstream packages
        // against a half-broken state.
        break;
      }
    }
  }

  console.log('');
  const passCount = results.filter((r) => r.ok).length;
  console.log(`[consumer-smoke] ${passCount}/${SUBSTRATE_PACKAGES.length === results.length ? SUBSTRATE_PACKAGES.length : results.length} package(s) attempted, ${passCount} passed`);

  if (failed) {
    console.error(
      args.negativeControl
        ? 'RED (expected): negative control reproduced a private-dependency resolution error'
        : 'RED: consumer smoke failed -- see FAIL lines above',
    );
    process.exit(1);
  }

  console.log('GREEN: every @adhd/sox-* substrate package imported and its trivial op succeeded');
  process.exit(0);
}

main().catch((err) => {
  console.error('RED: unhandled error in consumer-smoke.mjs');
  console.error(err);
  process.exit(1);
});
