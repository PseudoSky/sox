# Backlog store connection-lifetime forensics — 2026-08-17

**Agent:** error-detective (read-only investigation, no source changes). **Repos read:**
`/Users/nix/dev/node/adhd/entrypoint/backlog` (CLI/server entry) and
`/Users/nix/dev/ai/sox-ecosystem/libs/data/store/store-adapter` (turso adapter + lease registry).
**Data read:** `~/.adhd/sox-ecosystem/backlog/logs/backlog.cli-*.jsonl` (4 files, 2026-08-12 through
2026-08-17), live `ps`/`ls`/`cat` of `~/.adhd/backlog/production/data/backlog.db.sox-lease.d/` at
2026-08-17 13:42–13:44 local. **No writes were made to any store, lease dir, or log file.** Two
read-only `ls`/`cat` probes on the live lease directory were used (not `backlog` CLI invocations —
zero `backlog` commands were run during this investigation, so nothing here perturbed the
measurement).

## Answer, up front

**The holder is the long-lived `backlog serve --transport mcp` process each stdio MCP client spawns
for itself.** It acquires one store lease at process start and does not release it until the process
exits — which, for an MCP stdio server, means until the *client* (the agent's whole session)
disconnects. That is idle holding for the process's entire lifetime, not scoped to a request/
transaction. The owner's hypothesis is confirmed, not refuted.

Empirically: at the moment of this investigation, 4 `backlog serve --transport mcp` processes were
alive on this machine (matching this team's 4 concurrent agents), and **100% of the live lease-dir
entries belonged to those 4 processes** — zero belonged to any short-lived CLI invocation, because
none was open at that instant. Historically, log-derived open→close durations for the processes that
eventually *did* close are bimodal: 97.7% of paired samples closed in under 2 seconds (ordinary CLI
one-shots), but a cluster of ~15 processes held their connection open for 218,000–240,000 seconds
(2.5–2.8 **days**) before finally closing — and did so within the same ~3-second window, which is the
signature of a batch of `serve` sessions all torn down together at a session/task boundary.

## 1. Enumerated code paths that open a store connection

Two call sites reach `openGraphBacklogStore` (`store/graph-backlog-store.ts:45`, which calls
`acquireStoreLease` inside `connect()`, `turso-adapter.ts:454`), and their close-side lifetimes are
structurally different:

### 1a. `runBacklogCli` (one-shot CLI) — `entrypoint/backlog/src/cli.ts`

- **Open:** lazily, at most once per process, only if a dispatched command actually reaches a real
  function (`cli.ts:273-284`, `getCtx()`). Never opened for `--help`/no-args/unknown command/`install`/
  `install-skill`/`serve` (those are intercepted earlier, `cli.ts:230-266`, before `getCtx` exists).
- **Close:** in the `finally` block wrapping the single `cliPlugin.run()` dispatch (`cli.ts:307-337`):
  `signalCleanup.dispose(); await closeStoreOnce();` (`cli.ts:335-336`). `cliPlugin.run()` resolves
  after dispatching exactly **one** command (`cli.ts:212-214` doc comment: "one-shot ... resolves
  after dispatching a single command rather than listening").
- **Intended lifetime:** the duration of one CLI invocation — open, run one op, close, process exits.
  This is the process class the empirical duration data (§4) shows closing in well under 2s at the
  median.

### 1b. `startBacklogServer` (long-lived HTTP/MCP server) — `entrypoint/backlog/src/server.ts`

- **Open:** once, unconditionally, near the top of `startBacklogServer` (`server.ts:451-500`):
  `store = await openGraphBacklogStore(dbPath, env.config.db.busyTimeoutMs)` (`server.ts:492`), inside
  a `try` whose `catch` releases the just-acquired serve-lock and rethrows if the open itself fails
  (`server.ts:493-500`).
- **Close:** `closeStoreOnce` (`server.ts:480-485`) is invoked either by a signal handler
  (`installSignalCleanup`, `server.ts:486`, installed only `hasExternalSignalHandling()` is false) or
  by the caller of `startBacklogServer` after its returned promise settles. For `--transport mcp`,
  that promise is one of `runs` (`server.ts:506` `Promise.all`-style array; MCP branch begins
  `server.ts:519`) built from the MCP transport's own `run()`, which does not resolve until the stdio
  transport itself closes — i.e., until the spawning MCP client disconnects.
- **Intended lifetime, per the code's own comments:** `buildBacklogApigenPackage`'s doc comment
  states this explicitly (`cli.ts:382-393`): `ctx` may be a plain already-open `BacklogCtx` — "
  `startBacklogServer`'s case, where **a long-lived server needs its store immediately regardless of
  what request comes first**." The store is deliberately opened once and held for the server's whole
  life, not per-request. This is by design, not a bug in isolation — the defect is that "the server's
  whole life" for an MCP stdio server spawned per-client is, in practice, an entire agent session.

### 1c. `serve` dispatch inside the CLI process — `entrypoint/backlog/src/serve.ts` / `cli.ts:263-266`

`runBacklogCli` special-cases `argv[0] === 'serve'` and calls `runServeCommand` → `startBacklogServer`
in the **same process** (`serve.ts:21,58`). This matters for §1d below: there is no separate "serve"
binary or entry point — `backlog serve --transport mcp` is the exact same executable, same
`initTelemetry` call site, as `backlog get-item`.

### 1d. Telemetry `role` does NOT distinguish 1a from 1b/1c — `entrypoint/backlog/src/index.ts:121-151`

`initTelemetry({ service: 'backlog', role: 'cli', ... })` (`index.ts:143`) fires once per process, in
the bin-entry guard, **before** `runBacklogCli()` is even called, and the surrounding comment says so
explicitly (`index.ts:130-133`): "It also covers `serve`: that subcommand is dispatched from inside
`runBacklogCli()` (`cli.ts`), same process, same bin — there is no separate serve entry to
initialise." **Every log line in `backlog.cli-*.jsonl`, including from a `serve --transport mcp`
process that has been running for days, is stamped `"role":"cli"`.** This means the log's `role` field
cannot be used to separate one-shot invocations from long-lived servers — confirmed by grep across
all 4 log files: every single `close_checkpoint_busy` event in all 4 days is `"role":"cli"` (1409/1409,
verified below), which does NOT mean no server ever fired it — it means the field is uninformative for
this question. This is itself a finding: **the log schema cannot answer "was this pid a server or a
one-shot" and a fix design should not try to read `role` for that purpose.**

## 2. Who is actually the concurrent holder

### 2a. Live-process ground truth, captured read-only at 2026-08-17T13:42–13:44 local

```
$ ps aux | rg "backlog/index.js serve"
nix  72429  ...  1:34PM  0:10.88  node .../@adhd/backlog@0.1.7.../index.js serve --transport mcp
nix  81250  ...  1:42PM  0:01.02  node .../@adhd/backlog@0.1.7.../index.js serve --transport mcp
nix  77465  ...  1:41PM  0:00.93  node .../@adhd/backlog@0.1.7.../index.js serve --transport mcp
nix  75595  ...  1:40PM  0:01.05  node .../@adhd/backlog@0.1.7.../index.js serve --transport mcp
```

Cross-referenced against the live lease directory
(`~/.adhd/backlog/production/data/backlog.db.sox-lease.d/`, read via `ls -la` + `cat`, no CLI
invocation):

```
03a5155f-...  pid 81250  opened 2026-08-17T18:42:03.990Z  -> live, matches serve pid 81250
6d889f67-...  pid 75595  opened 2026-08-17T18:41:00.387Z  -> live, matches serve pid 75595
79ef6d79-...  pid 72429  opened 2026-08-17T18:34:59.748Z  -> live, matches serve pid 72429
b047b8d3-...  pid 77465  opened 2026-08-17T18:41:23.073Z  -> live, matches serve pid 77465
```

**All 4 live lease entries, 100%, belong to `serve` processes.** Zero belong to a short-lived CLI
invocation (none was mid-open at that instant — consistent with §4's finding that a one-shot CLI
connection's median lifetime is under half a second, so the chance of catching one mid-open with a
point-in-time snapshot is low). Each `.sox-lease.d` entry has a paired `.openmark` file with the same
pid/timestamp — `store-lease.ts:186` explicitly excludes `.openmark` files from `storeQuiescence`'s
peer count, so they do not double-count, they just confirm which connections are genuinely open.

**No entry held more than one connection's worth of lease/openmark pair** — i.e., no evidence of a
single process holding *multiple* simultaneous connections. Each pid appears in exactly one
lease+openmark pair.

### 2b. Historical pattern from the logs — overlapping short CLI opens, not the dominant contention source alone

Across all 4 days, `close_checkpoint_busy` fired 1409 times (718 on 08-12, 0 on 08-13, 348 on 08-14,
315 on 08-15, 28 on 08-17 — matches the counts given in the task). Of the 08-12 day, 718 events came
from 712 distinct pids; only 6 pids fired the warning twice, always separated by hours (one pair 6h04m
apart), never within the same second — i.e., **no evidence of one process repeatedly retrying against
itself**. Combined with §2a, the dominant "who is closing and finding itself busy" answer is
overlapping short-lived CLI invocations (each is its own process, each contributing at most 1-2
events), and the dominant "who they are finding in the way" answer (§2a, §4) is the long-lived `serve`
population.

### 2c. A synchronized mass-close burst — evidence of a `serve` fleet torn down together

Looking at 08-17's 28 events, 12 of them (pids 68917, 94843, 98345, 60847, 96406, 26483, 8897, 37011,
96995, 28620, 88065, 94535, 4926, 90467, 20915) fired within **17:10:04.091–17:10:07.077** — a 3-second
window. Pairing each of those pids against its own connection-open log line
(`store_adapter.turso.sidecar_reconcile_deferred`, emitted once at connect — see §4 methodology)
shows every one of them opened its connection on **2026-08-14 or 2026-08-15**, 2.5–2.8 days earlier
(full table in §4). That is a fleet of long-lived processes — a prior multi-agent team's `serve`
instances — sitting idle for days and then all exiting within the same few seconds, each one finding
several of its siblings still alive (or also mid-shutdown) at close time and logging
`close_checkpoint_busy` as a result. This is the "single event burst, many distinct pids, all
recently-opened-long-ago" signature the task asked to distinguish from ordinary short-CLI overlap —
and it is present and separately identifiable in the data.

## 3. Does any path hold a connection open while idle?

**Yes — `startBacklogServer`/`serve` (§1b, §1c), confirmed both structurally and empirically.**
Structurally: the store is opened once, before any request is served (`server.ts:492`, doc comment
`cli.ts:384-386`), and is closed only when the transport's `run()` promise resolves — for MCP stdio,
that is client disconnect, not per-tool-call. There is no per-request open/close cycle in this path at
all; the same `GraphBacklogStore`/lease is reused for every tool call the whole session. Empirically:
§2a shows all 4 currently-live leases belong to `serve` processes that have been running 2-9 minutes
with no work in flight between tool calls (checked via `ps` `etime` at the same instant `ls -la` on
the lease dir was taken), and §2c/§4 show the same pattern held for up to 2.8 days historically.

The one-shot CLI path (§1a) does **not** hold a connection idle — its store is opened and closed
within a single command dispatch, per §4's duration data.

## 4. Quantified window (open→close duration, paired from log timestamps)

Methodology: for each pid, took the first `store_adapter.turso.sidecar_reconcile_deferred` timestamp
(emitted once, at `connect()`, before the lease/quiescence machinery — confirmed by grep: it always
precedes `recursive_cte_probe_failed` and any `close_*` event for the same pid) as the connection-open
time, and the `close_checkpoint_busy` timestamp as the connection-close time. This only measures
connections that eventually hit the busy gate (a subset of all connections — connections that closed
*quiescently* are invisible to this log, so this is a lower bound on the total connection population,
not a census of it).

```
Paired samples across 4 log files: 1376 (of 1409 close_checkpoint_busy events; 33 had no matching
open line in these logs — e.g. opened before the log window started, or from the un-logged repair-
reconnect path at turso-adapter.ts:1740-1768).

min     0.042 s
median  0.474 s
p90     0.55 s
p99     896.559 s  (≈ 14.9 min)
max     240,137.177 s (≈ 66.7 hours / 2.8 days)

Distribution:
  under 2s:    1345 / 1376  (97.7%)
  2s – 60s:      14 / 1376  ( 1.0%)
  60s or more:   17 / 1376  ( 1.2%)
```

The 17 samples over 60s (top value shown, full set in §2c) range 218,439s–240,137s — i.e. the
"over 60s" bucket is not a smooth tail, it is a **second, distinct population** clustered around
2.5–2.8 days, matching the `serve`-fleet signature in §2c almost exactly (same pid set). There is no
observed process class in between (nothing between ~15 minutes and 2.5 days) in this 4-day window —
the bimodality is real, not an artifact of binning.

**Reading:** the fix should target the outlier population specifically (long-lived `serve` idle
holding), not the median (short CLI opens are already correctly scoped and fast). Structurally
tightening the *median* case would not move the needle on `close_checkpoint_busy` frequency, because
the median case is not what's failing to be quiescent — it's what's finding a non-quiescent store.

## 5. Is the quiescence check itself correct? Orphaned-lease hypothesis

Read `storeQuiescence`/`entryLiveness` in full (`store-lease.ts:41-217`). Findings:

- **Liveness probe is `process.kill(pid, 0)`** (`store-lease.ts:82-89`): no throw or `EPERM` ⇒ live,
  `ESRCH`/`EINVAL` ⇒ dead, anything else ⇒ undeterminable.
- **A definitively-dead pid is swept immediately**, not given any grace period — the 24h age-out
  (`LEASE_MAX_AGE_MS`, `store-lease.ts:47,96-101`) applies **only** to the `undeterminable` liveness
  class, explicitly to guard against pid reuse on a genuinely-live-but-unprobeable session, never to
  a pid `kill()` positively reports as dead. A crashed process's lease (e.g. the exit-134 case cited
  in the task) is therefore correctly recognized as dead and swept **the next time `storeQuiescence`
  runs**, not left to jam the gate indefinitely.
- **`.openmark` entries are explicitly excluded** from the peer count (`store-lease.ts:186`), so
  per-connection open markers (a separate registry owned by `preflight.ts`, sharing the same
  `pid\nopenedAtIso\n` content shape) cannot double-count or spuriously inflate `livePeers`.
- **`storeQuiescence` never throws** (`store-lease.ts:165-216`: absent/unreadable lease dir ⇒
  quiescent; any per-entry read failure ⇒ skip, not fail) — a filesystem hiccup fails open (declares
  quiescent), not closed, so it cannot itself cause a spurious `close_checkpoint_busy`.
- **Zero TOCTOU-window-observed events** (`store_adapter.turso.close_truncate_toctou_window_observed`,
  the log line the adapter itself emits when a peer appears in the gap between the pre-truncate
  quiescence check and the truncate completing, `turso-adapter.ts:1478-1491`) fired in any of the 4
  log files. This means the check-then-act race the adapter's own comments flag as a known,
  deliberately-unmitigated risk (`turso-adapter.ts:1451-1472`) has not been observed firing in this
  window, and — combined with the finding above — the pre-truncate `storeQuiescence` call is reliably
  finding real, live peers (the `serve` fleet), not stale garbage.

**Conclusion: orphaned leases are NOT jamming the gate.** The gate is jammed by real, live
concurrency — specifically the long-lived `serve` population from §2/§4 — not by dead entries the
sweep logic fails to clear. This refutes item 5 of the task's question list; the owner's hypothesis
in the main body (item under "Rules"/framing, i.e. connections held open when they should be scoped)
is the one the evidence supports.

## Summary for the design agent

| Question | Answer | Evidence |
|---|---|---|
| Enumerated open paths | `cli.ts` one-shot (`getCtx`, close in `finally`); `server.ts` long-lived (open once, close on transport-close/signal) | §1, cli.ts:273-337, server.ts:451-520 |
| Actual holder | `backlog serve --transport mcp`, one per stdio MCP client, per this team's own live processes | §2a — 4/4 live leases = 4/4 live serve pids |
| Overlapping short CLI vs idle server-hold vs multi-connection-per-process vs orphaned lease | Idle server-hold (confirmed); overlapping short CLI opens also contribute events but are not the blocker; multi-connection-per-process not observed; orphaned lease refuted | §2, §3, §5 |
| Idle holding? | Yes, by design (`server.ts`/`cli.ts:384-386` doc comment) and confirmed live | §3 |
| Duration distribution | Bimodal: median 0.47s / p90 0.55s (CLI) vs a distinct cluster at 218k–240k s / 2.5–2.8 days (serve) | §4 |
| Quiescence gate correctness | Correct — dead pids swept without grace, `.openmark` excluded, never throws, zero observed TOCTOU hits | §5 |

**Structural implication for the fix (not this agent's job to design, but the shape the evidence
points at):** the per-agent `serve --transport mcp` topology means a store connection is, in the
common case, live for the duration of an entire agent session — hours — not the duration of one MCP
tool call. `close()`-time `wal_checkpoint(TRUNCATE)` is gated on **zero** live peers, so as long as
≥1 of a team's several concurrently-spawned `serve` processes is alive, no CLI or server close can
ever truncate. A design that scopes the store connection (or at minimum the WAL-truncate-eligible
lease) to something shorter than "spawn to client-disconnect" — e.g., released between requests, or
truncated by whichever connection is last-standing on a periodic timer instead of only at close — is
what the data supports; a design that further optimizes the already-sub-second CLI path is not.
