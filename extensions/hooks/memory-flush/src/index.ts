// Hook: Memory Session Flush
// On SessionEnd: persists working memory, enqueues episodes, nudges memoryd.
// Also binds ScopePromotionProposed to run the promotion approval/policy step.
// Binds to lifecycle events and executes deterministically (no LLM calls).

export interface HookContext {
  event: string;
  timestamp: string;
  payload?: unknown;
}

/**
 * Hook handler — fires on SessionEnd and ScopePromotionProposed events.
 * order: 100. Deterministic: no LLM calls, no provider dependency.
 *
 * SessionEnd: persists working memory, enqueues episodes, nudges memoryd.
 * ScopePromotionProposed: runs the promotion approval/policy step (P4).
 */
export function handler(_ctx: HookContext): void {
  // Stub — behavior implemented in Phase 2 (SessionEnd) and Phase 4 (ScopePromotionProposed).
}

// P0 contract (design.md §1.1c): export the bound events as a string array.
export const events = ["SessionEnd", "ScopePromotionProposed"];
