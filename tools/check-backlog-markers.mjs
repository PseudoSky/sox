#!/usr/bin/env node
/**
 * check-backlog-markers — RETIRED ([ADR-0011] Stage 3, see SPEC-DELETE-FILES.md D4).
 *
 * This tool used to validate the `### BL-<n>` heading grammar of the shared root `BACKLOG.md`
 * (bold-status-span rules, duplicate-id detection, the "Total open: N" header count). That file
 * no longer exists — `BACKLOG.md`/`CHANGELOG.md` were deleted in this same change, and the graph
 * (queried via `tools/plan-status.mjs`, itself repointed at the `backlog` CLI) is now the sole
 * source of truth for `BL-*` status. The split-brain this script guarded against (a hand-written
 * heading whose grammar drifted from what the "Total open" count claimed) is now structurally
 * impossible — there is no heading to write.
 *
 * This script is reachable today only by direct manual invocation (habit, or a stray doc
 * reference) — nothing automated calls it any more (its only automated caller,
 * `check-bl-id-integrity.mjs`'s internal delegation, was removed in the same change). Its default
 * invocation therefore refuses outright, following `allocate-bl-id.mjs`'s established retirement
 * shape: `--help`/`-h` still print usage and exit 0 with zero I/O (BL-446 non-regression); any
 * other invocation prints a retirement message and exits 1 — a check that silently "passed"
 * would be indistinguishable from a check that never ran, which defeats the entire point of a
 * guard (see SPEC-DELETE-FILES.md D4's losing alternative).
 *
 * Use `node tools/plan-status.mjs [--check]` and the `backlog` CLI/MCP tools instead. See
 * CONTRIBUTING.md §1.9.
 *
 * Usage:
 *   node tools/check-backlog-markers.mjs               # RETIRED — prints a retirement message, exits 1
 *   node tools/check-backlog-markers.mjs --fix          # RETIRED — prints a retirement message, exits 1
 *   node tools/check-backlog-markers.mjs --help | -h    # print this usage, no git/file I/O at all
 */

const USAGE = `check-backlog-markers — RETIRED (ADR-0011 Stage 3)

Usage:
  node tools/check-backlog-markers.mjs               # RETIRED — prints a retirement message, exits 1
  node tools/check-backlog-markers.mjs --fix          # RETIRED — prints a retirement message, exits 1
  node tools/check-backlog-markers.mjs --help | -h    # print this usage, no git/file I/O at all

BACKLOG.md no longer exists. Use \`node tools/plan-status.mjs [--check]\` and the backlog
CLI/MCP tools instead. See CONTRIBUTING.md §1.9.`;

const RETIREMENT_MESSAGE = `check-backlog-markers: RETIRED (ADR-0011 Stage 3). This tool used to validate BACKLOG.md's
heading grammar — that file was deleted (see docs/decisions/0011-backlog-tool-write-destination.md
§4 Stage 3). The backlog graph is now the sole source of truth for BL-* status; there is no
markdown heading left to validate.

Use instead:
  node tools/plan-status.mjs --check       # derived-plan staleness guard, sourced from the graph
  backlog list-items / backlog get-item    # query the graph directly

See CONTRIBUTING.md §1.9 for the full procedure. No BACKLOG.md read occurred.`;

// [BL-446] Parse argv BEFORE any git/file I/O — --help must never touch git or the filesystem,
// and an unrecognized flag must never fall through to running the (retired) check silently.
const args = process.argv.slice(2);
const HELP = args.includes('--help') || args.includes('-h');
const FIX = args.includes('--fix');
const recognized = new Set(['--help', '-h', '--fix']);
const unrecognized = args.filter((a) => !recognized.has(a));

if (HELP) {
  console.log(USAGE);
  process.exit(0);
}
if (unrecognized.length > 0) {
  for (const a of unrecognized) {
    console.error(`check-backlog-markers: unrecognized argument '${a}'. Run with --help for usage.`);
  }
  process.exit(1);
}

// The default (validate) path and --fix are retired identically — zero filesystem writes, zero
// git calls, in either path. FIX is still parsed above (so --fix remains a recognized flag, not
// an "unrecognized argument" error) but deliberately has no effect on the outcome below.
void FIX;
console.error(RETIREMENT_MESSAGE);
process.exit(1);
