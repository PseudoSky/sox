#!/usr/bin/env node
/**
 * tools/check-nx-cache.js — nx cache-conformance gate (BL-44 guard).
 *
 * Fails if any cacheable `build` or `test` target in a `project.json` overrides
 * `inputs` in a way that is NOT dependency-aware — i.e. it neither includes a
 * `^`-prefixed input (e.g. `^production`, which folds in upstream source) nor
 * declares `dependsOn` containing `^build` (which makes the upstream build hash
 * part of this task's hash). Such a target's cache is dependency-blind: an upstream
 * source change does not invalidate it, so the cache can report a stale green.
 *
 * The correct states (any one passes):
 *   - no `inputs` override (inherits nx.json targetDefaults), OR
 *   - `inputs` contains a `^`-prefixed entry, OR
 *   - `dependsOn` contains `^build`.
 *
 * See docs/nx-cache-conformance.md. Exit 0 = conformant; exit 1 = violations.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SKIP = new Set(['node_modules', 'dist', '.nx', '.git', 'bundle', 'demo']);

/** Recursively collect every project.json (skipping build/dep dirs). */
function findProjectJson(dir, out) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) {
      if (SKIP.has(ent.name)) continue;
      findProjectJson(path.join(dir, ent.name), out);
    } else if (ent.name === 'project.json') {
      out.push(path.join(dir, ent.name));
    }
  }
  return out;
}

// nx semantics: a project target's `inputs` / `dependsOn` REPLACE (do not merge with)
// the targetDefaults. So the EFFECTIVE value is the project's if present, else the
// targetDefault's. Conformance is evaluated on the effective value.
const TARGET_DEFAULTS = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'nx.json'), 'utf8')).targetDefaults || {};
  } catch {
    return {};
  }
})();

const hasCaretInput = (inputs) =>
  Array.isArray(inputs) && inputs.some((i) => typeof i === 'string' && i.startsWith('^'));
const hasCaretBuild = (dependsOn) =>
  Array.isArray(dependsOn) &&
  dependsOn.some((d) => d === '^build' || (d && typeof d === 'object' && d.target === 'build' && d.dependencies));

/** A cacheable build/test target is dependency-aware iff its EFFECTIVE inputs carry a
 * `^`-entry OR its EFFECTIVE dependsOn carries `^build`. Hand-listed `X:build` deps do
 * NOT count — they drift incomplete; use the graph-resolved `^build`. */
function targetIsConformant(target, name) {
  if (!target || target.cache !== true) return true; // not cached → not our concern
  const def = TARGET_DEFAULTS[name] || {};
  const effInputs = target.inputs !== undefined ? target.inputs : def.inputs;
  const effDependsOn = target.dependsOn !== undefined ? target.dependsOn : def.dependsOn;
  return hasCaretInput(effInputs) || hasCaretBuild(effDependsOn);
}

const files = findProjectJson(ROOT, []);
const violations = [];

for (const file of files) {
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    violations.push(`${path.relative(ROOT, file)}: unparseable (${e.message})`);
    continue;
  }
  const targets = cfg.targets || {};
  for (const name of ['build', 'test']) {
    if (targets[name] && !targetIsConformant(targets[name], name)) {
      violations.push(
        `${path.relative(ROOT, file)} → '${name}' overrides inputs without '^production' ` +
        `or dependsOn '^build' (dependency-blind cache). See docs/nx-cache-conformance.md`,
      );
    }
  }
}

if (violations.length > 0) {
  console.error(`nx-cache-conformance: ${violations.length} violation(s):\n`);
  for (const v of violations) console.error('  ✗ ' + v);
  console.error(
    `\nFix: remove the narrow project-level inputs (inherit nx.json targetDefaults), or ` +
    `include "^production" / dependsOn ["^build"].`,
  );
  process.exit(1);
}

console.log(`nx-cache-conformance: OK — ${files.length} project.json files, all build/test caches are dependency-aware.`);
process.exit(0);
