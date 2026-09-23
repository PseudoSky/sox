#!/usr/bin/env node
/**
 * apps/sox/scripts/embed-registry.cjs
 *
 * Copy the repo's registry/index.json into the published CLI bundle at
 * apps/sox/dist/registry/index.json (D-D / SCOPE §6: "CLI ships a bundled
 * registry copy"). On a fresh machine with no repo checkout, the CLI falls back
 * to this embedded copy so `soxe search` / `soxe install` resolve extensions
 * without a working tree (loadRegistryIndexResolved() in main.ts).
 *
 * The embedded copy is a SNAPSHOT of whatever registry/index.json is current at
 * build time. In CI the publish flow rewrites registry sources to npm/CDN
 * locators BEFORE the CLI is built+published, so the published CLI embeds the
 * portable (npm:) registry. Run from repo root.
 *
 * PROD-BREAK-SOXCLI-121: that last paragraph used to be an UNENFORCED assumption,
 * and `@adhd/sox-cli@1.2.1` shipped because of it — 31 `file://` sources under
 * `/Users/nix/dev/ai/sox-ecosystem/...`, `provisional: true`, `+dirty` stamp, so
 * every fresh-machine install died on a path that exists only on a maintainer's
 * laptop. When the publish signal (`SOX_REGISTRY_PUBLISH`) is set, the index is
 * now VALIDATED before it is written, and a violation fails the build. The gate
 * is deliberately conditional: `file://` is the correct output of build-index's
 * default branch, so an unconditional refusal would break every dev build.
 * `check-bundled-registry.cjs` covers the case where this build never runs.
 *
 * Env overrides (tests only — the suite must never write the live artifact):
 *   SOX_EMBED_REGISTRY_SRC  — source index to read
 *   SOX_EMBED_REGISTRY_OUT  — destination file to write
 */
'use strict';
const fs = require('fs');
const path = require('path');

const { assertPublishable } = require('./registry-publish-gate.cjs');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const src = process.env['SOX_EMBED_REGISTRY_SRC'] || path.join(repoRoot, 'registry', 'index.json');
const out =
  process.env['SOX_EMBED_REGISTRY_OUT'] ||
  path.join(repoRoot, 'apps', 'sox', 'dist', 'registry', 'index.json');
const outDir = path.dirname(out);

if (!fs.existsSync(src)) {
  console.error(`embed-registry: registry/index.json not found at ${src} — run build-index:publish first`);
  process.exit(1);
}

const raw = fs.readFileSync(src, 'utf8');
let parsed;
try {
  parsed = JSON.parse(raw);
} catch (e) {
  console.error(`embed-registry: ${src} is not valid JSON: ${String(e)}`);
  process.exit(1);
}

// Validate BEFORE writing: a refused build must leave no artifact behind, or the
// rejected index simply gets packed by a later step that never rebuilds.
if (process.env['SOX_REGISTRY_PUBLISH']) {
  assertPublishable(parsed, `the registry about to be embedded from ${src}`);
}

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(out, raw);
console.log(`embed-registry: OK — embedded ${parsed.length} registry entries → ${out}`);
