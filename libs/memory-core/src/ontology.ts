import { ConstraintError, type TypePolicy } from '@adhd/sox-graph-store';

/** Byte-identical to graph-store's DEFAULT_NODE_KINDS (index.ts:257) — memory's six kinds. */
export const MEMORY_NODE_KINDS = ['episode', 'entity', 'claim', 'community', 'session', 'generic'] as const;

/** Byte-identical to graph-store's DEFAULT_EDGE_RELS (index.ts:538-549) — memory's ten rels. */
export const MEMORY_EDGE_RELS = [
  'MENTIONS', 'SUPPORTS', 'RELATES_TO', 'SUPERSEDES', 'DERIVED_FROM',
  'MEMBER_OF', 'PART_OF', 'SAME_AS', 'ASSIGNED_TO', 'DEPENDS_ON',
] as const;

export interface OntologyExtension {
  kinds?: string[];
  rels?: string[];
}

/**
 * memory-core's own TypePolicy (ADR-0010 D2). Constructed once per process by
 * graph-backend.ts's composition point — never instantiated ad hoc at a call site.
 * Accepts an optional extension set so a consumer can register additional kinds/rels
 * (BL-441's "registration surface") without forking the base vocabulary.
 */
export class MemoryOntologyPolicy implements TypePolicy {
  private readonly kinds: Set<string>;
  private readonly rels: Set<string>;

  constructor(extension?: OntologyExtension) {
    this.kinds = new Set([...MEMORY_NODE_KINDS, ...(extension?.kinds ?? [])]);
    this.rels = new Set([...MEMORY_EDGE_RELS, ...(extension?.rels ?? [])]);
  }

  validateKind(kind: string): void {
    if (!this.kinds.has(kind)) {
      throw new ConstraintError(
        `Unknown node kind "${kind}". Allowed kinds: ${[...this.kinds].join(', ')}.`,
      );
    }
  }

  validateRel(rel: string): void {
    if (!this.rels.has(rel)) {
      throw new ConstraintError(
        `Unknown edge rel "${rel}". Allowed rels: ${[...this.rels].join(', ')}.`,
      );
    }
  }
}

/**
 * Rewrites a raw SQLite CHECK-constraint failure on kind/rel into an operator-facing
 * message naming the migration that removes the CHECK on this store (BL-442/PKT-61).
 * Pure string inspection — no adapter, no DDL, no schema read. Call this in the catch
 * block of any write path that can hit graph-store's writeNode/writeEdgeInternal, so a
 * kind/rel the POLICY permits but a not-yet-migrated store's CHECK still forbids produces
 * a comprehensible error instead of a raw "CHECK constraint failed: kind" string.
 *
 * NOTE (BL-442 not yet landed): until PKT-61 ships the migration command, the message
 * below names the *future* command as not-yet-available. Update the wording once BL-442
 * lands (tracked so this doesn't ship a dangling pointer to a nonexistent command).
 */
export function translateStoreVocabularyError(err: unknown): never {
  if (err instanceof Error && /CHECK constraint failed/.test(err.message)) {
    throw new ConstraintError(
      `${err.message} — this store still enforces the closed kind/rel vocabulary. ` +
      `A policy-permitted kind or rel was rejected by the store's schema; run the ` +
      `open-schema migration (BL-442) on this store to lift the CHECK, or use one of ` +
      `today's built-in kinds/rels in the meantime.`,
    );
  }
  throw err;
}
