#!/usr/bin/env node
/**
 * allocate-bl-id — RETIRED (ADR-0011 Stage 2, see SPEC-ADR-0011-S2.md).
 *
 * This tool used to reserve a BL-<n> and append a `RESERVED` placeholder heading straight into
 * the shared BACKLOG.md — exactly the write path ADR-0011 exists to retire. That write was a
 * live, currently-firing defect (BL-475: this tool broke the shared pre-commit gate for every
 * concurrent agent twice in one day, once aborting a `git merge` into main, once leaving a stub
 * that tripped check-backlog-markers.mjs until cleared by hand). Both the default reservation
 * path and `--dry-run` (which only ever previewed the same deprecated markdown-side id) are
 * retired identically — see SPEC-ADR-0011-S2.md Decision D2. `--help` is unaffected (BL-446
 * non-regression).
 *
 * File new BL-* items through the backlog tool instead — see CONTRIBUTING.md §1.9:
 *
 *   1. node tools/bl-id-counter.mjs                 # reserve the next id, e.g. BL-479
 *   2. mcp__backlog__backlog_create_item({ data: { input: { family: "BL", title: "...",
 *      body: "...", repo: "sox-ecosystem", idOverride: "BL-479" } } })
 *
 * --- Historical prose, kept for BL-359/BL-416/BL-475 archaeology ---
 *
 * This script used to fix two independent failure modes of "read the current maximum
 * `### BL-<n>` heading and add one": a RACE (two agents reading the same max before either
 * wrote — BL-344, BL-354) and a BLIND SPOT (an id already resolved into CHANGELOG.md but never
 * counted, because the allocator only scanned BACKLOG.md headings — BL-395). It computed the max
 * across both files and took an exclusive mkdir-based lock before appending a placeholder
 * heading to the shared `BACKLOG.md` (resolved via `git rev-parse --git-common-dir` + '..', per
 * BL-416's "registry is shared, not per-worktree" ruling) so no two callers could compute the
 * same "next" id. None of that machinery performs any I/O any longer — see below.
 */

const USAGE = `allocate-bl-id — RETIRED (ADR-0011 Stage 2)

Usage:
  node tools/allocate-bl-id.mjs                 # RETIRED — prints a retirement message, exits 1
  node tools/allocate-bl-id.mjs --dry-run        # RETIRED — prints a retirement message, exits 1
  node tools/allocate-bl-id.mjs --help | -h      # print this usage, no git/file I/O at all

File new BL-* items through the backlog tool instead:
  1. node tools/bl-id-counter.mjs                 # reserve the next id
  2. mcp__backlog__backlog_create_item({ data: { input: { ..., idOverride: "<id from step 1>" } } })
See CONTRIBUTING.md §1.9 for the full procedure.`;

const RETIREMENT_MESSAGE = `allocate-bl-id: RETIRED (ADR-0011 Stage 2). This tool used to reserve a BL-<n> and append a
RESERVED placeholder heading to BACKLOG.md — that write is exactly what ADR-0011 stops (see
docs/decisions/0011-backlog-tool-write-destination.md). File new BL-* items through the backlog
tool instead:

  1. node tools/bl-id-counter.mjs                 # reserve the next id, e.g. BL-479
  2. mcp__backlog__backlog_create_item({
       data: {
         input: {
           family: "BL",
           title: "<short title>",
           body: "<full item body>",
           repo: "sox-ecosystem",
           idOverride: "BL-479",   // from step 1 — never trust the tool's own auto-allocation
         },
       },
     })

See CONTRIBUTING.md §1.9 for the full procedure. No BACKLOG.md write occurred.`;

// [BL-446] Parse argv BEFORE any git/file I/O — --help must never touch git
// or the filesystem, and an unrecognized flag must never fall through to
// the mutating write path (the pre-fix bug: any typo'd flag silently
// reserved an id and appended a placeholder).
const args = process.argv.slice(2);
const HELP = args.includes('--help') || args.includes('-h');
const DRY_RUN = args.includes('--dry-run');
const recognized = new Set(['--help', '-h', '--dry-run']);
const unrecognized = args.filter((a) => !recognized.has(a));

if (HELP) {
  console.log(USAGE);
  process.exit(0);
}
if (unrecognized.length > 0) {
  for (const a of unrecognized) {
    console.error(`allocate-bl-id: unrecognized argument '${a}'. Run with --help for usage.`);
  }
  process.exit(1);
}

// Both the default (reservation) path and --dry-run are retired identically (Decision D2) —
// zero filesystem writes, zero git calls, in either path. DRY_RUN is still parsed above (so
// --dry-run remains a recognized flag, not an "unrecognized argument" error) but deliberately
// has no effect on the outcome below.
void DRY_RUN;
console.error(RETIREMENT_MESSAGE);
process.exit(1);
