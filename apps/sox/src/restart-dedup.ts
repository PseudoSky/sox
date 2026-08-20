/**
 * apps/sox/src/restart-dedup.ts — dedupe the rolling-restart worklist by the
 * ACTUAL restart target (BUG-SOX-UPGRADE-RESTARTS-SAME-SERVICE-REPEATEDLY-001).
 *
 * Extracted from apps/sox/src/main.ts's `cmdUpgrade` so the grouping algorithm
 * can be imported and unit-tested in isolation (main.ts has a module-top-level
 * `void main()` side effect — see verify-artifact.ts's header comment on
 * BL-404/BL-568 — so importing main.ts anywhere, including from a test, runs
 * the whole CLI). This module is pure and has no such side effect.
 *
 * `soxe upgrade --all` enumerates the rolling-restart worklist once per
 * consumer ROW (extId × scope × root) in the install registry — but multiple
 * rows commonly resolve to the SAME underlying managed process: a proxy-mode
 * mcp-server's singleton key is `(id, canonical-store-resource)`
 * ([inv:singleton], service-lifecycle spec §5.1/§9.5 — keyed on
 * store-resource, "never on scope"), independent of which scope/root row
 * happened to enumerate it, and a running service's live pid is likewise a
 * single physical process no matter how many install-registry rows point at
 * it. Restarting per-row bounces that one process once per row — measured:
 * `soxe upgrade --all` restarted memory-server FIVE separate times in a
 * single pass, each a real SIGTERM to a live MCP server — and can unload an
 * os-unit that a later, non-owning row has no ownership entry to re-enable,
 * stranding the process unsupervised (the same defect's second symptom).
 *
 * `dedupeRestartRows` groups rows by a caller-supplied resolved identity and
 * restarts each distinct target exactly once, preferring as the group's
 * representative a row that owns the target's os-unit (so the re-enable step
 * in `rollingRestartConsumer` has an ownership entry to restore) when any row
 * in the group does.
 */

/** The minimal shape of a rolling-restart worklist row. */
export interface RestartRow {
  extId: string;
  scope: string;
  root: string;
}

/** What a row actually targets, as resolved by the (impure) caller. */
export interface RestartIdentity {
  /**
   * Stable string identifying the ACTUAL process/backend/unit this row
   * targets. Two rows with the same identity restart the same real thing and
   * MUST be grouped — restarting one, not both/all.
   */
  identity: string;
  /**
   * True iff this row's (extId, scope) owns an os-unit — used to prefer a
   * representative whose re-enable step has something to restore, rather
   * than one that will report `owned:false` after the shared unit was
   * unloaded by someone else's restart.
   */
  ownsOsUnit: boolean;
}

/** One distinct restart target: every row that shares it, and which one to physically restart. */
export interface RestartGroup<Row extends RestartRow = RestartRow> {
  identity: string;
  /** Every row that shares this identity, in original encounter order. */
  rows: Row[];
  /**
   * The single row chosen to perform the ACTUAL restart. Prefers the first
   * row in the group whose `ownsOsUnit` is true; falls back to the
   * first-encountered row when no row in the group owns an os-unit.
   */
  representative: Row;
  /** Whether `representative` owns an os-unit (mirrors the preference above). */
  representativeOwnsOsUnit: boolean;
}

/**
 * Group `rows` by `resolveIdentity(row).identity`, preserving first-seen
 * group order and within-group row order. `resolveIdentity` is invoked
 * exactly once per row (never re-invoked for bookkeeping), so it is safe for
 * it to be impure/expensive (e.g. reading a lockfile or ownership index).
 */
export function dedupeRestartRows<Row extends RestartRow>(
  rows: readonly Row[],
  resolveIdentity: (row: Row) => RestartIdentity,
): Array<RestartGroup<Row>> {
  interface Building<R extends RestartRow> {
    identity: string;
    rows: R[];
    representative: R;
    representativeOwnsOsUnit: boolean;
  }
  const groups = new Map<string, Building<Row>>();
  const order: string[] = [];

  for (const row of rows) {
    const resolved = resolveIdentity(row);
    let g = groups.get(resolved.identity);
    if (!g) {
      g = {
        identity: resolved.identity,
        rows: [],
        representative: row,
        representativeOwnsOsUnit: resolved.ownsOsUnit,
      };
      groups.set(resolved.identity, g);
      order.push(resolved.identity);
    }
    g.rows.push(row);
    if (resolved.ownsOsUnit && !g.representativeOwnsOsUnit) {
      g.representative = row;
      g.representativeOwnsOsUnit = true;
    }
  }

  return order.map((id) => {
    const g = groups.get(id)!;
    return {
      identity: g.identity,
      rows: g.rows,
      representative: g.representative,
      representativeOwnsOsUnit: g.representativeOwnsOsUnit,
    };
  });
}
