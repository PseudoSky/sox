# service-runtime — SERVICE RUNTIME

> **Slug is identity.** This filename and the `service-runtime` slug are immutable once assigned.

**Phase:** runtime · **Depends on:** mcp-install-modes · **Guard:** `bash .workflow/plans/extension-install-model/scripts/guards/service-runtime.sh`

---

## Goal

After this state, `[dod.5]` is satisfied: the supervisor spawns the materialized SERVICE bundle with `cwd` = its store directory (`[def:store-dir]`) — a foreign directory with no monorepo siblings — and the service resolves all deps and runs the **real `serve()` path**. The hand-rolled stdio fallback loop in `memory-server` is DELETED (so the real path is the only path); `serve()` emits `[shape:serve-marker]` (`[serve] real-path`) to stderr. No `MODULE_NOT_FOUND` or `Cannot find module '@adhd` appears in stderr.

---

## Semantic Distillation

- **Primitive:** MODIFY `libs/host-runtime/src/supervisor.ts` — set child cwd to `[def:store-dir]`. DELETE `handRolledStdioLoop` from `extensions/mcp-servers/memory-server/src/index.ts`.

- **Reference Pattern:** `libs/host-runtime/src/supervisor.ts` currently spawns child processes — locate the `spawn` call and confirm it already sets `cwd`; if not, add it. `extensions/mcp-servers/memory-server/src/index.ts` — locate the hand-rolled stdio fallback (the `dag.json` names it `handRolledStdioLoop`); delete it. The real `serve()` is imported from `@adhd/sox-mcp-runtime`.

- **Delta Spec:**
  - `supervisor.ts` — in the spawn call, set `cwd: extension.storePath` (the materialized store dir from the registry entry). The child has NO `node_modules` from the monorepo; it uses only the self-contained bundle.
  - `memory-server/src/index.ts` — delete the hand-rolled stdio loop; call only `serve(tools)` from `@adhd/sox-mcp-runtime`. Add (or confirm) `console.error('[serve] real-path')` at the top of `serve()` or immediately before it.
  - The serve marker `[serve] real-path` must appear in stderr within 3 seconds of the process starting.

- **Invariants:** `[inv:bundle-selfcontained]` — the bundle from bundle-pipeline has no `@adhd/sox-*` unresolved; the cwd change exposes any unresolved specifier. `[inv:tier3-proof]` — guard drives real CLI + asserts tool output + marker + no import error.

- **Validation:** `bash .workflow/plans/extension-install-model/scripts/guards/service-runtime.sh` — install → start → exec memory_recall; assert tool output, `[serve] real-path` marker, no `Cannot find module '@adhd`.

---

## Acceptance criteria

Checked by audit-final (terminal gate).

- [ ] **[service-runtime.1]** `sox install memory-server --profile service && sox start && sox exec memory-server memory_recall '{}'` exits 0 and returns tool output.
      Via guard: `bash .workflow/plans/extension-install-model/scripts/guards/service-runtime.sh`
- [ ] **[service-runtime.2]** The `[serve] real-path` marker appears in combined output after exec (real serve() ran).
      Via guard.
- [ ] **[service-runtime.3]** No `Cannot find module '@adhd` appears in stderr (bundle is self-contained from store dir).
      Via guard.
- [ ] **[service-runtime.4]** `handRolledStdioLoop` is deleted — negative grep returns empty.
      `grep -rn "handRolledStdioLoop\|hand.rolled\|# hand" extensions/mcp-servers/memory-server/src/ | grep -v "\.spec\."` → empty
- [ ] **[service-runtime.5]** `supervisor.ts` sets child `cwd` to the extension's store path.
      `grep -n "cwd\|storePath\|store_path" libs/host-runtime/src/supervisor.ts | grep -q "cwd" && echo OK`

---

## Reservations

```text
read_only:  ["libs/install-engine/src/capabilities/run-service.ts",
             "libs/install-engine/src/capabilities/materialize.ts",
             "libs/install-engine/src/install.ts"]
mutates:    ["extensions/mcp-servers/memory-server/src/index.ts",
             "libs/host-runtime/src/supervisor.ts",
             "scripts/guards/service-runtime.sh"]
```

**Merge protocol:** `lifecycle` also mutates `supervisor.ts` — it rebases onto this state's output (lifecycle depends_on service-runtime).

---

## Contract Promise

- **Modified:** `supervisor.ts` — child cwd set to store dir; `memory-server/src/index.ts` — fallback deleted, serve() emits marker
- **Deleted:** `handRolledStdioLoop` from `memory-server/src/index.ts`

---

## Commit points

- [ ] **After supervisor cwd fix** — commit `supervisor.ts`:
      `fix(eim): service-runtime — supervisor sets child cwd to store dir`
- [ ] **After fallback deleted + marker added** — commit `memory-server/src/index.ts`:
      `feat(eim): service-runtime — delete hand-rolled fallback; serve() emits real-path marker`
- [ ] **After the guard passes** (mandatory):
      `feat(eim): service-runtime complete — guard green ([dod.5])`

---

## Notes for executor

- Deleting the fallback is a deliberate forcing function: if the bundle is not self-contained, the service crashes immediately (no MODULE_NOT_FOUND is papered over). This is the design.
- The `[serve] real-path` marker must appear on stderr, not stdout, because the probe harness captures both and `assert_serve_real_path` checks `$LAST_OUT$LAST_ERR`.
- The guard gives the supervisor 2 seconds to spawn and the service to emit the marker — do not add a longer `sleep` inside the serve() call.
