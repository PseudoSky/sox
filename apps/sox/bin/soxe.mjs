#!/usr/bin/env node
// soxe — in-package CLI shim for the PUBLISHED @adhd/sox-cli package.
//
// Distinct from the repo-dev shim at <repo>/bin/soxe (which loads the tsc output
// at dist/apps/sox/main.js for tests/e2e/the live MCP). THIS shim ships inside the
// npm package and loads the self-contained esbuild bundle next to it
// (./dist/index.js — all @adhd/sox-* inlined, zero runtime deps), so `npm i -g
// @adhd/sox-cli` works on a fresh machine with no checkout (BL-34/BL-42).
//
// createRequire is used because this file is ESM (.mjs) while the bundle it loads
// is CommonJS (dist/package.json declares {"type":"commonjs"}).
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
const __dirname = dirname(fileURLToPath(import.meta.url));
createRequire(import.meta.url)(resolve(__dirname, '../dist/index.js'));
