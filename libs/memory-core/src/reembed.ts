/**
 * reembedStore — composed orchestration for re-embedding a sox-memory store.
 *
 * This is the single source of truth for the reembed workflow. It is the
 * library-form replacement for the loose `scripts/reembed-memory.mjs` (BL-160),
 * which has been deleted. The memory-cli `reembed` verb calls this function.
 *
 * Invariants:
 *   - --dry-run performs ZERO writes.
 *   - Idempotent by default: skips a node whose PER-RECORD `node.embed_model`
 *     already equals the target model. Override with opts.force = true.
 *   - Backs up the DB (+ -wal/-shm) before any write unless opts.backup = false.
 *   - Model id is always 'bge-base-en-v1.5' (the canonical fastembed model).
 *     NOT the cache-dir name 'fast-bge-base-en-v1.5'.
 *
 * ── BL-92 (data-integrity fix) ────────────────────────────────────────────────
 * BL-88 added a per-record `node.embed_model` column, stamped by the write path
 * (embed-pipeline.ts's applyEmbedding) in the same transaction as every vector
 * write. Before this fix, reembedStore ignored that column entirely and keyed
 * idempotency / source-model detection / grouping off the single scope-level
 * `memory_scope.embed_model` tag — one value for the WHOLE store. A store with
 * mixed vectors (some records on model A, some on model B) could not be
 * targeted: the only lever was --force, which blasts every row regardless of
 * whether it already matched the target model (burning GPU + rewriting vectors
 * that were already correct — an over-migration).
 *
 * This rewires all three concerns onto the per-record `node.embed_model`
 * column:
 *   - Idempotency: "current" means EVERY live, vectorized episode's own
 *     `embed_model` already equals the target — not the scope tag.
 *   - Source-model detection / grouping: candidates are grouped by their own
 *     `embed_model` value (querying `node` directly), so a store with N
 *     distinct stale models gets ALL N groups migrated in one pass — not just
 *     one arbitrarily chosen "the differing model" as before.
 *   - `memory_scope.embed_model` is updated at the end purely as a courtesy /
 *     backward-compat signal for other soft-mismatch consumers (db.ts's
 *     open-time warning, stats.ts's fallback probe) — it is NEVER read to
 *     decide what to migrate.
 *
 * NULL `embed_model` decision (rows written before BL-88's column existed):
 * NULL is treated as "provenance unknown, must migrate" — NOT as "assume
 * already current". This mirrors the explicit precedent already established
 * in embed-pipeline.ts's `healStaleVectors`, whose own comment (BL-88) says
 * NULL rows are deliberately EXCLUDED from ITS staleness pass and are "left
 * for the operator to handle via the full reembed path" — i.e. THIS function.
 * Treating NULL as "current" risks the under-migration failure mode this
 * ticket explicitly calls out as unacceptable: stale/unknown vectors silently
 * poisoning recall forever because nothing ever revisits them. Treating NULL
 * as "needs migration" costs at most one redundant re-embed per legacy row
 * (cheap, safe, self-healing — after which it carries a real stamp and is
 * never re-visited by this logic again).
 *
 * Because a genuinely mixed-model store must be reachable by tests, and the
 * REAL production vector table that `memory_recall`/embed-pipeline read and
 * write is the single fixed-schema `vec_node` table (schema.ts — NOT the
 * generic multi-space `vec_<model>` side tables from `@adhd/sox-vector-store`,
 * which nothing in the live recall path ever queries), this implementation
 * migrates vectors directly in `vec_node`, matching the exact
 * UPDATE-then-INSERT convention embed.ts / embed-pipeline.ts already use
 * (`vec0` virtual tables do not support `INSERT OR REPLACE` — BL-91). This
 * makes a reembed genuinely change what recall sees, rather than populating a
 * side table nothing reads.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createEmbeddingProvider } from '@adhd/sox-embedding-provider';
import { EMBED_DIM, vecToJson, vecToBuffer } from './embed.js';
import { openDb, expandDbPath } from './db.js';
import type { StoreAdapter } from '@adhd/sox-store-adapter';

// ── Public types ──────────────────────────────────────────────────────────────

export interface ReembedStoreOptions {
  /** Perform no writes; report what would change. Default: false. */
  dryRun?: boolean;
  /** Re-embed even if a record already uses the target model. Default: false. */
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
   * True when every live, vectorized episode was already on the target model
   * and opts.force was not set, so no migration ran.
   */
  alreadyCurrent: boolean;
  /** True when opts.dryRun was set; no writes were performed. */
  dryRun: boolean;
  backups: string[];
  /**
   * BL-92: per-source-model candidate counts considered for this run (before
   * `limit` clamping), keyed by the record's own `embed_model` value. The
   * literal key `"(null)"` groups pre-BL-88 rows with no stamp at all.
   * Present for observability — lets an operator see exactly what a mixed
   * store looked like going in.
   */
  sourceModelGroups: Record<string, number>;
}

// ── Default DB path ───────────────────────────────────────────────────────────

/** Canonical default memory DB path (~/.memory/memory.db). */
export function defaultMemoryDbPath(): string {
  return path.join(os.homedir(), '.memory', 'memory.db');
}

// ── Internal: per-record candidate discovery (BL-92) ──────────────────────────

interface EmbedCandidate {
  rowid: number;
  embed_model: string | null;
}

/** Sentinel key for the NULL-embed_model group in sourceModelGroups reporting. */
const NULL_MODEL_KEY = '(null)';

/**
 * Every live episode with an existing `vec_node` vector and non-empty content
 * — i.e. every row this function is capable of re-embedding — grouped
 * implicitly by its own `node.embed_model` (the per-record BL-92 column).
 *
 * Deliberately does NOT consult `memory_scope` — that table is a single
 * store-wide tag and cannot represent a mixed-model store.
 */
async function getReembedCandidates(adapter: StoreAdapter): Promise<EmbedCandidate[]> {
  const result = await adapter.executeAll<EmbedCandidate>(
    `SELECT n.rowid AS rowid, n.embed_model AS embed_model
     FROM node n
     WHERE n.kind = 'episode'
       AND n.t_invalid IS NULL
       AND n.content IS NOT NULL AND n.content != ''
       AND EXISTS (SELECT 1 FROM vec_node v WHERE v.node_id = n.rowid)
     ORDER BY n.rowid ASC`,
  );
  return result.rows;
}

function groupBySourceModel(candidates: EmbedCandidate[]): Record<string, number> {
  const groups: Record<string, number> = {};
  for (const c of candidates) {
    const key = c.embed_model ?? NULL_MODEL_KEY;
    groups[key] = (groups[key] ?? 0) + 1;
  }
  return groups;
}

// ── Implementation ────────────────────────────────────────────────────────────

/**
 * Open the DB at `dbPath`, warm up the fastembed 'bge-base-en-v1.5' provider,
 * and migrate nodes in the store to the target vector space.
 *
 * Dry-run contract: when `opts.dryRun` is `true` this function performs ZERO
 * writes.
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

  // libs/data/CLAUDE.md §3 (space invariant): `vec_node` is a FIXED-schema
  // vec0 table declared FLOAT[768] at DDL time (schema.ts) — it is the single
  // table `memory_recall` / embed-pipeline actually read and write, unlike the
  // generic multi-space `vec_<model>` tables `@adhd/sox-vector-store` can
  // create for arbitrary dims. A model whose dimension differs from
  // `vec_node`'s fixed column would require a physical schema migration
  // (recreate vec_node with the new FLOAT[N]) that this function does not
  // perform. Fail loud instead of attempting a dim-mismatched write that
  // sqlite-vec would otherwise reject row-by-row with cryptic errors.
  if (targetDim !== EMBED_DIM) {
    throw new Error(
      `[reembedStore] target model '${targetModelId}' has dimension ${targetDim}, but ` +
        `vec_node is a fixed FLOAT[${EMBED_DIM}] column (libs/memory-core/src/schema.ts). ` +
        `Migrating to a different-dimension model requires a vec_node schema migration, ` +
        `which reembedStore does not perform. Aborting to avoid silent corruption.`,
    );
  }

  // ── Open DB (memory-core: schema + sqlite-vec) ──────────────────────────────
  // BL-377: this used to be `(adapter as SqliteAdapter).unwrap()`. The cast is
  // asserted, never checked — and on the DEFAULT Turso backend the unwrapped
  // handle's query API is async, so these reads silently returned Promises.
  // Everything below goes through the backend-agnostic StoreAdapter API.
  const adapter = await openDb(resolvedDbPath);

  try {
    // ── BL-92: per-record candidate discovery + idempotency check ────────────
    const candidates = await getReembedCandidates(adapter);
    const sourceModelGroups = groupBySourceModel(candidates);
    const nonTarget = candidates.filter((c) => c.embed_model !== targetModelId);

    // Vacuously "current" when there is nothing to migrate at all (empty
    // store / no vectorized episodes yet) — otherwise current iff every
    // candidate's OWN embed_model already equals the target.
    const allCurrent = candidates.length === 0 || nonTarget.length === 0;

    log(`[reembedStore] candidates     : ${candidates.length} live vectorized episode(s)`);
    log(`[reembedStore] source groups  : ${JSON.stringify(sourceModelGroups)}`);

    if (allCurrent && !force && !dryRun) {
      log(
        `[reembedStore] all records already on '${targetModelId}' — nothing to do (use --force to re-embed anyway).`,
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
        sourceModelGroups,
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

    // ── Dry-run path: NO writes ────────────────────────────────────────────────
    if (dryRun) {
      // force re-embeds everything; a targeted run only touches non-target rows.
      const wouldMigrateRows = force ? candidates : nonTarget;
      const wouldMigrate =
        limit > 0 ? Math.min(wouldMigrateRows.length, limit) : wouldMigrateRows.length;

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
        sourceModelGroups,
      };
    }

    // ── Live reembed ──────────────────────────────────────────────────────────
    // force = touch every vectorized candidate (even ones already on target,
    // matching the historical --force "re-embed everything" contract).
    // !force = touch ONLY records whose own embed_model differs from target
    // (including NULL — see the NULL decision documented at file top). This
    // is the core BL-92 fix: a targeted, non-force run leaves already-correct
    // records byte-for-byte untouched.
    let targets = force ? candidates : nonTarget;
    if (limit > 0) targets = targets.slice(0, limit);

    const getText = async (id: number): Promise<string | null> => {
      const row = await adapter.executeGet<{ content: string | null; name: string | null }>(
        `SELECT content, name FROM node WHERE rowid = ?`,
        [id],
      );
      if (!row) return null;
      return [row.content, row.name].filter(Boolean).join(' ') || null;
    };

    log(`[reembedStore] re-embedding with model '${targetModelId}' (${targets.length} target row(s))...`);

    const result: Pick<ReembedStoreResult, 'migrated' | 'skipped' | 'errors'> = {
      migrated: 0,
      skipped: 0,
      errors: [],
    };

    const useBinaryFormat = adapter.capabilities.nativeVectors;
    const writeVector = async (rowid: number, vec: Float32Array): Promise<void> => {
      if (vec.length !== targetDim) {
        throw new Error(`dim mismatch for node ${rowid}: got ${vec.length}, expected ${targetDim}`);
      }
      const serialized = useBinaryFormat ? vecToBuffer(vec) : vecToJson(vec);
      const info = await adapter.executeRun(
        'UPDATE vec_node SET embedding = ? WHERE node_id = CAST(? AS INTEGER)',
        [serialized, rowid],
      );
      if (info.rowsAffected === 0) {
        await adapter.executeRun(
          'INSERT INTO vec_node(node_id, embedding) VALUES (CAST(? AS INTEGER), ?)',
          [rowid, serialized],
        );
      }
      // BL-92: stamp the per-record column so this row is never re-visited by
      // a future targeted (non-force) reembed once it's genuinely current.
      await adapter.executeRun(
        'UPDATE node SET embed_model = ? WHERE rowid = ?',
        [targetModelId, rowid],
      );
    };

    const BATCH_SIZE = 32;
    let batch: Array<{ rowid: number; text: string }> = [];

    const flushBatch = async (): Promise<void> => {
      if (batch.length === 0) return;
      const texts = batch.map((b) => b.text);
      const embeddings: Float32Array[] = [];
      try {
        for await (const emb of provider.embedBatch(texts)) {
          embeddings.push(emb);
        }
      } catch (err) {
        const msg = `Batch embedding failed: ${String(err)}`;
        for (const b of batch) result.errors.push({ id: b.rowid, error: msg });
        batch = [];
        return;
      }

      for (let i = 0; i < batch.length; i++) {
        const item = batch[i]!;
        const emb = embeddings[i];
        if (!emb) {
          result.errors.push({ id: item.rowid, error: 'Missing embedding from batch' });
          continue;
        }
        try {
          await writeVector(item.rowid, emb);
          result.migrated++;
        } catch (err) {
          result.errors.push({ id: item.rowid, error: String(err) });
        }
      }
      batch = [];
    };

    for (const t of targets) {
      const text = await getText(t.rowid);
      if (!text) {
        result.skipped++;
        continue;
      }
      batch.push({ rowid: t.rowid, text });
      if (batch.length >= BATCH_SIZE) {
        await flushBatch();
      }
    }
    await flushBatch();

    // Update memory_scope as a courtesy/backward-compat fallback tag ONLY —
    // never read by this function to decide what to migrate (see file-top note).
    if (result.migrated > 0 || force) {
      await adapter.executeRun(
        `UPDATE memory_scope SET embed_model = ?, embed_dim = ?`,
        [targetModelId, targetDim],
      );
      log(`[reembedStore] memory_scope.embed_model -> '${targetModelId}' (fallback tag only)`);
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
      sourceModelGroups,
    };
  } finally {
    await adapter.close();
  }
}
