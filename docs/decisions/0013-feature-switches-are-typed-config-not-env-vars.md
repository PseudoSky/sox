# ADR-0013 — Feature switches are typed config, never environment variables

**Status:** ACCEPTED (2026-08-11).
**Owner:** pseudosky.
**Grounding:** owner directive (verbatim — "SOX_ALLOW_AUTO_WAL_ASIDE is a huge antipattern that I
want generally banned by an ADR - never create env vars that enable or disable features"), the D6
BL-373 WAL-aside design that triggered it, and the env-policy/BL-344 incident this ADR's context
draws on.

## Context

The trigger was `SOX_ALLOW_AUTO_WAL_ASIDE` — a D6/BL-373 design (unmerged; recorded in
`docs/reporting/memory/findings/2026-08-11-dispatcher-session-state.md`) for a "last resort"
auto-recovery that moves a truncated Turso WAL aside. Its presence flips behavior: with `=1` the
server silently moves the WAL and reopens; without it, the server emits a typed operator-action
error. Three properties make this class of variable poisonous:

1. **Silent behavior change.** The active mode of a deployment is invisible — the same artifact runs
   a different recovery policy depending on an ambient string no one can see from the deployment.
2. **Silence masks data loss.** A variable that "enables recovery" reads as a safety net while
   actually being a mute button for the operator signal. Auto-moving a truncated WAL destroys the
   evidence an operator needs to diagnose it.
3. **A service can be 'running' while broken.** This is not hypothetical — it happened in-repo
   before this variable existed. `env-policy.ts:28-34` records that `SOX_DISABLE_EMBED_HEAL` was
   set on the live launchd unit to mitigate a read outage and had **zero effect**, because one of
   five hand-maintained spawn-time env copies scrubbed it away before the backend spawned: the var
   was present in the `.plist` and absent from `ps eww <backend-pid>` — verifying the plist
   produced a false green. `SOX_RECALL_EMBED_TIMEOUT_MS` and all four `SOX_MEMORY_LOG_*` controls
   shipped non-functional in the deployed configuration on their first outing, and nothing reported
   it.

Feature switches belong where they can be seen, validated, and audited: the typed config object.
The machinery already exists (config-cascade → `SOX_CONFIG_*` injection at `loader.ts:290`; the
env-policy deny-list for host-authoritative namespaces at `env-policy.ts:110`). This ADR makes the
boundary explicit.

## Decision

**Never create environment variables that enable or disable features.**

### D1 — No new `SOX_*` env var whose value toggles behavior on/off

No `VAR=1 enables X`, no `VAR=off disables Y`, no presence-gated `if (!process.env.X)`. If a code
path can take two different behaviors, the switch is a typed field.

### D2 — Feature switches are typed config, default-explicit, and reported

A behavior switch is injected as typed config in the config object / constructor options (via the
existing config cascade), with an explicit default, and its resolved value is surfaced in telemetry
and the health surface so an operator can see the active mode from one call. Precedent:
`memory_stats` reports `embed_backend_configured`.

### D3 — Tuning constants MAY stay env-tunable, with hard limits

Thresholds, budgets, and floors (timeouts, ceilings, stall thresholds) may remain env-tunable, but
MUST be additive/numeric and never gate a code path. A `=off` value that turns off the mechanism is
a toggle, not tuning. Parse failures must be loud (precedent: `SOX_ENRICH_STALL_THRESHOLD_MS`
rejects `'banana'`).

### D4 — One-shot operator actions are explicit invocations, never env-gated

A destructive repair or one-shot recovery is a CLI subcommand or typed API call the caller invokes,
and that reports what it did. It is never armed by an env var. Precedent:
`memory_curate reheal_stale` — a bounded, operator-invoked pass with honest `remaining` counts.

### D5 — Host-injected env (paths, ports, credentials, policy) is config, not a toggle, and stays

`SOX_CONFIG_*` (config cascade), `SOX_PERM_*` (compiled policy), `TURSO_DB_URL`/`TURSO_AUTH_TOKEN`,
`SOX_ECOSYSTEM_HOME`, `SOX_RUNTIME_FILE` are injection channels, not switches. Keep them, and keep
them host-authoritative: deny-listed from ambient inheritance and re-injected at spawn
(`env-policy.ts:110`). Flagged: `SOX_PERM_ENFORCE` uses presence-semantics (toggle-shaped) — keep,
but prefer explicit value semantics; the deny-list is what makes it safe.

## Consequences

**`SOX_ALLOW_AUTO_WAL_ASIDE` is deleted on merge.** It never shipped (unmerged D6 work); the
auto-move is removed from the design and the truncated-WAL path emits the typed operator-action
error — the safe default, since a store that cannot open loses nothing by waiting. Its compliant
sibling `SOX_WAL_SIDECAR_STALE_THRESHOLD_MS` (numeric threshold) stays.

### Current state — env-var inventory and dispositions (surveyed 2026-08-11, `rg` across libs/ extensions/ apps/ tools/)

**Violations — convert to typed config (or delete):**

| Variable | Shape | Disposition |
|---|---|---|
| `SOX_ALLOW_AUTO_WAL_ASIDE` | presence gates auto WAL-aside (unmerged) | DELETE on merge |
| `SOX_SYNC_EMBED` | `'1'` sync vs async embed (`embed-pipeline.ts:87`) | convert to config `embed.sync` default false; single choke point `syncEmbedEnabled()` |
| `SOX_HEAL_STALE_VECTORS` | `'1'` enables stale-vector heal pass (`embed-pipeline.ts:832`); also required for the typed operator surface (`memory-server:710`) | DELETE the gate — `memory_curate reheal_stale` is the operator action; an automatic pass, if ever wired, is config default-off + reported |
| `SOX_DISABLE_EMBED_HEAL` | `'1'` disables embed heal (SPEC-BL-474) | convert to config `embed.heal_enabled` default true |
| `SOX_DISABLE_PERIODIC_ENRICH` | `'1'` disables periodic enrich (`memory-server:3054`) | convert to config `enrich.periodic.enabled` default true |
| `SOX_AUTO_BACKUP_ENABLED` | `'false'`/`'0'` disables backup (`backup.ts:342`) | convert to config `backup.enabled` default true |
| `SOX_STORE_REPAIR` | `'off'` disables auto-repair (`integrity.ts:2449`) — the WAL-aside family | convert to config `verify.repair_enabled` default true, reported; detection always on |
| `SOX_STORE_VERIFY` | `'off'` disables verification (`integrity.ts:2387`) | remove the `'off'` value — verification always runs ≥ `'fast'`; keep rigor selection |
| `SOX_STORE_VERIFY_SKIP` | probe-skip list for short-lived callers (`integrity.ts:2441`, BL-431) | border: keep as an explicit, visible operator lever; move to config for long-lived services |
| `SOX_MEMORY_LOG_DISABLE` | `'1'` suppresses all telemetry writes (`telemetry.ts:80`) | border: disables diagnostics, not a feature; keep as operator lever, prefer config `log.enabled` |

**Border — selection, not toggle (keep):** `STORE_ADAPTER` — closed validated union
(`'sqlite'|'turso'`), error on unknown (`factory.ts:24`); preferred injection is typed
`AdapterConfig`, env is the fallback. `SOX_EMBED_BACKEND` — validated union (`'auto'|'real'`),
throws on unknown, reported (`embed.ts:65`). `SOX_PROXY_BACKEND` (+ `_SOCKET`/`_SCHEMA`) —
host-injected transport selection at spawn (`memory-server:872`). `SOX_EMBED_EXECUTION_PROVIDER`,
`SOX_EMBED_FORCE_UNAVAILABLE`, `SOX_RUN_EMBED_DOWNLOAD_TESTS` — test/diagnostic forcing; never
operator knobs.

**Tuning — keep per D3:** `SOX_WAL_SIDECAR_STALE_THRESHOLD_MS`, `SOX_ENRICH_STALL_THRESHOLD_MS`,
`SOX_RECALL_EMBED_TIMEOUT_MS`, `SOX_MEMORY_LOG_LEVEL`/`_MAX_BYTES`/`_MAX_FILES`/`_SYNC` (`_SYNC`
border: durability choice, keep as tuning), `SOX_CONFIG_RECALL_CEILING_MS`.

**Host config — keep per D5:** `SOX_CONFIG_DB_PATH`/`_PORT`/`_HOST`/`_SOCK_PATH`/`_MAP_PATH`/
`_CAPTURE_DIR` (config cascade, `loader.ts:290`), `SOX_PERM_ENFORCE`/`_FS_READ`/`_FS_WRITE`
(compiled policy; presence-semantics flagged), `SOX_ECOSYSTEM_HOME`, `SOX_RUNTIME_FILE`,
`TURSO_DB_URL`, `TURSO_AUTH_TOKEN`, `SOX_AUTO_BACKUP_DIR`.

**Dev tooling (not shipped config):** `SOX_AGENT_NAME`, `SOX_PROTOCOL_PATH`.

### Enforcement

- New PRs introducing a behavior-switching `SOX_*` env var are rejected.
- `env-policy.ts` remains the single list of forwardable `SOX_*` vars; adding an operator toggle to
  it is the review tripwire.
- Reviewers treat `SOX_*=off` / presence-gated behavior in shipped code as this ADR's violation
  class (the same posture ADR-0012 takes on taxonomy gaps).

## What does NOT change

Tuning env vars, adapter/backend selection from closed unions, host-injected
config/credentials/policy, and test-only forcing vars are all untouched by this ADR. The env-policy
scrub (BL-344) stays — it is the enforcement layer that makes D5 safe.
