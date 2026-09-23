#!/usr/bin/env node
/**
 * apps/sox/scripts/check-bundled-registry.cjs
 *
 * PROD-BREAK-SOXCLI-121 — PUBLISH-TIME half of the bundled-registry gate. Wired
 * as `prepack` on `@adhd/sox-cli`, so it runs on `npm pack`, `pnpm publish`, and
 * `changeset publish` alike.
 *
 * Why a second gate, when `embed-registry.cjs` already validates at build time:
 * a build-time gate does nothing if the build does not run. `pnpm release`
 * (as opposed to `release:prepared`) publishes without `build-index:publish` or
 * `nx build sox`, packing whatever `apps/sox/dist/` happens to hold — and a
 * stale dev `dist/` is the leading candidate for how 1.2.1 shipped a registry
 * stamped from a commit five days older than the publish. This gate reads the
 * artifact as it sits on disk, so it fires no matter how the artifact got there.
 *
 * `SOX_BUNDLED_REGISTRY_PATH` overrides the path (tests only) so the suite never
 * touches the real, live `apps/sox/dist/`.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const { assertPublishable } = require('./registry-publish-gate.cjs');

const indexPath =
  process.env['SOX_BUNDLED_REGISTRY_PATH'] ||
  path.resolve(__dirname, '..', 'dist', 'registry', 'index.json');

if (!fs.existsSync(indexPath)) {
  console.error(`BUNDLED-REGISTRY-GATE: refusing to publish — no embedded registry at ${indexPath}`);
  console.error(
    'BUNDLED-REGISTRY-GATE: the CLI falls back to this copy on a machine with no repo checkout; without it every `soxe install` resolves nothing.',
  );
  console.error('BUNDLED-REGISTRY-GATE: build first — `SOX_REGISTRY_PUBLISH=npm npx nx build sox`.');
  process.exit(1);
}

let parsed;
try {
  parsed = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
} catch (e) {
  console.error(`BUNDLED-REGISTRY-GATE: refusing to publish — ${indexPath} is not valid JSON: ${String(e)}`);
  process.exit(1);
}

assertPublishable(parsed, `the registry embedded at ${indexPath}`);

console.log(
  `check-bundled-registry: OK — ${parsed.length} entries, all portable, none provisional, none +dirty.`,
);
