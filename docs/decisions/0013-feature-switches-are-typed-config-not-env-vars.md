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

**`SOX_ALLOW_AUTO_WAL_ASIDE` is deleted on this branch (bl373-sidecar-staleness).** It shipped in the
D6 work, was identified as the ADR's trigger case, and is now removed together with the whole
lossy auto-WAL-aside path: `recoverTruncatedWal` is gone and the truncated-WAL path emits the typed
operator-action error (the manual `mv …-wal …-wal.corrupt-<stamp>` with the data-loss disclosure,
or restore from backup) — the safe default, since a store that cannot open loses nothing by
waiting. Its compliant sibling `SOX_WAL_SIDECAR_STALE_THRESHOLD_MS` (numeric threshold) stays.

### Current state — env-var inventory and dispositions (surveyed 2026-08-11, `rg` across libs/ extensions/ apps/ tools/)

> Survey-coverage note (F4, 2026-08-11): the original inventory scanned `libs/ extensions/ apps/
> tools/` only — repo-root SPEC files (`SPEC-PKT-18.md`, `SPEC-BL-474.md`, `SPEC-PKT-38.md`) and
> handoff/observability docs were NOT surveyed and still documented deleted vars as live controls.
> Those references are annotated superseded/historical on the strip branch; future inventories
> should include repo-root `SPEC-*.md` and `docs/`.

**Violations — deleted or converted (owner directive #3: DELETE unless a real, documented,
operational purpose exists; only `SOX_SYNC_EMBED` had one):**

| Variable | Shape | Disposition (actual outcome, bl373 branch) |
|---|---|---|
| `SOX_ALLOW_AUTO_WAL_ASIDE` | presence gates auto WAL-aside (unmerged) | DELETED — the lossy auto-move is gone; Shape B is refusal-only with the typed operator-action error (ADR-0013 consequences, above) |
| `SOX_SYNC_EMBED` | `'1'` sync vs async embed (`embed-pipeline.ts:87`) | CONVERTED to config `embed.sync` default false (`EmbedConfig.sync`, documented purpose: deterministic synchronous write-embed with `near_dup` in the response for test/CI suites and operators who need it — a genuine operational mode, not a workaround; the async two-phase write stays the shipped default). Single choke point `syncEmbedEnabled()` reads `getConfiguredSyncEmbed()` |
| `SOX_HEAL_STALE_VECTORS` | `'1'` enables stale-vector heal pass (`embed-pipeline.ts:832`); also gated the typed operator surface | DELETED — `memory_curate reheal_stale` always works when invoked; the `disabled` result field is gone. No automatic tick is wired (re-embedding a whole store after a model swap stays an explicit operator decision) |
| `SOX_DISABLE_EMBED_HEAL` | `'1'` disables embed heal (SPEC-BL-474) | DELETED — heal is always on ("Disable heal???"); the `_drainDisabled` latch, the `HealResult.disabled` field, and the scheduleNextDrain first-arm gate are gone |
| `SOX_DISABLE_PERIODIC_ENRICH` | `'1'` disables periodic enrich (`memory-server:3054`) | DELETED — the in-process periodic tick (ADR-0007) is always on; a maintenance-mode pause, if ever needed, is a typed operator action, not an env var |
| `SOX_AUTO_BACKUP_ENABLED` | `'false'`/`'0'` disables backup (`backup.ts:342`) | DELETED — auto-backup always runs on restart; `SOX_AUTO_BACKUP_DIR` stays (D5 host config); the typed `BackupConfig` skeleton lands on this branch (see below) |
| `SOX_STORE_REPAIR` | `'off'` disables auto-repair (`integrity.ts:2449`) | DELETED — the store ALWAYS repairs what it finds (readonly stores excepted, which cannot write); `repairEnabled()` is gone, `verifyOnly` remains only as a typed API option for direct callers |
| `SOX_STORE_VERIFY` | `'off'` disables verification (`integrity.ts:2387`) | `'off'` REMOVED — verification always runs ≥ `'fast'`; a request for `off` now refuses loudly (throws naming the anti-feature). Rigor selection (`fast`/`deep`) kept |
| `SOX_STORE_VERIFY_SKIP` | probe-skip list for short-lived callers (`integrity.ts:2441`, BL-431) | KEPT as a documented operator lever — it is visible + reported (a skipped probe's finding reads "skipped by the caller … this store is NOT verified against it", status `unknown`, never `ok`), and its rationale is real (a one-shot `memory-cli` need not pay `json_column_valid`'s 262 ms on a 105 MB store). No production caller sets it today; test fixtures use it exactly as a short-lived caller would. Not a core-function disable — the probes it skips are bounded per-caller, and the skip is never silent |
| `SOX_MEMORY_LOG_DISABLE` | `'1'` suppresses all telemetry writes (`telemetry.ts:80`) | DELETED — logs are always writable; rotation caps (`SOX_MEMORY_LOG_MAX_BYTES`/`_MAX_FILES`) handle space. `currentLogFilePath()` never returns `null` for "we chose not to log" (only for an uncreatable writer) |

**Typed config homes landed on the strip branch (D2):** `libs/memory-core/src/config.ts` carries the
`BackupConfig` skeleton for the upcoming backup feature — `enabled: true` (typed literal — a
report-only dimension, unrepresentable as false; no `SOX_BACKUP_*` toggle may ever exist),
`intervalMs` default 6 h, `retentionCount` default 24, `dir` default `~/.memory/backups` with
precedence `config.backup.dir` (typed seam) → `SOX_AUTO_BACKUP_DIR` (D5, kept) → default. The
full backup feature (timer, retention prune, backupOnOpen) lands separately on top of this
skeleton.

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
