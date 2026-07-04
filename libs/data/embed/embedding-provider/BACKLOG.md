# Backlog — `@adhd/sox-embedding-provider`

Package-local backlog. Items cross-reference the root [`/BACKLOG.md`](../../../../BACKLOG.md) BL-IDs.
This is a public data-layer package (the text→vector layer of the RAG substrate).

---

### BL-155 — CRITICAL: `import.meta.url` in `fastembed.ts` breaks under CJS bundling — **HIGH — RESOLVED (2026-07-04)**

`fastembed.ts` computes `const __dirname = dirname(fileURLToPath(import.meta.url))` to locate the
sibling `embedWorker.js`. When this package is inlined into an **esbuild CJS bundle** (as it is inside
the memory-server extension), esbuild replaces `import.meta` with `{}`, so `import.meta.url` is
`undefined` and `fileURLToPath(undefined)` **throws at module init** — which crash-looped the live
memory-server launchd daemon. Passed CI because vitest loads this package's own tsc dist (real ESM,
`import.meta.url` defined), never the esbuild CJS bundle.

Fixed at the bundler (`tools/bundle-extension.cjs` now shims `import.meta.url` for CJS output). **Guidance
for this package:** any worker/asset path resolution in code that may be consumed inside a CJS bundle
must be bundler-safe — prefer a `__dirname`-based or explicitly-injected path over
`fileURLToPath(import.meta.url)` at module scope. Root: BL-155.

---

_No open items. This package is functional and consumed live by `memory-core` (embed hot path) and
`hybrid-search`._
