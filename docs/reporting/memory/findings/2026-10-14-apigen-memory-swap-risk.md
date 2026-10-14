# Swapping memory-server to an apigen MCP with HTTP and CLI mirrors — risk analysis

**Date:** 2026-10-14 · **Scope:** analysis only, no source changes · **Status:** verdict recorded below

## Verdict

**Do not replace memory-server's MCP layer with apigen-generated code as a direct swap.** Two risks
are disqualifying regardless of store behaviour: the generated stdio server drops flat arguments
(R1) and default generation renames every tool (R2). A third risk (R3, writer-peer and write-queue
bypass) is high rather than disqualifying, because the store adapter now opens lazily and releases
idle connections. An additive apigen HTTP/CLI mirror in front of the existing backend is viable,
provided the conditions in "Recommended path" hold.

## Store lifetime (current code)

- Connection is lazy: `connect()` constructs a never-opened shell and performs no driver open
  (`libs/data/store/store-adapter/src/turso-adapter.ts:662-680`). The lease is acquired only at the
  real open (`turso-adapter.ts:2366-2372`, `acquireStoreLease` at `:2589`).
- Idle connections auto-release. The default `'gated'` strategy runs the full `close()` ceremony and
  the next operation reconnects transparently (`turso-adapter.ts:755-765`, `:792-801`). Idle flush
  timing is 2 s floor and 30 s ceiling (`libs/data/store/store-adapter/src/wal-tuning.ts:30,43`).
- The lease is a per-connection registry used to gate destructive operations, not an exclusive lock
  (`libs/data/store/store-adapter/src/store-lease.ts:1-16`).
- Write exclusion for Turso is cross-process `multiprocess_wal` writer serialization, per ADR-0012 §1
  (`docs/decisions/0012-turso-multiprocess-write-and-driver-agnostic-error-taxonomy.md:17-44`).
  ADR-0012 supersedes ADR-0007's invariant for the Turso adapter. The SQLite adapter keeps
  single-writer semantics (ADR-0012 lines 75-78).

Consequence: a process that performs store operations is a writer peer while it is active, but it
no longer holds a store lease for its whole session. Long-held leases belonged to the pre-lazy-connect
era and no longer describe current behaviour.

## What "apigen" is here

`@adhd/apigen-*` is a code-first generator family in a sister repo, `/Users/nix/dev/node/adhd/packages/apigen/`.
Published versions on npm: `apigen-plugin-mcp` 0.3.3, `apigen-plugin-api-fastify` 0.2.8,
`apigen-cli` 0.2.11. All are pre-1.0. sox-ecosystem declares no `@adhd/apigen-*` dependency today.
Its only in-repo consumers are plans and documentation (`docs/plan/backlog-rag/README.md`;
`docs/decisions/0015-backlog-single-writer-daemon-tier.md`, which is `PROPOSED`).

The sister repo's backlog tool is the production precedent. Its `cli.ts` header states "NO
`apigen generate`" and builds the package programmatically via `buildBacklogApigenPackage(ctx)`
(`/Users/nix/dev/node/adhd/entrypoint/backlog/src/cli.ts:2-6`).

## Current surface (measured)

- **29 `memory_*` tools** are registered in the `TOOLS` array, lines 653–1222 of
  `extensions/bundles/sox-memory-bundle/members/memory-server/src/index.ts`. The member's
  `CLAUDE.md` says "23", which is stale.
- **24 files** reference literal `mcp__memory-server__` tool names (agent `extension.json`
  allowlists, docs, skills, scripts). A rename is a cross-host reinstall.
- Transports: stdio per session, plus StreamableHTTP and SSE, all through a shim proxy to one UDS
  backend (`memory-server/CLAUDE.md`, "Dual transport").
- Error convention: `{ isError: true, content: [{type:"text", text}] }` with `E_*` codes
  (`memory-server/CLAUDE.md`, "Error handling").

## Probes (executed) and source reads

| # | Claim | Evidence | Confidence |
|---|---|---|---|
| P1 | Generation accepts untagged `string \| {prefix} \| string[]` unions | `apigen generate --type mcp` exit 0; emitted `oneOf` with `x-apigen-logical: union` (probe `scratchpad/apigen-probe/out-mcp`) | executed |
| P2 | Default naming yields `<ns>_api_<fn>`, not `memory_<fn>` | `--namespace memory` on `recall`/`write` → `memory_api_recall`, `memory_api_write` (`out-mcp2/index.ts`) | executed |
| P3 | Generated stdio server does no input validation | `rg validate` over `out-mcp/` and `out-mcp-ns/` → zero hits | executed (generation only; server not run) |
| P4 | Generated input is nested under `data`; the description documents it | `"apigen calling convention: all domain parameters go inside a \"data\" envelope"` | executed |
| P5 | The stdio handler falls back to `{}` when `data` is absent | `server-stdio.tpl.ts:62`: `((args as any)['data'] ?? {})` | source read, not run |
| P6 | The handler returns no `isError` flag and no `code` mapping | `server-stdio.tpl.ts:46-73` returns only `{content, structuredContent?}` | source read, not run |
| P7 | The TS-types emitter rejects untagged `oneOf` | `apigen-plugin-ts-types/src/lib/emit-types.ts:329` | source read. Affects `ts-types` output only, not the MCP path (P1) |
| P8 | The search MCP documents the same `data` convention | `extensions/agents/researcher/agent.md:76` | source read |

## Risk register

**R1 — Silent argument loss (critical, store-independent).** Every current caller sends flat
arguments. Under the generated stdio server (P5) they arrive as `{}`.
- `memory_write({content, project_path})` fails loudly.
- `memory_recall({query: "x"})` becomes a no-query importance-ranked listing across all projects, with
  no error. This is inferred from P5 plus the documented listing path; the generated server was not run.

A compatibility shim accepting both shapes and rejecting ambiguity is required before any cutover.

**R2 — Tool renames (critical, store-independent).** Default generation produces `memory_api_<fn>`
(P2). Exact `mcp__memory-server__memory_<op>` names require programmatic `Operation` definitions with
explicit MCP names, which is the backlog precedent's approach. Renaming breaks the 24 referencing files
and every host's permission allowlist.

**R3 — Writer peers and write-queue bypass (high).** A per-session apigen stdio server that performs
store operations becomes a `multiprocess_wal` writer peer while active (ADR-0012 §1; lazy-connect
above). Turso permits this, so it is not an invariant violation. It does bypass the single write queue
and group commit that ADR-0007 D5 and the write path rely on, and it adds contention. Contention is
measured: the gated WAL TRUNCATE deferred 1,409 times in 4 days (`turso-adapter.ts:755-765`). The apigen
layer must therefore forward to the existing UDS backend and never open the store itself.

**R4 — Artifact provenance and deploy (high).** The backlog-rag plan puts apigen output in `generated/`
(gitignored, built by nx). That changes the artifact hash on every build, and the deploy rules apply:
`memory_ping` artifact hash must equal `shasum` of `dist/index.js` (BUG-028); a rebuild under a live
service splits it (`docs/reporting/memory/STATE.md`, "Rebuilding `dist/` underneath a RUNNING
service"); registry checksums must be re-synced. The bundle must stay self-contained
(`docs/standards/extension-bundling.md`). Whether apigen's runtime (fastify, ajv, MCP SDK) bundles
cleanly is **unverified**.

**R5 — Destructive operations exposed over HTTP (high, store-independent).** `memory_curate` includes
`drop-episodes` (hard delete), `reset_pipeline`, `unpoison`, and `reheal_stale`. ADR-0007 D4 requires bearer
auth for any non-loopback bind, and that auth is not implemented (ADR-0007 D4, "Phase 4"). An HTTP mirror
generated from all 29 functions would expose hard deletes to any reachable client. Bind policy and auth
in the apigen fastify plugin were **not verified**.

**R6 — CLI as a second writer (high).** A CLI that opens the store per invocation is a writer peer (R3)
and bypasses the write queue. It must be a thin client of the daemon.

**R7 — Error and status semantics (medium).** Current handlers return `isError` and `E_*` codes. The
generated handler returns neither (P6). Callers that branch on `isError`, and the `{retryable,
retry_after_ms}` taxonomy, need a mapping layer.

**R8 — Schema fidelity (medium, unverified).** Hand-written schemas carry `minimum`/`maximum`, `enum`,
`default`, and `maxLength`. P1 confirms union handling but did not check whether these constraints
survive TS extraction. A schema-diff gate is required.

**R9 — Cross-repo coupling and pre-1.0 churn (medium).** Three pre-1.0 packages in another repo, pinned
by exact version at pack time (BL-452 cascade). Every apigen patch becomes a republish cascade.

**R10 — Connect failures (observation, not causal).** In this session the `backlog` and `search` MCP
servers both timed out at connect (30 s). Both are apigen-family servers. I did not diagnose the cause.

## Recommended path

1. **Keep the hand-written MCP surface.** It carries the flat envelope, exact names, `isError`, and the
   proxy/UDS topology.
2. **If HTTP and CLI mirrors are wanted, generate them as fronts over the UDS backend**, built
   programmatically, with:
   - explicit MCP and HTTP names equal to the current `memory_*` names;
   - an argument shim accepting flat and `data` shapes and rejecting ambiguity;
   - loopback by default, with bearer auth before any non-loopback bind;
   - `drop-episodes`, `reset_pipeline`, and `unpoison` excluded from HTTP and CLI, or gated;
   - the CLI as a daemon client only, so its writes go through the write queue.
3. **Conformance gate before cutover:** for each of the 29 tools, assert identical name, input schema
   constraints, and output and error shape between the hand-written and generated surfaces, plus a
   flat-argument regression test that fails if `data` is dropped.
4. **Record the architecture change as an ADR** before implementing. It changes the topology ADR-0007
   and ADR-0012 describe. ADR-0015 is `PROPOSED` and does not authorize implementation.

## Open items (not yet filed; backlog MCP unreachable this session)

- **Doc drift:** `extensions/bundles/sox-memory-bundle/members/memory-server/CLAUDE.md` says 23 tools;
  `TOOLS` in `src/index.ts` lists 29. Family BL, repo sox-ecosystem.
- **Design constraint:** apigen's stdio template drops flat arguments to `{}` (P5). No sox code is
  affected today.
- **Connect failures:** `backlog` and `search` MCP servers timed out at connect in this session (R10).

## Evidence limits

P1–P4 are generation-time probes. The generated server was never executed, so P5 and P6 are source
reads. R4, R5, and R8 were not verified. This analysis changed no source, bundle, or registry file.
