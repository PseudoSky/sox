/**
 * libs/install-engine/src/cascade.ts — Cascade-merge resolver
 *
 * Ported from scripts/cascade.ts. Zero changes to logic — byte-identical behaviour.
 * [inv:fix-carry-forward]: session fixes do not affect cascade.ts (pure function, unchanged).
 *
 * Contract (Section 4.2):
 *   Signature: cascade(scopes: ScopeConfig[]) → ResolvedConfigMap
 *   where scopes is ordered widest→narrowest [org, user, project, local]
 *
 *   Merge rules (CRITICAL — do NOT change without updating tests):
 *     - primitives REPLACE (narrower wins)
 *     - objects DEEP-MERGE (narrower keys win on conflict)
 *     - ARRAYS REPLACE ENTIRELY — NOT concat. Per migration.md Section 4.2:
 *       "project install list is authoritative; no concatenation across scopes"
 *     - narrowest scope wins for version
 *     - enabled = narrowest scope that specifies it; enabled:false at a narrower scope
 *       force-suppresses a wider true
 *
 *   Side effects: none — pure function.
 *   Source: multi-scope-install-config-cascade.md §4,§7
 */

export interface ScopeConfig {
  extends?: string;
  strict_capabilities?: boolean;
  providers?: Record<string, { base_url?: string; api_key?: string }>;
  install?: Array<{
    id: string;
    version?: string;
    enabled?: boolean;
    source?: string;
  }>;
  config?: Record<string, Record<string, unknown>>;
  enabled?: Record<string, boolean>;
  private?: boolean;
}

export interface ResolvedConfigEntry {
  version: string | undefined;
  enabled: boolean;
  config: Record<string, unknown>;
}

export type ResolvedConfigMap = Record<string, ResolvedConfigEntry>;

/**
 * Deep-merge two plain objects. Primitives and arrays at a key are REPLACED
 * by the override value (not merged/concatenated). Only plain objects are
 * recursively merged.
 *
 * NOTE: Arrays replace entirely — NOT concat. This is intentional per
 * migration.md Section 4.2: "arrays replace entirely (not concat)".
 */
export function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const baseVal = result[key];
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      baseVal !== null &&
      typeof baseVal === 'object' &&
      !Array.isArray(baseVal)
    ) {
      // Both are plain objects → recurse
      result[key] = deepMerge(
        baseVal as Record<string, unknown>,
        value as Record<string, unknown>,
      );
    } else {
      // Primitive, array, or null → REPLACE (arrays replace, not concat)
      result[key] = value;
    }
  }
  return result;
}

/**
 * cascade — Merge scoped configs into a flat resolved map.
 *
 * @param scopes — Ordered widest→narrowest [org, user, project, local].
 *                 Each element is a parsed extensions.json (org baseline
 *                 must already be fetched and pre-pended by install.ts).
 * @returns Flat { id → { version, enabled, config } } map.
 */
export function cascade(scopes: ScopeConfig[]): ResolvedConfigMap {
  const result: ResolvedConfigMap = {};

  // Process scopes from widest (index 0) to narrowest (last index).
  // Narrowest wins for all conflicts.
  for (const scope of scopes) {
    // ── Process install[] entries ───────────────────────────────────────────
    if (scope.install) {
      for (const entry of scope.install) {
        const existing = result[entry.id];
        if (existing) {
          if (entry.version !== undefined) {
            existing.version = entry.version;
          }
          if (entry.enabled !== undefined) {
            existing.enabled = entry.enabled;
          }
        } else {
          result[entry.id] = {
            version: entry.version,
            enabled: entry.enabled ?? true,
            config: {},
          };
        }
      }
    }

    // ── Process config{} entries ───────────────────────────────────────────
    if (scope.config) {
      for (const [id, extConfig] of Object.entries(scope.config)) {
        const entry = result[id];
        if (!entry) {
          result[id] = { version: undefined, enabled: true, config: extConfig };
        } else {
          entry.config = deepMerge(entry.config, extConfig);
        }
      }
    }

    // ── Process enabled{} overrides ─────────────────────────────────────────
    if (scope.enabled) {
      for (const [id, enabledVal] of Object.entries(scope.enabled)) {
        const entry = result[id];
        if (!entry) {
          result[id] = { version: undefined, enabled: enabledVal, config: {} };
        } else {
          entry.enabled = enabledVal;
        }
      }
    }
  }

  return result;
}
