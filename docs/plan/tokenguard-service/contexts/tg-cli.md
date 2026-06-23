# tg-cli — TOKENGUARD_CLI

> **Slug is identity.** Immutable.

**Phase:** service · **Depends on:** tg-service · **Guard:** `python3 docs/plan/tokenguard-service/scripts/guard_tg_cli.py`

---

## Goal

After this state, a **simple CLI** (invoked via `./bin/sox exec tokenguard -- <cmd>`) lets an operator **seed** and **inspect** identifiers, operating on the **same live, continuously-persisted token map** the running proxy reads — and the running proxy **reflects a CLI seed without a restart**. No MCP surface (out of scope by decision); the control plane is the shared live map plus a lightweight reload.

---

## Semantic Distillation

- **Primitive:** CREATE `extensions/services/tokenguard/src/cli.ts` + `src/mapstore.ts` — a CLI over the live map with a reload signal.
- **Reference Pattern:** `scripts/tokenguard/seed_artifacts.py` + `summary.py` (seed/inspect semantics); `extensions/mcp-servers/memory-server/src/memoryd.ts` (the socket-nudge reload pattern — a client write wakes the running process); the `sox exec` routing (`apps/sox`/`runtime-cli`).
- **Delta Spec:**
  - `src/mapstore.ts` — the single read/write owner of **[shape:token-map]** on disk, shared by the proxy and the CLI: atomic append of a `custom`/`tooling` entry, full read for inspection, and a change signal the running proxy subscribes to so a new seed is applied to live traffic without restart (**[def:live-map]**). **Design decision (not executor discretion):** the change signal is **stdlib `fs.watch` on the map-file path with a short debounce** (~100ms) — re-read + merge on change. No new dependency (no `chokidar`); no extra control socket. The reflection must land within ~500ms of the CLI seed write.
  - `src/cli.ts` — subcommands: `seed <real> <type> [token]` (append a custom entry, print the allocated token), `map` (print current entries), `summary` (per-identifier swap counts + leak check from the audit log). Wired into the service so `./bin/sox exec tokenguard -- <cmd>` reaches it.
  - `demo/live-seed.sh` — starts the proxy, sends traffic with an unseeded real (passes through), runs `./bin/sox exec tokenguard -- seed`, sends the same traffic again, and asserts the new identifier is now in the live map and replaced on the wire — printing `LIVE SEED REFLECTED` (or `LIVE SEED MISSED` if the running proxy didn't pick it up).
- **Invariants:** **[inv:bijective-roundtrip]** (a CLI seed is just another origin-tagged entry), **[inv:wire-guarantee]**, **[def:live-map]** (one store, continuously current).
- **Validation:** the guard proves a CLI-seeded identifier is reflected by the already-running proxy.

---

## Acceptance criteria

- [ ] **[tg-cli.1]** the CLI exposes `seed`, `map`, `summary`. `grep -n "seed\|map\|summary" extensions/services/tokenguard/src/cli.ts`
- [ ] **[tg-cli.2]** a single map store is the shared owner (proxy + CLI use it). `grep -n "mapstore\|token-mapping" extensions/services/tokenguard/src/mapstore.ts`
- [ ] **[tg-cli.3]** the running proxy reloads on a seed change via stdlib `fs.watch` + debounce (no new dependency). `grep -n "fs.watch\|watch\|debounce\|reload" extensions/services/tokenguard/src/mapstore.ts`
- [ ] **[tg-cli.4]** the CLI is reachable through `sox exec`. `grep -n "exec\|argv" extensions/services/tokenguard/src/cli.ts`
- [ ] **[tg-cli.5]** the live-seed demo asserts reflection. `grep -n "LIVE SEED REFLECTED" extensions/services/tokenguard/demo/live-seed.sh`

---

## Reservations

```text
read_only:  ["extensions/services/tokenguard/src/proxy.ts",
             "extensions/services/tokenguard/src/index.ts",
             "scripts/tokenguard/seed_artifacts.py",
             "scripts/tokenguard/summary.py"]
mutates:    ["extensions/services/tokenguard/src/cli.ts",
             "extensions/services/tokenguard/src/mapstore.ts",
             "extensions/services/tokenguard/demo/live-seed.sh",
             "extensions/services/tokenguard/src/index.ts"]
```

> The proxy (`src/proxy.ts`, authored in `tg-service`) must subscribe to the mapstore change signal. If that subscription is a one-line wire-up in `proxy.ts`/`index.ts`, record it as an executor-class `expand-artifacts` amendment adding those files to this state's `mutates`, then re-run gap-check.

---

## Contract Promise

- **Added:** the CLI + the shared mapstore + the live-seed demo.
- **Modified:** the proxy's subscription to the mapstore signal (see note — amend reservations if touched).
- **Deleted:** none.

---

## Commit points

- [ ] **After the CLI + live reload work end-to-end** — `feat(tokenguard-service): tg-cli — live map seed/inspect reflected by the running proxy`
- [ ] **After the guard passes** (mandatory) — `feat(tokenguard-service): tg-cli complete — live-seed reflection green`

---

## Notes for executor

- The footgun is a stale in-memory map: the proxy must re-read (or merge) on the change signal, not cache the map for the process lifetime. Prove the reflection with traffic, not just by reading the file.
- Keep the CLI dependency-free beyond `@adhd/sox-tokenguard-core` + stdlib; it ships inside the service bundle.
