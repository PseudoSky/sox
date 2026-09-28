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

/** BL-611a711e: the marker file minted alongside the scratch root — proves reuse below is really
 * reattaching to a root THIS run created, not trusting a stale/foreign env var whose directory
 * may have been removed, or worse, since been recreated by something unrelated. */
const OWNER_MARKER_NAME = '.sox-cli-scratch-owner';

export default function setup(): () => Promise<void> {
  const inherited = process.env[SCRATCH_ROOT_ENV];
  if (inherited) {
    const markerPath = path.join(inherited, OWNER_MARKER_NAME);
    if (!fs.existsSync(inherited) || !fs.existsSync(markerPath)) {
      throw new Error(
        `BL-611a711e: ${SCRATCH_ROOT_ENV}=${inherited} is set but ${fs.existsSync(inherited) ? 'carries no owner marker' : 'does not exist'} ` +
          `(${markerPath}) — refusing to reuse a root this run did not mint. A previous run's env leaked ` +
          'into this one without the directory (or its marker) surviving.',
      );
    }
    say(`reusing run scratch root ${inherited} (owner marker verified)`);
    return async () => {
      say('teardown deferred to the invocation that minted the scratch root');
    };
  }

  const runStartedMs = Date.now();
  // BL-611a711e: a short, ABSOLUTE `/tmp/sox-cli-` base (mirrors memory-server's own
  // `/tmp/sox-ms-`, vitest.global-embed-scratch.ts), never `path.join(os.tmpdir(), ...)`. On
  // macOS, `os.tmpdir()` resolves to `/var/folders/<2>/<~30 chars>/T/`, which alone eats ~50-70
  // bytes of the 104-byte Unix-domain-socket `sun_path` budget the real embed host's socket file
  // is bound under (`@adhd/sox-service-proxy`'s `backendSocketPath()`) — leaving so little margin
  // that a realistic singleton key forces `backendSocketPath()`'s tier-2 (shortened-filename)
  // fallback just to stay under budget, a handful of bytes from tier-3's fallback OUTSIDE this
  // scratch root entirely (`/tmp/sox-<uid>/p-<16hex>.sock`, `libs/service-proxy/src/socket-path.ts`).
  // A fixed `/tmp/sox-cli-` root keeps the full, unshortened socket path comfortably inside the
  // 104-byte budget without ever needing either fallback tier — see
  // `611a711e-scratch-socket-path.spec.ts`.
  const root = fs.mkdtempSync('/tmp/sox-cli-');
  const xdgCache = path.join(root, 'xdg-cache');
  const cacheDir = path.join(xdgCache, 'sox', 'models');
  const ecosystemHome = path.join(root, 'eco');
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.mkdirSync(ecosystemHome, { recursive: true });
  // BL-611a711e: owner marker — see the reuse check above.
  fs.writeFileSync(
    path.join(root, OWNER_MARKER_NAME),
    JSON.stringify({ pid: process.pid, mintedAtMs: runStartedMs }),
    'utf8',
  );

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
