# Changelog

---

## [Unreleased] — memory-server remote MCP transport: OpenCode connectivity, notification hang, stale port defaults

Four independent, previously-undiscovered bugs surfaced while diagnosing "why is the memory
server not working" for both Claude Code and OpenCode against the live `memory-server` remote
(`type: "remote"`, port 3099) deployment. All four are fixed, tested (unit + live end-to-end
against the real `opencode` CLI), and deployed to the running `com.sox.user.memory-server`
launchd unit.

### `service-proxy` shim: OpenCode's remote MCP client never performs the classic SSE handshake

**Root cause (proven by capturing OpenCode's real traffic):** OpenCode's `type: "remote"` MCP
client does not implement the classic two-step HTTP+SSE transport (`GET /sse` → parse an
`endpoint` event → `POST /messages?sessionId=...`) at all. It POSTs JSON-RPC directly to
whatever URL the host config gives it — in our case literally `http://localhost:3099/sse` — with
`Accept: application/json, text/event-stream`, and reads the JSON-RPC response straight from the
POST body. That is StreamableHTTP semantics, applied to whatever path string was configured; the
URL's path (`/sse` vs `/mcp`) is opaque to it. The shim's `/sse` route only accepted `GET`, so
every OpenCode request landed on the catch-all `405` handler and every connection attempt failed
silently ("server unavailable", logged continuously in `~/.local/share/opencode/log/opencode.log`
across many independent debugging sessions before this fix).

**Fix:** `libs/service-proxy/src/shim.ts` now serves `POST /sse` identically to `POST /mcp`
(both routed through one shared `handleStreamableHttpPost` / `handleHttpRpc`), so every host
config we generate (`/mcp` for the http profile, `/sse` for the sse profile) works against
OpenCode's actual client behavior without requiring it to implement the classic transport.
Verified against the real `opencode` CLI (`opencode mcp list`) both in a scratch project and in
the live `sox-ecosystem` project — `memory-server ✓ connected` — not just a unit test.

### `service-proxy` shim: a bad fix regressed the classic SSE transport for spec-compliant clients

A same-day, separately-authored, uncommitted edit to `shim.ts`'s `/messages` handler had removed
the `sseRes.write(...)` response delivery and replaced it with returning the JSON-RPC response
only in the POST body. That breaks every spec-compliant HTTP+SSE client — verified by reading the
official `@modelcontextprotocol/sdk`'s `SSEClientTransport.send()` (`client/sse.js`), which
explicitly does `await response.body?.cancel()` on the POST response ("POST responses don't have
content we need") and reads the result exclusively from the SSE stream's `onmessage`. The classic
`/messages` endpoint now dual-writes the response to both the SSE stream (for spec-compliant
clients) and the POST body (for clients that read it synchronously) — satisfying both without
regressing either.

### `service-proxy` shim: an HTTP JSON-RPC *notification* hung the connection forever

**Root cause:** `dial.ts`'s `send()` only registers a promise in its `pending`-by-id map when
`request.id !== undefined` (`writeToBackend`). A JSON-RPC notification (no `id` — e.g.
`notifications/initialized`, which every conformant MCP client sends immediately after
`initialize`) written via `send()` therefore never resolves the caller's promise. The stdio
transport path already special-cased this correctly (`if (req.id === undefined) { backend.notify(req); return; }`)
but neither the `/mcp` (StreamableHTTP) nor the `/messages` (classic SSE) HTTP handlers did — both
called `backend.send()` unconditionally on any method they didn't special-case, so the very first
notification after `initialize` hung the HTTP response forever. This affected the `/mcp` endpoint
too, independent of the OpenCode-specific routing bug above — any conformant HTTP/StreamableHTTP
client (Codex, Claude Code's http profile) sending `notifications/initialized` would have hit it.
Proven red→green: `libs/service-proxy/src/shim.spec.ts` — with the guard disabled, both new
notification tests time out (1.5s race against the real request); restored, both return `202` in
single-digit milliseconds.

**Fix:** all three HTTP-facing paths (`/mcp`, `/sse`, `/messages`) now go through one shared
`handleHttpRpc()` that checks `isNotification()` first and calls `backend.notify()`
(fire-and-forget, `202` immediately) — mirroring the stdio path exactly.

### `host-registry`: Claude Code's generated `.mcp.json` pointed at the wrong port

`libs/host-registry/src/claude.ts`'s `mcp-server` surface had no `mcpConfig` builder (unlike
`opencode.ts`, which already had one). `install-engine`'s generic fallback (`libs/install-engine/src/install.ts`,
"Default: Claude-format auto-derivation") therefore generated remote URLs against a hardcoded
`port ?? 3000` default — stale since the 2026-07-04 proxy-mode hardening (BL-155/156/157) moved
the real deployment to port 3099 (`SOX_CONFIG_PORT=3099`, documented in
`extensions/bundles/sox-memory-bundle/members/memory-server/CLAUDE.md`). The extension's own
config schema (`extension.json`'s `http_port`, `x-sox-default: 3000`) had drifted the same way and
was never updated to match. Every regenerated `.mcp.json` for Claude Code silently pointed at a
port nothing was listening on.

**Fix:** `claude.ts` now owns an explicit `mcpConfig` (mirroring `codex.ts`'s pattern, default
port 3099), and `extension.json`'s `http_port` schema default is corrected to 3099. New
`host-registry.spec.ts` coverage pins both the stdio command shape and the corrected remote-URL
defaults for both `http`/`sse` profiles.

### `tools/bundle-extension.cjs`: hardcoded pnpm virtual-store path broke clean-room builds

`ESBUILD_PATH` was a literal `node_modules/.pnpm/node_modules/esbuild` — a flat path that only
exists under some pnpm virtual-store hoisting layouts. A fresh `pnpm install` (clean-room reinstall,
or any isolated worktree) lays esbuild out at the real versioned path
(`node_modules/.pnpm/esbuild@<version>/node_modules/esbuild`) instead, so every extension build
failed immediately with `MODULE_NOT_FOUND` outside whatever machine state happened to produce the
flat layout. Fixed with `require.resolve('esbuild', { paths: [REPO_ROOT] })` — the portable way to
resolve a package from an explicit root, independent of virtual-store layout.

### Operational note: `service-proxy` has two independent deployment surfaces

Discovered while deploying this fix: the running shim (`soxe serve`, i.e. `dist/apps/sox/main.js`)
resolves `@adhd/sox-service-proxy` **externally** via the `node_modules` workspace symlink →
`libs/service-proxy/dist` — it is not bundled into `apps/sox`'s esbuild output. `memory-server`'s
own extension bundle, by contrast, **does** inline `service-proxy`'s source directly (it is not in
that build's `--external` list). Redeploying only `extensions/bundles/sox-memory-bundle/members/memory-server/dist`
after a `service-proxy` fix therefore does nothing for the live HTTP-facing shim — `libs/service-proxy/dist`
itself must also be rebuilt/redeployed, and the `soxe serve` process (the OS-unit) restarted.
Both surfaces were out of sync with the fix until this was caught by a live `curl` reproduction of
the notification-hang bug even after the first (memory-server-only) redeploy.

### `host-registry`/`install-engine`: `.mcp.json` used `"type": "remote"` — not a real Claude Code value

**A second, more fundamental bug in the fix above:** even with the port corrected, Claude Code
could still never have loaded the generated `.mcp.json` entry. `"type": "remote"` is not a value
Claude Code recognizes — confirmed against the official docs (code.claude.com/docs/en/mcp,
fetched live 2026-07-18). The only valid transport discriminators for a `url`-based entry are
`"http"` (Streamable HTTP, recommended) and `"sse"` (deprecated); `type` is **mandatory** — an
entry with a `url` but a missing or unrecognized `type` is silently treated as a broken stdio
server (which expects `command`, not `url`) and skipped, with no error surfaced to the user. This
was a pre-existing bug in `install-engine`'s "Claude-format auto-derivation" fallback (predates
this session), inherited verbatim into `claude.ts`'s new `mcpConfig` above.

**Fix:** both `libs/host-registry/src/claude.ts` and the fallback in
`libs/install-engine/src/install.ts` now emit `type: profile` directly (`profile` is already
exactly `'sse'` or `'http'`) instead of the invented `'remote'`. `.mcp.json` corrected to
`{"type": "http", "url": "http://localhost:3099/mcp"}`. New `host-registry.spec.ts` coverage
pins the corrected type values and asserts `'remote'` is never emitted. (OpenCode's own
`opencode.ts` legitimately uses `type: "remote"` — that is OpenCode's real schema value,
confirmed by capturing its actual traffic; this bug was Claude-specific.)

### `~/.claude.json`: new sessions had no memory-server tools even with a correct `.mcp.json`

Separately from the above: Claude Code gates every `.mcp.json` remote server behind a per-project
trust list (`~/.claude.json` → `projects["<root>"].enabledMcpjsonServers`), approved via an
interactive prompt on first use. `soxe install` has never written to this list — by design
(`claude.ts`'s original docblock: "soxe never auto-writes a trust flag"), matching Claude's own
P0.5-verified behavior of no blanket `enableAllProjectMcpServers` flag. But a *specific, named*
trust entry for the exact extension the user just ran `soxe install <id> --host=claude` for is a
much narrower action than a blanket trust-everything flag, and its absence means any context that
can't answer an interactive prompt (a background job, a fresh headless session) silently gets zero
MCP tools with no visible error — exactly what happened here. See the trust auto-management fix
below.

---

## [Unreleased] — graph-store kind:'generic' reuse contract; hybrid-search filter/vector-channel correctness

`@adhd/sox-graph-store` and `@adhd/sox-hybrid-search` fixes closing out the four blockers the
adhd agent-mcp-authoring integration audit filed as BL-293/294/295/303. Both packages remain
at their current published versions (`graph-store@0.2.0`, `hybrid-search@0.1.0`) pending a
version bump — not yet published.

### `@adhd/sox-graph-store` — `kind:'generic'` is now actually reachable through the public API (BL-295)

```ts
import { createGraphBackend } from '@adhd/sox-graph-store';

// Non-memory reuse (e.g. a component registry): write kind:'generic' and carry
// your own sub-kind in tags/metadata. The node.kind CHECK constraint is a fixed
// enum and is NEVER extended per consumer — this is the sanctioned escape hatch.
const graph = createGraphBackend(db);

const id = graph.writeNode('A reusable Button component', {
  kind: 'generic',
  name: 'Button',
  tags: ['component'],
  metadata: { subKind: 'component' },
});
graph.getNode(id)!.kind;            // 'generic'
graph.queryNodes({ kind: 'generic' }); // [...]
```

`NodeMeta.kind` / `NodeRecord.kind` / `NodeFilter.kind` are now first-class. Previously `kind`
was hardcoded to `'episode'` on every `writeNode()` call regardless of what a caller passed — so
a caller could never even write `kind:'generic'`, despite that value already sitting in the
`node.kind` CHECK constraint's enum. The fix threads `meta.kind` (default `'episode'`) into the
INSERT, validated against the fixed `DEFAULT_NODE_KINDS` enum
(`episode`/`entity`/`claim`/`community`/`session`/`generic`) — an out-of-enum kind throws
`ConstraintError` rather than a raw SQLite CHECK failure. **The CHECK constraint itself is never
extended per consumer** — this is sox-ecosystem's own Option A resolution for BL-295, chosen over
adding an extensible constructor-level kind allowlist (an earlier implementation attempt at the
allowlist approach was built, then reverted, per that decision). `NodeFilter` also gained
`kind`/`projectPath`/`agentId`, closing a gap where those columns (indexed already) were
unfilterable through the public read API.

### `@adhd/sox-hybrid-search` — vector channel now honors query filters (BL-294)

**Fix (namespace/tenant leak):** a `namespace`/`kind`/`topic`/`project_path`/`agent_id` filter
passed to `SqliteSearchBackend.search()` previously constrained only the FTS5 text channel — the
vector (kNN) channel ran completely unfiltered. A namespace-scoped hybrid or vec-only query could
therefore return another namespace's nodes fused into the results (proven with a red→green test:
two nodes with identical vectors in different namespaces, `filters: { namespace: 'tenant-b' }`
leaked `tenant-a`'s node on unfixed code). The vector channel now resolves the same `NodeFilter`
through `graph.queryNodes()` and constrains `vec.knn()` to the matching id set; a filter matching
zero nodes now correctly yields zero vector candidates instead of falling back to an unfiltered
`knn()` call (an empty `VecFilter.ids` array means "no filter" to the vector backend, not "match
nothing", so this required an explicit skip-the-call path, not just passing `{ ids: [] }`).

**New: degrade signal.** `SearchBackend.search()` results (and the top-level `search()`
function's `SearchResult[]`) gained an additive `degraded?: { unsupportedFilters: string[] }`
field, set whenever a caller's `filters` included a key with no mapping onto `NodeFilter`.
Surfaced unconditionally — not gated behind `explain: true`, since "was my filter actually
applied" is a correctness question, not a diagnostic one.

`buildFilterClause()`'s `project_path`/`agent_id` filter keys now route to
`NodeFilter.projectPath`/`NodeFilter.agentId` (previously silently dropped into an `extraClauses`
value that `SqliteSearchBackend` never actually applied to either search channel).

### Fixes (backlog evidence corrections — no code change)

- **BL-293** — `createGraphBackend(db)` already applies schema automatically
  (`SqliteGraphBackend`'s constructor calls `applySchema()`, which is idempotent). Confirmed via
  a fresh in-memory store round-trip and a live check against the **built** `dist/index.js`,
  invoked from a `cwd` outside the package with a real file-backed SQLite store — ruling out any
  `import.meta.url`/migrations-folder resolution issue. The constructor already carried the fix
  as of the 2026-07-11 Drizzle migration port (commit `9c63d40`, same day the blocker was filed
  against a pre-port line reference); this entry only corrects the stale backlog evidence.
- **BL-303** — `drizzle-orm` is not a dead dependency: `libs/data/graph/graph-store/src/index.ts`
  imports `drizzle`/`migrate` from it and runs it in every `applySchema()` call. The 2026-07-11
  Drizzle migration port (commit `9c63d40`) wired it up rather than removing it, closing the
  underlying finding by the opposite resolution than originally proposed. No code change
  required; this entry only corrects the stale backlog evidence.

## [1.2.0] — 2026-07-11 — asp-gateway install surface, build integrity, and embedding-provider audit

This release is where `soxe` grew the install capabilities the asp-gateway bundle needs to deploy on a fresh machine, the build substrate was standardized against off-the-shelf tools with the contract published, and the embedding-provider package's documentation was reconciled with reality through a component-spec audit.

### asp-gateway install capabilities

`soxe install` and `soxe uninstall` now support the four behaviours the asp-gateway bundle needs: hook surfaces with object-array-merge semantics, lockfile-less file-drop uninstall, service start after install, and bundle-level uninstall that recursively removes every member.

```bash
# Install a service extension and start it in one command
soxe install asp-gateway --start --scope=user

# Uninstall a bundle — recursively removes every member
soxe uninstall asp-gateway

# Hook surfaces use object-array-merge for settings.json
# (identity-scoped append/remove, not raw array overwrite)
soxe install components.hook --scope=user
```

**Hook surface + object-array-merge** — `'object-array-merge'` capability added to the host-registry capability set; `libs/install-engine/src/capabilities/object-array-merge.ts` provides identity-scoped append/remove with `OwnedEntry` kind `'object-array-values'`, tracked in the ownership ledger with `entryKey`/`supersededEntries` for fully reversible uninstall. The `claude` surface builder emits settings.json entries through this merge, not a raw overwrite. The `hook-script` secondary file-drop is wired in `declarativeInstall`.

**Lockfile-less uninstall** — `soxe uninstall` no longer hard-exits when no lockfile exists; instead it treats `null` as empty and falls through to the file-drop teardown, so a file-drop-only installation (no lockfile) can be completely reversed.

**Service start after install** — `soxe install` accepts `--start`; after a `type:service` install, it calls `enableOsUnit` with `load: true` and records os-unit ownership in the index for reversible uninstall.

**Bundle-level uninstall** — `soxe uninstall <bundle-id>` resolves the bundle's member ids from the registry, then recurses per member via a shared `uninstallOne()` helper.

### Build substrate standardized

The build substrate was audited per owner directive and migrated to standard tools where they proved equal-or-better, retaining the bespoke esbuild driver only where a swap would regress a safety invariant.

```bash
# The old hand-rolled exports verifier is gone — publint + attw handle it
npx publint --strict
npx attw --pack

# Cache inputs are now standard "production" + "^production"
# (editing memory-core now correctly invalidates memory-server's build cache)
npx nx build memory-server
```

`tools/verify-package-exports.mjs` deleted, replaced by `publint` (red→green proven a strict superset on broken fixtures) + `@arethetypeswrong/cli` (a types-resolution check the old script never had — the BL-208/BL-222 blind spot). Both wired into the smoke preflight.

Hand-maintained cross-package cache `inputs` on all five bundle targets replaced by standard `["production","^production"]` — this exposed and fixed a latent bug where editing `memory-core` did not invalidate `memory-server`'s build cache (verified 11/11 cache hits against changed source → now a cache miss), the cache-level root of the "always rebuild the chain" workaround.

`@nx/esbuild:esbuild` migration evaluated with a live spike on tokenguard, **not adopted**: no post-metafile sidecar-discovery hook exists (a swap re-creates the BL-262 per-consumer-list failure mode), and its default `deleteOutputPath:true` reproduces the BL-235 artifact destruction. Full rationale + revisit triggers documented.

Reusable invariant harness at `tools/test-bl266-bundle-invariants.mjs`. All five invariants verified post-merge: whole-repo build/lint/test/typecheck 32 projects green, smoke 13/0 isolation OK, registry checksum-stable across no-op rebuilds, live memory-server healthy on the new artifact.

### Extension build/bundling contract documented

`docs/standards/extension-bundling.md` is now the single source of truth for what a bundle is, how sidecars are declared/discovered/verified, the externals policy for native addons, atomic staging semantics (BL-235), registry checksum interplay, and the tests-bypass-artifact trap (BL-248/BL-262: vitest runs source; only the shipped bundle proves shipping).

Cross-linked from `AGENTS.md` and referenced in every build-target `CONTRIBUTING.md`. Test of done met: the doc names exactly the gap `3916afd`'s author fell into.

### Memory episode hard-delete

```bash
# Permanently drop specific episodes by UID
memory_curate({op: "drop-episodes", uids: ["<uid>", ...]})
```

`memory_curate` gains `op: "drop-episodes"` — hard-deletes nodes and cascades `vec_node`/`edge` rows in a single transaction. No tombstone, no bi-temporal invalidation: the episode and all its vector index entries are gone atomically.

### Root typecheck gate now green

The `sox-ecosystem:typecheck` script (`tsc --noEmit`) had **24 pre-existing errors** — never gated because the whole-repo gate was `build,lint,test` only. All 24 cleared in commit `334f266` without weakening any tsconfig flag (no `as any`/`!`/`@ts-expect-error`). The tautological routing-drift gate it uncovered (the generator clobbered its own baseline) was also fixed. `npx nx run-many -t build,lint,test,typecheck` goes green for the first time.

### Embedding-provider audit fixes

**`warmupTimeoutMs()` unified** — duplicate definitions in `index.ts` (default 180s) and `fastembed.ts` (default 60s) consolidated to a single exported function in `index.ts` with default `180_000`. Worker-init is no longer bounded by a shorter copy.

**`ModelCache`/`FileSystemModelCache` deprecated** — both carry `@deprecated SOX-BUG-002` JSDoc blocks explaining the real `cacheDir` resolution order; reachable only via the deprecated re-export.

**False "deterministic hash provider" claim removed** — `sox.concerns` no longer advertises a hash/deterministic provider; `createEmbeddingProvider` still switches only on `'fastembed'`/`'remote'` and throws `ResolutionError` for anything else.

**"Asymmetric role encoding" claim corrected** — `sox.concerns` now reads "EmbedRole param accepted for interface compatibility — currently ignored (not yet applied) by the fastembed provider". Code matches: `_role?` prefix and `void opts?.role` confirm the param is documented-accepted but silently unapplied.

**`FastEmbedPoolConfig.batchSizes` JSDoc default fixed** — documented as `256` (`DEFAULT_BATCH_SIZE`), was incorrectly `32`. Also documented that `FastEmbedPoolConfig` is not currently consumed by any factory.

**Stale "warmUp cache" claim removed** — `sox.invariants` now states `warmUp()` is a no-op when `isDeterministic === false` (always true today). No "cache for hot/topic texts" language remains.

**Summariser description corrected** — `sox.concerns` now reads "extractive summary (lead-N sentences — first summaryMaxSentences sentences, no scoring; zero LLM)" — was "sentence-scoring," which belongs to `extractTags`.

### Audit criteria wired

**`memory-refactor` audit states completed** — all five audit-state acceptance criteria (`[audit-*.N]`) wired to real, falsifiable checks in `audit_memrefactor.py`. Gap count dropped 39→9. Red→green proven on 5 sample checks; live write-path probes return blocked-red without an opt-in disposable DB (never a vacuous pass).

### Phantom-package audit resolved

**BL-304 — all 5 packages previously flagged "dead/phantom" verified as actively consumed.** Architect audit confirmed: `@adhd/sox-analysis` (imported by memory-core cluster/neardup/importance), `@adhd/sox-vector-store` (imported by hybrid-search), `@adhd/sox-blob-store` (agent-source `file:` dep, BL-166), `@adhd/sox-claim-verification` (agent-source `file:` dep, BL-166), `@adhd/sox-hybrid-search` (agent-source `file:` dep, BL-166), `@adhd/sox-graph-store` (8 memory-core modules call `createGraphBackend`). `drizzle-orm` in graph-store genuinely dead → BL-303 (already separately tracked and removed). No packages deleted. No code changes.
