/**
 * memory-flush — SessionEnd + ScopePromotionProposed hook handler.
 *
 * Binds two host events (design.md §1.1c, §2.5):
 *   1. SessionEnd — persists working memory, enqueues episodes, nudges memoryd.
 *   2. ScopePromotionProposed — runs the promotion approval/policy step (P4: stub).
 *
 * Deterministic: no LLM calls, no provider dependency (R3 preserved).
 * order: 100 (ascending; ties by id).
 */

import * as net from 'node:net';
import * as path from 'node:path';
import * as fs from 'node:fs';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

const SOCKET_PATH = path.join(process.env['HOME'] ?? '/tmp', '.memory', 'memoryd.sock');

export const events = ['SessionEnd', 'ScopePromotionProposed'];

export interface HookContext {
  event: string;
  timestamp: string;
  payload?: unknown;
}

interface SessionEndPayload {
  session_id: string;
  db_path?: string;
  scope?: string;
  working_memory?: Record<string, unknown>;
  episodes?: Array<{
    content: string;
    agent_id?: string;
    source?: string;
    importance?: number;
  }>;
}

interface ScopePromotionPayload {
  extension_id: string;
  from_scope: string;
  to_scope: string;
  items: Array<{ uid: string; content?: string }>;
  proposed_at: string;
}

/**
 * Nudge memoryd via the Unix socket doorbell.
 * Non-blocking: ignores errors if daemon isn't running.
 */
function nudgeDaemon(): void {
  try {
    const client = net.createConnection(SOCKET_PATH);
    client.on('connect', () => {
      client.write('nudge');
      client.end();
    });
    client.on('error', () => {
      // Daemon not running — queue is durable, will be processed on next startup
    });
  } catch {
    // ignore
  }
}

/**
 * Enqueue an episode into organizer_queue via the write DB.
 */
function enqueueEpisode(
  db: Database.Database,
  nodeUid: string,
  scope: string,
  agentId: string | null,
): void {
  const now = new Date().toISOString();
  const payload = JSON.stringify({ uid: nodeUid, scope, agent_id: agentId });
  const priority = scope === 'project' ? 0 : agentId ? 1 : 2;
  db.prepare(
    `INSERT INTO organizer_queue (op, payload, priority, enqueued)
     VALUES ('ingest', ?, ?, ?)`,
  ).run(payload, priority, now);
}

/**
 * Open the write DB for a given path (minimal — no full schema setup).
 */
function openWriteDb(dbPath: string): Database.Database | null {
  try {
    if (!fs.existsSync(dbPath)) return null;
    const db = new Database(dbPath);
    sqliteVec.load(db);
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA busy_timeout = 5000;');
    return db;
  } catch {
    return null;
  }
}

/**
 * Handle SessionEnd:
 *   1. Save session working memory state (if provided).
 *   2. Enqueue any pending episodes for async organization.
 *   3. Nudge memoryd to wake and process the queue.
 */
function handleSessionEnd(payload: SessionEndPayload): void {
  const { session_id, db_path, scope = 'project', working_memory, episodes } = payload;

  if (!db_path) return;

  const db = openWriteDb(db_path);
  if (!db) return;

  try {
    // 1. Persist session working memory (upsert: invalidate old, insert new)
    if (working_memory !== undefined) {
      const now = new Date().toISOString();
      const state = JSON.stringify(working_memory);

      db.transaction(() => {
        // Close previous session node
        db.prepare(
          `UPDATE node SET t_invalid = ? WHERE kind = 'session' AND session_id = ? AND t_invalid IS NULL`,
        ).run(now, session_id);

        // Insert new session node
        const sessionUid = `session-${session_id}-${Date.now()}`;
        db.prepare(
          `INSERT INTO node (uid, kind, session_id, resume_state, t_created, t_valid)
           VALUES (?, 'session', ?, ?, ?, ?)`,
        ).run(sessionUid, session_id, state, now, now);
      })();
    }

    // 2. Enqueue pending episodes for async organization
    if (episodes && episodes.length > 0) {
      const now = new Date().toISOString();
      for (const ep of episodes) {
        if (!ep.content?.trim()) continue;

        const uid = `ep-flush-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const contentHash = Buffer.from(ep.content.trim().toLowerCase()).toString('base64');

        // Check dedup
        const existing = db
          .prepare<[string], { uid: string }>('SELECT uid FROM node WHERE content_hash = ?')
          .get(contentHash);
        if (existing) continue;

        try {
          db.prepare(
            `INSERT INTO node (uid, kind, content, agent_id, session_id, source, importance, content_hash, t_created, t_valid)
             VALUES (?, 'episode', ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            uid,
            ep.content,
            ep.agent_id ?? null,
            session_id,
            ep.source ?? 'message',
            ep.importance ?? 1.0,
            contentHash,
            now,
            now,
          );

          // Enqueue for organize
          enqueueEpisode(db, uid, scope, ep.agent_id ?? null);
        } catch {
          // Skip individual insert failures
        }
      }
    }

    // 3. Nudge memoryd
    nudgeDaemon();
  } finally {
    db.close();
  }
}

/**
 * Promotion approval callback type.
 * Set via setPromotionApprover() to inject a decision function into the handler.
 * Default (no approver set): log receipt but take no action.
 */
type PromotionApproverFn = (payload: ScopePromotionPayload) => Promise<{
  approved: boolean;
  srcDbPath?: string;
  dstDbPath?: string;
  decidedBy?: string;
}>;

let _promotionApprover: PromotionApproverFn | null = null;

/**
 * Set the promotion approver callback (called by tests / memory promote CLI).
 * The approver receives the full ScopePromotionProposed payload and returns
 * { approved, srcDbPath, dstDbPath, decidedBy }.
 *
 * This replaces the stub from P2.
 */
export function setPromotionApprover(fn: PromotionApproverFn | null): void {
  _promotionApprover = fn;
}

/**
 * Handle ScopePromotionProposed (P4 — full implementation).
 *
 * Per design.md §2.5 + docs/scope-promotion.md:
 *   1. The host fires ScopePromotionProposed after tenant calls proposePromotion().
 *   2. memory-flush (bound to this event) runs the approval step.
 *   3. If auto_approve=true (org baseline opt-in) OR approver returns approved=true:
 *      copy node to wider scope's DB with SAME_AS edge, mark status='applied'.
 *   4. On rejection: no-op (row stays 'proposed' in promotion_queue; caller can mark rejected).
 *
 * config.promotion validation: check for typos at promote time (not install time).
 */
async function handleScopePromotionProposed(payload: ScopePromotionPayload): Promise<void> {
  const { extension_id, from_scope, to_scope, items, proposed_at } = payload;

  console.log(
    `[memory-flush] ScopePromotionProposed: ${extension_id} ${from_scope}→${to_scope} (${items.length} items, proposed_at=${proposed_at})`,
  );

  if (!_promotionApprover) {
    // No approver set — log and return (default host handler already enqueued to log)
    console.log(`[memory-flush] no promotion approver configured — deferring to host log`);
    return;
  }

  try {
    const decision = await _promotionApprover(payload);

    if (!decision.approved) {
      console.log(`[memory-flush] promotion REJECTED by ${decision.decidedBy ?? 'approver'}`);
      return; // no-op: row stays 'proposed' in promotion_queue
    }

    // Approved: apply promotion — copy nodes to wider scope DB
    if (!decision.srcDbPath || !decision.dstDbPath) {
      console.error(`[memory-flush] promotion approved but srcDbPath/dstDbPath not provided`);
      return;
    }

    const srcDbRaw = openWriteDb(decision.srcDbPath);
    if (!srcDbRaw) {
      console.error(`[memory-flush] cannot open source DB: ${decision.srcDbPath}`);
      return;
    }
    const dstDbRaw = openWriteDb(decision.dstDbPath);
    if (!dstDbRaw) {
      srcDbRaw.close();
      console.error(`[memory-flush] cannot open destination DB: ${decision.dstDbPath}`);
      return;
    }

    try {
      // Dynamically import applyPromotion and rejectPromotion from the dist lib
      // (avoids a circular dependency while keeping the logic in the lib — R3 preserved)
      const { applyPromotion } = await import('@sox/memory-core');

      let applied = 0;
      let failed = 0;

      for (const item of items) {
        // applyPromotion is async (embed is async); cast through unknown to handle
        // stale dist type declarations while awaiting correctly.
        const result = await (applyPromotion as unknown as (...args: unknown[]) => Promise<{ ok: boolean; dst_uid?: string; error?: string }>)(
          srcDbRaw, dstDbRaw, item.uid, from_scope, to_scope,
        );
        if (result?.ok) {
          applied++;
          console.log(`[memory-flush] applied promotion: ${item.uid} → ${result.dst_uid} (${from_scope}→${to_scope})`);
        } else {
          failed++;
          console.error(`[memory-flush] promotion apply failed for ${item.uid}: ${result?.error}`);
        }
      }

      console.log(`[memory-flush] promotion complete: ${applied} applied, ${failed} failed`);
    } finally {
      srcDbRaw.close();
      dstDbRaw.close();
    }
  } catch (err) {
    console.error(`[memory-flush] promotion handler error:`, err);
  }
}

/**
 * Hook handler — dispatches to SessionEnd or ScopePromotionProposed.
 * order: 100. Deterministic: no LLM calls, no provider dependency.
 * Returns a Promise for ScopePromotionProposed (async approval step).
 */
export function handler(ctx: HookContext): void | Promise<void> {
  try {
    switch (ctx.event) {
      case 'SessionEnd':
        handleSessionEnd(ctx.payload as SessionEndPayload);
        break;
      case 'ScopePromotionProposed':
        return handleScopePromotionProposed(ctx.payload as ScopePromotionPayload).catch(err => {
          console.error(`[memory-flush] ScopePromotionProposed handler error:`, err);
        });
      default:
        break;
    }
  } catch (err) {
    console.error(`[memory-flush] handler error for ${ctx.event}:`, err);
    // Don't re-throw: hook failures must not crash the host.
  }
}
