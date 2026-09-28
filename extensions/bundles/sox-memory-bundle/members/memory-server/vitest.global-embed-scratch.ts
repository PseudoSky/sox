/**
 * vitest.global-embed-scratch.ts — BL-26291f21: one run-scoped embed scratch root.
 *
 * Runs ONCE in the vitest runner process, before any fork worker exists. Workers are forked with
 * this process's env, so every env var set here is inherited by every worker of both projects
 * (`default-mock` and `real-backend`).
 *
 * WHY: `npx nx test memory-server` peer-spawned the machine-wide embedding host against the
 * operator's `~/.cache/sox/models` with its socket under `~/.adhd/sox-ecosystem/run` — the
 * `real-backend` project embeds for real IN-PROCESS, and nothing pinned the worker's embed paths,
 * so memory-core's `resolveConfig()` and embedding-provider's `resolveEmbedHostSocketDir()` fell
 * through to the operator defaults. See `src/test-support/bl-26291f21-embed-scratch.ts`.
 *
 * WHAT:
 *   1. `mkdtemp('/tmp/sox-ms-')` — a SHORT base on purpose: under macOS's `/var/folders/...`
 *      tmpdir the socket path would overflow `sun_path` and fall to the tier-3
 *      `/tmp/sox-<uid>/` root (socket-path.ts), outside this root, where teardown cannot see it.
 *   2. Seeds `<root>/xdg-cache/sox/models/fast-bge-base-en-v1.5` by copy-on-write CLONE of the
 *      operator's model dir (`seedModelCache`, the scripts/smoke-test.mjs 3ebd7ecb mechanism:
 *      `cp -c -R`, read-only on the source, distinct inodes on the destination), so the
 *      real-backend files never download. A stat-only fingerprint of the operator's model dir is
 *      taken before and compared after the run.
 *   3. Pins `SOX_EMBED_CACHE_DIR`, `XDG_CACHE_HOME`, `SOX_ECOSYSTEM_HOME` (and
 *      `SOX_MEMSRV_TEST_SCRATCH_ROOT`) for every worker. `HOME` is deliberately NOT overridden —
 *      the BL-412 `~/.memory` guard in vitest.setup.ts keys on `os.homedir()`.
 *   4. Teardown: audit + verified-stop (SIGTERM → poll → identity re-check → SIGKILL) every embed
 *      host / fastembed child whose argv or env names this root — never any other process — then
 *      assert none of them ran with a cache dir or socket outside the root, then `rm -rf` it.
 *
 * Idempotent: if the root is already pinned in this process (a second invocation for another
 * project), it is reused and only the first invocation's teardown cleans up.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { operatorModelCacheDir, seedModelCache, treeFingerprint } from '../../../../../scripts/lib/smoke-fs.mjs';
import { PS_ARGS, auditAndReapEmbedHosts, describeHost, isInsideRoot } from '../../../../../scripts/lib/embed-host-isolation.mjs';
import {
  EMBED_MODEL_DIR_NAME,
  MODEL_SEEDED_ENV,
  SCRATCH_ROOT_ENV,
  TELEMETRY_DIR_ENV,
} from './src/test-support/bl-26291f21-embed-scratch-env.js';

const PINNED_KEYS = [
  'SOX_EMBED_CACHE_DIR',
  'XDG_CACHE_HOME',
  'SOX_ECOSYSTEM_HOME',
  SCRATCH_ROOT_ENV,
  TELEMETRY_DIR_ENV,
  MODEL_SEEDED_ENV,
] as const;

/** Evidence of a model fetch in a host log (fastembed/HF download path, or the host's own events). */
const FETCH_MARKER_RE = /download|huggingface|https?:\/\/|fetching model|model_fetch/i;

/** Count fetch/download markers in every log file under `dir` (stderr logs + JSONL); stat-bounded. */
function countFetchMarkers(dir: string): { files: number; hits: number } {
  let files = 0;
  let hits = 0;
  if (!fs.existsSync(dir)) return { files, hits };
  for (const rel of Object.keys(treeFingerprint(dir))) {
    if (!/\.(log|jsonl)$/.test(rel)) continue;
    files++;
    for (const line of fs.readFileSync(path.join(dir, rel), 'utf8').split('\n')) {
      if (FETCH_MARKER_RE.test(line)) hits++;
    }
  }
  return { files, hits };
}

function say(msg: string): void {
  process.stderr.write(`[memory-server vitest.global-embed-scratch] BL-26291f21: ${msg}\n`);
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
    return execFileSync('ps', ['-ww', '-o', 'lstart=,command=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
  } catch (err) {
    // `ps -p` exits 1 when the pid is gone — that is the expected "no identity" answer.
    const status = (err as { status?: number }).status;
    if (status !== 1) say(`identity probe of pid ${String(pid)} failed: ${String(err)}`);
    return null;
  }
}

/** Total bytes + newest mtime of a model dir (stat only, never reads content); null if absent. */
function bytesAndMtime(dir: string): { bytes: number; newestMtimeMs: number } | null {
  if (!fs.existsSync(dir)) return null;
  let bytes = 0;
  let newestMtimeMs = 0;
  for (const rel of Object.keys(treeFingerprint(dir))) {
    const st = fs.statSync(path.join(dir, rel));
    bytes += st.size;
    newestMtimeMs = Math.max(newestMtimeMs, st.mtimeMs);
  }
  return { bytes, newestMtimeMs };
}

export default function setup(): () => Promise<void> {
  if (process.env[SCRATCH_ROOT_ENV]) {
    say(`reusing run scratch root ${process.env[SCRATCH_ROOT_ENV]}`);
    return async () => {
      say('teardown deferred to the invocation that minted the scratch root');
    };
  }

  const runStartedMs = Date.now();
  const prior = Object.fromEntries(PINNED_KEYS.map((k) => [k, process.env[k]]));
  const operatorModelDir = path.join(operatorModelCacheDir(process.env), EMBED_MODEL_DIR_NAME);
  // BL-404 keeps worker telemetry durable under the ORIGINAL ecosystem home (never a bare tmpdir);
  // resolved here, before SOX_ECOSYSTEM_HOME is re-pointed at the scratch root. Its
  // `sox-tests/logs` leaf is the one operator path the worker guard allowlists (exact match).
  const originalEcosystemHome =
    process.env['SOX_ECOSYSTEM_HOME'] !== undefined && process.env['SOX_ECOSYSTEM_HOME'] !== ''
      ? process.env['SOX_ECOSYSTEM_HOME']
      : path.join(os.homedir(), '.adhd', 'sox-ecosystem');

  const root = fs.mkdtempSync('/tmp/sox-ms-');
  const xdgCache = path.join(root, 'xdg-cache');
  const cacheDir = path.join(xdgCache, 'sox', 'models');
  const ecosystemHome = path.join(root, 'eco');
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.mkdirSync(ecosystemHome, { recursive: true });

  const operatorBefore = fs.existsSync(operatorModelDir) ? JSON.stringify(treeFingerprint(operatorModelDir)) : null;
  const operatorStatBefore = JSON.stringify(bytesAndMtime(operatorModelDir));
  const seed = seedModelCache({
    src: operatorModelDir,
    dst: path.join(cacheDir, EMBED_MODEL_DIR_NAME),
    log: (m) => say(`model cache seed: ${m}`),
  });
  say(
    `scratch root ${root}; model cache ${seed.seeded ? `seeded by ${String(seed.method)} (${String(seed.files)} files, ${String(seed.bytes)} bytes)` : `NOT seeded (${seed.reason}) — real-backend files will skip`}`,
  );

  // Downloads land on the SCRATCH side, so that is the tree whose drift proves or disproves one.
  const scratchModelsAtSeed = JSON.stringify(treeFingerprint(cacheDir));

  process.env[MODEL_SEEDED_ENV] = seed.seeded ? '1' : '0';
  process.env['SOX_EMBED_CACHE_DIR'] = cacheDir;
  process.env['XDG_CACHE_HOME'] = xdgCache;
  process.env['SOX_ECOSYSTEM_HOME'] = ecosystemHome;
  process.env[SCRATCH_ROOT_ENV] = root;
  process.env[TELEMETRY_DIR_ENV] = path.join(originalEcosystemHome, 'sox-tests', 'logs');

  return async function teardown(): Promise<void> {
    const problems: string[] = [];
    // Set when the reap left an undead run-owned host or the ps capture used to verify the reap
    // failed outright — in either case we cannot prove the root is free of live processes, so
    // `rm -rf` on it would delete the only evidence of what is still running against it.
    let keepRoot = false;
    try {
      const r = await auditAndReapEmbedHosts(
        { smokeRoots: [root], spawnedPids: new Set<number>(), runStartedMs },
        {
          ps: psCapture,
          now: () => Date.now(),
          kill: (pid, sig) => process.kill(pid, sig as NodeJS.Signals),
          identity: processIdentity,
          sleep: (ms) => new Promise<void>((res) => { setTimeout(res, ms); }),
          log: (m) => say(`embed-host reap: ${m}`),
        },
      );
      say(
        `embed-host reap: run-owned ${String(r.smoke.length)} [${r.smoke.map((p) => `${String(p.pid)}:${p.kind}`).join(', ')}], ` +
          `stopped ${String(r.stopped.length)}, undead ${String(r.undead.length)}, foreign (untouched) ${String(r.foreign.length)}`,
      );
      if (r.psFailed) {
        problems.push('embed-host ps capture failed — reap unverifiable');
        keepRoot = true;
      }
      if (r.undead.length > 0) {
        problems.push(`undead run-owned embed processes: ${r.undead.join(', ')}`);
        keepRoot = true;
      }
      // HOME is intentionally inherited (see header), so only the two paths this item is about are
      // contained here: the model cache and the socket of every host this run spawned.
      for (const p of r.smoke) {
        if (p.kind !== 'host') continue;
        if (!isInsideRoot(p.cacheDir, root)) problems.push(`host ${describeHost(p)} ran with --cache-dir outside ${root}`);
        if (!isInsideRoot(p.socket, root)) problems.push(`host ${describeHost(p)} ran with --socket outside ${root}`);
      }
      // No-download proof, taken on the side a download would write to, before the rm below.
      const scratchModelsAfter = JSON.stringify(treeFingerprint(cacheDir));
      const fetch = countFetchMarkers(ecosystemHome);
      say(
        `scratch model cache tree ${scratchModelsAfter === scratchModelsAtSeed ? 'unchanged since seed (no download)' : 'CHANGED since seed'}; ` +
          `fetch/download markers in ${String(fetch.files)} run log file(s) under the scratch ecosystem home: ${String(fetch.hits)}`,
      );
      if (seed.seeded && scratchModelsAfter !== scratchModelsAtSeed) problems.push('the seeded scratch model cache changed during the run (a model download or rewrite happened)');
      if (seed.seeded && fetch.hits > 0) problems.push(`${String(fetch.hits)} fetch/download marker(s) in run logs despite a seeded cache`);
    } finally {
      const operatorAfter = fs.existsSync(operatorModelDir) ? JSON.stringify(treeFingerprint(operatorModelDir)) : null;
      const operatorStatAfter = JSON.stringify(bytesAndMtime(operatorModelDir));
      say(
        // The operator path itself is deliberately not echoed: a leak audit greps this run's output
        // for it, and the clone source must never read as a leak line.
        `operator model dir ${EMBED_MODEL_DIR_NAME} (clone source, read-only): ${operatorAfter === operatorBefore && operatorStatAfter === operatorStatBefore ? 'unchanged (stat fingerprint identical' : 'CHANGED during the run (this harness only reads it — check for a concurrent operator download'}; bytes+newest mtime before ${operatorStatBefore} after ${operatorStatAfter})`,
      );
      for (const k of PINNED_KEYS) {
        const v = prior[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      if (keepRoot) {
        say(`leaving scratch root ${root} in place — undead process or unverifiable ps capture, see problems above`);
      } else {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
    if (problems.length > 0) {
      // vitest 4.1.8 runs globalSetup teardowns inside `Vitest.close()`, which catches a thrown
      // teardown error, logs it as "error during close", and lets the process exit 0 — a throw
      // alone cannot fail the run (same fix as libs/memory-core/vitest.global-guard.ts and
      // libs/data/embed/embedding-provider/vitest.global-scratch.ts). Set exitCode first, then
      // report, so the failure survives even if something upstream swallows the throw too.
      process.exitCode = 1;
      const report =
        `BL-26291f21: embed scratch teardown found:\n  - ${problems.join('\n  - ')}` +
        (keepRoot ? `\n  scratch root kept for inspection: ${root}` : '');
      process.stderr.write(`\n${report}\n\n`);
      throw new Error(report);
    }
  };
}
