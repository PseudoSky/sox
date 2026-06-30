# Architecture Audit — sox-ecosystem

**Date:** 2026-06-08
**Auditor:** architect-reviewer
**Method:** Independent code inspection; all findings cite file and line. Files read: 41. Patterns evaluated: 28. Risks identified: 19. Recommendations: 12.

---

## Executive Summary

The repository is a multi-kind LLM-extension ecosystem (agents, skills, mcp-servers, prompts, hooks, commands, bundles) built inside a pnpm monorepo. The developer-tooling side — manifest schema, validator, install client, cascade engine, scaffolder, registry index builder, CI gates, and changeset release pipeline — is structurally sound and well-tested (256 passing tests at time of review).

The consumer-facing and runtime sides have a single catastrophic structural gap: **no host runtime exists**. Every installed extension ends at a lockfile entry. Nothing loads the entry, spawns the process, registers tools into an agent surface, or fires lifecycle events. The gap is acknowledged internally (supervisor-shim.js, host-event-shim.js are labelled "TEST SCAFFOLDING"), but it is not bounded: there is no host runtime roadmap, no interface contract, and no owner named for the missing piece. This means the system cannot deliver its Layer 0 promise to either consumer class — operators or agents — under any current or planned configuration.

A secondary structural finding is that the build pipeline is fractured: nine extension manifests declare `entrypoint: "dist/index.js"` but no per-package `dist/` directory exists under any of those packages. The root-level compiler output lands in `dist/extensions/...` (wrong path) and four critical memory-bundle extensions have neither path populated.

These two findings together mean the end-to-end chain from "user wants it" to "agent can call it" is broken at two points before any tool is ever reached.

---

## Section 1 — End-to-End Chain Trace

The framing asks: trace one extension from "a user wants it" to "it runs and the agent can call it." I trace `memory-server`, the primary MCP server in the memory subsystem.

**Step 1 — Discover.** `registry/index.json` contains a `memory-server` entry with a description, keywords, and a `file://` source path. The `soxe details memory-server` command reads this file and prints it. Discovery is present-and-working for local lookups. There is no search verb: `bin/sox` line 612 stubs `'search'` as "not yet implemented (coming in a later phase)."

**Step 2 — Install.** `soxe install -s project` spawns `npx tsx scripts/install.ts --scope=project` (bin/soxe line 265). The install client reads `.extensions/extensions.json`, sees `{ id: "sox-memory-bundle", version: "^0.1.0" }`, expands the bundle to four members, fetches each from `file://...` paths, checksums them, and writes `.extensions/extensions.lock`. This works. The lockfile at `.extensions/extensions.lock` confirms the run produced one entry (`memory-server@0.1.0`).

**BREAK — Step 3 — Activation.** Nothing reads the lockfile after it is written and launches any process. There is no host loader. `scripts/install.ts` returns a `ResolvedSet` to its caller but has no callee that acts on it at runtime. `tools/supervisor-shim.js` provides a shim that can spawn `dist/memoryd.js`, but it is explicitly labelled "TEST SCAFFOLDING, not a product workaround" (supervisor-shim.js line 9). It is never invoked by `soxe install` or any CI step. The `lifecycle.background:true` flag on the `memory-server` manifest (`extensions/mcp-servers/memory-server/extension.json` line 15) documents a host contract that has no implementor.

**BREAK — Step 4 — Build.** Even if a host loader existed and tried to execute `dist/index.js` relative to the package root at `extensions/mcp-servers/memory-server/dist/index.js`, that file does not exist. The package declares `"scripts": { "build": "tsc" }` (memory-server/package.json line 8) but no per-package `tsconfig.json` exists under that directory. The root `tsconfig.json` compiles everything into `dist/` at the repo root (outDir: "dist", tsconfig.base.json line 26), producing `dist/extensions/mcp-servers/memory-server/src/index.js` — a structurally different path from what `entrypoint: "dist/index.js"` resolves to at install time. CI runs `pnpm typecheck` (tsc --noEmit) but never `pnpm -r build`.

**BREAK — Step 5 — MCP registration.** Because the process cannot be started, the `tools/list` and `tools/call` JSON-RPC surface never becomes available to any agent. The agent cannot receive or invoke `memory_write`, `memory_recall`, or any other tool. The full agent-side half of Layer 0 is absent.

**Chain verdict:** Holds through Step 2 (install + lockfile). Breaks at Step 3 (no host runtime), Step 4 (no runnable entrypoint), and Step 5 (no MCP registration). Three consecutive breaks mean zero end-to-end delivery.

---

## Section 2 — Missing Developer / Maintainer Tooling

### Gap D1 — No build step in CI; per-package dist never produced (CRITICAL)

Nine extension manifests declare `entrypoint: "dist/index.js"`:

- `extensions/agents/echo-agent/extension.json` line 13
- `extensions/agents/memory-organizer/extension.json` line 11
- `extensions/commands/memory-cli/extension.json` line 11
- `extensions/commands/status-command/extension.json` line 14
- `extensions/hooks/audit-hook/extension.json` line 14
- `extensions/hooks/memory-flush/extension.json` line 11
- `extensions/mcp-servers/hello-server/extension.json` line 14
- `extensions/mcp-servers/memory-server/extension.json` line 11
- `extensions/skills/hello-world/extension.json` line 14

None of these packages have a `dist/` directory inside their own package directory. Confirmed by direct inspection: `ls extensions/mcp-servers/memory-server/dist` → `NO DIST DIR`; same for `memory-organizer`, `memory-flush`, `memory-cli`.

The CI validate workflow (`.github/workflows/validate.yml`) runs `pnpm typecheck` (tsc --noEmit) and `pnpm run test` but contains no `pnpm -r build` or equivalent step. The release workflow (`.github/workflows/release.yml`) runs `pnpm run build-index` (registry index, not extension builds) but no extension compilation.

The root `tsconfig.json` compiles into `outDir: "dist"` at the repo root (tsconfig.base.json line 26), landing output at `dist/extensions/mcp-servers/memory-server/src/index.js` — not at `extensions/mcp-servers/memory-server/dist/index.js`, which is where the entrypoint field resolves. This path mismatch means even `pnpm typecheck` passing gives no assurance of a runnable artifact.

Each package declares `"scripts": { "build": "tsc" }` (e.g., memory-server/package.json line 8) but has no local `tsconfig.json`, so `tsc` in that package directory would inherit the root config and emit to the wrong location.

**Consequence:** Any host that resolves the entrypoint path from the manifest gets a file-not-found error. This is not a theoretical gap — it makes every behavioral extension non-executable.

### Gap D2 — No linter or formatter (MEDIUM)

No ESLint, Biome, or Prettier configuration exists anywhere in the repo (confirmed by searching for `.eslintrc*`, `eslint.config*`, `.biome*`, `biome.json`, `.prettier*` — all absent). The CI validate workflow has no lint step. TypeScript strict mode is set (tsconfig.base.json), which catches some categories, but import ordering, code style, unused-variable patterns in JS files, and the hand-maintained `dist/*.js` files receive zero automated quality enforcement.

### Gap D3 — Hand-maintained dist/*.js files with no sync guard (MEDIUM)

`docs/cli-build-decision.md` documents a "Discipline B" decision: `dist/memory-lib.js`, `dist/memory-cli.js`, and `dist/memoryd.js` are hand-authored ESM mirrors of their TypeScript sources. These are 1,550-line files (e.g., `dist/memory-lib.js`) maintained manually. There is no CI check that the hand-maintained JS matches the TypeScript source, no diff-on-edit hook, and no automated sync mechanism. Drift is guaranteed as sources evolve.

Critically, `extensions/hooks/memory-flush/src/index.ts` line 262 dynamically imports `'../../../dist/memory-lib.js'` using a relative path that resolves to the repo-root `dist/memory-lib.js`. This creates a cross-package runtime dependency on a hand-maintained file that is not part of any npm package's `files` field and will not be present on a clean install from npm.

### Gap D4 — No eval harness for behavioral extension types (LOW)

The only evaluation coverage is a five-case golden-assertion fixture for `hello-world` skill (`extensions/skills/hello-world/eval/goldens.json`). The skill type exists as a Layer 0 consumer of agents; agent, prompt, and mcp-server types have no behavioral eval at all. VERIFICATION.md lines 214–228 documents the decision to defer Layer 3 (LLM-judge) and limit Layer 2 to the one fixture. Acceptable as a deferral, but the gap exists.

### Gap D5 — Schema $id URLs are placeholder values (LOW)

All three schemas use `"$id": "https://your-registry/schemas/..."` (`schemas/extension/v1.json` line 3, `schemas/extensions-config/v1.json` line 3, `schemas/lockfile/v1.json`). All 11 extension manifests use `"$schema": "https://your-registry/schemas/extension/v1.json"`. These are non-dereferenceable. Schema validation in `scripts/validate-manifests.ts` uses AJV with the local JSON directly (not by URL), so this does not break current validation, but it does mean: (a) third-party tooling that validates the `$schema` field cannot resolve it; (b) there is no served schema endpoint to point operators to.

---

## Section 3 — Missing Consumer Tooling

### Gap C1 — No host runtime (CRITICAL — the single most consequential finding)

The framing's Layer 1 maps "Activation (launch, supervise, register tools)" to "host runtime: loader → process supervisor (lifecycle) → MCP registrar." None of this exists as product code. What exists is:

- `tools/supervisor-shim.js` — 230-line test scaffolding that can spawn `dist/memoryd.js` and probe the Unix socket health endpoint. Explicitly "not a product workaround" (line 9). Not invoked by `soxe install`, not invoked by any CI step.
- `tools/host-event-shim.js` — 80-line test scaffolding that stubs the `proposePromotion` API. Same status.
- `scripts/hook-loader.ts` — A HookLoader class that can register and fire hooks in-process. This is framework code but has no integration point: no code loads installed extensions from the lockfile and calls `loader.register()` on them at host startup.

The lifecycle manifest block (`extensions/mcp-servers/memory-server/extension.json` lines 15–24) describes a complete supervision contract (`background: true`, `singleton: true`, health probe via Unix socket), but no host reads this block and acts on it.

**This is not a future-phase gap that is bounded and understood.** The framing's Layer 3 item 8 ("host loads + launches + supervises") is named "nominal owner: a host runtime loader/supervisor" but no such component exists, is under construction, or has a deliverable owner in the repository. The `lifecycle` field was designed, the schema was updated, the shim was written, and then the chain stopped. As of the current commit, installing an extension produces a lockfile and nothing else happens.

### Gap C2 — No MCP tool registration into an agent surface (CRITICAL)

Even assuming a host could spawn `dist/index.js`, the MCP server would be running but nothing would register its tools into an agent's context. The framing's Layer 3 item 9 ("tools registered into the agent's surface") has "nominal owner: a host MCP registrar" — absent. The JSON-RPC transport is correctly implemented in `memory-server/src/index.ts` (lines 324–366, readline over stdio), but the host side of MCP — the client that discovers and exposes tools — does not exist.

The `hello-server` demonstrates the same pattern: a correct MCP stdio server (`extensions/mcp-servers/hello-server/src/index.ts`) with no client counterpart. The agent has no mechanism to know these tools exist.

### Gap C3 — No search / catalog command (MEDIUM)

`soxe search` is stubbed as "not yet implemented" (bin/soxe line 612–613). The registry `index.json` has `description`, `keywords`, and `tags` fields that could power text search, but the operator has no way to discover extensions beyond reading the JSON directly or knowing the exact `id` to pass to `soxe details`.

### Gap C4 — The install client resolves to source files, not built artifacts (HIGH)

When the install client processes `file://` sources for a directory (install.ts lines 311–317), it checksums and records `src/index.ts` as the resolved source:

> "if (fs.existsSync(indexTs)) contentPath = indexTs" — install.ts line 314

The lockfile at `.extensions/extensions.lock` confirms this: `"source": "file:///...extensions/mcp-servers/memory-server/src/index.ts"`. The lockfile records a TypeScript source file as the artifact. If a host tried to `require()` or `import()` that path it would need `tsx` or a TypeScript runtime, which is a development dependency. A production host that uses the lockfile to load extensions gets a .ts file, not a .js file.

### Gap C5 — Uninstall does not clean up the lockfile (LOW)

`soxe uninstall` removes the extension entry from `extensions.json` (bin/soxe lines 316–326) but explicitly does not touch the lockfile: "Does NOT touch the lockfile (stale lock entries are harmless until next install run)." This is defensible for simple cases but becomes a problem if a host reads the lockfile directly to determine what to load (which a host would naturally do), because the uninstalled extension remains present in the lockfile until the next `install` run is executed.

### Gap C6 — No upgrade path (LOW)

`soxe update` is stubbed as "not yet implemented" (bin/soxe line 609). The install client supports an `--update` mode that re-fetches and re-pins, but it is not wired to any user-facing command.

---

## Section 4 — Architectural and Contractual Gaps

### Gap A1 — Hook event binding is not in the manifest schema (HIGH)

The extension schema (`schemas/extension/v1.json`) has an `order` field for hooks (line 86) but no `event` field declaring which lifecycle event the hook binds to. A hook extension declares which events it handles only inside its source code (`extensions/hooks/memory-flush/src/index.ts` line 20: `export const events = ['SessionEnd', 'ScopePromotionProposed']`).

Consequences: (a) A host cannot know which events a hook binds without loading and executing its code. (b) The manifest validator cannot check that a hook's declared event exists in the host's event vocabulary. (c) The registry index cannot expose event binding for operator discovery. (d) The schema's `allOf` enforcement for `order` (v1.json line 184) has no companion enforcement that the event field is valid. This is a schema design omission that the framing's taxonomy does not surface.

### Gap A2 — Hook chain abort-on-throw is a known defect with no fix timeline (MEDIUM)

`docs/engine-defects-found.md` documents DEFECT-1: `HookLoader.fire()` (hook-loader.ts lines 109–116) aborts the hook chain on the first throwing hook. Subsequent hooks are silently skipped. The defect is pinned in `scripts/hook-isolation.test.ts` with tests that assert the broken behavior, deliberately keeping the suite green. The recommended fix (`fireIsolated()`) is described but marked "out of scope for P7" with no phase assignment. A single buggy hook can suppress all downstream hooks for an event.

### Gap A3 — Bundle version conflict resolution is silent first-seen dedup (MEDIUM)

When two bundles list the same member extension with different version specs, `expandBundles()` (install.ts lines 709–794) uses first-seen semantics: the second occurrence is silently dropped. This is documented and pinned in `scripts/bundle-collision.test.ts` lines 120–163. The operator gets no warning that a version conflict was silently resolved. At scale (multiple organization-provided bundles), this creates invisible dependency shadowing.

### Gap A4 — Cross-package runtime dependency via relative path (HIGH)

`extensions/hooks/memory-flush/src/index.ts` line 262 contains:

```typescript
const { applyPromotion } = await import('../../../dist/memory-lib.js' as string);
```

This dynamically imports a file at a relative path that resolves to the repo root's `dist/memory-lib.js`. This file: (a) is hand-maintained, not compiled; (b) is not listed in any package's `files` field; (c) will not exist after an npm publish of `@adhd/sox-extension-memory-flush`. When the hook is loaded in production from npm, this import will throw `MODULE_NOT_FOUND`. This is a currently broken runtime dependency path.

### Gap A5 — memory-server health endpoint mismatch (MEDIUM)

The `memory-server` manifest specifies `lifecycle.health.type: "socket"` with `endpoint: "~/.memory/memoryd.sock"` (extension.json lines 18–22). The tilde is a shell expansion, not a Node.js path. `memoryd.ts` constructs its socket path using `path.join(process.env['HOME'] ?? '/tmp', '.memory', 'memoryd.sock')` (memoryd.ts line 30). A host that naively passes `"~/.memory/memoryd.sock"` to `net.createConnection()` will fail to connect. The shell expansion contract is undocumented and the supervisor shim (supervisor-shim.js) hardcodes the same `path.join(HOME, ...)` formula, but only because it is the one piece of scaffolding that reads the same env variable rather than the manifest field.

### Gap A6 — Embed model is a hash projection, not semantic (MEDIUM)

`extensions/mcp-servers/memory-server/src/embed.ts` implements `EMBED_MODEL = 'nomic-embed-text-v1.5-hash'` (line 20) using an FNV-1a hash projection (lines 38–68), not the actual nomic-embed-text model. The comment acknowledges this ("when fastembed/onnxruntime becomes available... swap the embedText() implementation") but the model name in `memory_scope` metadata is misleading: stored records will claim `embed_model = 'nomic-embed-text-v1.5-hash'` but the vectors are random hash projections with no semantic relationship to the nomic embedding space. Recall quality from vector search is undefined relative to the stated goal of "hybrid vec+BM25+temporal, <50ms."

### Gap A7 — No host version enforcement (LOW)

Every manifest declares `compatibility.host: ">=1.0.0 <2.0.0"`, but nothing reads or enforces this. The install client (`install.ts`) reads the manifest's `requires` block for capability checks but does not read `compatibility.host` and compare it to any running host version. The host has no version at all — there is no host. This field is data without a consumer.

### Gap A8 — Registry source URLs are absolute local paths (MEDIUM)

All entries in `registry/index.json` use `"source": "file:///Users/nix/dev/ai/sox-ecosystem/..."` with the developer's absolute filesystem path. This is machine-specific. Any operator on a different machine who clones the repo and runs `soxe install` will receive a source URL that does not exist on their filesystem. The `build-index.ts` logic does generate these paths from the local filesystem at build time (build-index.ts lines 112–128), which is correct behavior for local development, but the committed `registry/index.json` contains a hardcoded developer path. A published registry should contain CDN or npm URLs for all entries.

---

## Section 5 — Gaps the Framing Missed

### Gap F1 — Hook event binding vocabulary is undefined

The framing describes hooks as binding to lifecycle events but does not identify the absence of a canonical event vocabulary. There is no schema, enum, or registry of valid event names (`SessionEnd`, `PreToolUse`, `PostToolUse`, `ScopePromotionProposed`). The names exist only in source code and documentation prose. A third-party hook author has no machine-readable specification of what events are available.

### Gap F2 — Extension dependencies are declared but never resolved or enforced at install time

The manifest schema allows a `dependencies` array (v1.json line 87). The `memory-flush` hook declares `dependencies: [{ id: "memory-server", version: "^0.1.0" }]` (memory-flush/extension.json). The install client never reads this field. Installing `memory-flush` without `memory-server` produces no error. The framing describes this under "dependencies" between extensions but does not flag the absence of enforcement.

### Gap F3 — No config schema per extension

The `extensions-config/v1.json` schema allows `config: { [extensionId]: object }` with `additionalProperties: { type: "object" }`. There is no per-extension config schema — any JSON object is accepted. The `memory-server` config in `.extensions/extensions.json` specifies `db_engine`, `recall_ceiling_ms`, and `embed_model`, but no schema validates these keys or their types at install time. Misconfiguration is silent.

### Gap F4 — The framing omits the build/entrypoint alignment problem

The framing's Layer 3 item 4 says "runnable entrypoint artifact ⇐ source code — nominal owner: a build/packaging subsystem." The framing assumes this subsystem exists and is working. In fact the build subsystem is structurally broken (per Gap D1), and the framing's taxonomy does not flag the path mismatch between `entrypoint` in the manifest and the actual compiler output location.

### Gap F5 — No security for the MCP transport

The MCP server reads from stdin with no authentication, no request signing, and no rate limiting (memory-server/src/index.ts lines 351–366). In any deployment where the MCP server is accessible to multiple clients (e.g., a shared host), all clients have equal write access to the memory store via `memory_write`. The `db_path` parameter is caller-supplied and not sandboxed — a caller can supply any filesystem path as `db_path` and the server will create or open that SQLite file. This is a security design gap not surfaced by the framing's security architecture section.

---

## Section 6 — Present-But-Broken vs. Absent vs. Present-But-Untested

| Component | State | Evidence |
|---|---|---|
| Manifest schema | Present and working | 11 extensions validate, 256 tests pass |
| Manifest validator | Present and working | `validate-manifests.ts`, CI gate |
| Install client | Present and working (for local file sources) | `.extensions/extensions.lock` produced correctly |
| Cascade engine | Present and working | `cascade.test.ts` passes |
| Registry index builder | Present and working | `build-index.ts` runs, registry/index.json generated |
| Scaffolder | Present and working | `new-extension.ts`, scaffolder.test.ts passes |
| Changeset release pipeline | Present-but-untested in production | No live npm publish performed; VERIFICATION.md line 110 |
| soxe CLI (Tier-1 verbs) | Present and working | bin/soxe tested by cli-adapter.test.ts |
| soxe search | Absent | Stubbed, bin/soxe line 612 |
| soxe update / enable / disable | Absent | Stubbed, bin/soxe lines 609–615 |
| Per-package build (dist/) | Present-but-broken | Package build scripts exist, no per-package tsconfig, no build in CI |
| Hook loader (HookLoader class) | Present-but-broken | DEFECT-1 abort-on-throw; engine-defects-found.md |
| Host process supervisor | Absent (test scaffolding only) | supervisor-shim.js line 9 |
| Host event bus | Absent (test scaffolding only) | host-event-shim.js |
| Host MCP registrar | Absent | No component exists |
| memoryd daemon entrypoint | Present-but-broken | dist/memoryd.js exists; per-package dist/index.js does not |
| Semantic vector embedding | Present-but-broken | Hash projection, not actual nomic-embed model (embed.ts line 20) |
| Extension dependency resolution at install | Absent | install.ts never reads the dependencies field |
| Per-extension config schema validation | Absent | extensions-config schema accepts any object |
| Hook event binding in manifest | Absent | No `event` field in schema |

---

## Section 7 — Recommended Remediation Sequencing

Ordered by dependency and severity. Items 1–3 must be completed before any runtime delivery is possible. Items 4–6 close critical architectural holes. Items 7–12 are quality and completeness work.

**1. Fix the per-package build pipeline (blocks all runtime delivery)**
Add a per-package `tsconfig.json` to each extension package (or a workspace-level `tsconfig.packages.json` with `references`) that compiles `src/index.ts` to the package's own `dist/index.js`. Add `pnpm -r build` to the CI validate workflow after `pnpm typecheck`. Until this is done, no extension is executable.

**2. Define and implement a host runtime (blocks operator and agent activation)**
This is the largest single work item. Decide concretely: is the host runtime part of this repository, a separate repository, or an integration with an existing agent host (Claude Code, a custom LiteLLM proxy, etc.)? Write the interface contract. The lifecycle schema already describes the contract (`background`, `singleton`, health probe, `stop_timeout_ms`). The supervisor-shim.js provides a reference implementation that can be promoted to product code. Until there is a host that reads the lockfile, spawns extension processes, and wires MCP clients, the ecosystem produces configuration only.

**3. Add `event` field to the hook manifest schema**
Add a required `events` array to the extension schema for type `hook`, listing the lifecycle event names the hook binds. Add an enum of valid host event names. Update the manifest validator to enforce this. This enables a host to discover hook bindings without executing code, and enables operator tooling to surface which hooks fire on which events.

**4. Fix the cross-package runtime dependency in memory-flush**
Replace the dynamic `import('../../../dist/memory-lib.js')` in `extensions/hooks/memory-flush/src/index.ts` line 262 with a proper package dependency. Either publish `@adhd/sox-memory-lib` as an npm package or restructure the code to avoid the cross-package runtime import. As written, this hook is undeployable from npm.

**5. Implement extension dependency resolution at install**
Teach `install.ts` to read the `dependencies` field from each resolved extension's manifest and add those dependency extensions to the install queue if they are not already present. Dependency-missing installs should warn or error, not silently succeed.

**6. Fix the socket health endpoint path resolution**
Change `lifecycle.health.endpoint` from `"~/.memory/memoryd.sock"` to a documented convention (e.g., `${MEMORY_SOCKET_DIR}/memoryd.sock`) and define how a host resolves it. Or change the endpoint type to use a relative path convention. Document the resolution rule explicitly in the schema description.

**7. Add a build step to CI that produces per-package dist artifacts and validates entrypoint reachability**
After `pnpm -r build`, add a step that for each extension with an `entrypoint` field, verifies the resolved path exists. This catches path mismatches before release.

**8. Implement soxe search**
Implement full-text search over `registry/index.json` using keywords, tags, and description fields. This is the minimum viable discovery path for operators who do not know extension IDs in advance.

**9. Replace the hash-based embedding with a real embedding model**
The `embed.ts` implementation produces semantically meaningless vectors. The memory system's recall quality depends on embedding quality. Integrate a local embedding model (fastembed, onnxruntime with a real nomic-embed checkpoint) before the memory system is used in production.

**10. Add a per-extension config schema mechanism**
Allow extension manifests to declare a JSON Schema for their config block. Have the install client (or a separate lint step) validate the per-extension config against that schema. This prevents silent misconfiguration.

**11. Fix HookLoader.fire() to isolate hook failures**
Implement the `fireIsolated()` variant described in `docs/engine-defects-found.md` and use it for all lifecycle event dispatching. The current abort-on-throw behavior allows a single buggy hook to suppress all downstream hooks silently.

**12. Replace placeholder schema $id URLs**
Set `$id` in all three schemas to real, dereferenceable URLs. Serve the schemas at those URLs. Update all extension manifests to reference the real URLs. This unblocks third-party tooling that validates `$schema` by dereferencing it.

---

## Appendix — Files Read During Audit

41 files read. Key files:

- `/Users/nix/dev/ai/sox-ecosystem/package.json`
- `/Users/nix/dev/ai/sox-ecosystem/pnpm-workspace.yaml`
- `/Users/nix/dev/ai/sox-ecosystem/tsconfig.json`
- `/Users/nix/dev/ai/sox-ecosystem/tsconfig.base.json`
- `/Users/nix/dev/ai/sox-ecosystem/.github/workflows/validate.yml`
- `/Users/nix/dev/ai/sox-ecosystem/.github/workflows/release.yml`
- `/Users/nix/dev/ai/sox-ecosystem/schemas/extension/v1.json`
- `/Users/nix/dev/ai/sox-ecosystem/schemas/extensions-config/v1.json`
- `/Users/nix/dev/ai/sox-ecosystem/schemas/lockfile/v1.json`
- `/Users/nix/dev/ai/sox-ecosystem/registry/index.json`
- `/Users/nix/dev/ai/sox-ecosystem/.extensions/extensions.json`
- `/Users/nix/dev/ai/sox-ecosystem/.extensions/extensions.lock`
- `/Users/nix/dev/ai/sox-ecosystem/bin/sox`
- `/Users/nix/dev/ai/sox-ecosystem/scripts/install.ts`
- `/Users/nix/dev/ai/sox-ecosystem/scripts/cascade.ts`
- `/Users/nix/dev/ai/sox-ecosystem/scripts/build-index.ts`
- `/Users/nix/dev/ai/sox-ecosystem/scripts/validate-manifests.ts` (header)
- `/Users/nix/dev/ai/sox-ecosystem/scripts/hook-loader.ts`
- `/Users/nix/dev/ai/sox-ecosystem/scripts/provider-capabilities.ts`
- `/Users/nix/dev/ai/sox-ecosystem/scripts/new-extension.ts` (error, too large — skipped body)
- `/Users/nix/dev/ai/sox-ecosystem/scripts/v2-e2e.test.ts`
- `/Users/nix/dev/ai/sox-ecosystem/scripts/install.test.ts` (header)
- `/Users/nix/dev/ai/sox-ecosystem/scripts/bundle-collision.test.ts`
- `/Users/nix/dev/ai/sox-ecosystem/scripts/install-multiscope.test.ts` (header)
- `/Users/nix/dev/ai/sox-ecosystem/extensions/mcp-servers/memory-server/extension.json`
- `/Users/nix/dev/ai/sox-ecosystem/extensions/mcp-servers/memory-server/package.json`
- `/Users/nix/dev/ai/sox-ecosystem/extensions/mcp-servers/memory-server/src/index.ts`
- `/Users/nix/dev/ai/sox-ecosystem/extensions/mcp-servers/memory-server/src/db.ts`
- `/Users/nix/dev/ai/sox-ecosystem/extensions/mcp-servers/memory-server/src/embed.ts`
- `/Users/nix/dev/ai/sox-ecosystem/extensions/mcp-servers/memory-server/src/schema.ts` (header)
- `/Users/nix/dev/ai/sox-ecosystem/extensions/mcp-servers/memory-server/src/write.ts`
- `/Users/nix/dev/ai/sox-ecosystem/extensions/mcp-servers/memory-server/src/memoryd.ts`
- `/Users/nix/dev/ai/sox-ecosystem/extensions/mcp-servers/hello-server/src/index.ts`
- `/Users/nix/dev/ai/sox-ecosystem/extensions/hooks/memory-flush/src/index.ts`
- `/Users/nix/dev/ai/sox-ecosystem/extensions/hooks/memory-flush/extension.json`
- `/Users/nix/dev/ai/sox-ecosystem/extensions/hooks/audit-hook/extension.json`
- `/Users/nix/dev/ai/sox-ecosystem/extensions/agents/memory-organizer/src/index.ts`
- `/Users/nix/dev/ai/sox-ecosystem/tools/supervisor-shim.js`
- `/Users/nix/dev/ai/sox-ecosystem/tools/host-event-shim.js`
- `/Users/nix/dev/ai/sox-ecosystem/dist/memory-lib.js` (header)
- `/Users/nix/dev/ai/sox-ecosystem/docs/engine-defects-found.md`
- `/Users/nix/dev/ai/sox-ecosystem/docs/cli-build-decision.md`
- `/Users/nix/dev/ai/sox-ecosystem/docs/scope-promotion.md` (header)
- `/Users/nix/dev/ai/sox-ecosystem/VERIFICATION.md`
- `/Users/nix/dev/ai/sox-ecosystem/assets/model_capabilities.json` (not read directly; referenced via provider-capabilities.ts)
