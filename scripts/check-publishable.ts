#!/usr/bin/env node
/**
 * scripts/check-publishable.ts — born-publishable structural gate (G4 / SCOPE §7.4)
 *
 * Fails (exit 1) if any PUBLISHABLE package would 404 on a fresh-machine install,
 * structurally preventing the BL-42 dependency-404 class from regressing:
 *
 *   1. No published package may carry a `workspace:*` runtime dep that points at a
 *      NON-PUBLISHED (private/absent) workspace package — that 404s on install.
 *   2. **Registry existence.** Every `workspace:*` runtime dep of a published
 *      package must resolve to a package that ACTUALLY EXISTS on the npm registry.
 *      Changesets rewrites `workspace:*` to a concrete version at publish time
 *      (`updateInternalDependencies`), so a workspace dep on a package that has
 *      never been published ships a hard 404 to every consumer — transitively.
 *      Rule (1) alone could never catch this: it builds its "published" set from
 *      the workspace `private` flag and never consults the registry. It ran GREEN
 *      while `@adhd/sox-telemetry` — a hard runtime dep of `store-adapter` and
 *      `memory-core` — was E404 on npm.
 *      Exemption: a package with a pending changeset in `.changeset/*.md` is
 *      being published in this very run, so its absence from the registry is
 *      expected and is reported as a NOTE, not an error.
 *   3. No published EXTENSION (@adhd/sox-extension-*) may carry an `@adhd/sox-*`
 *      RUNTIME dependency at all — extensions ship as self-contained esbuild
 *      bundles with zero @adhd runtime deps (Model A). (@adhd as devDependencies
 *      is fine — the bundler inlines them at build time.)
 *   4. Every published package should declare `engines.node` (warn, not fail).
 *
 * Rules 1, 2, 3 and 5 all treat `optionalDependencies` as the runtime edges they
 * are (see `runtimeDeps`): npm installs them by default and changesets rewrites
 * their `workspace:` range at publish, so an optional dep carries the identical
 * 404 / exact-pin hazard as a mandatory one.
 *
 * Scans libs/*, apps/*, and extension/bundle-member package.json files. A package
 * with `"private": true` is skipped (it never publishes).
 *
 * Run:  npx tsx scripts/check-publishable.ts
 * Fix:  publish the missing dependency in the same release, move the dep to
 *       devDependencies (bundled), or declare native addons as real
 *       (non-workspace) dependencies.
 *
 * Network behaviour — deliberately fail-closed:
 *   --registry <url>  registry base to probe (default $npm_config_registry or
 *                     https://registry.npmjs.org). Used by the regression test to
 *                     point at a local fixture registry; also the private-registry path.
 *   --offline         explicitly skip the registry probe. This EXITS 1. A check that
 *                     degrades to green when the network is unavailable reproduces the
 *                     exact defect class this rule exists to close.
 *   A probe that times out or errors with no cached positive is an ERROR, never a pass.
 *   Positive results are cached for 24h under node_modules/.cache/check-publishable/.
 *   Negative results are never cached (a package can be published at any moment).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

const argv = process.argv.slice(2);
const flagValue = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1] !== undefined) return argv[i + 1];
  const inline = argv.find((a) => a.startsWith(`--${name}=`));
  return inline?.slice(name.length + 3);
};
const hasFlag = (name: string): boolean =>
  argv.includes(`--${name}`) || argv.some((a) => a.startsWith(`--${name}=`));

const positionals = argv.filter((a, i) => {
  if (a.startsWith('--')) return false;
  const prev = argv[i - 1];
  return !(prev === '--registry' || prev === '--probe-timeout-ms');
});

const root = positionals[0] ?? process.cwd();
const registryBase = (
  flagValue('registry') ??
  process.env['npm_config_registry'] ??
  'https://registry.npmjs.org'
).replace(/\/+$/, '');
const offline = hasFlag('offline') || process.env['CHECK_PUBLISHABLE_OFFLINE'] === '1';
const probeTimeoutMs = Number(flagValue('probe-timeout-ms') ?? 10_000);
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface Pkg {
  name?: string;
  private?: boolean;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  engines?: Record<string, string>;
}

/**
 * The runtime dependency edges of a manifest, tagged with the field they came
 * from. `optionalDependencies` are runtime edges: npm installs them by default,
 * and changesets rewrites their `workspace:` range at publish exactly like a
 * mandatory one — so they carry the identical fresh-machine-404 and exact-pin
 * hazards, and must be checked. (They were invisible to every rule here until
 * `@adhd/sox-semantic` moved its native-chain deps to optionalDependencies.)
 */
function runtimeDeps(pkg: Pkg): Array<{ dep: string; range: string; field: 'dependencies' | 'optionalDependencies' }> {
  return [
    ...Object.entries(pkg.dependencies ?? {}).map(([dep, range]) => ({
      dep,
      range,
      field: 'dependencies' as const,
    })),
    ...Object.entries(pkg.optionalDependencies ?? {}).map(([dep, range]) => ({
      dep,
      range,
      field: 'optionalDependencies' as const,
    })),
  ];
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

/**
 * Packages with a pending changeset are being published in THIS run, so their
 * absence from the registry is expected — not a 404 waiting to happen.
 * Parses the `---`-delimited YAML frontmatter of every `.changeset/*.md`:
 *   ---
 *   "@adhd/sox-telemetry": minor
 *   ---
 */
function pendingChangesetPackages(): Set<string> {
  const out = new Set<string>();
  const dir = path.join(root, '.changeset');
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'README.md');
  } catch {
    return out;
  }
  for (const f of files) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(dir, f), 'utf8');
    } catch {
      continue;
    }
    const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    if (!m?.[1]) continue;
    for (const line of m[1].split(/\r?\n/)) {
      const dep = /^\s*["']?(@?[^"':]+)["']?\s*:\s*\w+/.exec(line);
      if (dep?.[1]) out.add(dep[1].trim());
    }
  }
  return out;
}

/**
 * Classify an internal `@adhd/sox-*` dependency range by what it BECOMES WHEN
 * PUBLISHED — the same semantics `tools/release-consumers.mjs` documents:
 *
 *   workspace:^  ->  "^1.2.3"   FLOATS within the compatible range
 *   workspace:~  ->  "~1.2.3"   floats within the patch range
 *   workspace:*  ->  "1.2.3"    EXACT — frozen at publish time, never floats
 *   ^1.2.3 / ~1.2.3             FLOATS
 *   1.2.3 (bare)                EXACT
 *
 * An exact pin on a stateful internal package (sox-telemetry keeps its sink in
 * module scope; sox-store-adapter carries connection semantics) is how
 * BUG-BACKLOG-TELEMETRY-001 split: `@adhd/sox-graph-store@0.8.4` published
 * `@adhd/sox-telemetry` and `@adhd/sox-store-adapter` as exact pins (`workspace:*`
 * at the time), so when telemetry/store-adapter bumped and the caret-pinned
 * packages floated forward, the exact-pinned package froze on the old version and
 * `@adhd/backlog` resolved TWO copies of the stateful telemetry runtime.
 */
function classifyInternalRange(range: string): 'floating' | 'exact' {
  const s = String(range);
  if (s.startsWith('workspace:')) {
    const proto = s.slice('workspace:'.length);
    return proto === '^' || proto === '~' ? 'floating' : 'exact';
  }
  if (s.startsWith('^') || s.startsWith('~')) return 'floating';
  return 'exact';
}

// ── registry existence probe ────────────────────────────────────────────────
type ProbeResult = { exists: true } | { exists: false; reason: string } | { error: string };

const cacheDir = path.join(root, 'node_modules', '.cache', 'check-publishable');
const cacheFile = path.join(
  cacheDir,
  `registry-${crypto.createHash('sha256').update(registryBase).digest('hex').slice(0, 12)}.json`,
);

function readCache(): Record<string, number> {
  try {
    const j = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as Record<string, number>;
    const now = Date.now();
    // Only positives are ever written; drop expired entries on read.
    return Object.fromEntries(Object.entries(j).filter(([, t]) => now - t < CACHE_TTL_MS));
  } catch {
    return {};
  }
}

function writeCache(cache: Record<string, number>): void {
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    const tmp = path.join(cacheDir, `.tmp-${process.pid}-${Date.now()}`);
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
    fs.renameSync(tmp, cacheFile);
  } catch {
    /* cache is an optimization; never fail the gate on it */
  }
}

async function probeRegistry(name: string): Promise<ProbeResult> {
  // Scoped names must have the `/` percent-encoded for the packument endpoint.
  const url = `${registryBase}/${name.replace('/', '%2f')}`;
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { accept: 'application/vnd.npm.install-v1+json, application/json' },
      signal: AbortSignal.timeout(probeTimeoutMs),
    });
    if (res.status === 404) return { exists: false, reason: `registry returned 404 for ${url}` };
    if (!res.ok) return { error: `registry returned HTTP ${res.status} for ${url}` };
    const body = (await res.json()) as { name?: string; versions?: Record<string, unknown> };
    const versionCount = Object.keys(body.versions ?? {}).length;
    if (versionCount === 0) {
      return { exists: false, reason: `registry has ${url} but zero published versions` };
    }
    return { exists: true };
  } catch (e) {
    return { error: `probe of ${url} failed: ${(e as Error).message}` };
  }
}

// ── main ────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const allPkgPaths = findPackageJsons();

  // First pass: the set of all workspace package names that ARE published
  // (no `private:true`). Necessary but NOT sufficient — see rule (2).
  const publishedNames = new Set<string>();
  for (const p of allPkgPaths) {
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8')) as Pkg;
      if (j.private !== true && typeof j.name === 'string') publishedNames.add(j.name);
    } catch {
      /* skip */
    }
  }

  const errors: string[] = [];
  const warnings: string[] = [];
  const notes: string[] = [];
  let scanned = 0;

  // dep name -> list of "<consumer rel path>: <range>" that depend on it
  const workspaceDepConsumers = new Map<string, string[]>();

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

    const deps = runtimeDeps(pkg);
    for (const { dep, range, field } of deps) {
      // (1) workspace:* onto a non-published target → 404 on install.
      if (range.startsWith('workspace:')) {
        if (!publishedNames.has(dep)) {
          errors.push(
            `${rel}: ${field} entry "${dep}":"${range}" targets a NON-PUBLISHED package — 404s on install. Publish "${dep}", or move it to devDependencies (bundled).`,
          );
        } else {
          // (2) queue a real registry existence probe.
          const list = workspaceDepConsumers.get(dep) ?? [];
          list.push(`${rel} ("${dep}":"${range}", ${field})`);
          workspaceDepConsumers.set(dep, list);
        }
      }
      // (3) extensions must be self-contained: zero @adhd runtime deps.
      if (dep.startsWith('@adhd/sox-') && isExtension) {
        errors.push(
          `${rel}: extension carries @adhd ${field} entry "${dep}". Extensions must be self-contained bundles (zero @adhd runtime deps) — move to devDependencies.`,
        );
      }
    }

    if (pkg.engines?.['node'] === undefined) {
      warnings.push(`${rel}: missing engines.node (recommend ">=20").`);
    }
  }

  // ── rule (2): registry existence ──────────────────────────────────────────
  const depNames = [...workspaceDepConsumers.keys()].sort();

  if (offline) {
    // Fail-closed. A gate that goes green when it cannot check is the defect.
    console.error(
      'check-publishable: FAIL — OFFLINE MODE. The registry existence probe (rule 2) did not run,\n' +
        `  so ${depNames.length} workspace:* runtime dependencies are UNVERIFIED and this gate cannot\n` +
        '  certify a fresh-machine install. This exit is deliberate: passing here would reproduce the\n' +
        '  exact defect (a green check over a dependency that 404s) that rule 2 exists to prevent.\n' +
        '  Re-run with network access, or point --registry at a reachable mirror.',
    );
    process.exit(1);
  }

  const pending = pendingChangesetPackages();
  const cache = readCache();
  let cacheDirty = false;

  const results = await Promise.all(
    depNames.map(async (dep): Promise<[string, ProbeResult]> => {
      if (cache[dep] !== undefined) return [dep, { exists: true }];
      return [dep, await probeRegistry(dep)];
    }),
  );

  for (const [dep, result] of results) {
    const consumers = workspaceDepConsumers.get(dep) ?? [];
    if ('exists' in result && result.exists) {
      if (cache[dep] === undefined) {
        cache[dep] = Date.now();
        cacheDirty = true;
      }
      continue;
    }
    if ('error' in result) {
      errors.push(
        `UNVERIFIABLE: could not determine whether "${dep}" exists on ${registryBase} — ${result.error}. ` +
          `Depended on at runtime by: ${consumers.join(', ')}. This gate fails closed rather than assuming published.`,
      );
      continue;
    }
    if (pending.has(dep)) {
      notes.push(
        `"${dep}" is not on ${registryBase} yet, but has a pending changeset — it publishes in this same run. Consumers: ${consumers.join(', ')}.`,
      );
      continue;
    }
    errors.push(
      `"${dep}" DOES NOT EXIST on ${registryBase} (${result.reason}), but is a workspace:* RUNTIME dependency of: ${consumers.join(', ')}. ` +
        `Changesets rewrites workspace:* to a concrete version at publish, so every one of those packages would ship a hard 404 — transitively to their dependents too. ` +
        `Fix: publish "${dep}" (add a changeset for it so it ships in the same release), or move the dependency to devDependencies if it is bundled.`,
    );
  }

  if (cacheDirty) writeCache(cache);

  // ── rule (5): single-instance resolution invariant (BUG-BACKLOG-TELEMETRY-001) ──
  //
  // No published LIBRARY package (non-extension; extensions are rule (3)'s
  // concern — they must bundle and ship zero @adhd runtime deps) may carry an
  // EXACT-pinned runtime `dependencies` edge on another `@adhd/sox-*` package.
  // Internal stateful packages must float together (`workspace:^`/`workspace:~`)
  // so that every consumer resolves ONE copy of the stateful runtime — most
  // importantly `@adhd/sox-telemetry`, whose sink is module-scoped: two resolved
  // copies mean `initTelemetry()` on one copy never configures the other, and
  // every record emitted through the other copy is silently dropped (exactly
  // BUG-BACKLOG-TELEMETRY-001 — @adhd/backlog resolved telemetry 0.2.0 and 0.2.1).
  for (const pkgPath of allPkgPaths) {
    let pkg: Pkg;
    try {
      pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as Pkg;
    } catch {
      continue;
    }
    if (pkg.private === true) continue;
    if (typeof pkg.name !== 'string' || !pkg.name.startsWith('@adhd/sox-')) continue;
    if (pkg.name.startsWith('@adhd/sox-extension-')) continue; // rule (3) owns extensions
    const rel = path.relative(root, pkgPath);
    for (const { dep, range, field } of runtimeDeps(pkg)) {
      if (!dep.startsWith('@adhd/sox-')) continue;
      if (classifyInternalRange(range) === 'floating') continue;
      errors.push(
        `${rel}: ${field} entry "${dep}":"${range}" is an EXACT pin. ` +
          `Exact pins on internal @adhd/sox-* packages freeze that package at the version current when it last published, ` +
          `while caret-pinned packages float forward — so a telemetry/store-adapter bump resolves TWO copies of a stateful ` +
          `runtime (BUG-BACKLOG-TELEMETRY-001: @adhd/backlog resolved @adhd/sox-telemetry 0.2.0 and 0.2.1, dropping every record ` +
          `emitted through the un-initialised copy). Use workspace:^ (or a ^/~ range).`,
      );
    }
  }

  for (const n of notes) console.log(`check-publishable: NOTE ${n}`);
  for (const w of warnings) console.warn(`check-publishable: WARN ${w}`);

  if (errors.length > 0) {
    console.error('check-publishable: FAIL — publishable packages with a fresh-machine-404 shape:');
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }

  console.log(
    `check-publishable: OK — ${scanned} published @adhd packages have a fresh-machine-safe dependency shape ` +
      `(${depNames.length} workspace:* runtime deps verified to exist on ${registryBase}).`,
  );
}

main().catch((e: unknown) => {
  console.error(`check-publishable: FAIL — unexpected error: ${(e as Error).stack ?? String(e)}`);
  process.exit(1);
});
