# TRUNCATE-checkpoint-under-writer-slot experiment — INCONCLUSIVE (could not reproduce baseline)

**Date:** 2026-08-17
**Scope:** Settle whether `PRAGMA wal_checkpoint(TRUNCATE)` is safe under N concurrent writer
processes WITHOUT the app-level quiescence gate, specifically while holding multiprocess WAL's
writer slot. Experiment only — no shipped source touched. Harness lives entirely under
`/private/tmp/claude-502/.../scratchpad/truncate-exp/` (scratch, not committed).

## Verdict

**Could not reproduce the baseline failure (#8348's 3/20 SIGABRT).** Per the experiment's own
stop condition ("if you cannot reproduce the baseline failure, STOP and report that immediately —
every downstream conclusion depends on the harness being able to show the failure at all"), arms
2–4 (gated-at-close, writer-slot-mid-transaction, idle-triggered) were **not run** — there is no
value in comparing crash rates against arms that never diverged from a baseline that itself never
crashed. This is a negative/inconclusive result, not a safety proof for ungated TRUNCATE.

## What was attempted

Harness: `@tursodatabase/database@0.7.1` (matches the version pinned in
`libs/data/store/store-adapter/package.json:28`), macOS arm64 (`Darwin 24.0.0 arm64`, same
platform as the owner's #8348 report), Node 24.11.1. Each trial: fresh `mkdtemp` scratch store,
schema created in one prior sequential process (isolates the *separate*, already-known
"`Database is already open without experimental multiprocess WAL`" open-handshake race —
`turso-adapter.ts:609` — from the checkpoint race under test; the worker harness retries that one
open race with the same 100/200ms backoff `turso-adapter.ts` uses, so it never gets counted as a
"crash"), then N concurrent short-lived Node child processes each connect with
`experimental: ['index_method', 'multiprocess_wal']`, write, and run
`PRAGMA wal_checkpoint(TRUNCATE)` ungated at close (baseline arm). A separate verification process
then re-opens the store, runs `integrity_check` (classified via the real
`classifyIntegrityMessages` from `libs/data/store/store-adapter/dist/index.js`, not a hand-rolled
filter), and counts rows to check durability.

Configurations tried, all baseline arm, all zero crashes / zero corruption:

| Config | N | writes/proc | trials | total procs | crashes |
|---|---|---|---|---|---|
| plain, small values | 20 | 25 | 10 | 200 | 0 |
| plain, small values, very short-lived (1 write) | 20 | 1 | 15 | 300 | 0 |
| barrier-synced + aged `-tshm` sidecar (>60s stale, matching #8348's documented deterministic-repro precondition) | 20 | 1 | 10 | 200 | 0 |
| barrier-synced + aged `-tshm` + primed 8KB-payload WAL (forces overflow-page chains — the crash is specifically in `BTreeCursor::process_overflow_read`, which only fires for overflow pages) + 8KB writes | 8 (matches the issue's own 8-way isolated repro) | 1 | 10 | 80 | 0 |
| natural concurrent spawn (no barrier) + primed 8KB WAL + 8KB writes | 20 | 5 | 20 | 400 | 0 |

**Total: 1180 concurrent writer-process trials, 0 SIGABRT, 0 integrity damage, 0 durability
mismatches, across every configuration attempted.**

## Why this is inconclusive, not a clean bill of health

`tursodatabase/turso#8348`'s own body distinguishes two repro shapes:

1. The *observed* production-shaped scenario: "20 concurrent short-lived writer processes... 3/20
   died" — no stated precondition beyond concurrency + TRUNCATE + multiprocess WAL.
2. The *deterministic, isolated* repro: 8-way, barrier-synced, against "a scratch store with an
   aged WAL-index sidecar (tshm mtime frozen >60s under multiprocess coordination)", explicitly
   noting a **contrast control** — "fresh tshm, sub-threshold age, same 6-8 writers: failures drop
   to the handshake-refusal class only, no panic, no short-read." That sentence says the owner's
   own control arm (fresh tshm) *also* failed to reproduce the panic — matching what this harness
   found across every configuration. The isolated repro additionally notes it is "reproducible via
   the core multiprocess_tests harness shape" — i.e. the Rust-internal test harness, which may
   exercise timing/scheduling this JS-binding-level harness structurally cannot reach (this
   harness cannot control the engine's internal frame-read scheduling, only process-level
   spawn/connect/write/checkpoint timing).

So the aged-`-tshm` precondition this harness reproduced (verified `tshmAged: true` on every
attempt) matches the documented precondition, but 0/200 crashed here where the owner's isolated
8-way repro reported 3/8. Candidate explanations, none confirmed:

- Timing granularity: this harness's "barrier" is a 2ms-poll on a marker file, coarser than
  whatever synchronization actually produces the frame-pread-vs-truncate race at the Rust I/O
  layer.
- The exact WAL byte offset in the panic (107152) implies a specific frame-boundary alignment this
  harness's payload sizes (8000-byte text, ~2 pages of overflow) never hit.
- 3/20 or 3/8 is a low-probability race even under the owner's own harness — with no visibility
  into that harness's exact mechanics, 200–400 trials per configuration here may simply be
  insufficient to hit the same narrow window, especially if the true trigger probability per
  attempt is materially lower than 3/8 in a JS-binding-driven harness vs. whatever produced the
  owner's isolated repro.

## What this does NOT settle

- Whether the writer slot confers safety for ungated mid-transaction TRUNCATE (arm 3) — not
  tested, per the stop condition.
- Whether `write-queue.ts`'s months of incident-free ungated idle-triggered TRUNCATE
  (`write-queue.ts:670-693`) is safe *because* of the writer slot, or safe *because* its
  effective concurrency has stayed at 1 in practice — still open.
- Any N-threshold between "safe" and "unsafe" — no threshold observed because nothing crashed at
  any N tried (2, 8, 20).

## Recommendation

Do not treat this as evidence that ungated TRUNCATE is safe. Do not treat it as evidence it is
unsafe either — #7833/#8348 remain open, verified-real defects (already confirmed via live GitHub
API fetch: #8348 open, filed by this org's own account, body re-read in full for this experiment).
The honest state is: **the failure mode is real and documented, but not reproducible by this
harness within the time budget spent (1180 trials, multiple configurations matching the
documented precondition).** If this question needs settling further, the next step is either (a)
get the owner's exact `multiprocess_tests`-shaped Rust harness or exact JS reproduction script
that produced the 3/8 result, or (b) treat the upstream issue's own report as the only available
evidence and continue to gate TRUNCATE at the app level (current shipped behavior,
`storeQuiescence()`, 9 references in `turso-adapter.ts`) as the conservative default until either
upstream fixes the assert or a reproducible local repro says otherwise.

## Harness location (scratch, not committed)

`/private/tmp/claude-502/-Users-nix-dev-ai-sox-ecosystem/c899d6b8-aeb3-43e4-875c-846f92d311a5/scratchpad/truncate-exp/`
— `worker.mjs`, `setup.mjs`, `prime.mjs`, `verify.mjs`, `run-trial.mjs`, `batch.mjs`, `logs/*.jsonl`
(raw per-trial results for every configuration above).
