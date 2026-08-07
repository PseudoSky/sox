---
"@adhd/sox-install-engine": minor
---

Additive: mcp-trust-sync, object-array-merge capability, and lockfile/ownership extensions.

New module `mcp-trust-sync.d.ts` (`syncMcpTrustToProjects`, `reverseMcpTrustFromProjects`, types
`TrustSyncResult`, `SyncTrustOptions`) re-exported from `index.d.ts`. New capability module
`capabilities/object-array-merge.d.ts` (entirely new file). `install.d.ts` gains `SCOPES: Scope[]`,
`` writeLockfileAtomic(lockPath, lockfile): void ``, and `InstallDescriptor` gains four new optional
fields (`configValues?`, `configEntries?`, `configIdentityField?`, `configIdentityValue?`);
`DeclarativeInstallResult` gains optional `hints?: string[]`. `ledger.d.ts`'s `CapabilityId` union
widened with `'object-array-merge'` (same union-widening treatment as `sox-host-registry`, ruled
minor — verified no in-repo exhaustive switch breaks) and `LedgerAction` gains optional `meta?:
Record<string, unknown>`. `ownership.d.ts`'s `OwnedEntry` discriminated union gains two new tagged
variants (`kind: 'object-array-values'`, `kind: 'os-unit'`) — additive, same reasoning — plus two new
methods on the ownership index class (`static dedupeEntries`, `compact()`), both new, nothing
removed. No removed or narrowed export found — minor.
