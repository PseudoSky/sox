#!/usr/bin/env node
/**
 * apps/sox/scripts/registry-publish-gate.cjs
 *
 * PROD-BREAK-SOXCLI-121 — the single validator for "is this registry index fit
 * to ship inside a published @adhd/sox-cli tarball?".
 *
 * `@adhd/sox-cli@1.2.1` went to npm embedding a registry with 31 `file://`
 * sources under `/Users/nix/dev/ai/sox-ecosystem/...`, `provisional: true`, and
 * a `+dirty` build stamp. On a fresh machine `loadRegistryResolved` (main.ts)
 * falls back to that embedded copy, so EVERY install failed with
 * `install: source file not found: /Users/nix/...` — leaking a maintainer's home
 * directory and never reaching the checksum gate.
 *
 * Nothing had ever checked. `build-index.ts` documents `provisional` as "should
 * not be trusted as a supply-chain integrity record", and `embed-registry.cjs`'s
 * header ASSUMED the publish flow rewrote sources first — both were unenforced
 * prose. This module is the enforcement, shared by the two call sites that can
 * each independently stop a bad publish:
 *
 *   - `embed-registry.cjs`        — build time, when SOX_REGISTRY_PUBLISH is set.
 *   - `check-bundled-registry.cjs` — publish time (`prepack`), unconditionally,
 *     reading the artifact as it sits on disk. This one fires even when the
 *     build never ran and a stale dev `dist/` is packed wholesale.
 *
 * A warning would not do. This repo has a documented history (BL-88, BL-167) of
 * unenforced claims shipping as if enforced, so every violation here is fatal.
 */
'use strict';

/** Locator schemes that a consumer with no repo checkout can actually fetch. */
const PORTABLE_SCHEMES = ['npm-package:', 'https://'];

/**
 * Validate a parsed registry index for publication.
 *
 * @param {unknown} index Parsed `registry/index.json` content.
 * @returns {string[]} Human-readable violations; empty means fit to publish.
 */
function findPublishViolations(index) {
  if (!Array.isArray(index)) {
    return [`registry index is not a JSON array (got ${typeof index})`];
  }
  if (index.length === 0) {
    // A CLI that ships an empty registry resolves nothing; `loadRegistryResolved`
    // treats an empty array as "absent" and falls through, so this would surface
    // to the user as a silent no-op rather than an error.
    return ['registry index is EMPTY — a published CLI must embed a resolvable registry'];
  }

  const violations = [];
  for (const entry of index) {
    const id = (entry && entry.id) || '<unnamed entry>';
    const source = String((entry && entry.source) || '');

    if (source.startsWith('file://') || source.startsWith('/')) {
      violations.push(
        `${id}: non-portable source "${source}" — a file:// path does not exist on a consumer's machine`,
      );
    } else if (!PORTABLE_SCHEMES.some((scheme) => source.startsWith(scheme))) {
      violations.push(`${id}: unrecognised source scheme "${source}" — expected npm-package: or https://`);
    }

    if (entry && entry.provisional === true) {
      violations.push(
        `${id}: provisional:true — its checksum was computed from a dirty tree and is reproducible from no commit`,
      );
    }

    const stamp = String((entry && entry.builtFromCommit) || '');
    if (stamp.includes('+dirty')) {
      violations.push(`${id}: builtFromCommit "${stamp}" is +dirty — built from uncommitted source`);
    }
  }

  return violations;
}

/**
 * Print violations and exit non-zero, or return silently.
 *
 * @param {unknown} index Parsed registry index.
 * @param {string} label Where the index came from, for the operator.
 */
function assertPublishable(index, label) {
  const violations = findPublishViolations(index);
  if (violations.length === 0) return;

  console.error(`BUNDLED-REGISTRY-GATE: refusing to publish ${label}`);
  console.error(`BUNDLED-REGISTRY-GATE: ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  - ${v}`);
  console.error(
    'BUNDLED-REGISTRY-GATE: regenerate with `SOX_REGISTRY_PUBLISH=npm pnpm run build-index` from a CLEAN checkout, then rebuild the CLI.',
  );
  process.exit(1);
}

module.exports = { findPublishViolations, assertPublishable, PORTABLE_SCHEMES };
