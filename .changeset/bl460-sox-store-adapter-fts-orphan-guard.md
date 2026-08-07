---
"@adhd/sox-store-adapter": minor
---

Additive FTS-index tooling (BL-461).

New exports in `fts-dialect.d.ts`: `` canonicalFtsIndexName(table): string `` and ``
resolveExistingFtsIndexName(adapter, table): Promise<string | null> ``. New module
`fts-orphan-guard.d.ts` (types `OrphanedFtsIndex`, `FtsOrphanRepair`, `FtsOrphanGuardResult`;
functions `findOrphanedFtsIndexes`, `nextShadowIndexName`, `guardSucceeded`,
`guardOrphanedFtsIndexes`, `describeFtsOrphanGuard`), re-exported from `index.d.ts` via `` export *
from './fts-orphan-guard.js' ``. No removed or narrowed export in any of the three changed files —
minor.
