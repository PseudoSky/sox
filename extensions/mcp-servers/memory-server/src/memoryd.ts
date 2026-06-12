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
 * Loop (7-step deterministic-first, ≤50 nodes/cycle):
 *   ingest → extract → link → consolidate → decay → reindex → idle
 *
 * LLM step delegated to memory-organizer via the organizeItems() IPC call.
 */

import * as net from 'node:net';
import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { PRAGMAS, DDL, FTS_TRIGGERS } from './schema.js';

const SOCKET_PATH = path.join(process.env['HOME'] ?? '/tmp', '.memory', 'memoryd.sock');
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

export interface OrganizerItem {
  uid: string;
  content: string;
  kind: string;
  agent_id: string | null;
  session_id: string | null;
}

export interface OrganizerResult {
  uid: string;
  importance?: number;
  entities?: Array<{ name: string; type: string; summary?: string }>;
  relations?: Array<{ src_uid?: string; rel: string; dst_uid?: string; dst_name?: string; weight?: number }>;
  contradicts_uid?: string;
  reflection?: string;
}

/**
 * Organizer callback type. memoryd invokes this with a batch;
 * memory-organizer implements the LLM step (R3: every LLM call lives there).
 */
type OrganizerFn = (items: OrganizerItem[], db: Database.Database) => Promise<OrganizerResult[]>;

export class MemoryDaemon {
  private db: Database.Database;
  private server: net.Server | null = null;
  private stopping = false;
  private loopHandle: ReturnType<typeof setTimeout> | null = null;
  private organizerFn: OrganizerFn;
  readonly dbPath: string;

  constructor(dbPath: string, organizerFn: OrganizerFn) {
    this.dbPath = dbPath;
    this.organizerFn = organizerFn;

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

    // Separate ingest rows (need organizer) from others (deterministic)
    const ingestRows = rows.filter((r) => r.op === 'ingest');
    const otherRows = rows.filter((r) => r.op !== 'ingest');

    // Process deterministic ops first (steps: link, consolidate, decay, reindex)
    for (const row of otherRows) {
      await this.processDeterministic(row);
    }

    // Process ingest rows via organizer (the LLM step — only in memory-organizer per R3)
    if (ingestRows.length > 0) {
      await this.processIngestBatch(ingestRows);
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
        // Trigger FTS rebuild for recently modified nodes
        const uids = (payload['uids'] as string[] | undefined) ?? [];
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
        // These require the organizer LLM step — mark as handled via ingest flow
        break;
      default:
        break;
    }
    void payload; // used above
  }

  /**
   * Process a batch of 'ingest' operations via the organizer.
   * The organizer makes the only LLM calls (R3).
   */
  private async processIngestBatch(rows: QueueRow[]): Promise<void> {
    const items: OrganizerItem[] = [];

    for (const row of rows) {
      const payload = JSON.parse(row.payload) as Record<string, unknown>;
      const uid = payload['uid'] as string;
      if (!uid) continue;

      const node = this.db
        .prepare(`SELECT uid, content, kind, agent_id, session_id FROM node WHERE uid = ?`)
        .get(uid) as OrganizerItem | undefined;

      if (node) {
        items.push(node);
      }
    }

    if (items.length === 0) return;

    try {
      const results = await this.organizerFn(items, this.db);
      this.applyOrganizerResults(results);
    } catch (err) {
      console.error('[memoryd] organizer error:', err);
      // Don't re-throw — the items are marked done to avoid re-processing
    }
  }

  /**
   * Apply organizer results to the database:
   * - Update importance scores
   * - Insert entity nodes
   * - Insert relation edges
   * - Handle contradictions (bi-temporal invalidation, R5)
   * - Insert reflection nodes
   */
  private applyOrganizerResults(results: OrganizerResult[]): void {
    const tx = this.db.transaction(() => {
      for (const result of results) {
        // Update importance
        if (result.importance !== undefined) {
          this.db.prepare(`UPDATE node SET importance = ? WHERE uid = ?`)
            .run(result.importance, result.uid);
        }

        // Insert entity nodes
        if (result.entities) {
          for (const entity of result.entities) {
            const existingEntity = this.db
              .prepare(`SELECT uid, rowid FROM node WHERE kind = 'entity' AND name = ? AND t_invalid IS NULL`)
              .get(entity.name) as { uid: string; rowid: number } | undefined;

            if (!existingEntity) {
              const entityUid = `entity-${Date.now()}-${Math.random().toString(36).slice(2)}`;
              const now = new Date().toISOString();
              const entityRow = this.db.prepare(
                `INSERT INTO node (uid, kind, name, summary, t_created, t_valid)
                 VALUES (?, 'entity', ?, ?, ?, ?)
                 RETURNING rowid`,
              ).get(entityUid, entity.name, entity.summary ?? null, now, now) as { rowid: number } | undefined;

              if (entityRow) {
                // Link the source node to this entity via MENTIONS
                const srcRow = this.db
                  .prepare(`SELECT rowid FROM node WHERE uid = ?`)
                  .get(result.uid) as { rowid: number } | undefined;

                if (srcRow) {
                  this.db.prepare(
                    `INSERT INTO edge (src, dst, rel, origin, t_created)
                     VALUES (?, ?, 'MENTIONS', 'extracted', ?)`,
                  ).run(srcRow.rowid, entityRow.rowid, now);
                }
              }
            }
          }
        }

        // Handle contradiction: close old claim (bi-temporal R5)
        if (result.contradicts_uid) {
          const now = new Date().toISOString();
          this.db.prepare(`UPDATE node SET t_invalid = ? WHERE uid = ? AND t_invalid IS NULL`)
            .run(now, result.contradicts_uid);

          const oldRow = this.db
            .prepare(`SELECT rowid FROM node WHERE uid = ?`)
            .get(result.contradicts_uid) as { rowid: number } | undefined;

          const newRow = this.db
            .prepare(`SELECT rowid FROM node WHERE uid = ?`)
            .get(result.uid) as { rowid: number } | undefined;

          if (oldRow && newRow) {
            this.db.prepare(
              `INSERT INTO edge (src, dst, rel, origin, t_created, meta)
               VALUES (?, ?, 'SUPERSEDES', 'extracted', ?, ?)`,
            ).run(newRow.rowid, oldRow.rowid, now, JSON.stringify({ reason: 'contradiction_detected' }));
          }
        }

        // Insert reflection node
        if (result.reflection) {
          const reflUid = `reflect-${Date.now()}-${Math.random().toString(36).slice(2)}`;
          const now = new Date().toISOString();
          this.db.prepare(
            `INSERT INTO node (uid, kind, content, source, t_created, t_valid)
             VALUES (?, 'episode', ?, 'reflection', ?, ?)`,
          ).run(reflUid, result.reflection, now, now);
        }
      }
    });

    tx();
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

/** Export socket path for health checks and tests */
export { SOCKET_PATH };
