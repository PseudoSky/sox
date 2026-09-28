/**
 * vitest.global-embed-scratch.ts — BL-57ae788f: one run-scoped embed scratch root for
 * memory-cli's suite, closing the memory-cli half of BL-26291f21.
 *
 * WHY: `npx nx test memory-cli` had no setup file at all. The `pipeline drain` spec
 * (`bug-memoryserver-embed-heal-nooperator-001-cli.spec.ts`) calls `memoryCurate(adapter,
 * { op: 'drain' }, wq)`, which reaches `drainBacklog()` → memory-core's `embed()` →
 * `getOrCreateProvider()`. With no test-provider override installed, that resolved the REAL
 * fastembed backend and spawned/dialed the shared embedding host against the OPERATOR's
 * `~/.cache/sox/models` model cache and `~/.adhd/sox-ecosystem/run` socket dir — the same leak
 * class as BL-26291f21 in memory-server, one spec earlier in the funnel. That real backend also
 * explains the reported timeout: model load + real ONNX inference is orders of magnitude slower
 * than the deterministic mock, and a cold cache pays a real download.
 *
 * WHAT: mirrors memory-server's `vitest.global-embed-scratch.ts` structure (BL-26291f21) but
 * simpler — this suite's `vitest.setup.ts` installs `DeterministicTestProvider` for EVERY spec
 * (no real-backend opt-out exists in memory-cli today), so no real embed ever reaches
 * `resolveProvider()`/`getSharedFastembedProcess()` and no model-cache seed is needed. This
 * module still pins the scratch root and reaps run-owned embed hosts as defense-in-depth: if a
 * future spec ever clears the mock (`_setEmbedProviderForTest(null)`), it fails isolated instead
 * of falling through to the operator's real paths.
 *
 * Runs ONCE in the vitest runner process, before any fork worker exists; every env var set here
 * is inherited by every worker.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PS_ARGS, auditAndReapEmbedHosts, describeHost, isInsideRoot } from '../../../../../scripts/lib/embed-host-isolation.mjs';
import { SCRATCH_ROOT_ENV } from './src/test-support/bl-57ae788f-embed-scratch-env.js';

function say(msg: string): void {
  process.stderr.write(`[memory-cli vitest.global-embed-scratch] BL-57ae788f: ${msg}\n`);
}

function psCapture(): string | null {
  try {
    return execFileSync('ps', PS_ARGS, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    say(`embed-host ps capture failed: ${String(err)}`);
    return null;
  }
}

function processIdentity(pid: number): string | null {
  try {
    return (
      execFileSync('ps', ['-ww', '-o', 'lstart=,command=', '-p', String(pid)], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() || null
    );
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status !== 1) say(`identity probe of pid ${String(pid)} failed: ${String(err)}`);
    return null;
  }
}

export default function setup(): () => Promise<void> {
  if (process.env[SCRATCH_ROOT_ENV]) {
    say(`reusing run scratch root ${process.env[SCRATCH_ROOT_ENV]}`);
    return async () => {
      say('teardown deferred to the invocation that minted the scratch root');
    };
  }

  const runStartedMs = Date.now();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-cli-embed-'));
  const xdgCache = path.join(root, 'xdg-cache');
  const cacheDir = path.join(xdgCache, 'sox', 'models');
  const ecosystemHome = path.join(root, 'eco');
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.mkdirSync(ecosystemHome, { recursive: true });

  process.env['SOX_EMBED_CACHE_DIR'] = cacheDir;
  process.env['XDG_CACHE_HOME'] = xdgCache;
  process.env['SOX_ECOSYSTEM_HOME'] = ecosystemHome;
  process.env[SCRATCH_ROOT_ENV] = root;

  say(`scratch root ${root} pinned; DeterministicTestProvider (vitest.setup.ts) keeps this suite from ever reaching the real backend`);

  return async function teardown(): Promise<void> {
    const problems: string[] = [];
    try {
      const r = await auditAndReapEmbedHosts(
        { smokeRoots: [root], spawnedPids: new Set<number>(), runStartedMs },
        {
          ps: psCapture,
          now: () => Date.now(),
          kill: (pid, sig) => process.kill(pid, sig as NodeJS.Signals),
          identity: processIdentity,
          sleep: (ms: number) => new Promise<void>((res) => { setTimeout(res, ms); }),
          log: (m: string) => say(`embed-host reap: ${m}`),
        },
      );
      say(
        `embed-host reap: run-owned ${String(r.smoke.length)}, stopped ${String(r.stopped.length)}, ` +
          `undead ${String(r.undead.length)}, foreign (untouched) ${String(r.foreign.length)}`,
      );
      if (r.psFailed) problems.push('embed-host ps capture failed — reap unverifiable');
      if (r.undead.length > 0) problems.push(`undead run-owned embed process(es): ${r.undead.join(', ')}`);
      // This suite never embeds for real (DeterministicTestProvider, vitest.setup.ts), so no host
      // this run spawns should ever exist; if one did, its cache-dir/socket must still be
      // contained — the same positive-containment check memory-server's teardown makes.
      for (const p of r.smoke) {
        if (p.kind !== 'host') continue;
        if (!isInsideRoot(p.cacheDir, root)) problems.push(`host ${describeHost(p)} ran with --cache-dir outside ${root}`);
        if (!isInsideRoot(p.socket, root)) problems.push(`host ${describeHost(p)} ran with --socket outside ${root}`);
      }
    } catch (err) {
      problems.push(`teardown audit/reap threw: ${String(err)}`);
    } finally {
      if (problems.length > 0) {
        // BL-bd91334d policy (memory-server precedent): keep the root on ANY problem — a throw or
        // an undead process means we do not know what is still running against it.
        process.exitCode = 1;
        say(`FAILED — root kept at ${root} for inspection (rm -rf ${root} once triaged):\n  - ${problems.join('\n  - ')}`);
      } else {
        fs.rmSync(root, { recursive: true, force: true });
        say(`clean — 0 undead embed hosts; removed ${root}`);
      }
    }
  };
}
