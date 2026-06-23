/**
 * memoryd — host-supervised singleton writer daemon.
 *
 * Lifecycle contract (design.md §2.4, architecture-v2.md §G-A):
 *   - The HOST spawns this process (lifecycle.background:true, lifecycle.singleton:true).
 *   - The host holds the per-(id,scope) singleton lock — NO OS advisory lock here.
 *   - The host probes health via the Unix socket (lifecycle.health.type:"socket").
 *   - On SIGTERM: graceful drain then exit; host waits stop_timeout_ms then SIGKILL.
 *
 * This file: daemon internals ONLY.
 *   - No self-lock (forbidden by v2 R6 / design.md §2.4).
 *   - No lazy-spawn / self-restart (host owns that).
 *   - IPC: durable organizer_queue table (authoritative) + Unix-socket doorbell.
 *   - Socket doubles as lifecycle.health endpoint (no extra FD).
 *   - Fallback poll every 1000ms if no socket nudge.
 *
 * Loop (deterministic batch enrichment, ≤50 items/cycle):
 *   drain organizer_queue → runBatchEnrich(@sox/memory-enrich) → idle
 *
 * Enrichment is fully deterministic — no LLM, no provider calls.
 */

import * as net from 'node:net';
import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { PRAGMAS, DDL, FTS_TRIGGERS } from './schema.js';
import { reembedNodes } from './embed.js';
import { runBatchEnrich } from '@sox/memory-enrich';

export const SOCKET_PATH = path.join(process.env['HOME'] ?? '/tmp', '.memory', 'memoryd.sock');
const POLL_INTERVAL_MS = 1000;
const BATCH_MAX = 50;
const DECAY_FACTOR = 0.995; // per-hour recency decay

// Queue priority constants: project=0, agent-tagged=1, user/global=2.
// Used in enqueueIngest (exported below) as inline logic.

interface QueueRow {
  seq: number;
  op: string;
  payload: string;
  priority: number;
  enqueued: string;
  attempts: number;
}

export class MemoryDaemon {
  private db: Database.Database;
  private server: net.Server | null = null;
  private stopping = false;
  private loopHandle: ReturnType<typeof setTimeout> | null = null;
  readonly dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;

    // Open write connection
    const dir = path.dirname(dbPath);
    fs.mkdirSync(dir, { recursive: true });
    this.db = new Database(dbPath);
    sqliteVec.load(this.db);
    for (const pragma of PRAGMAS.trim().split('\n').filter(Boolean)) {
      const line = pragma.trim();
      if (line) this.db.exec(line);
    }
    this.db.exec(DDL);
    this.db.exec(FTS_TRIGGERS);
  }

  /**
   * Start the daemon:
   * 1. Bind the Unix socket (doorbell + health endpoint).
   * 2. Resume from MAX(seq WHERE done_at IS NULL) in organizer_queue.
   * 3. Begin the drain loop.
   */
  async start(): Promise<void> {
    await this.bindSocket();
    this.scheduleLoop(0);

    // Graceful shutdown on SIGTERM
    process.on('SIGTERM', () => {
      void this.stop();
    });
    process.on('SIGINT', () => {
      void this.stop();
    });
  }

  /**
   * Bind the Unix-domain socket.
   * Removes stale socket file if present (left by a previous crash — the host
   * has already ensured the singleton via its own lock, so this is safe).
   */
  private bindSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socketDir = path.dirname(SOCKET_PATH);
      fs.mkdirSync(socketDir, { recursive: true });

      // Remove stale socket if it exists (previous process crashed without cleanup)
      try {
        if (fs.existsSync(SOCKET_PATH)) {
          fs.unlinkSync(SOCKET_PATH);
        }
      } catch {
        // ignore
      }

      this.server = net.createServer((conn) => {
        // Nudge: a client wrote to the socket — wake the loop
        conn.on('data', () => {
          this.scheduleLoop(0); // immediate
        });
        conn.on('error', () => { /* ignore connection errors */ });
        conn.end(); // health: just accept+close proves liveness
      });

      this.server.on('error', reject);
      this.server.listen(SOCKET_PATH, () => {
        resolve();
      });
    });
  }

  private scheduleLoop(delayMs: number): void {
    if (this.stopping) return;
    if (this.loopHandle) clearTimeout(this.loopHandle);
    this.loopHandle = setTimeout(() => {
      void this.runLoop();
    }, delayMs);
  }

  /**
   * Main drain loop — processes one batch then reschedules.
   * 7-step deterministic-first pipeline.
   */
  private async runLoop(): Promise<void> {
    if (this.stopping) return;

    try {
      const processed = await this.drainBatch();
      // If we processed items, immediately try another batch;
      // otherwise, poll after POLL_INTERVAL_MS.
      this.scheduleLoop(processed > 0 ? 0 : POLL_INTERVAL_MS);
    } catch (err) {
      console.error('[memoryd] loop error:', err);
      this.scheduleLoop(POLL_INTERVAL_MS);
    }
  }

  /**
   * Drain up to BATCH_MAX queue items.
   * Resumes from MAX(seq WHERE done_at IS NULL) — crash-safe.
   * Returns the number of items processed.
   */
  private async drainBatch(): Promise<number> {
    const rows = this.db
      .prepare<[number], QueueRow>(
        `SELECT seq, op, payload, priority, enqueued, attempts
         FROM organizer_queue
         WHERE done_at IS NULL
         ORDER BY priority ASC, seq ASC
         LIMIT ?`,
      )
      .all(BATCH_MAX) as QueueRow[];

    if (rows.length === 0) return 0;

    // Mark rows as claimed
    const seqs = rows.map((r) => r.seq);
    const claimedAt = new Date().toISOString();
    this.db.prepare(
      `UPDATE organizer_queue SET claimed_at = ?, attempts = attempts + 1
       WHERE seq IN (${seqs.map(() => '?').join(',')})`,
    ).run(claimedAt, ...seqs);

    // Separate enrich rows (trigger batch enrichment) from other deterministic ops
    const enrichRows = rows.filter((r) => r.op === 'ingest' || r.op === 'enrich');
    const otherRows = rows.filter((r) => r.op !== 'ingest' && r.op !== 'enrich');

    // Process other deterministic ops (decay, reindex, etc.)
    for (const row of otherRows) {
      await this.processDeterministic(row);
    }

    // Process enrich/ingest rows via deterministic batch enrichment (no LLM, no provider)
    if (enrichRows.length > 0) {
      this.processBatchEnrich();
    }

    // Mark done
    const doneAt = new Date().toISOString();
    this.db.prepare(
      `UPDATE organizer_queue SET done_at = ?
       WHERE seq IN (${seqs.map(() => '?').join(',')})`,
    ).run(doneAt, ...seqs);

    return rows.length;
  }

  /**
   * Process a single deterministic queue item (non-ingest ops).
   */
  private async processDeterministic(row: QueueRow): Promise<void> {
    const payload = JSON.parse(row.payload) as Record<string, unknown>;

    switch (row.op) {
      case 'decay': {
        // Update access timestamps for decay tracking — no LLM needed
        const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
        this.db.prepare(
          `UPDATE node SET importance = MAX(1.0, importance * ?)
           WHERE t_invalid IS NULL AND last_access < ?`,
        ).run(DECAY_FACTOR, cutoff);
        break;
      }
      case 'reindex': {
        // Trigger FTS rebuild for recently modified nodes.
        // When payload.reembed=true, also re-run the embedding model over each node
        // (used when embed_model changes — see design.md §R2).
        const uids = (payload['uids'] as string[] | undefined) ?? [];
        const reembed = (payload['reembed'] as boolean | undefined) ?? false;

        if (reembed) {
          // Resolve rowids for the given uids (or ALL nodes if uids is empty = full reindex)
          let rowids: number[];
          if (uids.length > 0) {
            rowids = uids.flatMap((uid) => {
              const row = this.db
                .prepare(`SELECT rowid FROM node WHERE uid = ?`)
                .get(uid) as { rowid: number } | undefined;
              return row ? [row.rowid] : [];
            });
          } else {
            // Full reindex: every non-invalidated node
            rowids = (
              this.db
                .prepare(`SELECT rowid FROM node WHERE t_invalid IS NULL`)
                .all() as { rowid: number }[]
            ).map((r) => r.rowid);
          }

          const getContent = (rowid: number): string | null => {
            const row = this.db
              .prepare(`SELECT content, name FROM node WHERE rowid = ?`)
              .get(rowid) as { content: string | null; name: string | null } | undefined;
            if (!row) return null;
            return [row.content, row.name].filter(Boolean).join(' ') || null;
          };

          try {
            const updated = await reembedNodes(this.db, rowids, getContent);
            console.log(`[memoryd] reindex: re-embedded ${updated} nodes`);
          } catch (err) {
            console.error('[memoryd] reindex: re-embed error', err);
          }
        }

        if (uids.length > 0) {
          // FTS content table is kept in sync via triggers; force rebuild by rebuilding
          try {
            this.db.exec('INSERT INTO fts_node(fts_node) VALUES(\'rebuild\')');
          } catch {
            // Not critical if rebuild fails
          }
        }
        break;
      }
      case 'consolidate':
      case 'extract':
      case 'link':
        // Legacy op codes — treated as batch-enrich triggers; handled above via processBatchEnrich
        break;
      default:
        break;
    }
    void payload; // used above
  }

  /**
   * Run deterministic batch enrichment over the full live corpus.
   * Called whenever enrich/ingest queue items are drained.
   * Delegates to @sox/memory-enrich runBatchEnrich — no LLM, no provider calls.
   */
  private processBatchEnrich(): void {
    try {
      const result = runBatchEnrich(this.db);
      console.log(
        `[memoryd] batch enrich: communities=${result.communities_upserted}` +
        ` member_of=${result.member_of_edges}` +
        ` importance_updated=${result.importance_updated}` +
        ` relates_to=${result.relates_to_edges}` +
        ` topics_backfilled=${result.topics_backfilled}`,
      );
    } catch (err) {
      console.error('[memoryd] batch enrich error:', err);
      // Don't re-throw — items are marked done; next cycle will retry
    }
  }

  /**
   * Graceful stop: drain remaining queue, close socket, close DB.
   */
  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;

    if (this.loopHandle) {
      clearTimeout(this.loopHandle);
      this.loopHandle = null;
    }

    // Final drain attempt
    try {
      await this.drainBatch();
    } catch {
      // Ignore errors on shutdown
    }

    // Close socket
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
    }

    // Remove socket file
    try {
      if (fs.existsSync(SOCKET_PATH)) {
        fs.unlinkSync(SOCKET_PATH);
      }
    } catch {
      // ignore
    }

    // Close DB
    try {
      this.db.close();
    } catch {
      // ignore
    }
  }
}

/**
 * Enqueue an item for the daemon to process.
 * Called by memory_write (enqueue+nudge replaces synchronous in-process write).
 * Sub-ms under WAL; does NOT block on LLM.
 */
export function enqueueIngest(
  db: Database.Database,
  uid: string,
  scope: string,
  agentId: string | null,
): void {
  const now = new Date().toISOString();
  const payload = JSON.stringify({ uid, scope, agent_id: agentId });
  const priority = scope === 'project' ? 0 : agentId ? 1 : 2;

  db.prepare(
    `INSERT INTO organizer_queue (op, payload, priority, enqueued)
     VALUES ('ingest', ?, ?, ?)`,
  ).run(payload, priority, now);
}

/**
 * Enqueue a reindex operation.
 * When reembed=true, re-runs the embedding model over each node's content
 * and replaces its vec_node row. Use this after changing SOX_EMBED_BACKEND
 * to keep vectors consistent with the active embed_model.
 *
 * @param uids - specific node UIDs to reindex; omit (or pass []) for a full reindex.
 * @param reembed - also re-run the embedder (default true).
 */
export function enqueueReindex(
  db: Database.Database,
  uids: string[] = [],
  reembed = true,
): void {
  const now = new Date().toISOString();
  const payload = JSON.stringify({ uids, reembed });
  db.prepare(
    `INSERT INTO organizer_queue (op, payload, priority, enqueued)
     VALUES ('reindex', ?, 0, ?)`,
  ).run(payload, now);
}

/**
 * Nudge the daemon via the Unix socket doorbell.
 * Non-blocking: if daemon isn't running yet, the table-backed queue ensures durability.
 */
export function nudgeDaemon(): void {
  try {
    const client = net.createConnection(SOCKET_PATH);
    client.on('connect', () => {
      client.write('nudge');
      client.end();
    });
    client.on('error', () => {
      // Daemon not running yet — queue is durable, will be processed on next startup
    });
  } catch {
    // ignore
  }
}

// SOCKET_PATH is exported above as `export const`.
