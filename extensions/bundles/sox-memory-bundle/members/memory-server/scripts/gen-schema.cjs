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
const { execFileSync } = require('node:child_process');

// BL-38: memory-server is now a SELF-CONTAINED esbuild bundle (dist/index.js with
// @adhd/sox-* inlined) — there is no separate dist/backend.js to require. Derive
// the schema by invoking the built bundle with --emit-schema, which prints the
// canonical buildToolsListResult() to stdout ([contract:schema-hash] preserved).
const distDir = path.resolve(__dirname, '..', 'dist');
const bundlePath = path.join(distDir, 'index.js');
if (!fs.existsSync(bundlePath)) {
  console.error(`[gen-schema] built bundle not found at ${bundlePath} — build first`);
  process.exit(1);
}

const stdout = execFileSync(process.execPath, [bundlePath, '--emit-schema'], {
  encoding: 'utf8',
  maxBuffer: 16 * 1024 * 1024,
});
const result = JSON.parse(stdout);

const out = path.join(distDir, 'schema.json');
fs.writeFileSync(out, JSON.stringify(result, null, 2) + '\n', 'utf8');
console.log(`[gen-schema] wrote ${out} (${result.tools.length} tools)`);
