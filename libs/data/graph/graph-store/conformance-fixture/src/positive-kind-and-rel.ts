/**
 * PKT-62 / BL-443 — AC-1, AC-2, AC-3 positive arm.
 *
 * Runs against the INSTALLED `@adhd/sox-graph-store` tarball, resolved only through
 * `node_modules` (bare specifiers, never a relative `./index.js` import) — the entire point of
 * this fixture per SPEC-PKT-62.md §1. Imports `createGraphBackend`, `DEFAULT_TYPE_POLICY`, and the
 * `TypePolicy`/`EdgeRel` types from `@adhd/sox-graph-store`, and `SqliteAdapterImpl` from
 * `@adhd/sox-store-adapter` — both real npm tarballs installed by the orchestrator
 * (tools/graph-store-tarball-conformance.mjs), never workspace symlinks.
 *
 * Mirrors the naming convention already established in-repo by
 * open-kind-check.bl439.spec.ts / open-rel-check.bl448.spec.ts: novel kind `'component'`, novel
 * rel `'COMPONENT_REL'`, a permissive local TypePolicy that defers everything else to
 * DEFAULT_TYPE_POLICY (SPEC-PKT-62.md §2 item 4).
 *
 * Emits one NDJSON line per assertion group to stdout: {"check":"<name>","ok":true|false}.
 * Exits non-zero if anything throws unexpectedly.
 */
import { createGraphBackend, DEFAULT_TYPE_POLICY } from '@adhd/sox-graph-store';
import type { TypePolicy, EdgeRel } from '@adhd/sox-graph-store';
import { SqliteAdapterImpl } from '@adhd/sox-store-adapter';

type CheckResult = { check: string; ok: boolean; detail?: string };

let anyFailed = false;

function emit(result: CheckResult): void {
  if (!result.ok) anyFailed = true;
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const permissiveTestPolicy: TypePolicy = {
  validateKind(kind: string): void {
    if (kind === 'component') return;
    DEFAULT_TYPE_POLICY.validateKind(kind);
  },
  validateRel(rel: string): void {
    if (rel === 'COMPONENT_REL') return;
    DEFAULT_TYPE_POLICY.validateRel(rel);
  },
};

function planStrings(plan: { rows: Array<Record<string, unknown>> }): string[] {
  return plan.rows.flatMap((row) =>
    Object.values(row).filter((v): v is string => typeof v === 'string'),
  );
}

async function main(): Promise<void> {
  const adapter = new SqliteAdapterImpl(':memory:');
  const backend = createGraphBackend(adapter, { typePolicy: permissiveTestPolicy });
  await backend.applySchema();

  // ── AC-1 (BL-443) — novel kind write/read round-trip ──────────────────────
  try {
    const id = await backend.writeNode('novel kind node', { kind: 'component' });
    const node = await backend.getNode(id);
    const ok = node !== null && node.kind === 'component';
    emit({ check: 'kind-write-read', ok, detail: ok ? undefined : JSON.stringify(node) });
  } catch (err) {
    emit({ check: 'kind-write-read', ok: false, detail: String(err) });
  }

  // ── AC-3 (BL-443) — EXPLAIN QUERY PLAN resolves the novel kind via ix_node_kind, zero json_each ──
  try {
    for (let i = 0; i < 5; i++) {
      await backend.writeNode(`component content ${i}`, { kind: 'component' });
    }
    const plan = await adapter.executeAll<Record<string, unknown>>(
      `EXPLAIN QUERY PLAN SELECT * FROM node WHERE kind = 'component'`,
    );
    const strings = planStrings(plan);
    const usesIndex = strings.some((s) => s.includes('ix_node_kind'));
    const noJsonEach = strings.every((s) => !s.toLowerCase().includes('json_each'));
    const ok = usesIndex && noJsonEach;
    emit({
      check: 'kind-explain-plan',
      ok,
      detail: ok ? undefined : `usesIndex=${usesIndex} noJsonEach=${noJsonEach} plan=${JSON.stringify(plan.rows)}`,
    });
  } catch (err) {
    emit({ check: 'kind-explain-plan', ok: false, detail: String(err) });
  }

  // ── AC-2 (BL-443) — novel rel write/read round-trip via getEdges + getNeighbors ────
  let relSrc: number | undefined;
  let relDst: number | undefined;
  try {
    const a = await backend.writeNode('node a', { kind: 'episode' });
    const b = await backend.writeNode('node b', { kind: 'episode' });
    relSrc = a;
    relDst = b;
    await backend.writeEdge(a, b, 'COMPONENT_REL' as EdgeRel);

    const edges = await backend.getEdges({ rel: 'COMPONENT_REL' as EdgeRel });
    const edgeOk =
      edges.length === 1 &&
      edges[0]!.rel === 'COMPONENT_REL' &&
      edges[0]!.src === a &&
      edges[0]!.dst === b;
    emit({ check: 'rel-write-read', ok: edgeOk, detail: edgeOk ? undefined : JSON.stringify(edges) });

    const neighbors = await backend.getNeighbors(a, { rel: 'COMPONENT_REL' as EdgeRel });
    const neighborOk = neighbors.length === 1 && neighbors[0]!.id === b;
    emit({
      check: 'rel-getNeighbors',
      ok: neighborOk,
      detail: neighborOk ? undefined : JSON.stringify(neighbors.map((n) => n.id)),
    });
  } catch (err) {
    emit({ check: 'rel-write-read', ok: false, detail: String(err) });
    emit({ check: 'rel-getNeighbors', ok: false, detail: String(err) });
  }

  // ── AC-2 (BL-443), edge-side EXPLAIN QUERY PLAN — ix_edge_src / ix_edge_unique ─────
  try {
    if (relSrc === undefined) throw new Error('rel-write-read did not produce a src node id');
    const plan = await adapter.executeAll<Record<string, unknown>>(
      `EXPLAIN QUERY PLAN SELECT * FROM edge WHERE t_invalid IS NULL AND src = ${relSrc} AND rel = 'COMPONENT_REL'`,
    );
    const strings = planStrings(plan);
    const ok = strings.some((s) => s.includes('ix_edge_src') || s.includes('ix_edge_unique'));
    emit({ check: 'rel-explain-plan', ok, detail: ok ? undefined : JSON.stringify(plan.rows) });
  } catch (err) {
    emit({ check: 'rel-explain-plan', ok: false, detail: String(err) });
  }

  await adapter.close();

  if (anyFailed) process.exitCode = 1;
}

main().catch((err) => {
  emit({ check: 'fixture-fatal', ok: false, detail: String(err && err.stack ? err.stack : err) });
  process.exitCode = 1;
});
