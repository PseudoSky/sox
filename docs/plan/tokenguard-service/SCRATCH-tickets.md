<!-- SCRATCH — non-authoritative. The state machine (dag.json + contexts/) remains
     the source of truth; its guards live at the STATE boundary, not the ticket
     boundary. These "tickets" are sub-tasks WITHIN a state for estimation,
     parallelization, and per-ticket model routing — most are NOT independently
     shippable (siblings in a state must land together to pass that state's guard). -->
# SCRATCH — ticket-level breakdown (tokenguard-service)

Conceptual decomposition of the 9 work states into ~Jira-sized tickets
(one focused, reviewable unit ≈ a few hours to a day, ~one PR).

**Legend — Difficulty doubles as model tier:**
`Easy` ≈ Haiku-viable · `Med` ≈ Sonnet · `Hard`/`V.Hard` ≈ Opus/careful.

**Phase gates (implicit, omitted from rows):** every `TGS-*` ticket also waits on
`audit-framework` + `audit-core` passing; `DG-*`/`CR-*` wait on `audit-service`.
Cross-state deps cite the specific upstream ticket that produces the needed artifact.

---

## `service-type` (ST) — root, depends on nothing

| Ticket | Name / description | Diff | Depends on |
|---|---|---|---|
| ST-1 | Add `service` to the type system: `VALID_TYPES` (manifest **+** `scripts/new-extension.ts` dup) + `Manifest`/`ManifestInstall` unions + `transports?` field | Med | — |
| ST-2 | Inline JSON-schema enums + `processTypes`: `service` in type/install.type, `http-get` in health.type, `socket` in transport vocab | Med | ST-1 |
| ST-3 | Generalize `validate()`: `profiles ⊆ {serves∪transports}`, transport vocabulary, require ≥1 transport for `service` + unit tests | Med | ST-1, ST-2 |
| ST-4 | `serviceTemplate` + scaffold dispatch + exports (born-conformant fileset, mirror `mcpServerTemplate`) | Med | ST-1 |
| ST-5 | `soxe init service` routing + `--transport` flag in `cmdInit` | Easy | ST-4 |
| ST-6 | `docs/guidelines/service.md` (transports/health/supervision + concurrent-start non-goal) | Easy | ST-1 |
| ST-7 | `check-service-scaffold.sh` harness (init→build→validate→`SCAFFOLD OK`) | Easy | ST-5 |

## `http-transport` (HT) — state depends_on service-type

| Ticket | Name / description | Diff | Depends on |
|---|---|---|---|
| HT-1 | `http-get` health type + `_probeHealth` impl (stdlib `http.get` + timeout) | Med | ST-2 |
| HT-2 | Port resolution: `_waitForHealth` polls `storePath/port.txt`, probe targets actual bound port (`${PORT}`) | Hard | HT-1 |
| HT-3 | `loader.ts dispatchToAdapter`: add `service` case (runtime dispatch), keep `activateMcp` intact | Hard | ST-1 |
| HT-4 | `install.ts`: route `transport:http` through unified `run-service` (generalize `profile:service`) | Hard | ST-1 |
| HT-5 | `SOX_CONFIG_*` injection at the `run-service` registration site (`spec.env`) | Med | HT-4 |
| HT-6 | host-registry `service` surface in `buildSurfaces()` | Easy | ST-1 |
| HT-7 | `typeDirs += 'services'` (lib + legacy `scripts/install.ts` copy) | Easy | — |
| HT-8 | SIGTERM→`stop_timeout`→SIGKILL verification for a port-holder (zero orphans) | Med | HT-2, HT-3, HT-4 |
| HT-9 | `check-http-service.sh` harness (install→start→`HEALTHY`→stop→`orphans=0`) | Med | HT-2, HT-3, HT-4, HT-5, HT-6, HT-7 |

## `mcp-as-service` (MAS) — state depends_on http-transport

| Ticket | Name / description | Diff | Depends on |
|---|---|---|---|
| MAS-1 | manifest: `mcp-server` treated as `service[transport=stdio]` for routing (stays a valid type) | Med | ST-1, HT-4 |
| MAS-2 | `install.ts`: route mcp-server through unified `run-service`; remove the parallel stdio registration branch | Hard | HT-4, MAS-1 |
| MAS-3 | `mcpServerTemplate` emits `transports:['stdio']` | Easy | ST-1 |
| MAS-4 | `docs/guidelines/mcp-server.md`: document the `service[stdio]` relationship | Easy | MAS-1 |
| MAS-5 | `check-memory-nonregress.sh` harness (lifecycle + C6 DENY) | Med | HT-3 |
| MAS-6 | **memory-server non-regression glue** — make C6 + full lifecycle pass under unified routing | V.Hard | MAS-2, MAS-5 |

## `core-engine` (CE) — root, parallel track

| Ticket | Name / description | Diff | Depends on |
|---|---|---|---|
| CE-1 | nx lib scaffold `libs/tokenguard-core` (project/package/tsconfig/index barrel) | Easy | — |
| CE-2 | `types.ts` — `TokenMap`/`MapEntry`/`IdType`/`Source` | Easy | CE-1 |
| CE-3 | `mapper.ts` — bijective origin-tagged store (get/register/seed/lookup/longest-first/persist) | Med | CE-2 |
| CE-4 | `detectors.ts` — 7 detectors + regexes + `NEVER`/`BOUNDED_TYPES` + toggles (Python→JS regex port) | Hard | CE-2 |
| CE-5 | `tokenize.ts` — `tokenizeStr`/`walk`/`tokenizeRequest`(two-pass)/`wireLeaks`/`detokenizeText`/`identifierGroupVariants` | Hard | CE-3, CE-4 |
| CE-6 | `sse.ts` — `detokenizeSse` delta reassembly + thinking/signature passthrough | Hard | CE-3 |

## `core-invariants` (CI) — state depends_on core-engine

| Ticket | Name / description | Diff | Depends on |
|---|---|---|---|
| CI-1 | vitest config + `test` target on `project.json` | Easy | CE-1 |
| CI-2 | `mapper.spec.ts` — idempotent / bijective / reload-stable | Easy | CI-1, CE-3 |
| CI-3 | `detectors.spec.ts` — coverage / longest-first / NEVER / fqdn-vs-path / variants | Med | CI-1, CE-4 |
| CI-4 | `roundtrip.spec.ts` — exact round-trip + zero-leak + scoping (tools untouched) | Med | CI-1, CE-5 |
| CI-5 | `sse.spec.ts` — split-token reassembly + thinking passthrough | Med | CI-1, CE-6 |

## `tg-service` (TGS) — state depends_on audit-framework + audit-core

| Ticket | Name / description | Diff | Depends on |
|---|---|---|---|
| TGS-1 | Scaffold `tokenguard` service ext + fill manifest (type:service/transports:http/http-health/config_schema/permissions) | Med | ST-4, ST-5 |
| TGS-2 | `package.json`/`project.json` incl. `bundle` target (mirror memory-server) + tsconfig | Easy | TGS-1, CE-1 |
| TGS-3 | `config.ts` — resolve from `SOX_CONFIG_*` (port/upstream/capture/provider/seeds/never/detectors/map) | Med | TGS-1 |
| TGS-4 | `proxy.ts` server core — port walk + `storePath/port.txt` after listen + `/_tokenguard/health` | Hard | TGS-3, HT-2 |
| TGS-5 | `proxy.ts` tokenize path — outbound scoping via engine, `Accept-Encoding: identity`, leak self-check + audit | Hard | TGS-4, CE-5 |
| TGS-6 | capture/audit policy (full/truncated/none + caps + `audit.jsonl`) | Med | TGS-4, TGS-3 |
| TGS-7 | `adapters/anthropic.ts` — request scoping + SSE reassembly + thinking passthrough | Hard | TGS-5, CE-6 |
| TGS-8 | `adapters/generic.ts` — plain JSON passthrough + whole-body reversal | Easy | TGS-5, CE-5 |
| TGS-9 | C6 sink guard — read `SOX_POLICY_*`, deny capture/upstream outside allowlist before side-effect | Hard | TGS-4 |
| TGS-10 | `index.ts` wiring — config→mapper(seed+map)→proxy→continuous persist | Med | TGS-3, TGS-4, TGS-9, CE-3 |
| TGS-11 | `demo/proxy-roundtrip.sh` + `mock-upstream.mjs` + 4 founder artifacts | Med | TGS-10, TGS-7, TGS-8 |

## `tg-cli` (CLI) — state depends_on tg-service

| Ticket | Name / description | Diff | Depends on |
|---|---|---|---|
| CLI-1 | `mapstore.ts` — shared store owner + atomic append + `fs.watch`/debounce/merge signal | Hard | TGS-10 |
| CLI-2 | `cli.ts` — `seed`/`map`/`summary` via `soxe exec` | Med | CLI-1 |
| CLI-3 | proxy subscription to the mapstore signal (live reload, no stale in-memory map) | Med | CLI-1, TGS-10 |
| CLI-4 | `demo/live-seed.sh` — assert `LIVE SEED REFLECTED` | Med | CLI-2, CLI-3 |

## `decouple-generalize` (DG) — state depends_on audit-service

| Ticket | Name / description | Diff | Depends on |
|---|---|---|---|
| DG-1 | `libs/tokenguard-core/README.md` — engine API + generic usage | Easy | CE-5 |
| DG-2 | service `README.md` — operator workflow + `*_BASE_URL` model (≥2 providers) | Easy | TGS-10 |
| DG-3 | service `CLAUDE.md` — operator/agent guidance | Easy | CLI-2 |

## `code-review` (CR) — state depends_on decouple-generalize

| Ticket | Name / description | Diff | Depends on |
|---|---|---|---|
| CR-1 | Orchestrator review of all touched projects → `code-review.md VERDICT: PASS` + clean cross-project `typecheck/lint/test` | Hard | all impl tickets |

---

## Rollup

- **52 tickets** — **18 Easy** (Haiku) · **20 Med** (Sonnet) · **13 Hard + 1 V.Hard** (Opus).
- **Roots (no deps, start in parallel):** `ST-1` (framework) and `CE-1` (core).
- **Critical path (Hard spine):**
  - engine→service: `CE-4 → CE-5 → TGS-5 → TGS-7 → TGS-11`
  - framework: `HT-3 / HT-4 → MAS-2 → MAS-6`
- **Haiku-offloadable bucket (~18):** ST-5, ST-6, ST-7, HT-6, HT-7, MAS-3, MAS-4, CE-1, CE-2, CI-1, CI-2, TGS-2, TGS-8, DG-1, DG-2, DG-3 (+ borderline CI-* / MAS-5).
- **Reserve Opus for (~14):** HT-2/3/4, MAS-2/6, CE-4/5/6, TGS-4/5/7/9, CLI-1, CR-1.

> Reminder: tickets within a state are mostly **not independently shippable** — the
> red→green guard is at the state boundary. Treat these as sub-tasks for
> sequencing + model routing, not as deployable increments. The authoritative
> graph is `dag.json`.
