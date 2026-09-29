/**
 * test-support/scratchModelCache.ts — the run-scoped scratch root every
 * embedding-provider spec runs under (BL-230d1d2a, BL-0b0573f8). Test-only:
 * excluded from the library build (`tsconfig.lib.json`), never shipped.
 *
 * `vitest.global-scratch.ts` (globalSetup, main vitest process) creates ONE
 * short root (`/tmp/sox-ep-*`), seeds its model cache by copy-on-write clone
 * from the operator's cache (read-only on the operator side), snapshots the
 * operator cache, and hands everything to the workers through vitest
 * `provide`/`inject` under {@link EMBED_SCRATCH_KEY}. `vitest.setup-scratch.ts`
 * (setupFiles, every worker) then points the path config (`TMPDIR`,
 * `XDG_CACHE_HOME`, `SOX_EMBED_CACHE_DIR`, `SOX_ECOSYSTEM_HOME`) inside that
 * root and arms the funnel's typed spawn guard with it.
 *
 * Everything here is pure `node:fs`/`node:path` so both the globalSetup and
 * the specs share one definition of "operator cache unchanged" and "a
 * download happened".
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** vitest `provide`/`inject` key carrying {@link EmbedScratch}. */
export const EMBED_SCRATCH_KEY = 'soxEmbedScratch';

/** Per-file identity: size and mtime (bytes + mtime, per BL-230d1d2a) plus inode. */
export interface FileStamp {
  size: number;
  mtimeMs: number;
  ino: number;
}

/** Stat-only snapshot of a tree. `dirs` carries every directory's own mtime. */
export interface TreeSnapshot {
  root: string;
  exists: boolean;
  files: Record<string, FileStamp>;
  dirs: Record<string, number>;
}

/** What the globalSetup provides to every worker. */
export interface EmbedScratch {
  /** The run-scoped scratch root (`/tmp/sox-ep-*`), realpath'd. */
  root: string;
  /** The seeded model cache inside `root` (`<root>/xdg-cache/sox/models`). */
  modelCache: string;
  /** `TMPDIR` for workers (`<root>/tmp`). */
  tmp: string;
  /** Default `SOX_ECOSYSTEM_HOME` for workers (`<root>/sox-home`). */
  soxHome: string;
  /** The operator's model cache, resolved from the ORIGINAL (pre-redirect) env. */
  operatorModelCache: string;
  /** Operator cache snapshot taken before any spec ran. */
  operatorSnapshot: TreeSnapshot;
  /** Model directory names (e.g. `fast-bge-small-en-v1.5`) cloned into `modelCache`. */
  seededModels: string[];
  /** Snapshot of `modelCache` right after seeding (the no-download baseline). */
  seededSnapshot: TreeSnapshot;
}

declare module 'vitest' {
  export interface ProvidedContext {
    soxEmbedScratch: EmbedScratch;
  }
}

/**
 * The operator's model cache exactly as the product resolves it
 * (`index.ts` createFastembedProvider: `SOX_EMBED_CACHE_DIR` →
 * `$XDG_CACHE_HOME/sox/models` → `$HOME/.cache/sox/models`), from `env`.
 */
export function resolveOperatorModelCache(env: NodeJS.ProcessEnv): string {
  const explicit = env['SOX_EMBED_CACHE_DIR'];
  if (explicit !== undefined && explicit !== '') return explicit;
  const xdg = env['XDG_CACHE_HOME'];
  return path.join(xdg !== undefined && xdg !== '' ? xdg : path.join(os.homedir(), '.cache'), 'sox', 'models');
}

/** Stat-only snapshot (never reads content). A missing root is a valid, empty snapshot. */
export function snapshotTree(root: string): TreeSnapshot {
  const snap: TreeSnapshot = { root, exists: fs.existsSync(root), files: {}, dirs: {} };
  if (!snap.exists) return snap;
  const walk = (dir: string): void => {
    snap.dirs[path.relative(root, dir) || '.'] = fs.statSync(dir).mtimeMs;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) {
        const st = fs.statSync(full);
        snap.files[path.relative(root, full)] = { size: st.size, mtimeMs: st.mtimeMs, ino: st.ino };
      }
    }
  };
  walk(root);
  return snap;
}

/** Every difference between two snapshots of the same tree, human-readable. Empty = unchanged. */
export function diffSnapshots(before: TreeSnapshot, after: TreeSnapshot): string[] {
  const out: string[] = [];
  if (before.exists !== after.exists) out.push(`${after.root}: existence changed ${before.exists} → ${after.exists}`);
  for (const [rel, a] of Object.entries(before.files)) {
    const b = after.files[rel];
    if (!b) out.push(`removed file ${rel}`);
    else if (a.size !== b.size || a.mtimeMs !== b.mtimeMs || a.ino !== b.ino) {
      out.push(`changed file ${rel} (size ${a.size}→${b.size}, mtime ${a.mtimeMs}→${b.mtimeMs}, ino ${a.ino}→${b.ino})`);
    }
  }
  for (const rel of Object.keys(after.files)) if (!(rel in before.files)) out.push(`added file ${rel}`);
  for (const [rel, m] of Object.entries(before.dirs)) {
    const n = after.dirs[rel];
    if (n === undefined) out.push(`removed dir ${rel}`);
    else if (n !== m) out.push(`dir mtime changed ${rel} (${m}→${n})`);
  }
  for (const rel of Object.keys(after.dirs)) if (!(rel in before.dirs)) out.push(`added dir ${rel}`);
  return out;
}

/**
 * Download markers under `root`. fastembed's `retrieveModel()` fetches
 * `<cacheDir>/<model>.tar.gz`, extracts `<cacheDir>/<model>/`, then unlinks the
 * tarball; the HF path writes `<cacheDir>/<repo>/…`. So a download leaves
 * either a `*.tar.gz` (in flight or crashed) or a real-sized
 * `model_optimized.onnx` in a model dir that was never seeded. Stub caches the
 * specs write (a few bytes of `'stub'`) are not markers.
 */
export function findDownloadMarkers(root: string, seeded: TreeSnapshot | null): string[] {
  const out: string[] = [];
  if (!fs.existsSync(root)) return out;
  const REAL_MODEL_MIN_BYTES = 1024 * 1024;
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full);
        continue;
      }
      if (!e.isFile()) continue;
      if (e.name.endsWith('.tar.gz') || e.name.endsWith('.incomplete')) out.push(`download artifact ${full}`);
      else if (e.name === 'model_optimized.onnx' || e.name === 'model.onnx') {
        const rel = seeded ? path.relative(seeded.root, full) : null;
        const wasSeeded = seeded !== null && rel !== null && !rel.startsWith('..') && rel in seeded.files;
        if (!wasSeeded && fs.statSync(full).size >= REAL_MODEL_MIN_BYTES) out.push(`unseeded real model ${full}`);
      }
    }
  };
  walk(root);
  return out;
}

/**
 * The run's scratch context, or `null` when a spec runs outside the project's
 * vitest config (no globalSetup, nothing provided).
 */
export function embedScratchOrNull(provided: EmbedScratch | undefined): EmbedScratch | null {
  return provided !== undefined && provided !== null && typeof provided.root === 'string' ? provided : null;
}

/** True when `p` is `root` or lies beneath it, comparing both `/private` spellings (macOS). */
export function pathInside(p: string, root: string): boolean {
  const spell = (x: string): string[] => {
    const n = path.resolve(x);
    if (n.startsWith('/private/')) return [n, n.slice('/private'.length)];
    if (/^\/(?:tmp|var)(?:\/|$)/.test(n)) return [n, `/private${n}`];
    return [n];
  };
  for (const a of spell(p)) {
    for (const r of spell(root)) {
      if (a === r || a.startsWith(r.endsWith(path.sep) ? r : r + path.sep)) return true;
    }
  }
  return false;
}
