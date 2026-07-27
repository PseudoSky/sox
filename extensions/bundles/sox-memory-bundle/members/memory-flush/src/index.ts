/**
 * memory-flush — SessionEnd + ScopePromotionProposed hook handler.
 *
 * Binds two host events (design.md §1.1c, §2.5):
 *   1. SessionEnd — persists working memory, enqueues episodes for async
 *      organization, then (if export_enabled+export_dir configured)
 *      auto-exports to markdown.
 *   2. ScopePromotionProposed — runs the promotion approval/policy step (P4: stub).
 *
 * P5 auto-export (BL-21):
 *   - Gated: only runs when `export_enabled=true` AND `export_dir` is configured.
 *   - Throttled: at most once per `export_throttle_secs` (default 60s) per process.
 *   - Failure-isolated: a failed export NEVER breaks the SessionEnd flush.
 *
 * Deterministic: no LLM calls, no provider dependency (R3 preserved).
 * order: 100 (ascending; ties by id).
 */

import { applyPromotion as memCoreApplyPromotion, exportMarkdown as memCoreExportMarkdown, openDb as memCoreOpenDb } from '@adhd/sox-memory-core';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as sqliteVec from 'sqlite-vec';

export const events = ['SessionEnd', 'ScopePromotionProposed'];

export interface HookContext {
  event: string;
  timestamp: string;
  payload?: unknown;
}

// ── Export config (P5 — BL-21) ────────────────────────────────────────────────

/**
 * Configuration for the auto-export feature.
 * Can be injected at test time via `setExportConfig()` or read from
 * `SessionEndPayload.export_config` at runtime.
 */
export interface ExportConfig {
  /** Enable auto-export on SessionEnd. Default: false. */
  export_enabled: boolean;
  /** Directory to write the markdown mirror into. Required when export_enabled=true. */
  export_dir: string;
  /**
   * Minimum seconds between auto-exports per process lifetime (throttle).
   * Default: 60. Set to 0 to disable throttle (useful in tests).
   */
  export_throttle_secs: number;
}

/** Module-level export config override (set by tests or host startup). */
let _exportConfig: ExportConfig | null = null;

/**
 * Override export config for the lifetime of this module instance.
 * Pass `null` to clear the override and revert to payload-driven config.
 * Tests use this to inject config without needing to send it via payload.
 */
export function setExportConfig(cfg: ExportConfig | null): void {
  _exportConfig = cfg;
}

/** Module-level last-export timestamp in ms (per process lifetime). */
let _lastExportMs = 0;

/**
 * Reset the throttle clock (useful in tests to force a fresh export).
 * Not exported for production use; tests should import this for isolation.
 */
export function _resetExportThrottle(): void {
  _lastExportMs = 0;
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
  /**
   * Optional export config passed by the host from installed extension config.
   * If _exportConfig module override is set, it takes precedence.
   */
  export_config?: Partial<ExportConfig>;
}

interface ScopePromotionPayload {
  extension_id: string;
  from_scope: string;
  to_scope: string;
  items: Array<{ uid: string; content?: string }>;
  proposed_at: string;
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
 * Resolve the effective export config for a SessionEnd event.
 * Priority: module-level override (_exportConfig) > payload.export_config > defaults.
 */
function resolveExportConfig(payload: SessionEndPayload): ExportConfig {
  if (_exportConfig !== null) {
    return _exportConfig;
  }
  const pc = payload.export_config ?? {};
  return {
    export_enabled: pc.export_enabled ?? false,
    export_dir: pc.export_dir ?? '',
    export_throttle_secs: pc.export_throttle_secs ?? 60,
  };
}

/**
 * Attempt a markdown export from the given db_path to export_dir.
 *
 * Throttle: if called within `throttleSecs` of the last successful export,
 * this is a no-op. The throttle is per-process (module-level `_lastExportMs`).
 *
 * Failure-isolated: any error is caught and logged; never re-thrown.
 *
 * @returns true if export ran, false if throttled or skipped.
 */
async function tryAutoExport(db_path: string, exportDir: string, throttleSecs: number): Promise<boolean> {
  // Throttle check
  const nowMs = Date.now();
  const elapsedSecs = (nowMs - _lastExportMs) / 1000;
  if (_lastExportMs > 0 && elapsedSecs < throttleSecs) {
    console.log(
      `[memory-flush] auto-export throttled (${elapsedSecs.toFixed(1)}s since last export, ` +
      `throttle=${throttleSecs}s)`,
    );
    return false;
  }

  try {
    if (!fs.existsSync(db_path)) {
      console.log(`[memory-flush] auto-export skipped: db_path not found: ${db_path}`);
      return false;
    }

    const adapter = await memCoreOpenDb(db_path);
    try {
      const result = memCoreExportMarkdown(adapter, { dir: exportDir, enabled: true });
      _lastExportMs = Date.now();
      console.log(
        `[memory-flush] auto-export complete: ${result.nodesWritten} nodes written, ` +
        `${result.topics} topics → ${exportDir}`,
      );
    } finally {
      await adapter.close();
    }
    return true;
  } catch (err) {
    console.error(`[memory-flush] auto-export failed (non-fatal):`, err);
    return false;
  }
}

/**
 * Handle SessionEnd:
 *   1. Save session working memory state (if provided).
 *   2. Enqueue any pending episodes for async organization.
 *      Batch enrichment runs via memory-server's in-process periodic loop —
 *      no daemon socket nudge required (S9/BL-182: memory-daemon deleted).
 *   3. (P5 BL-21) Auto-export to markdown if export_enabled + export_dir configured and
 *      not within the throttle window.
 */
async function handleSessionEnd(payload: SessionEndPayload): Promise<void> {
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

    // 2. Enqueue pending episodes for async organization.
    // Batch enrichment runs via memory-server's in-process periodic loop —
    // no daemon nudge required (S9/BL-182: memory-daemon deleted).
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
  } finally {
    db.close();
  }

  // 3. (P5 BL-21) Auto-export — runs AFTER db.close() so the DB is not locked during export.
  // Gate: export_enabled must be true AND export_dir must be a non-empty string.
  // Failure-isolated: tryAutoExport catches all errors internally.
  const exportCfg = resolveExportConfig(payload);
  if (exportCfg.export_enabled && exportCfg.export_dir.trim()) {
    await tryAutoExport(db_path, exportCfg.export_dir.trim(), exportCfg.export_throttle_secs);
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
      let applied = 0;
      let failed = 0;

      for (const item of items) {
        // applyPromotion is async (embed is async); cast through unknown to handle
        // stale dist type declarations while awaiting correctly.
        const result = await (memCoreApplyPromotion as unknown as (...args: unknown[]) => Promise<{ ok: boolean; dst_uid?: string; error?: string }>)(
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
        // handleSessionEnd is async (awaits tryAutoExport). Return the Promise so the host
        // can optionally await the full flush+export cycle. Errors are caught inside.
        return handleSessionEnd(ctx.payload as SessionEndPayload).catch(err => {
          console.error(`[memory-flush] SessionEnd handler error:`, err);
        });
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
