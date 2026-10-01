# s3 — Leak-gate observability fix (`2bf0b7c8`)

## Goal

Make `fts-optimize-leak-gate.bl-c5249cdd.spec.ts` legible in **every** outcome.

## Problem

TEST 1 (`:96-117`) asserts A (leak reproduces, `:102`) before B (version pin, `:107`).
vitest throws on the first failure, so when the leak **still reproduces on a bumped
driver** (A passes, B fails) the run prints only the version mismatch and **no
`page_count`**.

## Work

Compute `interleaved` and `single` **unconditionally**, then assert on a single combined
object so both numbers are always in the thrown message (single-assertion restructure —
not a reporter hook). Keep the leak fact and the version-pin fact as separate fields of
that object so neither masks the other.

## Deliverable

Rewritten TEST 1 + `fts-gate-evidence.bl-2bf0b7c8.spec.ts` (drives the A-passes/B-fails
path; asserts the thrown message contains both values; RED before, GREEN after).

## Constraints

Do **not** weaken or delete the leak assertion, and do **not** delete the 0.7.1 control
path — the differential must stay demonstrable (`89849d2a`). Independent of s1; may run
in parallel.
