/**
 * test-support/bl-df0ea359-embed-host-isolation.ts — BL-df0ea359.
 *
 * `bl404-telemetry-composition-root.spec.ts` and `bl401-stages-declared-live.spec.ts`
 * spawn the REAL `src/index.ts` entrypoint via `tsx` (never `dist/`, never in-process —
 * that is the whole point of those two specs: exercising `require.main === module` for
 * real). The entrypoint unconditionally fires `warmupEmbed()` on startup
 * (`index.ts`'s `setImmediate(() => void warmupEmbed()...)`, right after
 * `initTelemetry()` — see BL-89), which resolves the real fastembed backend and spawns
 * a shared embedding-host CHILD PROCESS (`embedHostMain.ts`) if one isn't already
 * running for the resolved `(model, ep, cacheDir, buildId)` singleton key.
 *
 * Before this fix, both specs only overrode `SOX_ECOSYSTEM_HOME` in the spawned
 * entrypoint's env and otherwise spread the calling process's `process.env` verbatim.
 * `resolveConfig()` in `libs/memory-core/src/embed.ts` falls back to
 * `join(process.env['XDG_CACHE_HOME'] ?? join(homedir(), '.cache'), 'sox', 'models')`
 * when `SOX_EMBED_CACHE_DIR` is unset, and `homedir()` reads the process's `HOME` env
 * var — so every spec run spawned a REAL embedding host with the OPERATOR's
 * `HOME=/Users/nix` and `--cache-dir=/Users/nix/.cache/sox/models`, sharing the
 * production model cache and (via `resolveEmbedHostSocketDir()`'s
 * `SOX_ECOSYSTEM_HOME` default) the production embed socket directory whenever that
 * var happened to be unset elsewhere in the chain. `buildEmbedHostEnv()`
 * (`embedHostConfig.ts`) forwards `HOME`/`XDG_CACHE_HOME`/`TMPDIR` verbatim from the
 * spawner's own env to the host it launches, so overriding them on the spawned
 * `tsx` entrypoint's env is sufficient to isolate the whole chain — no code outside
 * this test-support module needs to change.
 *
 * `buildScratchEmbedEnv()` gives each spec its own scratch `HOME`, `XDG_CACHE_HOME`,
 * `SOX_EMBED_CACHE_DIR`, and `TMPDIR`, plus a scratch `SOX_ECOSYSTEM_HOME` (unchanged
 * from before this fix) so the socket dir is isolated too. `stopSpawnedEmbedHosts()`
 * verified-stops (SIGTERM, poll, escalate to SIGKILL, re-check) any embed host whose
 * argv carries that scratch cache dir, so a spec never leaves an orphaned host running
 * after `afterAll`.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { log } from '@adhd/sox-telemetry';

/** The on-disk model dir name embedding-provider's fastembed carrier resolves to. */
const MODEL_DIR_NAME = 'fast-bge-base-en-v1.5';
const MODEL_MARKER_FILE = 'model_optimized.onnx';

/**
 * Resolve where THIS (calling, un-overridden) process would find its own cached
 * model — mirrors `resolveConfig()` in `libs/memory-core/src/embed.ts`.
 */
function resolveOperatorModelCacheDir(): string {
  return (
    process.env['SOX_EMBED_CACHE_DIR'] ??
    path.join(process.env['XDG_CACHE_HOME'] ?? path.join(os.homedir(), '.cache'), 'sox', 'models')
  );
}

/**
 * Best-effort: seed the scratch cache dir with a COPY of the model bytes already
 * cached for the operator's real backend, so the spawned host's FIRST real-embed
 * attempt succeeds without a network fetch — avoiding funnelClient's multi-attempt
 * ensure()/cooldown retry storm (ENSURE_FAILURE_THRESHOLD=3,
 * ENSURE_CIRCUIT_COOLDOWN_MS=10_000) that a network-denied sandbox would otherwise
 * hit on every single spec run. This is a one-time file COPY performed by THIS
 * process, before the scratch env is ever handed to a spawned child — the spawned
 * embed host's own `cacheDir` argv is always the scratch path; it is never pointed
 * at, and never touches, the operator's real cache directory. Silently no-ops (and
 * lets the real backend fall back to a network fetch) if no cached model is found.
 */
function seedScratchModelCache(destCacheDir: string): boolean {
  const srcModelDir = path.join(resolveOperatorModelCacheDir(), MODEL_DIR_NAME);
  if (!fs.existsSync(path.join(srcModelDir, MODEL_MARKER_FILE))) return false;
  try {
    fs.mkdirSync(destCacheDir, { recursive: true });
    fs.cpSync(srcModelDir, path.join(destCacheDir, MODEL_DIR_NAME), { recursive: true });
    return true;
  } catch (err) {
    log.warn('bl_df0ea359_model_cache_seed_failed', { destCacheDir, error: String(err) });
    return false;
  }
}

export interface ScratchEmbedEnv {
  env: NodeJS.ProcessEnv;
  cacheDir: string;
  home: string;
}

/**
 * Build a spawn env for a real memory-server entrypoint test that never shares the
 * operator's HOME, model cache, XDG cache dir, tmp dir, or embed socket dir.
 */
export function buildScratchEmbedEnv(scratchRoot: string, baseEnv: NodeJS.ProcessEnv = process.env): ScratchEmbedEnv {
  const home = path.join(scratchRoot, 'home');
  const xdgCache = path.join(scratchRoot, 'xdg-cache');
  const cacheDir = path.join(xdgCache, 'sox', 'models');
  const tmp = path.join(scratchRoot, 'tmp');
  const sandboxEcosystemHome = path.join(scratchRoot, 'home');

  seedScratchModelCache(cacheDir);

  return {
    env: {
      ...baseEnv,
      HOME: home,
      XDG_CACHE_HOME: xdgCache,
      SOX_EMBED_CACHE_DIR: cacheDir,
      TMPDIR: tmp,
      SOX_ECOSYSTEM_HOME: sandboxEcosystemHome,
    },
    cacheDir,
    home,
  };
}

/** Find pids of `embedHostMain` child processes whose argv carries `--cache-dir=<cacheDir>`. */
function findEmbedHostPids(cacheDir: string): number[] {
  const out = spawnSync('ps', ['-axEww', '-o', 'pid=,command='], { encoding: 'utf8' });
  const lines = (out.stdout ?? '').split('\n');
  const needle = `--cache-dir=${cacheDir}`;
  const pids: number[] = [];
  for (const line of lines) {
    if (line.includes('embedHostMain') && line.includes(needle)) {
      const m = /^\s*(\d+)/.exec(line);
      if (m?.[1] !== undefined) pids.push(Number(m[1]));
    }
  }
  return pids;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Verified-stop every embed host spawned under `cacheDir` (SIGTERM, poll for exit,
 * escalate to SIGKILL on timeout, re-check). Never kills a process this helper did not
 * itself discover via the scratch `--cache-dir=` argv marker — it never touches a host
 * running against the operator's real cache dir.
 */
export async function stopSpawnedEmbedHosts(
  cacheDir: string,
  watchWindowMs = 25_000,
  killGraceMs = 4_000,
): Promise<{ found: number[]; stopped: number[]; stillRunning: number[] }> {
  // The parent entrypoint's warmupEmbed() is fire-and-forget (setImmediate); its
  // actual fork of the embed-host child can lag well behind the MCP round trip this
  // spec already completed (buildId fingerprinting + singleton-key resolution run
  // first). Worse, `funnelClient.ts`'s ensure() retries a failed/not-ready host up
  // to ENSURE_FAILURE_THRESHOLD times with an ENSURE_CIRCUIT_COOLDOWN_MS gap between
  // attempts — a NEW pid each time — so a single discover-then-kill pass can miss a
  // later retry entirely. `buildScratchEmbedEnv()` pre-seeds the scratch cache with a
  // real cached model specifically to make the FIRST attempt succeed and avoid this
  // storm, but this loop still watches for and kills every distinct pid it ever sees
  // under `cacheDir` for the whole window, not just the first.
  const seen = new Map<number, boolean>(); // pid -> SIGTERM sent
  const windowStart = Date.now();
  while (Date.now() - windowStart < watchWindowMs) {
    const current = findEmbedHostPids(cacheDir);
    for (const pid of current) {
      if (!seen.has(pid)) {
        seen.set(pid, false);
      }
    }
    for (const [pid, termed] of seen) {
      if (!termed && current.includes(pid)) {
        try {
          process.kill(pid, 'SIGTERM');
        } catch (err) {
          log.warn('bl_df0ea359_embed_host_sigterm_failed', { pid, error: String(err) });
        }
        seen.set(pid, true);
      }
    }
    await sleep(250);
  }

  const found = [...seen.keys()];

  const killStart = Date.now();
  let remaining = findEmbedHostPids(cacheDir).filter((pid) => found.includes(pid));
  while (remaining.length > 0 && Date.now() - killStart < killGraceMs) {
    await sleep(150);
    remaining = findEmbedHostPids(cacheDir).filter((pid) => found.includes(pid));
  }

  for (const pid of remaining) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch (err) {
      log.warn('bl_df0ea359_embed_host_sigkill_failed', { pid, error: String(err) });
    }
  }
  if (remaining.length > 0) {
    await sleep(300);
  }

  const stillRunning = findEmbedHostPids(cacheDir);
  const stopped = found.filter((pid) => !stillRunning.includes(pid));
  return { found, stopped, stillRunning };
}
