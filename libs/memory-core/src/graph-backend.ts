import { createGraphBackend, type GraphBackend } from '@adhd/sox-graph-store';
import type { StoreAdapter } from '@adhd/sox-store-adapter';
import { MemoryOntologyPolicy, MEMORY_NODE_KINDS, MEMORY_EDGE_RELS, type OntologyExtension } from './ontology.js';

let registeredExtension: OntologyExtension = {};

/**
 * Registration surface (BL-441): an in-process consumer sharing this store (per
 * ADR-0006, DI for live objects — never a new module boundary) can extend the base
 * vocabulary before any backend is constructed. Last-registration-wins is deliberate:
 * this is a process-wide policy, not a per-call override, so there is exactly one
 * vocabulary in force for the life of the process — call this once, at startup, before
 * the first getMemoryGraphBackend() call. Calling it after backends already exist does
 * NOT retroactively change them (each SqliteGraphBackend captures its TypePolicy at
 * construction, graph-store/src/index.ts:888-890) — it only affects backends
 * constructed after the call.
 */
export function registerOntologyExtension(extension: OntologyExtension): void {
  registeredExtension = {
    kinds: [...(registeredExtension.kinds ?? []), ...(extension.kinds ?? [])],
    rels: [...(registeredExtension.rels ?? []), ...(extension.rels ?? [])],
  };
}

/** Read-only snapshot for observability (memory_stats — see index.ts change below). */
export function getOntologySnapshot(): { kinds: string[]; rels: string[] } {
  // Rebuild the union directly from the same source constants + registered extension
  // MemoryOntologyPolicy is constructed from, so the snapshot and the policy can never
  // drift relative to each other (MEMORY_NODE_KINDS/MEMORY_EDGE_RELS are the single
  // source of truth — never re-type the six/ten strings a second time here).
  return {
    kinds: [...new Set([...MEMORY_NODE_KINDS, ...(registeredExtension.kinds ?? [])])],
    rels: [...new Set([...MEMORY_EDGE_RELS, ...(registeredExtension.rels ?? [])])],
  };
}

/**
 * memory-core's ONE composition point for graph-store backends. Every memory-core
 * module that needs a GraphBackend calls this — never createGraphBackend directly.
 * See ontology-seam.bl441.spec.ts for the structural test enforcing that invariant.
 */
export function getMemoryGraphBackend(adapter: StoreAdapter): GraphBackend {
  return createGraphBackend(adapter, { typePolicy: new MemoryOntologyPolicy(registeredExtension) });
}
