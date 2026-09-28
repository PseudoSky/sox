/**
 * vitest.global-scratch.ts — embedding-provider's run-scoped scratch root
 * (BL-230d1d2a, BL-0b0573f8). Runs ONCE in the main vitest process.
 *
 * setup:
 *   1. snapshot the operator model cache (stat-only: size, mtime, inode, dir mtimes);
 *   2. create a short root `/tmp/sox-ep-*` (UDS paths stay under the 104-byte limit);
 *   3. seed `<root>/xdg-cache/sox/models/<model>` from each operator model dir by
 *      copy-on-write clone (`scripts/lib/smoke-fs.mjs` seedModelCache — `cp -c`,
 *      read-only on the operator side, distinct inodes on ours);
 *   4. `provide` the context to every worker (`vitest.setup-scratch.ts` points
 *      the path config inside the root and arms the funnel's typed spawn guard).
 * teardown (the run-wide no-download / no-leak proof — throws, failing the run):
 *   - verified-stop every embedding host whose argv/env names the root
 *     (`scripts/lib/embed-host-isolation.mjs` auditAndReapEmbedHosts; lineage
 *     only, never a foreign host) and fail on survivors or on a host whose
 *     `--cache-dir`/`--socket` escaped the root;
 *   - fail if the operator cache's bytes or mtimes changed, or if any download
 *     marker (tarball, unseeded real model) exists under the root;
 *   - remove the root.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { TestProject } from 'vitest/node';
import {
  EMBED_SCRATCH_KEY,
  diffSnapshots,
  findDownloadMarkers,
  resolveOperatorModelCache,
  snapshotTree,
  type EmbedScratch,
} from './src/test-support/scratchModelCache';

const TAG = '[embedding-provider scratch]';
const REPO_ROOT = path.resolve(__dirname, '../../../..');

/**
 * The shared harness helpers in `scripts/lib/` (plain ESM, pinned by the
 * tools/test-26121495/97e7f214/e5cf17a0 guards). Loaded by computed URL, the
 * same way memory-server's dist-freshness-guard spec loads `tools/`:
 * `@nx/enforce-module-boundaries` rejects a static relative import that leaves
 * this project, and `scripts/` has no npm scope to import it by.
 */
interface SeedResult {
  seeded: boolean;
  reason: string;
}
interface ReapResult {
  smoke: unknown[];
  undead: number[];
  violations: Array<{ pid: number; reasons: string[] }>;
  psFailed: boolean;
}
interface HarnessLib {
  seedModelCache(o: { src: string; dst: string; log?: (s: string) => void }): SeedResult;
  PS_ARGS: string[];
  auditAndReapEmbedHosts(ctx: Record<string, unknown>, io: Record<string, unknown>): Promise<ReapResult>;
}
async function loadHarnessLib(): Promise<HarnessLib> {
  const fsLib = (await import(/* @vite-ignore */ pathToFileURL(path.join(REPO_ROOT, 'scripts/lib/smoke-fs.mjs')).href)) as Pick<HarnessLib, 'seedModelCache'>;
  const isoLib = (await import(
    /* @vite-ignore */ pathToFileURL(path.join(REPO_ROOT, 'scripts/lib/embed-host-isolation.mjs')).href
  )) as Pick<HarnessLib, 'PS_ARGS' | 'auditAndReapEmbedHosts'>;
  return { seedModelCache: fsLib.seedModelCache, PS_ARGS: isoLib.PS_ARGS, auditAndReapEmbedHosts: isoLib.auditAndReapEmbedHosts };
}

function warn(msg: string): void {
  process.stderr.write(`${TAG} ${msg}\n`);
}

function psEmbedHosts(psArgs: string[]): string | null {
  try {
    return execFileSync('ps', psArgs, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    warn(`ps capture failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function processIdentity(pid: number): string | null {
  try {
    return execFileSync('ps', ['-ww', '-o', 'lstart=,command=', '-p', String(pid)], { encoding: 'utf8' }).trim() || null;
  } catch (err) {
    // exit status 1 = no such pid (gone): a plain null. Anything else is logged.
    if ((err as { status?: number }).status !== 1) warn(`identity probe of pid ${pid} failed: ${String(err)}`);
    return null;
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const runStartedMs = Date.now();
  const { seedModelCache, PS_ARGS, auditAndReapEmbedHosts } = await loadHarnessLib();
  const operatorModelCache = resolveOperatorModelCache(process.env);
  const operatorSnapshot = snapshotTree(operatorModelCache);

  const root = fs.mkdtempSync('/tmp/sox-ep-');
  const realRoot = fs.realpathSync(root);
  const modelCache = path.join(root, 'xdg-cache', 'sox', 'models');
  const tmp = path.join(root, 'tmp');
  const soxHome = path.join(root, 'sox-home');
  for (const d of [modelCache, tmp, soxHome]) fs.mkdirSync(d, { recursive: true });

  const seededModels: string[] = [];
  if (operatorSnapshot.exists) {
    for (const e of fs.readdirSync(operatorModelCache, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const r = seedModelCache({ src: path.join(operatorModelCache, e.name), dst: path.join(modelCache, e.name), log: warn });
      if (r.seeded) seededModels.push(e.name);
      else warn(`not seeded ${e.name}: ${r.reason}`);
    }
  }
  const seededSnapshot = snapshotTree(modelCache);
  const ctx: EmbedScratch = { root, modelCache, tmp, soxHome, operatorModelCache, operatorSnapshot, seededModels, seededSnapshot };
  project.provide(EMBED_SCRATCH_KEY, ctx);

  return async () => {
    const problems: string[] = [];
    const reap = await auditAndReapEmbedHosts(
      { smokeRoots: [root, realRoot], spawnedPids: new Set<number>(), runStartedMs },
      {
        ps: () => psEmbedHosts(PS_ARGS),
        now: () => Date.now(),
        kill: (pid: number, sig: NodeJS.Signals | number) => process.kill(pid, sig),
        identity: processIdentity,
        sleep: (ms: number) => new Promise<void>((res) => setTimeout(res, ms)),
        log: warn,
      },
    );
    if (reap.psFailed) problems.push('embed-host ps capture failed — reap unverifiable');
    if (reap.undead.length > 0) problems.push(`embed host(s) survived verified stop: ${reap.undead.join(', ')}`);
    for (const v of reap.violations) {
      // HOME is deliberately the operator's (only path config is redirected);
      // the containment this harness asserts is --cache-dir and --socket.
      const reasons = v.reasons.filter((r) => !r.startsWith('HOME'));
      if (reasons.length > 0) problems.push(`pid ${v.pid}: ${reasons.join('; ')}`);
    }
    const opDiff = diffSnapshots(operatorSnapshot, snapshotTree(operatorModelCache));
    if (opDiff.length > 0) problems.push(`operator model cache ${operatorModelCache} changed: ${opDiff.join(' | ')}`);
    const markers = findDownloadMarkers(root, seededSnapshot);
    if (markers.length > 0) problems.push(`download markers: ${markers.join(' | ')}`);
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch (err) {
      problems.push(`could not remove scratch root ${root}: ${String(err)}`);
    }
    if (problems.length > 0) {
      // vitest 4 reports a throwing globalSetup teardown as "error during close"
      // but still exits 0 (verified), so the non-zero exit is set explicitly.
      process.exitCode = 1;
      throw new Error(`${TAG} run-wide isolation proof FAILED:\n  - ${problems.join('\n  - ')}`);
    }
    process.stderr.write(
      `${TAG} OK: seeded [${seededModels.join(', ')}]; operator cache unchanged (${Object.keys(operatorSnapshot.files).length} files); ` +
        `0 download markers; reaped ${reap.smoke.length} run-owned host record(s)\n`,
    );
  };
}
