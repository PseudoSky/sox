# Backlog — `@adhd/sox-embedding-provider`

Package-local backlog. Items cross-reference the root [`/BACKLOG.md`](../../../../BACKLOG.md) BL-IDs.
This is a public data-layer package (the text→vector layer of the RAG substrate).

---

### BL-155 — CRITICAL: `import.meta.url` in `libs/data/embed/embedding-provider/src/fastembed.ts` breaks under CJS bundling — **HIGH — RESOLVED (2026-07-04)**

`libs/data/embed/embedding-provider/src/fastembed.ts` computes `const __dirname = dirname(fileURLToPath(import.meta.url))` to locate the
sibling `libs/data/embed/embedding-provider/src/embedWorker.ts` (bundled to `dist/embedWorker.js`). When this package is inlined into an **esbuild CJS bundle** (as it is inside
the memory-server extension), esbuild replaces `import.meta` with `{}`, so `import.meta.url` is
`undefined` and `fileURLToPath(undefined)` **throws at module init** — which crash-looped the live
memory-server launchd daemon. Passed CI because vitest loads this package's own tsc dist (real ESM,
`import.meta.url` defined), never the esbuild CJS bundle.

Fixed at the bundler (`tools/bundle-extension.cjs` now shims `import.meta.url` for CJS output). **Guidance
for this package:** any worker/asset path resolution in code that may be consumed inside a CJS bundle
must be bundler-safe — prefer a `__dirname`-based or explicitly-injected path over
`fileURLToPath(import.meta.url)` at module scope. Root: BL-155.

---

### BL-238 — HIGH: `onnxruntime-node` native V8 crash when 2+ ONNX worker threads run inference concurrently in one process — **RESOLVED (2026-07-09)**

Two independent, empirically-proven native hazards, both fixed:

1. **Cross-isolate hazard (whole-process fatal).** 2+ *separate* `worker_threads.Worker` instances,
   each holding an active onnxruntime-node `InferenceSession`, running inference concurrently, crash
   the ENTIRE process with `FATAL ERROR: HandleScope::HandleScope Entering the V8 API without proper
   locking in place` (inside `InferenceSessionWrap::Run`). Reproduced even with TWO workers on the
   exact SAME onnxruntime-node version — not an ABI/version-mismatch bug, a genuine thread-safety
   limitation whenever 2+ instances are concurrently active in one process.
2. **Same-thread native timing hazard (`std::bad_alloc`), independent of (1).** Even with fastembed's
   `init` and a `@huggingface/transformers` `init` STRICTLY serialized in JS (proven via instrumented
   tracing — zero JS-level overlap), loading onnxruntime-node@1.21.0 (fastembed) immediately after
   onnxruntime-node@1.24.3 (transformers) in the same worker thread still deterministically threw
   `std::bad_alloc`. This hazard is below what JS-level scheduling/serialization can observe or
   prevent.

**Fix (two-part, matching each hazard):**
- `sharedOnnxWorker.ts` — a process-wide singleton `worker_threads.Worker` (`embedWorker.ts`) hosts
  ONLY cross-encoder rerank + NLI verify (both `@huggingface/transformers`, onnxruntime-node@1.24.3 —
  proven safe to share one worker even under real concurrency). `@adhd/sox-hybrid-search`'s
  `CrossEncoderWorker` and `@adhd/sox-claim-verification`'s `WorkerProxy` route through
  `getSharedOnnxWorker()` instead of constructing their own `Worker`.
- `sharedFastembedProcess.ts` — a process-wide singleton child **process**
  (`fastembedProcessHost.ts`, forked via `node:child_process.fork()`) hosts fastembed
  (onnxruntime-node@1.21.0) in permanent OS-process isolation from `embedWorker.ts` — never a
  `worker_threads.Worker`, never sharing a thread or address space. `FastembedProvider` routes
  through `getSharedFastembedProcess()` instead of constructing its own `Worker`.

There is never a second onnxruntime-bearing WORKER THREAD alive in the process, and fastembed never
shares a thread (or process) with the shared worker at all — both hazard classes are structurally
impossible, not merely statistically less likely.

**Proof (real ONNX inference, zero mocks):** `sharedFastembedProcess.spec.ts` (2 concurrent fastembed
providers via the shared child process), `sharedOnnxWorker.spec.ts` (concurrent rerank+verify via the
shared worker), `@adhd/sox-hybrid-search`'s `cross-encoder.spec.ts` (embed + rerank concurrently),
`@adhd/sox-claim-verification`'s `bl238-concurrent-onnx.integration.test.ts` (embed + verify, AND
embed + rerank + verify ALL THREE concurrently — the exact composition that crashed pre-fix). Root:
BL-238, BL-171 (root `/BACKLOG.md`).

---

_This package is functional and consumed live by `memory-core` (embed hot path), `hybrid-search`, and
`claim-verification`._
