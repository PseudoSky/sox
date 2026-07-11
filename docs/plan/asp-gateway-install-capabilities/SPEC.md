# SPEC — asp-gateway install capabilities (soxe enhancement)

**Status:** proposal / work order (2026-07-11). **Owner:** driven & verified from `agent-source`'s plan per
ADR 0002; implemented here in `sox-ecosystem`.
**Origin:** `agent-source` BL-249 (founder decision "enhance soxe to match the plan", 2026-07-10) +
`agent-source/docs/architecture/open-items-remediation.md` §3. **Consumer contract:**
`agent-source/docs/plan/delivery-surface/scripts/assert_install.js` (dod.3) must pass **unchanged** after
this work — that is the honesty gate.

The `asp-gateway` soxe bundle (authored at `agent-source/tools/fixtures/delivery-surface/asp-gateway/`)
requires three install-engine capabilities soxe **v1.1.1 does not provide** (source- + empirically
confirmed; soxe still 1.1.1, no prior enhancement landed as of 2026-07-11). Two of the three need **no new
engine primitive** — the machinery exists and is merely unwired. A fourth, adjacent bundle-uninstall defect
is folded in.

All file:line references below are into this repo (`~/dev/ai/sox-ecosystem`) as of the investigation.

---

## Capability 1 — Claude `hook` install surface (PostToolUse arming, reversible)

**Gap.** The Claude host has no `surfaces['hook']` — only `hook-script` (script file-drop,
`libs/host-registry/src/claude.ts:180`) and `settings` (config-merge). soxe's `type:hook` is a runtime
event-bus concept, unrelated to Claude Code PostToolUse. So `soxe install <hook> --host=claude` finds no
surface and errors (`apps/sox/src/main.ts:1193`).

**Fix — two parts:**
1. **Data-driven:** add a `hook` entry to `buildSurfaces()` (`libs/host-registry/src/claude.ts`, alongside
   `hook-script`). It must produce **two effects** — reuse the existing `hook-script` file-drop to
   `~/.claude/hooks/<id>/`, **and** a `settings.json` array entry (mirror the "hooks are TWO surfaces" note
   at `claude.ts:177`).
2. **New primitive (the only genuinely new code in this work order):** arming a PostToolUse entry is an
   **object-array append with identity-scoped reversal**. Neither existing primitive fits — `config-merge`
   deletes the whole keyPath on reverse (`config-merge.ts:422`, would clobber foreign hooks) and
   `array-merge` handles `string[]` only (`array-merge.ts:29`). Add an `object-array-merge` capability under
   `libs/install-engine/src/capabilities/` that appends an object to `hooks.PostToolUse` tagged with a
   stable identity (e.g. `_sox: <extId>` or the command path) and on reverse removes **only** entries
   carrying that identity. Record a new `OwnedEntry` kind in `ownership.ts:31`; wire apply/reverse into
   `declarativeInstall` (`install.ts:1519+`) and `lifecycle.ts`.

**Verify first:** re-confirm the live Claude Code PostToolUse JSON shape before finalizing the identity
strategy (`claude.ts:14` claims a 2026-06 surface-matrix verification, but the object-array reversal
semantics are new).

**Acceptance:** `assert_install.js` field `components.hook === true`; the dropped hook script + the
settings.json entry both appear on install and both reverse on uninstall with foreign PostToolUse entries
left intact.

---

## Capability 2 — lockfile-less `--host` file-drop uninstall

**Gap.** A pure `--host` file-drop (rules/skill/command) writes ledger + ownership but **no lockfile** (by
design — host placements aren't resolver-managed; gate at `install.ts:1697`). `cmdUninstall` already has a
BL-109 ownership-index fallback that removes file-drops (`apps/sox/src/main.ts:2857`, `:2958`) — but it is
**unreachable** because `cmdUninstall` hard-exits `"no lockfile at <path>"` at `main.ts:2844` *before*
reaching it.

**Fix — surgical, no new primitive:** when `loadLockfile` returns null, treat it as an empty
`{resolved:{}}` and fall through to the ownership branch instead of exiting; guard the later lockfile
rewrite (`main.ts:2983`) to skip when there was none. The dropped `.claude/rules/...` file is already fully
tracked in `ownership.json`.

**Acceptance:** `soxe uninstall` on a scope whose only install was a `--host` rules drop removes the dropped
file wholesale; `assert_install.js` fields `uninstall.guidance_file_removed === true` and
`uninstall.host_files_clean === true`.

---

## Capability 3 — service running after install (+ list running, uninstall stop)

**Gap.** `run-service.apply` records intent only — writes a manifest + `registry.json` `status:'installed'`,
never spawns (`libs/install-engine/src/capabilities/run-service.ts:89`).

**Fix — pure wiring, no new primitive.** Every runtime piece already exists: `cmdStart`/`cmdStop`
(`main.ts:3710`/`4260`), `cmdList` RUNNING/STOPPED via `quickReconcile` (`main.ts:3374`), the launchd/systemd
`os-unit` layer (BL-263-hardened, `libs/host-runtime/src/os-unit.ts:136`), the **port.txt handshake** in the
supervisor (`supervisor.ts:437`), and uninstall os-unit teardown (`main.ts:2932`). After a successful
`type:service` install (`cmdInstall`, `main.ts:1207`), invoke the existing `enableOsUnit` + start path (as
`cmdService enable` does at `main.ts:4642`), gated behind a `--start`/`--no-start` flag (~10 lines).

**Verify first:** that `resolveOsUnitContext` returns a usable spec for a freshly-installed service before
any supervisor exists.

**Acceptance:** `assert_install.js` fields `service_running === true` after install and
`uninstall.service_stopped === true`; `soxe list` reports the service RUNNING.

---

## Adjacent defect — bundle-level `soxe uninstall`

**Gap.** Lockfile + ownership are keyed by **member** ids, never a bundle id (`install.ts:1697`,
`ownership.ts:51`), so `soxe uninstall <bundleId>` finds nothing and fails; the resolver bundle path can also
miss an explicit `--root` (`main.ts:1299`). Not one of the 3 dod.3 capabilities, but it will bite the
`soxe uninstall asp-gateway` beat.

**Fix.** Write a bundle-level ownership record at expand time (a parent entry listing member ids —
`bundleId` is already on every member record, `ownership.ts:51`); make `cmdUninstall` resolve a bundle id →
its member set → reverse each. Fix in the same pass.

---

## Sequencing & done-definition

```
C2 (lockfile-less uninstall fallthrough)   surgical    — do first, unblocks the uninstall beat
C3 (install-time service start wiring)      wiring
C1 (hook surface + object-array-merge)      new primitive — verify PostToolUse shape first
BundleUninstall (member-set reversal)       same pass
—— then ——
Re-run agent-source assert_install.js UNCHANGED → dod.3 green on all 3 fields
Bump soxe version; agent-source P4 re-verifies delivery-surface-e2e
```

**Definition of done:** `assert_install.js` (unchanged) exits 0 against a real `soxe install/uninstall
asp-gateway` at USER scope — `components.hook`, `service_running`, `uninstall.service_stopped` all true,
alongside the already-green guidance-drop/removal, ledger-reversal, seed, and zero-config fields. This is the
sole remaining blocker on `agent-source`'s P4 `delivery-surface` plan.
