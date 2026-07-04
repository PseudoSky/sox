# Context 03 — supervision, activation posture, store identity

**Execute:** read `../_shared/RULES.md` → `../_shared/CONTRACTS.md` →
`../_shared/PROTOCOL.md`, then this file, then ADR 0007 D3/D6/D7 and BACKLOG BL-121/122/
128/130/131/137/145. Worktree branch: `runtime-prod/03-supervision-activation`. Log to
`./progress.json`; finish with `./REPORT.md`.

**Mission:** make activation posture a config key, make socket-activation real, make the
spawn fallback race-free, and make the store + instance identity verifiable from any
client — then, gated, bring launchd back.

**Depends on:** items SA-1..SA-7 start immediately. SA-8 (the launchd re-enable) starts
ONLY after context 02's gate is `passed` — this is BL-145's re-enable gate; no early
enable under any circumstances.

**Scope fence (may touch):** `libs/host-runtime/**` (os-unit, singleton, reaper only as
needed for lease), `libs/service-proxy/**`, `libs/manifest/**` (config_schema/lifecycle
schema additions), `libs/memory-core/**` (identity items SA-5..7),
`extensions/bundles/sox-memory-bundle/members/memory-server/**`. Nothing in `apps/sox`
beyond what `soxe config`/os-unit generation already calls into host-runtime (if a CLI
change is unavoidable, blocker it — apps/sox belongs to context 05).

## Items

| id | BL | Work | Acceptance | NC |
|---|---|---|---|---|
| SA-1 | — | `activation_posture` config key per CONTRACTS §I: manifest `config_schema` entry + `deriveOsUnitSpec()` branch (`always-on` → RunAtLoad+KeepAlive; `on-demand` → socket-activation spec) | unit tests over `deriveOsUnitSpec` for both postures; `soxe config set … activation_posture` triggers the existing restartOsUnit hook | no |
| SA-2 | — | Socket-activation rendering: `Sockets` key in `LaunchdPlatform.renderBody()` + paired `.socket` unit in `SystemdPlatform` | rendered plist/unit snapshots match golden fixtures for both postures | no |
| SA-3 | — | Inherited-fd support in `serveBackend()` (service-proxy): accept a pre-bound fd (launchd activation) as an alternative to create+bind+chmod | integration test passes a pre-bound socket fd → backend serves on it without binding | yes |
| SA-4 | 137 | Fallback spawn hardening in `ensure-backend.ts`/`backend.ts`: probe-connect before spawn AND before bind (NEVER unlink/steal a live socket), readiness handshake replacing the fixed 10s timeout, lock-holder liveness (`kill(pid,0)`), backend exit handling | race test: two concurrent ensureBackend calls → exactly one backend, loser dials winner; live-socket steal attempt refused with structured error | yes — restore the old unlink-first behavior → race test red |
| SA-5 | 121 | Store stamp per CONTRACTS §G (`sox_store_meta`, open-for-write check, `E_STORE_MISMATCH`) | mismatched-artifact fixture store → structured refusal naming both sides | yes |
| SA-6 | 130 | Named-store registry per CONTRACTS §I/H: `store:"name"` param resolved via `~/.memory/registry.json`; every result echoes resolved path + fingerprint; raw `db_path` still accepted with deprecation warning | registry round-trip tests; misroute test (unknown name → structured error, never a silent new file) | yes |
| SA-7 | 122, 131 | `memory_ping` per CONTRACTS §H (instance block, store block, embed block via provider.health(); legacy keys derived) | ping schema test; a second stray backend started manually is distinguishable by `instance_id`/pid | no |
| SA-8 | 128, 145 | Writer lease per CONTRACTS §J (flock-held, graceful drain on shutdown); then execute the BL-145 re-enable: `soxe service enable` both units per posture config, verify single writer under launchd | lease contention test (second opener → `E_BUSY` naming holder); after enable: `lsof` one holder, ping identity matches launchd pid | yes — kill -9 the leased writer → lease recoverable, restart acquires cleanly |

## Gate

Chaos suite: `kill -9` the writer mid-write-burst → supervised restart, `PRAGMA
integrity_check` clean, lease re-acquired, zero corrupted results; reconnect storm (10
shims dialing during restart) → exactly one backend after settle. Posture flip
`always-on` ↔ `on-demand` via `soxe config set` alone, taking effect without manual
service surgery. All suites green.

## Subdispatch notes

Good candidates: golden-fixture authoring for plist/unit rendering; the race and
chaos test implementations from your specifications; a verifier pass (own control:
e.g. break the lease flock → chaos test red). Keep SA-4's probe/handshake design and
the SA-8 re-enable execution yourself. SA-8's re-enable touches the OWNER'S live
machine state — record every command + its reversal in REPORT.md.
