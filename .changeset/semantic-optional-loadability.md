---
"@adhd/sox-semantic": patch
---

Make the native chain optional: `@adhd/sox-vector-store` and `@adhd/sox-embedding-provider` become `optionalDependencies`, resolved only on the default capability-probe path.

`createSemanticBackend` used to reach both packages through **static** value imports, so every consumer loaded `sqlite-vec` / `better-sqlite3` / `lancedb` and the `onnxruntime` / `fastembed` graph at module load — even a caller that injected its own provider and vector backend. Both are now reached through lazy, non-literal dynamic imports taken only when nothing was injected; their types stay type-only imports (erased at emit).

- The DI-injected path (`embeddingProvider` + `vectorBackend`) resolves **neither** specifier. Loading the module with both injected can no longer throw `ERR_MODULE_NOT_FOUND` for either package.
- A genuinely absent optional package on a default path returns the typed `not_installed` failure — `createSemanticBackend` still never throws for a configurable failure. `provider_failed` / `unsupported_adapter` / `vector_store_failed` are unchanged.
- `semanticSearchNodes` also loads `@adhd/sox-hybrid-search` lazily. That is required, not incidental: hybrid-search's entrypoint re-exports `cross-encoder.js`, which statically imports `@adhd/sox-embedding-provider`, so a static hybrid-search import resolved the optional package on **every** path and defeated the invariant above. hybrid-search stays a mandatory dependency; it is simply no longer resolved until a search runs.
- The specifiers are held in variables rather than written as literals, so no bundler can statically hoist them back into an eager import.

New regression guard `src/optional-loadability.spec.ts` loads the **built artifact** in a child process behind an ESM resolve hook (`module.register()`) that throws on either specifier, runs the injected path under it, and asserts neither was requested. It also asserts the manifest keeps both optional. Verified red against the pre-change build and green after.

Residual (follow-up, not fixed here): `@adhd/sox-hybrid-search` — a mandatory dependency of this package — still declares both packages as mandatory `dependencies`, so a default install of `@adhd/sox-semantic` still pulls the native chain transitively. Closing that needs the same treatment inside hybrid-search.
