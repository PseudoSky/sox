---
"@adhd/sox-host-registry": minor
---

Additive: new opencode host surface.

New `opencodeHost` export from a new `opencode.d.ts` module. New `McpConfig` interface (`keyPath`,
`value` methods) re-exported as a type. `Surface` interface gains two optional fields
(`mcpConfig?: McpConfig`, `postInstallHint?: string`). `CapabilityId` union widened with
`'object-array-merge'` — treated as additive/minor per the standard ecosystem convention for
widening a string-literal union that consumers write data into rather than exhaustively switch over;
verified no in-repo exhaustive switch over `CapabilityId` breaks. `claude.d.ts`/`codex.d.ts`/
`internal.d.ts` carry only `sox`→`soxe` comment rebrands plus documentation of the
mcp-trust-sync behavior shipped elsewhere. No removed or narrowed export.
