# Context 05 — platform integrity (soxe truth-telling)

**Execute:** read `../_shared/RULES.md` → `../_shared/CONTRACTS.md` →
`../_shared/PROTOCOL.md`, then this file, then ADR 0007 D8 and BACKLOG BL-136/138/139/
140/141/142/143. Worktree branch: `runtime-prod/05-platform-integrity`. Log to
`./progress.json`; finish with `./REPORT.md`.

**Mission:** make soxe's view of the world equal the OS's view — reaping that works
across builds, kill surfaces that respect launchd, upgrades that cannot silently break
cold-start, and one live pane (`soxe ps` / `soxe follow`). Touches ZERO memory code —
fully parallel with everything.

**Depends on:** nothing. Start immediately.

**Scope fence (may touch):** `apps/sox/**`, `libs/host-runtime/**`,
`libs/install-engine/**`. Nothing else (no memory packages, no service-proxy — if a
change seems needed there, blocker it; context 03 owns service-proxy).

## Items

| id | BL | Work | Acceptance | NC |
|---|---|---|---|---|
| PI-1 | 136 | Identity-based reaping: match by logical service identity (service-id in argv/env at spawn + socket/db ownership), not literal entrypoint paths; add `soxe doctor` (reconcile: list strays, `--fix` reaps); run a read-only reconciliation on every `soxe status` | doctor detects+reaps a planted cross-build stray (old-path copy of a service) that today's reaper provably cannot match | yes — plant the stray, run OLD matching (flag) → survives; new → reaped |
| PI-2 | 138 | Every kill surface (soxe stop, upgrade's rolling reap, singleton-heal) consults os-unit state first and unloads before reaping ([inv:unload-then-reap] everywhere, not just `service disable`); fix the false "never a real launchctl load" header comment in os-unit.ts | with a loaded KeepAlive unit, `soxe stop` leaves NO resurrected process 15s later | yes — bypass the unload (flag) → resurrection observed |
| PI-3 | 139 | Unified log keying by logical service id: `soxe logs --id=<ext>` finds ALL streams incl. proxy-backend logs (migrate/alias the `proxy-backend-<ext>` dirs) | `soxe logs --id=memory-server` lists backend + serve + unit streams in one output | no |
| PI-4 | 140 | `soxe ps`: one table merging supervisor registry + os-units (launchctl/systemctl) + proxy locks/sockets + an OS-truth pass (ps/lsof by socket+db ownership), flagging UNMANAGED/STALE rows, with per-process build hash + version. `soxe follow [--id]`: merged, prefixed, colorized live tail (docker-compose semantics) over the PI-3 layout | `soxe ps` on a machine with a planted unmanaged stray shows it flagged; `follow` interleaves two live streams in one pane | yes — planted stray must appear; hide-check (old status) recorded red |
| PI-5 | 141 | Upgrade/lockfile integrity: atomic lockfile write (temp+rename), hard failure when resolution yields zero members, post-upgrade cold-spawn gate (`soxe serve <ext>` must succeed with no pre-existing socket before upgrade reports success), `soxe status` flags lockfile-empty-but-registry-populated divergence | sabotage test: simulate the 2026-07-03 failure (empty resolved{}) → upgrade FAILS loudly; divergence flagged by status | yes |
| PI-6 | 142 | Ownership-ledger dedupe by (kind, file/path, keyPath) on write + one-time compaction migration | reinstall ×3 → exactly one entry per (kind,target); compaction shrinks the real ledger's duplicates (fixture copy) | no |
| PI-7 | 143 | `soxe serve` lockfile-miss error: cross-check install-registry + bundle manifests, print the exact repair command (`soxe install <bundle> --scope=…`) | error-message snapshot test for the exact 2026-07-03 scenario | no |

## Gate

Adversarial stray test: plant (a) a cross-build stray process, (b) a stale
proxy-backend lock naming a dead pid, (c) an orphaned socket file — `soxe ps` flags all
three, `soxe doctor --fix` clears all three, and a loaded KeepAlive unit killed via
`soxe stop` stays down. PI-5's sabotage suite green. All apps/sox + host-runtime +
install-engine suites green.

## Subdispatch notes

Good candidates: snapshot/fixture authoring for ps/logs output; the sabotage test
implementations; mechanical migration of log-dir naming; a verifier pass (own control:
un-flag the UNMANAGED detection → adversarial test red). Keep PI-1's identity scheme
and PI-2's kill-surface audit (finding every kill call site) yourself. Never run
destructive tests against the owner's real `~/.adhd`/`~/.memory` state — fixture roots
only (`SOX` data-root env overrides exist; use them).
