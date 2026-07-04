/**
 * embed-pipeline.ts — Phase-B of the two-phase write path (2026-07-04 incident fix).
 *
 * THE CORE PROBLEM: memory_write used to run its ENTIRE body — including ONNX
 * bge embedding inference (~50–100ms warm, ~0.75s+ under CPU contention) — as
 * one task holding the serial WriteQueue slot. Under contention per-item latency
 * stretched, the queue backed up, and MCP clients timed out (2026-07-04: 6-item
 * batch timeout at queue depth 29). Expensive compute must not block writes.
 *
 * THE FIX — two-phase write:
 *   Phase A (holds the queue slot, NO embed, NO ONNX — fully synchronous):
 *     dedup, node insert, FTS (trigger-driven), tags/entities, sync non-embed
 *     enrichment, transactional outbox row, commit. See write.ts
 *     memoryWritePhaseA(). The fresh episode is BM25/temporal-recallable
 *     immediately.
 *   Phase B (this module, OFF the slot):
 *     compute the embedding via the worker-thread provider WITHOUT holding the
 *     WriteQueue slot, then insert vec_node (+ the deferred E8 near-dup pass)
 *     in a SHORT follow-up queue task. The episode becomes vec-recallable
 *     ~seconds later.
 *
 * BL-154 INVARIANT (chunk-write deadlock class): never enqueue onto a serial
 * WriteQueue from inside a task already running on that queue. Every scheduling
 * entry point in this module (`schedulePendingEmbeds`, `healMissingVectors`)
 * MUST be called from OUTSIDE any queue task — the memory-server handler awaits
 * the Phase-A enqueue first, and only then schedules Phase B; the periodic tick
 * is a plain interval callback. The apply tasks themselves are synchronous and
 * never enqueue.
 *
 * FAILURE/RETRY: if Phase B fails (embed error, E_BUSY rejection of the apply
 * task, process death between phases) the node exists without a vector. That is
 * a DETECTED state, not a silent one:
 *   - `embedBacklogStats()` is the cheap SQL scan exposed via memory_ping's
 *     store block (`embed_backlog`) and folded into the enrichment health
 *     verdict (a dead Phase-B pipeline reads `stalled`, never silent).
 *   - `healMissingVectors()` runs on the periodic enrich tick and re-embeds
 *     every live episode missing its vec row (same recovery shape as
 *     reembedStore/BL-160, scoped to missing vectors only).
 *
 * KILL-SWITCH: SOX_SYNC_EMBED=1 restores the old synchronous behaviour (embed
 * inside the queue slot, near_dup in the response) for rollback without revert.
 * Read per-call so it can be flipped live. Default = async (owner decision:
 * fresh writes are BM25/temporal-recallable immediately, vec-recallable
 * ~seconds later).
 */

import type Database from 'better-sqlite3';
import { embed, vecToJson } from './embed.js';
import { detectNearDup } from './neardup.js';
import type { NearDupResult } from './neardup.js';
import { applyNearDupResult, NEARDUP_THRESHOLD } from './enrich.js';
import type { WriteQueue } from './write-queue.js';

/** Stderr log prefix — matches the writeq convention ([inv:no-stdout-diagnostics]). */
const LOG_PREFIX = '[memory-core embed-pipeline]';

// ── Kill-switch ───────────────────────────────────────────────────────────────

/**
 * True when SOX_SYNC_EMBED=1: the write path embeds INSIDE the queue slot (the
 * pre-2026-07-04 behaviour). Read per-call so operators can flip it without a
 * restart of anything but the affected request stream.
 */
export function syncEmbedEnabled(): boolean {
  return process.env['SOX_SYNC_EMBED'] === '1';
}

// ── Types ─────────────────────────────────────────────────────────────────────

/** A committed Phase-A episode awaiting its Phase-B embedding. */
export interface PendingEmbed {
  /** Episode uid — re-verified against the rowid before the vec insert. */
  uid: string;
  /** Committed node rowid the vec_node row must reference. */
  rowid: number;
  /** Text to embed (the episode content). */
  text: string;
}

export interface EmbedApplyResult {
  /**
   * applied — vec row inserted (near-dup ran if the node is still live).
   * exists  — a vec row already existed (heal/pipeline race; benign no-op).
   * gone    — rowid no longer resolves to this uid (node superseded by a
   *           different row or store rolled back); nothing written.
   */
  status: 'applied' | 'exists' | 'gone';
  /** Deferred E8 near-dup outcome (null unless status === 'applied' on a live node). */
  near_dup: NearDupResult | null;
}

export interface SchedulePendingResult {
  applied: number;
  exists: number;
  gone: number;
  failed: number;
}

export interface HealResult {
  scanned: number;
  healed: number;
  exists: number;
  gone: number;
  failed: number;
  /** True when SOX_DISABLE_EMBED_HEAL=1 short-circuited the pass (test seam / NC). */
  disabled: boolean;
}

export interface EmbedBacklogStats {
  /** Live episodes (t_invalid IS NULL, non-empty content) with NO vec_node row. */
  count: number;
  /** t_created of the oldest such episode — the stall-age signal. */
  oldest_created_at: string | null;
}

// ── Phase-B apply (SHORT queue task body — synchronous) ───────────────────────

/**
 * Insert the computed embedding for a Phase-A-committed episode and run the
 * deferred E8 near-dup pass. Synchronous and short — designed to be the body of
 * a WriteQueue task (or to run inline in the SOX_SYNC_EMBED composition).
 *
 * Write→vec ordering per node: the vec insert references the committed rowid
 * and is guarded by a uid match, so a rowid that no longer belongs to this
 * episode is never written. A node invalidated between phases still receives
 * its vector (bi-temporal: the row is kept and point-in-time recall may use
 * it) but the near-dup pass — which can invalidate OTHER nodes — is skipped.
 */
export function applyEmbedding(
  db: Database.Database,
  pending: PendingEmbed,
  vec: Float32Array,
): EmbedApplyResult {
  const tx = db.transaction((): EmbedApplyResult => {
    const row = db
      .prepare<[number], { uid: string; t_invalid: string | null }>(
        'SELECT uid, t_invalid FROM node WHERE rowid = ?',
      )
      .get(pending.rowid);
    if (!row || row.uid !== pending.uid) {
      return { status: 'gone', near_dup: null };
    }

    const existing = db
      .prepare<[number], { node_id: number }>(
        'SELECT node_id FROM vec_node WHERE node_id = ?',
      )
      .get(pending.rowid);
    if (existing) {
      return { status: 'exists', near_dup: null };
    }

    db.prepare('INSERT INTO vec_node(node_id, embedding) VALUES (CAST(? AS INTEGER), ?)').run(
      pending.rowid,
      vecToJson(vec),
    );

    // Deferred E8 near-dup: only for still-live nodes (near-dup may invalidate
    // the OLDER neighbour — never run it on behalf of an already-dead node).
    let nearDup: NearDupResult | null = null;
    if (row.t_invalid === null) {
      try {
        nearDup = detectNearDup(db, pending.rowid, vec, NEARDUP_THRESHOLD);
      } catch {
        nearDup = null; // KNN may fail on empty stores — treat as no dup
      }
      if (nearDup !== null) {
        applyNearDupResult(db, pending.rowid, nearDup);
      }
    }

    return { status: 'applied', near_dup: nearDup };
  });

  return tx();
}

// ── In-flight tracking (test/drain seam) ──────────────────────────────────────

const inFlight = new Set<Promise<unknown>>();

function track<T>(p: Promise<T>): Promise<T> {
  inFlight.add(p);
  void p.finally(() => inFlight.delete(p));
  return p;
}

/**
 * Resolve when every currently-scheduled Phase-B pipeline has settled.
 * Used by tests (deterministic drain) and available to shutdown paths.
 */
export async function flushPendingEmbeds(): Promise<void> {
  while (inFlight.size > 0) {
    await Promise.allSettled([...inFlight]);
  }
}

// ── Phase-B scheduling (call from OUTSIDE any queue task — BL-154) ────────────

/**
 * Run Phase B for a batch of Phase-A-committed episodes: embed each text OFF
 * the queue slot (worker-thread provider), then apply each vector in a SHORT
 * follow-up queue task.
 *
 * NEVER call this from inside a WriteQueue task (BL-154). The memory-server
 * handlers await the Phase-A enqueue, then call this with the returned
 * pendings — the Phase-A task has fully released its slot by then.
 *
 * Never throws: per-item failures are counted, logged to stderr, and left for
 * the periodic heal (`healMissingVectors`) to repair.
 */
export async function schedulePendingEmbeds(
  wq: WriteQueue,
  pendings: PendingEmbed[],
  opts?: { logSink?: (line: string) => void },
): Promise<SchedulePendingResult> {
  const log = opts?.logSink ?? ((line: string) => console.error(line));
  const out: SchedulePendingResult = { applied: 0, exists: 0, gone: 0, failed: 0 };
  if (pendings.length === 0) return out;

  const run = (async () => {
    for (const p of pendings) {
      try {
        const vec = await embed(p.text); // off-slot: worker-thread ONNX
        const r = await wq.enqueue(`embed_apply:${p.uid}`, (qdb) =>
          applyEmbedding(qdb, p, vec),
        );
        out[r.status === 'applied' ? 'applied' : r.status === 'exists' ? 'exists' : 'gone']++;
      } catch (err) {
        out.failed++;
        const msg = err instanceof Error ? err.message : JSON.stringify(err);
        log(
          `${LOG_PREFIX} Phase-B FAILURE uid=${p.uid} rowid=${p.rowid}: ${msg} — ` +
            `vector deferred to the periodic heal pass`,
        );
      }
    }
    return out;
  })();

  return track(run);
}

// ── Backlog observability (cheap SQL — safe from a ping handler) ──────────────

/**
 * Count live episodes missing their vec_node row (Phase B not yet landed, or
 * lost to a crash). Cheap: one indexed scan over live episodes with a vec0
 * point-lookup per row. Exposed via memory_ping's store block.
 *
 * Invalidated nodes are deliberately EXCLUDED: a node invalidated between
 * phases may legitimately never receive a vector, and must not pin the backlog
 * above zero forever.
 */
export function embedBacklogStats(db: Database.Database): EmbedBacklogStats {
  const row = db
    .prepare<[], { c: number; o: string | null }>(
      `SELECT COUNT(*) AS c, MIN(n.t_created) AS o
       FROM node n
       WHERE n.kind = 'episode'
         AND n.t_invalid IS NULL
         AND n.content IS NOT NULL AND n.content != ''
         AND NOT EXISTS (SELECT 1 FROM vec_node v WHERE v.node_id = n.rowid)`,
    )
    .get();
  return { count: row?.c ?? 0, oldest_created_at: row?.o ?? null };
}

// ── Periodic heal (the Phase-B crash-recovery path) ───────────────────────────

/** True when SOX_DISABLE_EMBED_HEAL=1 (negative-control seam — never set in prod). */
function healDisabled(): boolean {
  return process.env['SOX_DISABLE_EMBED_HEAL'] === '1';
}

/**
 * Re-embed every live episode missing its vec_node row. Runs on the periodic
 * enrich tick in memory-server, mirroring reembedStore's missing-vector
 * recovery (BL-160) but scoped to vec_node gaps only.
 *
 * `db` is used for the read scan; each apply routes through `wq` as a short
 * task so the single-writer contract holds. Called from the interval callback
 * — OUTSIDE any queue task (BL-154).
 *
 * Bounded: at most `opts.limit` (default 500) nodes per pass; the next tick
 * picks up the remainder.
 */
export async function healMissingVectors(
  db: Database.Database,
  wq: WriteQueue,
  opts?: { limit?: number; logSink?: (line: string) => void },
): Promise<HealResult> {
  const out: HealResult = { scanned: 0, healed: 0, exists: 0, gone: 0, failed: 0, disabled: false };
  if (healDisabled()) {
    out.disabled = true;
    return out;
  }
  const limit = opts?.limit ?? 500;
  const log = opts?.logSink ?? ((line: string) => console.error(line));

  const rows = db
    .prepare<[number], { rowid: number; uid: string; content: string }>(
      `SELECT n.rowid, n.uid, n.content
       FROM node n
       WHERE n.kind = 'episode'
         AND n.t_invalid IS NULL
         AND n.content IS NOT NULL AND n.content != ''
         AND NOT EXISTS (SELECT 1 FROM vec_node v WHERE v.node_id = n.rowid)
       ORDER BY n.rowid ASC
       LIMIT ?`,
    )
    .all(limit);

  out.scanned = rows.length;
  for (const r of rows) {
    const pending: PendingEmbed = { uid: r.uid, rowid: r.rowid, text: r.content };
    try {
      const vec = await embed(pending.text);
      const applied = await wq.enqueue(`embed_heal:${pending.uid}`, (qdb) =>
        applyEmbedding(qdb, pending, vec),
      );
      if (applied.status === 'applied') out.healed++;
      else if (applied.status === 'exists') out.exists++;
      else out.gone++;
    } catch (err) {
      out.failed++;
      const msg = err instanceof Error ? err.message : JSON.stringify(err);
      log(`${LOG_PREFIX} heal FAILURE uid=${pending.uid} rowid=${pending.rowid}: ${msg}`);
    }
  }
  return out;
}
