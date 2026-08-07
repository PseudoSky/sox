#!/usr/bin/env node
/**
 * tools/graph-store-tarball-conformance.mjs — PKT-62 tarball-conformance gate (closes BL-443).
 *
 * Proves the PUBLISHED `@adhd/sox-graph-store` contract by packing it (and its two transitive
 * workspace dependencies) into real npm tarballs with `pnpm pack`, installing them through a real
 * `node_modules` in a scratch consumer project (never a workspace symlink, never a relative import
 * of this repo's own `src/`), and running fixture code that imports the package ONLY via its bare
 * specifier. See SPEC-PKT-62.md for the full ruling — this file implements §4/§5/§6 exactly.
 *
 * Mirrors tools/born-conformance.js's shape (spawnSync, mkdtempSync, structured console output,
 * explicit exit codes) — not a vitest file, because it spawns `pnpm pack`, `pnpm install`, and
 * `tsc` as real child processes against a real filesystem tree outside the repo (SPEC-PKT-62.md §2
 * item 1).
 *
 * Two modes, both wired as nx targets on the graph-store project:
 *   - default:              packs + installs + runs AC-1..AC-5, prints PASS/FAIL per AC, exits 0/1.
 *   - --vacuity-guard-demo: proves AC-6 — renames dist/ away, expects the precondition check to
 *     fail loudly (never skip, never exit 0), then restores dist/ in a `finally` block regardless
 *     of outcome (SPEC-PKT-62.md Decision 7 — never `rm -rf`).
 */

import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  cpSync,
  renameSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(__dirname, '..');

const GRAPH_STORE_DIR = join(ROOT, 'libs/data/graph/graph-store');
const STORE_ADAPTER_DIR = join(ROOT, 'libs/data/store/store-adapter');
const TELEMETRY_DIR = join(ROOT, 'libs/observability/sox-telemetry');
const FIXTURE_TEMPLATE_DIR = join(GRAPH_STORE_DIR, 'conformance-fixture');

const VACUITY_MODE = process.argv.includes('--vacuity-guard-demo');

// ── small helpers ────────────────────────────────────────────────────────────

function log(msg) {
  console.log(msg);
}
function fail(msg) {
  console.error(msg);
}

/** @returns {import('node:child_process').SpawnSyncReturns<string>} */
function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', ...opts });
}

function dieOnSpawnFailure(label, r) {
  if (r.error) {
    fail(`FAIL: ${label} could not be spawned: ${r.error}`);
    return true;
  }
  if (r.status !== 0) {
    fail(`FAIL: ${label} exited ${r.status}`);
    if (r.stdout) fail(`  stdout:\n${indent(r.stdout)}`);
    if (r.stderr) fail(`  stderr:\n${indent(r.stderr)}`);
    return true;
  }
  return false;
}

function indent(text) {
  return text
    .trim()
    .split('\n')
    .map((l) => `    ${l}`)
    .join('\n');
}

// ── AC-6 precondition: graph-store's own dist/ must exist ─────────────────────

function checkGraphStoreDistPresent() {
  const jsPath = join(GRAPH_STORE_DIR, 'dist', 'index.js');
  const dtsPath = join(GRAPH_STORE_DIR, 'dist', 'index.d.ts');
  if (!existsSync(jsPath) || !existsSync(dtsPath)) {
    fail('FAIL: dist/index.js missing — run npx nx build graph-store first');
    return false;
  }
  return true;
}

// ── vacuity-guard-demo mode (AC-6) ────────────────────────────────────────────

function vacuityGuardDemo() {
  const distPath = join(GRAPH_STORE_DIR, 'dist');
  const backupPath = join(GRAPH_STORE_DIR, 'dist.vacuity-bak');

  if (!existsSync(distPath)) {
    fail(
      'FAIL: dist/index.js missing — run npx nx build graph-store first (dist/ was already absent before the vacuity demo could even rename it away)',
    );
    process.exit(1);
  }
  if (existsSync(backupPath)) {
    fail(
      `FAIL: ${backupPath} already exists — a previous vacuity-guard-demo run did not restore cleanly; investigate before proceeding, do not delete either directory blindly`,
    );
    process.exit(1);
  }

  let restored = false;
  let guardOk = false;
  try {
    renameSync(distPath, backupPath);
    log('vacuity-guard-demo: renamed dist/ -> dist.vacuity-bak/, dist/ is now absent');

    const distStillReportsPresent = checkGraphStoreDistPresent();
    if (distStillReportsPresent) {
      fail(
        'AC-6 (BL-443): FAIL — precondition check reported dist/ present immediately after it was renamed away; the vacuity guard itself is broken',
      );
      guardOk = false;
    } else {
      log(
        'AC-6 (BL-443): PASS — orchestrator failed loudly (printed the FAIL line above) with dist/ absent, never skipped, never exited 0 for the missing-dist case',
      );
      guardOk = true;
    }
  } finally {
    try {
      renameSync(backupPath, distPath);
      restored = existsSync(distPath) && !existsSync(backupPath);
    } catch (e) {
      fail(`FAIL: could not restore dist/ after vacuity demo: ${e}`);
      restored = false;
    }
    log(
      `vacuity-guard-demo restore: ${restored ? 'OK — dist/ restored, dist.vacuity-bak/ gone' : 'FAILED — dist/ may still be renamed away, fix before running anything else against this worktree'}`,
    );
  }

  process.exit(guardOk && restored ? 0 : 1);
}

if (VACUITY_MODE) {
  vacuityGuardDemo();
  // vacuityGuardDemo() always calls process.exit(); unreachable.
}

// ── default mode: pack, install, run AC-1..AC-5 ───────────────────────────────

if (!checkGraphStoreDistPresent()) {
  process.exit(1);
}

function expectedTarballName(pkgJsonPath) {
  const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
  const name = pkg.name.startsWith('@') ? pkg.name.slice(1).replace('/', '-') : pkg.name;
  return { fileName: `${name}-${pkg.version}.tgz`, name: pkg.name, version: pkg.version };
}

function pnpmPack(label, pkgDir, destDir) {
  const { fileName, name, version } = expectedTarballName(join(pkgDir, 'package.json'));
  const r = run('pnpm', ['pack', '--pack-destination', destDir], { cwd: pkgDir });
  if (dieOnSpawnFailure(`pnpm pack (${label})`, r)) return null;
  const tarballPath = join(destDir, fileName);
  if (!existsSync(tarballPath)) {
    fail(
      `FAIL: pnpm pack (${label}) reported success but expected tarball ${fileName} (for ${name}@${version}) was not found in ${destDir}`,
    );
    fail(`  pnpm pack stdout:\n${indent(r.stdout || '(empty)')}`);
    return null;
  }
  log(`  packed ${name}@${version} -> ${tarballPath}`);
  return tarballPath;
}

async function main() {
  let anyAcFailed = false;
  const acResults = new Map(); // AC id -> boolean

  const scratchRoot = mkdtempSync(join(tmpdir(), 'graph-store-tarball-conformance-'));

  // Risk 4 (SPEC-PKT-62.md §5): defend against a TMPDIR override that resolves inside the repo.
  if (resolve(scratchRoot).startsWith(resolve(ROOT) + '/') || resolve(scratchRoot) === resolve(ROOT)) {
    fail(
      `FATAL: scratch path ${scratchRoot} resolved inside the repo root ${ROOT} — refusing to proceed (suspected TMPDIR override). Nothing was written or deleted.`,
    );
    rmSync(scratchRoot, { recursive: true, force: true });
    process.exit(1);
  }

  try {
    // ── 1. pnpm pack the three packages (Decision 1, Decision 2) ────────────
    log('\n== packing tarballs (pnpm pack) ==');
    const tarballDir = join(scratchRoot, 'tarballs');
    mkdirSync(tarballDir, { recursive: true });

    const telemetryTarball = pnpmPack('sox-telemetry', TELEMETRY_DIR, tarballDir);
    const storeAdapterTarball = pnpmPack('store-adapter', STORE_ADAPTER_DIR, tarballDir);
    const graphStoreTarball = pnpmPack('graph-store', GRAPH_STORE_DIR, tarballDir);

    if (!telemetryTarball || !storeAdapterTarball || !graphStoreTarball) {
      fail('\ngraph-store:tarball-conformance: FAIL (packing failed, see above)');
      process.exitCode = 1;
      return;
    }

    // ── 2. materialize the scratch consumer project ──────────────────────────
    log('\n== materializing scratch consumer project ==');
    const consumerDir = join(scratchRoot, 'consumer');
    mkdirSync(consumerDir, { recursive: true });
    mkdirSync(join(consumerDir, 'src'), { recursive: true });

    cpSync(join(FIXTURE_TEMPLATE_DIR, 'tsconfig.json'), join(consumerDir, 'tsconfig.json'));
    cpSync(join(FIXTURE_TEMPLATE_DIR, 'src'), join(consumerDir, 'src'), { recursive: true });

    const templatePkg = JSON.parse(
      readFileSync(join(FIXTURE_TEMPLATE_DIR, 'package.json'), 'utf8'),
    );
    const consumerPkg = {
      ...templatePkg,
      dependencies: {
        '@adhd/sox-graph-store': `file:${graphStoreTarball}`,
        '@adhd/sox-store-adapter': `file:${storeAdapterTarball}`,
      },
      pnpm: {
        ...(templatePkg.pnpm ?? {}),
        overrides: {
          '@adhd/sox-store-adapter': `file:${storeAdapterTarball}`,
          '@adhd/sox-telemetry': `file:${telemetryTarball}`,
        },
      },
    };
    writeFileSync(join(consumerDir, 'package.json'), `${JSON.stringify(consumerPkg, null, 2)}\n`);
    log(`  scratch consumer project at ${consumerDir}`);

    // ── 3. pnpm install (Decision 2: file: deps + overrides pinned, everything else registry) ──
    log('\n== pnpm install (scratch consumer) ==');
    const installR = run('pnpm', ['install', '--no-frozen-lockfile'], { cwd: consumerDir });
    if (dieOnSpawnFailure('pnpm install (scratch consumer)', installR)) {
      fail('\ngraph-store:tarball-conformance: FAIL (install failed, see above)');
      process.exitCode = 1;
      return;
    }

    const installedGraphStoreJs = join(
      consumerDir,
      'node_modules',
      '@adhd',
      'sox-graph-store',
      'dist',
      'index.js',
    );
    const installedGraphStoreDts = join(
      consumerDir,
      'node_modules',
      '@adhd',
      'sox-graph-store',
      'dist',
      'index.d.ts',
    );
    if (!existsSync(installedGraphStoreJs) || !existsSync(installedGraphStoreDts)) {
      fail(
        `FAIL: pnpm install succeeded but ${installedGraphStoreJs} / index.d.ts is missing — the tarball's own \`files\` allowlist may be wrong`,
      );
      process.exitCode = 1;
      return;
    }
    log('  node_modules/@adhd/sox-graph-store/dist/{index.js,index.d.ts} present');

    // ── 4. AC-5: tsc --noEmit against the installed tarball's dist/*.d.ts (Decision 5) ─────
    log('\n== AC-5 (BL-443): tsc --noEmit against installed dist/*.d.ts ==');
    const tscBin = join(consumerDir, 'node_modules', '.bin', 'tsc');
    const noEmitR = run(tscBin, ['--noEmit', '-p', 'tsconfig.json'], { cwd: consumerDir });
    const ac5Ok = noEmitR.status === 0;
    acResults.set('AC-5', ac5Ok);
    if (ac5Ok) {
      log(
        'AC-5 (BL-443): PASS — tsc --noEmit exited 0; compile-break.ts\'s @ts-expect-error is judged necessary, proving EdgeRel is genuinely widened in the installed tarball\'s dist/index.d.ts',
      );
    } else {
      fail('AC-5 (BL-443): FAIL — tsc --noEmit against the installed tarball did not exit 0');
      fail(`  stdout:\n${indent(noEmitR.stdout || '(empty)')}`);
      fail(`  stderr:\n${indent(noEmitR.stderr || '(empty)')}`);
    }

    // ── 5. emit compiled JS for the runtime fixtures ────────────────────────
    log('\n== compiling fixtures (tsc, emit) ==');
    const emitR = run(tscBin, ['-p', 'tsconfig.json'], { cwd: consumerDir });
    if (dieOnSpawnFailure('tsc (emit)', emitR)) {
      fail(
        '\ngraph-store:tarball-conformance: FAIL (fixture compile-with-emit failed; note this is independent of the AC-5 --noEmit result above)',
      );
      acResults.set('AC-1', false);
      acResults.set('AC-2', false);
      acResults.set('AC-3', false);
      acResults.set('AC-4', false);
      anyAcFailed = true;
    } else {
      // ── 6. run positive-kind-and-rel.js (AC-1, AC-2, AC-3) ────────────────
      log('\n== running positive-kind-and-rel.js ==');
      const positiveR = run(
        process.execPath,
        [join(consumerDir, 'dist', 'positive-kind-and-rel.js')],
        { cwd: consumerDir },
      );
      const positiveChecks = parseNdjson(positiveR.stdout);
      for (const c of positiveChecks) log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.check}${c.ok ? '' : ` — ${c.detail}`}`);
      if (positiveR.stderr) fail(`  stderr:\n${indent(positiveR.stderr)}`);

      const byName = (name) => positiveChecks.find((c) => c.check === name);
      const kindWriteRead = byName('kind-write-read');
      const kindExplainPlan = byName('kind-explain-plan');
      const relWriteRead = byName('rel-write-read');
      const relGetNeighbors = byName('rel-getNeighbors');
      const relExplainPlan = byName('rel-explain-plan');

      // Gate on whether the fixture process crashed before emitting anything (no NDJSON output at
      // all, or an explicit 'fixture-fatal' line) — NOT on the process's overall exit code, which
      // is 1 whenever ANY single check fails (positive-kind-and-rel.ts's own `anyFailed` gate).
      // Conflating the two previously made AC-1/AC-2 falsely report FAIL whenever only AC-3's
      // check failed, even though their own named checks had genuinely passed — caught live via
      // the BL-225 red-arm demo below (see final report).
      const positiveCrashed =
        positiveChecks.length === 0 || positiveChecks.some((c) => c.check === 'fixture-fatal');
      const ac1Ok = !positiveCrashed && !!kindWriteRead?.ok;
      const ac3Ok = !positiveCrashed && !!kindExplainPlan?.ok;
      const ac2Ok =
        !positiveCrashed && !!relWriteRead?.ok && !!relGetNeighbors?.ok && !!relExplainPlan?.ok;

      acResults.set('AC-1', ac1Ok);
      acResults.set('AC-2', ac2Ok);
      acResults.set('AC-3', ac3Ok);

      log(
        `AC-1 (BL-443): ${ac1Ok ? 'PASS' : 'FAIL'} — a consumer installing the tarball can inject a TypePolicy and write/read a novel kind, through node_modules resolution only`,
      );
      log(
        `AC-2 (BL-443): ${ac2Ok ? 'PASS' : 'FAIL'} — the same, for a novel rel, traversed via getEdges/getNeighbors`,
      );
      log(
        `AC-3 (BL-443): ${ac3Ok ? 'PASS' : 'FAIL'} — EXPLAIN QUERY PLAN shows the novel kind resolves via ix_node_kind, zero json_each`,
      );

      // ── 7. run negative-closed-ddl.js (AC-4) ───────────────────────────────
      log('\n== running negative-closed-ddl.js ==');
      const negativeR = run(
        process.execPath,
        [join(consumerDir, 'dist', 'negative-closed-ddl.js')],
        { cwd: consumerDir },
      );
      const negativeChecks = parseNdjson(negativeR.stdout);
      for (const c of negativeChecks) log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.check}${c.ok ? '' : ` — ${c.detail}`}`);
      if (negativeR.stderr) fail(`  stderr:\n${indent(negativeR.stderr)}`);

      const negByName = (name) => negativeChecks.find((c) => c.check === name);
      const kindReject = negByName('closed-ddl-kind-reject');
      const relReject = negByName('closed-ddl-rel-reject');
      const noRebuild = negByName('closed-ddl-no-silent-rebuild');

      const negativeCrashed =
        negativeChecks.length === 0 || negativeChecks.some((c) => c.check === 'fixture-fatal');
      const ac4Ok = !negativeCrashed && !!kindReject?.ok && !!relReject?.ok && !!noRebuild?.ok;
      acResults.set('AC-4', ac4Ok);
      log(
        `AC-4 (BL-443): ${ac4Ok ? 'PASS' : 'FAIL'} — a store built with the pre-open CHECK-bearing schema still rejects a consumer kind AND a consumer rel, through the installed package`,
      );
    }

    for (const [, ok] of acResults) {
      if (!ok) anyAcFailed = true;
    }

    log('');
    if (anyAcFailed) {
      fail('graph-store:tarball-conformance: FAIL');
      process.exitCode = 1;
    } else {
      log('graph-store:tarball-conformance: PASS');
      process.exitCode = 0;
    }
  } finally {
    // Risk 6 (SPEC-PKT-62.md §5): always clean up, success or failure.
    rmSync(scratchRoot, { recursive: true, force: true });
  }
}

function parseNdjson(stdout) {
  if (!stdout) return [];
  const results = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      results.push(JSON.parse(trimmed));
    } catch {
      // not a JSON line (e.g. stray console output) — ignore
    }
  }
  return results;
}

await main();
