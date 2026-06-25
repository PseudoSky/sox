#!/usr/bin/env node
/**
 * scripts/gen-schema.cjs — generate dist/schema.json from the canonical tools list.
 *
 * The front-shim service-proxy (spec §9.5.3) serves initialize + tools/list from a
 * cached schema so the MCP client gets an instant, stable interface even while the
 * backend is mid-restart. lifecycle.schema_path points at this file.
 *
 * The canonical source of truth is `buildToolsListResult()` in the built backend
 * module (which derives from `TOOLS` in index.ts) — NEVER hand-maintained. This
 * runs as a postbuild step so the published schema.json can never drift from the
 * tool surface the backend actually serves (the [contract:schema-hash] invariant).
 */
const fs = require('node:fs');
const path = require('node:path');

const distDir = path.resolve(__dirname, '..', 'dist');
const backendPath = path.join(distDir, 'backend.js');
if (!fs.existsSync(backendPath)) {
  console.error(`[gen-schema] built backend not found at ${backendPath} — build first`);
  process.exit(1);
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { buildToolsListResult } = require(backendPath);
const result = buildToolsListResult();

const out = path.join(distDir, 'schema.json');
fs.writeFileSync(out, JSON.stringify(result, null, 2) + '\n', 'utf8');
console.log(`[gen-schema] wrote ${out} (${result.tools.length} tools)`);
