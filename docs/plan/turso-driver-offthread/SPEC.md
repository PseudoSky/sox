# SPEC — Turso native driver off the memory-server main thread (plan of record)

- **Status:** RECONCILED (uncommitted draft) · **Run:** `dispatch-2026-09-29-8f99`
- **Supersedes:** the two divergent plans — V1 (packetized recovered spec) and V2 (backlog-filed `[Turso off-thread plan] Segment 0–G`, run `dispatch-2026-09-29-b1kt`).
- **Backlog umbrella:** `862129b5` (+ related `5b58b189`, `3e3ff0ec`)
- **Empirical basis:** `libs/data/store/store-adapter/scripts/turso-driver-probes/README.md`

---

## 1. Code facts verified

- `op-tracing.ts` exists.
- `slowOpThresholdMs` at `types.ts:398`.
- `mainThreadMonitor.start()` wired at `memory-server/src/index.ts:4661`; `serverLivenessWatchdog.start()` at `:4429`.
- `mainthread-monitor.5b58b189.spec.ts` exists → **Segment 0 IS landed** (commit `d215fc30`).
- `turso-driver-host.ts` / `turso-driver-worker.ts` do NOT exist.
- `deep-verify-offthread.bl-fc5ab895.test.ts` exists.
- Verified anchors: `unwrap()` at `turso-adapter.ts:3586`, `_openReal :2235`, `TursoTransactionImpl` ctor `:422`, `db` field `:505`, `connectionHealth :1964`.
- Actual unwrap() count: **9 files / 29 calls** in `store-adapter/src/__tests__/` (connection-recycle = 12).

## 2. CONFLICTS table — V1 × V2 × resolution

| Topic | V1 | V2 | Resolution |
| --- | --- | --- | --- |
| Naming | `TUR-*` | Segment 0–G | **TUR-\* canonical**; V2 Seg 0–G == TUR-0/A–D/E/F/G |
| Segment 0 landed | right | right | Both right — Segment 0 IS landed (commit `d215fc30`) |
| TUR-T / `5b58b189` | in scope | (implicit) | **In scope** with a BL-ID-named test |
| TUR-H / `3e3ff0ec` | — | — | **Split**: production change folds into TUR-D, BL-ID test stays separate |
| TUR-I / `56c72ccb` | — | — | **OUT** — a second worker is forbidden by upstream thread-unsafety; fixable only after 0.8 `STEP_SLEEP`, **BLOCKED on `809153d1`** |
| SQL-A / SQL-B (`a6203466`) | in scope | — | **OUT** — separate design/change-set |
| REL-A / REL-B (`52a5097b`) | — | — | **OUT** — distinct concern |
| `index.ts` ownership | — | — | Owned by **TUR-C only** |
| `package.json` ownership | — | — | Owned by **TUR-B only** |
| ADR-0024 | Proposed | — | **DRAFT-only**, owner approval required |
| `docs/plan/store-adapter-batch-0.10.0/SPEC.md` | — | — | **Collides on the same five files and is STALE** (targets 0.9.2→0.10.0 while live is 0.12.0; its `unwrap()`-based Arms B/C1 break under TUR-D) → **Wave 0 precondition: batch-0.10.0 lands first as its own release train, then off-thread rebases on the split `close()`.** |
| ADR-0019 | — | — | Tension noted (pre-existing) |

## 3. RECONCILED MANIFEST

See `PACKETS.json` (the JSON array below / in the sibling file).

## 4. RECONCILED WAVES

- **Wave 0** = batch-0.10.0 (separate train, precondition)
- **Wave 1** = TUR-0, TUR-A
- **Wave 2** = TUR-B
- **Wave 3** = TUR-C
- **Wave 4** = TUR-D
- **Wave 5** = TUR-E, TUR-T, TUR-H, TUR-F
- **Wave 6** = TUR-G

## 5. Separate change-sets (NOT this plan)

- SQL-A / SQL-B (`a6203466`)
- REL-A / REL-B (`52a5097b`)
- TUR-I (`56c72ccb`, blocked on `809153d1`)
- Redirects:
  - `fc5ab895` — reconcile on-main off-thread deep-verify with unmerged `fix/sibling-scratch-cache`
  - `250c821b` — move 4 exports to a sibling module + `export {x} from './y.js'`
  - `9cde6f90` — golden event-loop-lag test
  - `c26e222b` — worktree liveness check + scratch-script `timeout`

## 6. ADR-0024 proposal

- **Status:** Proposed
- **Owner:** pseudosky
- **Drives:** `862129b5`, `5b58b189`, `3e3ff0ec`
- **Six decisions D1–D6:**
  1. Handle-level seam.
  2. One process-wide driver thread via `globalThis[Symbol.for('@adhd/sox-store-adapter/turso-driver-host')]` + versioned protocol.
  3. Realm isolation.
  4. No host-side cancellation — stall is a synchronous deadline-based suspect state.
  5. Kill policy belongs to the consumer via memory-server `driver-stall-watchdog` / `forceExit`.
  6. Per-connection workers forbidden until upstream declares its core `Database` thread-safe.
- **Two explicit non-guarantees:**
  - Bounds **main-thread blocking, not operation latency**.
  - Same-process writers still pay the 5s busy timeout until 0.8 (`809153d1`).
- Must **not** touch ADR-0012's invariant.
- **Write `docs/decisions/0024-*.md` ONLY after explicit owner approval — do NOT create it now.**

## 7. Provenance

- V1 source: architect transcript `~/.claude/projects/-Users-nix-dev-ai-sox-ecosystem/31b57e43-043e-44d9-ba94-b71ef5f16511/subagents/agent-a279af484af5b62f5.jsonl`
- V2 source: `[Turso off-thread plan]` items filed by `dispatch-2026-09-29-b1kt` (uids `e65f1c12`, `e7d62a97`, `491097fa`, `f68a6dbe`, `93ff7a59`, `7da9b010`, `92338fcd`, `f689f4e3`).
