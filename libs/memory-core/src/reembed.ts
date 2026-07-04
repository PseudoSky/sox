/**
 * reembedStore — composed orchestration for re-embedding a sox-memory store.
 *
 * This is the single source of truth for the reembed workflow. It is the
 * library-form replacement for the loose `scripts/reembed-memory.mjs` (BL-160),
 * which has been deleted. The memory-cli `reembed` verb calls this function.
 *
 * Invariants:
 *   - --dry-run performs ZERO writes. It does NOT create the target vector space.
 *   - Idempotent by default: skips when all scopes already use the target model.
 *     Override with opts.force = true.
 *   - Backs up the DB (+ -wal/-shm) before any write unless opts.backup = false.
 *   - Model id is always 'bge-base-en-v1.5' (the canonical fastembed model).
 *     NOT the cache-dir name 'fast-bge-base-en-v1.5'.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createEmbeddingProvider } from '@adhd/sox-embedding-provider';
import { SqliteVectorBackend, reembed } from '@adhd/sox-vector-store';
import { openDb, expandDbPath } from './db.js';

// ── Public types ──────────────────────────────────────────────────────────────

export interface ReembedStoreOptions {
  /** Perform no writes; report what would change. Default: false. */
  dryRun?: boolean;
  /** Re-embed even if the store already uses the target model. Default: false. */
  force?: boolean;
  /** Create .bak-reembed-<ts> copies of the db before writing. Default: true. */
  backup?: boolean;
  /** SOX_EMBED_BACKEND override: 'real' | 'auto'. Default: 'real'. */
  backend?: string;
  /** Maximum nodes to re-embed (0 = no limit). Default: 0. */
  limit?: number;
  /** Structured logger. Defaults to console.log. */
  log?: (...args: unknown[]) => void;
}

export interface ReembedStoreResult {
  dbPath: string;
  modelId: string;
  dimensions: number;
  migrated: number;
  skipped: number;
  errors: Array<{ id: number; error: string }>;
  /**
   * True when the store was already on the target model and opts.force was
   * not set, so no migration ran.
   */
  alreadyCurrent: boolean;
  /** True when opts.dryRun was set; no writes were performed. */
  dryRun: boolean;
  backups: string[];
}

// ── Default DB path ───────────────────────────────────────────────────────────

/** Canonical default memory DB path (~/.memory/memory.db). */
export function defaultMemoryDbPath(): string {
  return path.join(os.homedir(), '.memory', 'memory.db');
}

// ── Implementation ────────────────────────────────────────────────────────────

/**
 * Open the DB at `dbPath`, warm up the fastembed 'bge-base-en-v1.5' provider,
 * and migrate all nodes in the store to the target vector space.
 *
 * Dry-run contract: when `opts.dryRun` is `true` this function performs ZERO
 * writes — it does NOT call `backend.ensureSpace()`, so no empty vec0 table
 * is created (fixes the BL-159 cosmetic side-effect).
 *
 * @param dbPath  Absolute or tilde-prefixed path to the memory.db file.
 * @param opts    Orchestration options.
 * @returns       Structured result describing what happened (or would happen).
 */
export async function reembedStore(
  dbPath: string,
  opts: ReembedStoreOptions = {},
): Promise<ReembedStoreResult> {
  const {
    dryRun = false,
    force = false,
    backup = true,
    backend: backendEnv = 'real',
    limit = 0,
    log = (...args: unknown[]) => console.log(...args),
  } = opts;

  // Resolve and verify the DB path.
  const resolvedDbPath = path.resolve(expandDbPath(dbPath));
  if (!fs.existsSync(resolvedDbPath)) {
    throw new Error(`[reembedStore] db not found: ${resolvedDbPath}`);
  }

  // Force the embedding backend BEFORE creating the provider (config is read
  // at first embed call; setting the env here mirrors the script's contract).
  const prevBackendEnv = process.env['SOX_EMBED_BACKEND'];
  process.env['SOX_EMBED_BACKEND'] = backendEnv;

  try {
    return await _reembedStore(resolvedDbPath, { dryRun, force, backup, limit, log });
  } finally {
    // Restore env to avoid polluting other code in the same process.
    if (prevBackendEnv === undefined) {
      delete process.env['SOX_EMBED_BACKEND'];
    } else {
      process.env['SOX_EMBED_BACKEND'] = prevBackendEnv;
    }
  }
}

async function _reembedStore(
  resolvedDbPath: string,
  opts: Required<Omit<ReembedStoreOptions, 'backend' | 'log'>> & { log: (...args: unknown[]) => void },
): Promise<ReembedStoreResult> {
  const { dryRun, force, backup, limit, log } = opts;

  // ── Warm up the embedding provider ─────────────────────────────────────────
  const provider = await createEmbeddingProvider({
    type: 'fastembed',
    model: 'bge-base-en-v1.5',
  });

  const targetModelId = provider.metadata.modelId;
  const targetDim = provider.metadata.dimensions;

  log(`[reembedStore] target db      : ${resolvedDbPath}`);
  log(`[reembedStore] active model   : ${targetModelId}`);
  log(`[reembedStore] dimensions     : ${targetDim}`);

  // ── Open DB (memory-core: schema + sqlite-vec) ──────────────────────────────
  const db = openDb(resolvedDbPath);

  try {
    // ── Idempotency check ─────────────────────────────────────────────────────
    const scopes = db
      .prepare<[], { scope: string; embed_model: string; embed_dim: number }>(
        `SELECT scope, embed_model, embed_dim FROM memory_scope`,
      )
      .all();

    log(`[reembedStore] scopes         : ${JSON.stringify(scopes)}`);

    const allCurrent =
      scopes.length > 0 && scopes.every((s) => s.embed_model === targetModelId);

    if (allCurrent && !force && !dryRun) {
      log(
        `[reembedStore] all scopes already on '${targetModelId}' — nothing to do (use --force to re-embed anyway).`,
      );
      return {
        dbPath: resolvedDbPath,
        modelId: targetModelId,
        dimensions: targetDim,
        migrated: 0,
        skipped: 0,
        errors: [],
        alreadyCurrent: true,
        dryRun: false,
        backups: [],
      };
    }

    // ── Backup ────────────────────────────────────────────────────────────────
    const backups: string[] = [];
    if (!dryRun && backup) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      for (const suffix of ['', '-wal', '-shm']) {
        const src = resolvedDbPath + suffix;
        if (fs.existsSync(src)) {
          const dst = `${resolvedDbPath}.bak-reembed-${ts}${suffix}`;
          fs.copyFileSync(src, dst);
          backups.push(dst);
          log(`[reembedStore] backup         : ${dst}`);
        }
      }
    }

    // ── Dry-run path: NO writes, no ensureSpace ───────────────────────────────
    // The original script's dry-run bug: it called backend.ensureSpace() before
    // checking dryRun, which created an empty vec_bge_base_en_v1_5 table in the
    // database. We skip ensureSpace entirely in dry-run mode.
    if (dryRun) {
      const backend = new SqliteVectorBackend(db);

      // Count nodes that would be migrated: find source space nodes
      const sourceModelId = scopes.find((s) => s.embed_model !== targetModelId)?.embed_model
        ?? (scopes[0]?.embed_model ?? null);

      let wouldMigrate = 0;
      if (sourceModelId) {
        for (const _ of backend.iter(sourceModelId)) {
          wouldMigrate++;
          if (limit > 0 && wouldMigrate >= limit) break;
        }
      }

      log(
        `[reembedStore] DRY-RUN: would migrate ${wouldMigrate} nodes. No writes performed.`,
      );
      return {
        dbPath: resolvedDbPath,
        modelId: targetModelId,
        dimensions: targetDim,
        migrated: wouldMigrate,
        skipped: 0,
        errors: [],
        alreadyCurrent: allCurrent && !force,
        dryRun: true,
        backups: [],
      };
    }

    // ── Live reembed ──────────────────────────────────────────────────────────
    const backend = new SqliteVectorBackend(db);
    const targetSpace = { modelId: targetModelId, dim: targetDim };

    // Determine source model (the non-target space, or first scope model if all
    // same — this handles --force re-embed against the same model).
    const sourceModelId =
      scopes.find((s) => s.embed_model !== targetModelId)?.embed_model
      ?? (limit > 0 ? scopes[0]?.embed_model : undefined);

    const getText = (id: number): string | null => {
      const row = db
        .prepare<[number], { content: string | null; name: string | null }>(
          `SELECT content, name FROM node WHERE rowid = ?`,
        )
        .get(id);
      if (!row) return null;
      return [row.content, row.name].filter(Boolean).join(' ') || null;
    };

    log(`[reembedStore] re-embedding with model '${targetModelId}'...`);

    const result = await reembed(backend, provider, {
      targetSpace,
      ...(sourceModelId !== undefined ? { sourceModelId } : {}),
      dryRun: false,
      getText,
    });

    // Update memory_scope to reflect the new model.
    if (result.migrated > 0 || force) {
      db.prepare(`UPDATE memory_scope SET embed_model = ?, embed_dim = ?`).run(
        targetModelId,
        targetDim,
      );
      log(`[reembedStore] memory_scope.embed_model -> '${targetModelId}'`);
    }

    log(
      `[reembedStore] DONE: migrated ${result.migrated}, skipped ${result.skipped}, errors ${result.errors.length}.`,
    );
    if (result.errors.length > 0) {
      for (const e of result.errors.slice(0, 10)) {
        log(`[reembedStore]   error: node ${e.id} — ${e.error}`);
      }
    }

    return {
      dbPath: resolvedDbPath,
      modelId: targetModelId,
      dimensions: targetDim,
      migrated: result.migrated,
      skipped: result.skipped,
      errors: result.errors,
      alreadyCurrent: false,
      dryRun: false,
      backups,
    };
  } finally {
    db.close();
  }
}
