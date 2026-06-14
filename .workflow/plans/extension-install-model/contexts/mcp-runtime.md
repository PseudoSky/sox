<!-- markdownlint-disable MD013 MD033 -->
# mcp-runtime — `@sox/mcp-runtime` wrapper with uniform C6 enforcement

> **Slug is identity.** This filename and the `mcp-runtime` slug are immutable once assigned.
> Ordering comes from `dag.json` (`depends_on`), not from this name.

**Phase:** enforcement · **Depends on:** audit-foundation · **Guard:** `./node_modules/.bin/nx run mcp-runtime:test`
**Parallel with:** install-lifecycle, generators

---

## Goal

After this state `libs/mcp-runtime` (`@sox/mcp-runtime`) is a shared lib that **wraps** the official
`@modelcontextprotocol/sdk` (ADR decision #4 — do not reimplement the protocol). Authors write tools
only via `serve(defineTool(...))` (**[shape:mcp-tool]**); the wrapper provides transport selection
(stdio | sse/http, chosen by a flag/env set by the install profile), health, graceful shutdown, and
**C6 policy-env enforcement at the resource sink — uniform across claude-stdio and sox-service**
(**[inv:c6-holds]**, **[ref:policy-env-enforce]**, **[def:policy-env]**). It ships ONE generic
conformance test every mcp extension inherits (start in each transport, run initialize + tools/list).

It depends on `audit-foundation` (the descriptor + capabilities exist). It is the prerequisite for
`rehome-memory-server`, which collapses onto it. Parallel with `install-lifecycle` + `generators`
(disjoint files).

---

## Semantic Distillation

- **Primitive:** CREATE `libs/mcp-runtime/src/{index,serve,transport,enforce}.ts` + conformance test.

- **Reference Pattern:** spec §8 (the wrapper spec), ADR decision #4/#6; the C6 contract in
  `libs/host-runtime/src/policy.ts` (`toEnv`, `compilePolicyFromEnv`) — reused unchanged.

- **Delta Spec:**
  - `serve.ts`: `serve(defineTool(...))` author API; selects transport from a flag/env the install
    profile sets.
  - `transport.ts`: stdio loop + sse/http listener around the official SDK.
  - `enforce.ts`: read **[def:policy-env]** via `compilePolicyFromEnv` and enforce at the resource
    sink **before** the OS resource, on **every** path (stdio + sse) (**[inv:c6-holds]**).
  - `index.ts`: exports + the derived `serves` fact (built on `@sox/mcp-runtime` ⇒ stdio+sse).
  - `conformance.spec.ts`: the ONE generic test every mcp extension inherits.

- **Invariants:** **[inv:c6-holds]** (no unenforced spawn path), **[ref:policy-env-enforce]**.
  Do not reimplement the MCP protocol (wrap the SDK).

- **Validation:** `./node_modules/.bin/nx run mcp-runtime:test` — the conformance test starts the
  server in each transport, runs initialize + tools/list, and asserts an undeclared resource access
  is **denied** on both transports.

---

## Acceptance criteria

Checked by `audit-enforcement`. One check per item; none deferred.

- [ ] **[mcp-runtime.1]** `serve` author API exists and wraps the official SDK (not a reimpl).
      `grep -nE 'serve|defineTool' libs/mcp-runtime/src/serve.ts` → non-empty;
      `grep -nE '@modelcontextprotocol/sdk' libs/mcp-runtime/src/*.ts` → non-empty.
- [ ] **[mcp-runtime.2]** Dual transport (stdio + sse/http) selected by flag/env.
      `grep -niE 'stdio|sse|http' libs/mcp-runtime/src/transport.ts` → non-empty; conformance test
      starts in each transport.
- [ ] **[mcp-runtime.3]** C6 enforcement reads policy-env and enforces at the sink on every path
      (**[inv:c6-holds]**, **[ref:policy-env-enforce]**).
      `grep -nE 'compilePolicyFromEnv' libs/mcp-runtime/src/enforce.ts` → non-empty;
      `mcp-runtime:test` covers an undeclared-access-denied case for stdio AND sse.
- [ ] **[mcp-runtime.4]** One generic conformance test exists and is inheritable.
      `grep -nqE 'initialize|tools/list' libs/mcp-runtime/src/conformance.spec.ts`
- [ ] **[mcp-runtime.5]** `serves` is derived from building on the wrapper.
      `grep -niE 'serves' libs/mcp-runtime/src/index.ts` → non-empty.

---

## Reservations

```text
read_only:  ["libs/host-runtime/src/policy.ts",
             "libs/manifest/src/schema.json"]
mutates:    ["libs/mcp-runtime/src/index.ts",
             "libs/mcp-runtime/src/serve.ts",
             "libs/mcp-runtime/src/transport.ts",
             "libs/mcp-runtime/src/enforce.ts",
             "libs/mcp-runtime/src/conformance.spec.ts"]
```

**Merge protocol:** none — disjoint files from the parallel `install-lifecycle` + `generators`
states.

---

## Contract Promise

- **Added:** `@sox/mcp-runtime` (`serve`, transport, enforce, conformance test).
- **Modified:** none (reuses `libs/host-runtime/src/policy.ts` read-only).
- **Deleted:** none here (memory-server's duplication is removed in `rehome-memory-server`).

---

## Commit points

- [ ] **After the conformance test (both transports + C6 deny) passes** (mandatory) — commit source
      **and** `state.json` / `dag.json`: `feat(eim): mcp-runtime complete — wrapper + uniform C6 — guard green`

---

## Notes for executor

- **Reuse** `compilePolicyFromEnv`/`toEnv` from `libs/host-runtime/src/policy.ts` — do not vendor a
  copy (that vendoring is exactly what `rehome-memory-server` deletes). Import the shared symbol
  (**[ref:policy-env-enforce]**).
- The deny test must cover **both** transports — a common miss is enforcing only on stdio and
  leaving the sse path open (**[inv:c6-holds]**). The C6 sse failure is the named risk in the dag
  notes.
- Wrap the SDK; reimplementing the protocol fails `mcp-runtime.1`. Budget ~2 sessions.
