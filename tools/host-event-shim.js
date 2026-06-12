#!/usr/bin/env node
/**
 * tools/host-event-shim.js — Host event-bus reference core (product code).
 *
 * Purpose (docs/scope-promotion.md, design.md §2.5):
 *   The host event bus (proposePromotion / ScopePromotionProposed) provides the
 *   reference implementation for the ScopePromotionProposed lifecycle event path.
 *   Tenant code calls the real API — this shim IS the real dispatch path.
 *
 * Lifecycle event vocabulary (closed — matches schemas/extension/v1.json and
 * scripts/host/event-bus.ts):
 *   PreToolUse | PostToolUse | SessionEnd | ScopePromotionProposed | Stop
 *
 * Dispatch contract:
 *   proposePromotion(extension_id, from_scope, to_scope, items)
 *     → fires ScopePromotionProposed with payload
 *       { extension_id, from_scope, to_scope, items, proposed_at }
 *   Any handler bound to ScopePromotionProposed runs the approval step.
 *   Default: enqueues to a host-managed promotion log + emits a log entry.
 *
 * Isolation guarantee: every handler is wrapped in its own try/catch (mirroring
 *   fireIsolated() in scripts/hook-loader.ts). A throwing handler does NOT abort
 *   the chain — its error is recorded and later handlers still execute.
 *
 * NO bespoke notification path: tenant calls proposePromotion() → shim fires the
 *   event → bound handler (memory-flush) runs. This is the exact generic-event path.
 */

const _handlers = []; // bound ScopePromotionProposed handlers
const _log = [];      // host-managed promotion log (default handler)
let _bespokeCalled = false; // sentinel: detect any bypass of the host event path

/**
 * Bind a handler to ScopePromotionProposed.
 * Called by memory-flush to register its approval step.
 *
 * @param {function(payload: ScopePromotionPayload): void|Promise<void>} handler
 */
export function bindScopePromotionHandler(handler) {
  _handlers.push(handler);
}

/**
 * The host API: proposePromotion(extension_id, from_scope, to_scope, items).
 * Fires ScopePromotionProposed with the standard payload.
 *
 * Isolation guarantee: every bound handler is invoked inside its own try/catch.
 * A throwing handler does NOT abort the chain — its error is collected and all
 * subsequent handlers still execute (matching fireIsolated() semantics from
 * scripts/hook-loader.ts / docs/engine-defects-found.md DEFECT-1 fix).
 *
 * @param {string} extension_id
 * @param {string} from_scope
 * @param {string} to_scope
 * @param {unknown[]} items
 * @returns {Promise<Array<{id: string, error: unknown}|undefined>>} per-handler results
 */
export async function proposePromotion(extension_id, from_scope, to_scope, items) {
  const proposed_at = new Date().toISOString();
  const payload = { extension_id, from_scope, to_scope, items, proposed_at };

  // Default host handler: enqueue to promotion log + emit
  _log.push({ ...payload, received_at: proposed_at });
  console.log(`[host-event-shim] ScopePromotionProposed: ${extension_id} ${from_scope}→${to_scope} (${items.length} items)`);

  // Fire all bound handlers with per-handler isolation (fireIsolated() semantics)
  const results = [];
  for (let i = 0; i < _handlers.length; i++) {
    const handler = _handlers[i];
    try {
      await handler(payload);
      results.push(undefined); // success
    } catch (e) {
      const id = `handler-${i}`;
      console.error(`[host-event-shim] ScopePromotionProposed handler ${id} threw:`, e);
      results.push({ id, error: e }); // failure — chain continues
    }
  }
  return results;
}

/**
 * Get the host promotion log (for test assertions).
 * @returns {Array<object>}
 */
export function getPromotionLog() {
  return [..._log];
}

/**
 * Clear state between tests.
 */
export function resetShim() {
  _handlers.length = 0;
  _log.length = 0;
  _bespokeCalled = false;
}

/**
 * Mark that a bespoke (non-host-event) notification path was used.
 * Called by any code that tries to bypass proposePromotion().
 * test-promotion.js asserts this was NEVER called.
 */
export function markBespokeUsed(reason) {
  _bespokeCalled = true;
  console.error(`[host-event-shim] BESPOKE PATH DETECTED: ${reason}`);
}

/**
 * Assert no bespoke path was used (test-promotion assertion d).
 * @returns {boolean}
 */
export function wasBespokeUsed() {
  return _bespokeCalled;
}

/**
 * Get count of fired events (for test assertions).
 */
export function getEventCount() {
  return _log.length;
}
