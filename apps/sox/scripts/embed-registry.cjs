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
 */
'use strict';
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const src = path.join(repoRoot, 'registry', 'index.json');
const outDir = path.join(repoRoot, 'apps', 'sox', 'dist', 'registry');
const out = path.join(outDir, 'index.json');

if (!fs.existsSync(src)) {
  console.error(`embed-registry: registry/index.json not found at ${src} — run registry:sync-index first`);
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });
fs.copyFileSync(src, out);
const n = JSON.parse(fs.readFileSync(out, 'utf8')).length;
console.log(`embed-registry: OK — embedded ${n} registry entries → apps/sox/dist/registry/index.json`);
