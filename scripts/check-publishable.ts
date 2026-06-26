#!/usr/bin/env node
/**
 * scripts/check-publishable.ts — born-publishable structural gate (G4 / SCOPE §7.4)
 *
 * Fails (exit 1) if any PUBLISHABLE package would 404 on a fresh-machine install,
 * structurally preventing the BL-42 dependency-404 class from regressing:
 *
 *   1. No published package may carry a `workspace:*` runtime dep that points at a
 *      NON-PUBLISHED (private/absent) workspace package — that 404s on install.
 *      A `workspace:*` dep on another PUBLISHED package is fine: changesets/pnpm
 *      rewrites it to the real version at publish time (`updateInternalDependencies`).
 *   2. No published EXTENSION (@adhd/sox-extension-*) may carry an `@adhd/sox-*`
 *      RUNTIME dependency at all — extensions ship as self-contained esbuild
 *      bundles with zero @adhd runtime deps (Model A). (@adhd as devDependencies
 *      is fine — the bundler inlines them at build time.)
 *   3. Every published package should declare `engines.node` (warn, not fail).
 *
 * Scans libs/*, apps/*, and extension/bundle-member package.json files. A package
 * with `"private": true` is skipped (it never publishes).
 *
 * Run:  npx tsx scripts/check-publishable.ts
 * Fix:  move workspace:* / @adhd runtime deps to devDependencies (bundled), or
 *       declare native addons as real (non-workspace) dependencies.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const root = process.argv[2] ?? process.cwd();

interface Pkg {
  name?: string;
  private?: boolean;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  engines?: Record<string, string>;
}

function findPackageJsons(): string[] {
  const out: string[] = [];
  const roots = ['libs', 'apps', 'extensions', 'packages'];
  const walk = (dir: string, depth: number): void => {
    if (depth > 6) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name === 'bundle') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full, depth + 1);
      } else if (e.name === 'package.json') {
        out.push(full);
      }
    }
  };
  for (const r of roots) {
    const abs = path.join(root, r);
    if (fs.existsSync(abs)) walk(abs, 0);
  }
  return out;
}

// First pass: the set of all workspace package names that ARE published
// (no `private:true`). A workspace:* dep onto one of these is publish-safe.
const allPkgPaths = findPackageJsons();
const publishedNames = new Set<string>();
for (const p of allPkgPaths) {
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8')) as Pkg;
    if (j.private !== true && typeof j.name === 'string') publishedNames.add(j.name);
  } catch { /* skip */ }
}

const errors: string[] = [];
const warnings: string[] = [];
let scanned = 0;

for (const pkgPath of allPkgPaths) {
  let pkg: Pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as Pkg;
  } catch {
    continue;
  }
  if (pkg.private === true) continue; // never published
  if (typeof pkg.name !== 'string' || !pkg.name.startsWith('@adhd/sox-')) continue;
  scanned++;
  const rel = path.relative(root, pkgPath);
  const isExtension = pkg.name.startsWith('@adhd/sox-extension-');

  const deps = pkg.dependencies ?? {};
  for (const [dep, range] of Object.entries(deps)) {
    // (1) workspace:* onto a non-published target → 404 on install.
    if (range.startsWith('workspace:') && !publishedNames.has(dep)) {
      errors.push(`${rel}: runtime dependency "${dep}":"${range}" targets a NON-PUBLISHED package — 404s on install. Publish "${dep}", or move it to devDependencies (bundled).`);
    }
    // (2) extensions must be self-contained: zero @adhd runtime deps.
    if (dep.startsWith('@adhd/sox-') && isExtension) {
      errors.push(`${rel}: extension carries @adhd runtime dependency "${dep}". Extensions must be self-contained bundles (zero @adhd runtime deps) — move to devDependencies.`);
    }
  }

  if (pkg.engines?.['node'] === undefined) {
    warnings.push(`${rel}: missing engines.node (recommend ">=20").`);
  }
}

for (const w of warnings) console.warn(`check-publishable: WARN ${w}`);

if (errors.length > 0) {
  console.error('check-publishable: FAIL — publishable packages with a fresh-machine-404 shape:');
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

console.log(`check-publishable: OK — ${scanned} published @adhd packages have a fresh-machine-safe dependency shape.`);
