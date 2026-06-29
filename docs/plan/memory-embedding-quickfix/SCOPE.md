# SCOPE — Memory embedding quickfix (front-loaded)

**Status:** proposed · **Date:** 2026-06-26 · **Owner gate:** apply to live user-scope install
**Relationship:** front-loaded subset of `docs/plan/memory-refactor/SCOPE.md`. This doc fixes the
*running* system NOW; the refactor doc handles the durable decomposition. Do the quickfix first.

## Goal (one sentence)
Make the live **user-scope** `memory-server` produce and query **real** embeddings
(`bge-base-en-v1.5`), not the degenerate hash fallback — for new writes AND existing records — and
make any future embedding failure **loud**, not silent.

## Background — why embeddings are off (verified this session)
- **BL-87 (packaging):** the published `memory-server` declares only `better-sqlite3` + `sqlite-vec`
  as deps; `fastembed`/`onnxruntime-node` live in `memory-core` (a *devDependency*, inlined as JS) and
  are **not** externalized in the esbuild bundle. So an `npm-package:`-mode install (incl. the BL-65
  repointed `~/.adhd/sox-cli` server) has **no embedding runtime → permanent hash fallback**.
- **BL-89 (worker):** even where the deps exist (dev box), `onnxruntime-node` loads and the BGE model
  is cached, yet the worker-thread warmup hangs/fails and `embed()` (`auto`) **silently** swallows it
  into hash (`embed.ts:271-285`).
- **BL-86 (hash quality):** the hash fallback is degenerate (~0.97–0.998 cosine between unrelated text)
  — *out of scope here* (we want real on), but it's why "degraded" = "broken," and why re-embedding the
  fallback-era records matters.

## In scope
1. **Declare + ship the embedding runtime.** Add `fastembed` (→ `onnxruntime-node`) as real
   `dependencies` of the published `memory-server` (and `memory-daemon`, which runs batch enrichment /
   clustering that also embeds), and **externalize** them in the esbuild bundle (same treatment as
   `better-sqlite3`/`sqlite-vec`). Verify the native prebuild matrix covers the live Node (22/24).
2. **Fail loud, not silent.** Surface the worker warmup error + add a warmup timeout + a health signal;
   `memory_ping`/`memory_stats` already expose `embed_on_hash_fallback` — make the *cause* diagnosable.
   Root-cause the BL-89 dev-box warmup hang enough to get real embeddings to engage.
3. **Re-embed script.** A script that, on the current `~/.memory/memory.db`, re-embeds every node whose
   stored model ≠ the active real model (uses `reembedNodes()` / the reindex op), updating `vec_node`,
   with a **DB backup first** and a dry-run mode.

## Acceptance / measurement (the bar — must be demonstrated)
- **User-scope, real model on writes+queries:** after the fix + a memory-server reconnect, on the
  user-scope install: `memory_ping` → `embed_on_hash_fallback:false` and `embed_model:"bge-base-en-v1.5"`;
  a **new** `memory_write` then a semantic `memory_recall` returns the relevant result ranked by real
  vectors; sanity: cosine of two unrelated strings is ~0 (NOT ~0.99).
- **Re-embed runs on the current system:** the script, run against (a backup of) `~/.memory/memory.db`,
  converts hash-era records to the real model (vectors change, `embed_model` updated), verified by a
  post-run cosine-sanity spot check on previously-degenerate pairs.
- **Loud failure:** with the real backend forced unavailable, startup/ping clearly reports the failure
  (no silent hash downgrade) — opt-in hash only via explicit config.

## Out of scope (→ the refactor plan)
The `embedding-provider`/`vector-store` package decomposition, model-switching/resolution config, the
deterministic-provider (BL-86) rewrite, per-record provenance (BL-88) schema change, and the area/group
reorg. The quickfix may add a *minimal* per-record model tag only if needed to make re-embed targeting
correct; otherwise it targets by scope `embed_model`.

## Constraints / risks
- **BL-65:** the live server runs from `~/.adhd/sox-cli` (npm install), and the dev `dist` must not be
  built into the live path — build in a worktree, then upgrade/reinstall the user-scope install.
- **Live data safety:** back up `~/.memory/memory.db` before re-embedding; script must be idempotent +
  dry-runnable; never delete, only update vec rows.
- **Native/Node:** onnxruntime-node prebuild availability for the live Node version is the main external
  dependency (cf. the better-sqlite3 engines decision).
- **Reconnect:** the user may need to reload/reconnect the MCP client to pick up the fixed server.

## Open decisions
- Is `fastembed` added to `memory-server`+`memory-daemon` directly, or do we ship a thin embedding
  runtime package now (a down-payment on the refactor's `embedding-provider`)? Quickfix default: declare
  directly on the two members; the refactor extracts the package.
- Default backend policy: flip default to `real`-required (fail loud) now, or keep `auto` but make the
  fallback loud? Quickfix default: keep `auto`, make fallback loud + reported; the refactor makes `real`
  the enforced default.

## Incident log — 2026-06-27: pnpm native binding miss (BL-TBD)

**Symptom:** Session-wide `better-sqlite3` failure — `Could not locate the bindings file` for
`node-v137-darwin-arm64`. All `memory_write` and `memory_recall` calls failing for both the primary
session and subagent sessions.

**Root cause:** The MCP server runs the extension from the dev checkout via
`~/.adhd/sox-cli/bin/soxe serve memory-server` → resolves the bundle at
`extensions/bundles/sox-memory-bundle/members/memory-server/dist/index.js`. That bundle externalizes
`better-sqlite3`, so Node resolves it from the pnpm virtual store at
`.pnpm/better-sqlite3@12.10.0/node_modules/better-sqlite3/`. That package had **never been compiled**
— no `build/` dir — because pnpm does not run `node-gyp` automatically when the content-addressed store
is populated. The user-scope ext installs at `~/.adhd/sox-ecosystem/ext/*/node_modules/` have their own
working binaries (npm `postinstall` runs there) but sit on a different resolution path.

**Fix applied (2026-06-27):**
```
cd /Users/nix/dev/ai/sox-ecosystem/node_modules/.pnpm/better-sqlite3@12.10.0/node_modules/better-sqlite3
npx node-gyp rebuild
```
Binding now present for ABI 137 (Node 24.11.1). `sqlite-vec` was unaffected (already resolved).
`memory_ping` confirms `ok: true`, `embed_on_hash_fallback: false` post-reconnect.

**Permanent fix needed (→ refactor or post-install):** A fresh `pnpm install` on a new Node version
silently breaks the MCP server. Add a root-level `postinstall` script (or an nx `setup` target) that
rebuilds native deps in the pnpm store after install:
```json
"scripts": { "postinstall": "node-gyp-build" }
```
or drive it via `pnpm rebuild better-sqlite3 sqlite-vec` from an explicit nx target. Track as BL-TBD.
