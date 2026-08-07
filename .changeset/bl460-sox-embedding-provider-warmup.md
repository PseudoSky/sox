---
"@adhd/sox-embedding-provider": major
---

Breaking: `warmupTimeoutMs` gained a required, non-optional parameter.

```
-export declare function warmupTimeoutMs(): number;
+export declare function warmupTimeoutMs(cacheHit: boolean): number;
```

Any consumer calling `warmupTimeoutMs()` with zero arguments — the only legal call under the
published `0.1.0` signature — now fails to compile. This is a required-parameter addition to an
existing exported function, not an additive change: the old call site is a type error under the new
`dist/index.d.ts`, so major is correct regardless of how trivial the call-site fix is (BL-376).

Also additive in this release (does not affect the bump, recorded for changelog completeness):
new exports `isPidAlive`, `checkAndClaimFastembedLock` (`fastembedProcessHost.d.ts`), `isModelCached`
(`index.d.ts`), a new `fastembedLock.d.ts` module exporting `FastembedLockInfo` and
`resolveFastembedLockPath` (BL-471), a new optional `EmbeddingProviderMetadata.execution_provider?:
string` field, a new `SharedFastembedProcessClient`-accepting constructor overload, and
telemetry-carrying JSDoc on `request()`/`terminate()` (BL-432/BL-405, comment-only).
