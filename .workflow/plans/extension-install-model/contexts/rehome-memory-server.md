<!-- markdownlint-disable MD013 MD033 -->
# rehome-memory-server — Collapse memory-server onto `@adhd/sox-mcp-runtime`

> **Slug is identity.** This filename and the `rehome-memory-server` slug are immutable once
> assigned. Ordering comes from `dag.json` (`depends_on`), not from this name.

**Phase:** enforcement · **Depends on:** mcp-runtime · **Guard:** `./node_modules/.bin/nx run memory-server:test && ./node_modules/.bin/nx run host-runtime:test-e2e`

---

## Goal

After this state `memory-server` is re-homed onto `@adhd/sox-mcp-runtime`: its hand-rolled MCP loop and
its **vendored** permission guard (`compilePolicyFromEnv` copy + `checkDbPathPolicy` + `getPolicy` +
`handleToolCall`) are **gone** — replaced by `serve(tools)` + the wrapper's ctx policy accessors
(**[dod.6]**). This proves the duplication the ADR called out (a hand-rolled loop + vendored guard
that should live in shared infra) is actually retired (`grep` empty), while behavior and the C6
negative reality check stay identical (**[inv:c6-holds]**, **[inv:no-regress]**).

It depends on `mcp-runtime` (the wrapper it collapses onto must exist first).

---

## Semantic Distillation

- **Primitive:** REWRITE `extensions/mcp-servers/memory-server/src/index.ts` onto `@adhd/sox-mcp-runtime`;
  MODIFY its `extension.json` to declare the wrapper dependency.

- **Reference Pattern:** spec §8 final bullet ("memory-server's MCP loop + vendored
  `compilePolicyFromEnv` collapse into `@adhd/sox-mcp-runtime`"); the current
  `extensions/mcp-servers/memory-server/src/index.ts` (the loop + vendored guard being removed);
  `libs/mcp-runtime` (the `serve` API it now uses).

- **Delta Spec:**
  - Replace the hand-rolled MCP loop + `handleToolCall` with `serve(defineTool(...))`
    (**[shape:mcp-tool]**).
  - **Delete** the vendored `checkDbPathPolicy` and `getPolicy`; the wrapper's ctx policy accessors
    - uniform C6 enforcement replace them (**[ref:policy-env-enforce]**). The vendored
    `compilePolicyFromEnv` copy goes with them (the canonical one lives in `libs/host-runtime` and is
    used by `@adhd/sox-mcp-runtime`).
  - `extension.json` declares `@adhd/sox-mcp-runtime` and derives `serves`.
  - Behavior + the C6 negative reality check are **identical** — `host-runtime:test-e2e` stays green
    (**[inv:no-regress]**).

- **Invariants:** **[inv:c6-holds]** (enforcement preserved via the wrapper), **[inv:no-regress]**
  (memory-* behavior + e2e unchanged), **[ref:policy-env-enforce]**.

- **Validation:** `./node_modules/.bin/nx run memory-server:test && ./node_modules/.bin/nx run host-runtime:test-e2e`
  — memory tools still pass, and the e2e (including the undeclared-access-denied check) is green.

---

## Acceptance criteria

Checked by `audit-enforcement`. One check per item; none deferred.

- [ ] **[rehome-memory-server.1]** memory-server uses `serve()` from `@adhd/sox-mcp-runtime`, not a
      hand-rolled loop. `grep -nE 'serve|@adhd/sox-mcp-runtime' extensions/mcp-servers/memory-server/src/index.ts` → non-empty.
- [ ] **[rehome-memory-server.2]** The vendored guard symbols are GONE (**[dod.6]**).
      `grep -rn 'checkDbPathPolicy\|getPolicy\|handleToolCall' extensions/mcp-servers/memory-server/src/` → empty.
- [ ] **[rehome-memory-server.3]** No vendored `compilePolicyFromEnv` copy remains in the extension
      (**[dod.6]**). `grep -rn 'compilePolicyFromEnv' extensions/mcp-servers/memory-server/src/` → empty
      (the canonical one is imported via the wrapper, not vendored here).
- [ ] **[rehome-memory-server.4]** `extension.json` declares `@adhd/sox-mcp-runtime`.
      `grep -nE 'mcp-runtime' extensions/mcp-servers/memory-server/extension.json` → non-empty.
- [ ] **[rehome-memory-server.5]** Behavior + C6 reality check unchanged (**[inv:no-regress]**,
      **[inv:c6-holds]**). `./node_modules/.bin/nx run host-runtime:test-e2e` exits 0.

---

## Reservations

```text
read_only:  ["libs/mcp-runtime/src/serve.ts",
             "libs/mcp-runtime/src/enforce.ts",
             "libs/host-runtime/src/policy.ts"]
mutates:    ["extensions/mcp-servers/memory-server/src/index.ts",
             "extensions/mcp-servers/memory-server/extension.json",
             "extensions/mcp-servers/memory-server/src/permission-guard.spec.ts"]
```

> **MANDATORY (architect pre-dispatch fix — BLOCKER-2):** `permission-guard.spec.ts` currently imports
> `handleToolCall` + `compilePolicyFromEnv` directly from `./index.js`. Deleting `checkDbPathPolicy`/
> `getPolicy` and rewiring `handleToolCall` onto `@adhd/sox-mcp-runtime` breaks its compile — so the guard
> (`memory-server:test`) cannot go green until this spec is **rewritten to test through the wrapper's
> `ctx` policy accessors** (the C6 negative case must still be asserted). It is now a declared mutate.

---

## Contract Promise

- **Added:** `@adhd/sox-mcp-runtime` dependency on memory-server; `serve()`-based tools.
- **Modified:** `memory-server/src/index.ts` (rewritten), `extension.json` (declares wrapper).
- **Deleted:** `checkDbPathPolicy`, `getPolicy` (vendored guard); `handleToolCall` (re-signed away);
  the vendored `compilePolicyFromEnv` copy — confirm no remaining references in the extension.

---

## Commit points

- [ ] **After the guard (memory tests + e2e) is green** (mandatory) — commit source **and**
      `state.json` / `dag.json`: `refactor(eim): rehome-memory-server complete — onto @adhd/sox-mcp-runtime, vendored guard gone — guard green`

---

## Notes for executor

- The deletion must be **complete** — `rehome-memory-server.2`/`.3` are negative greps over the
  extension's `src/`. Leaving even a commented reference fails the audit. Remove the symbols, don't
  stub them.
- Behavior parity is the constraint: the C6 negative reality test
  (`extensions/mcp-servers/memory-server/src/permission-guard.spec.ts` semantics) must keep passing
  through the wrapper (**[inv:c6-holds]**). If the wrapper's ctx accessors differ from the old
  guard's API, adapt the call sites — do not weaken the test.
- This is the only enforcement-phase state that runs after `mcp-runtime` (not parallel) — it needs
  the wrapper to exist.
