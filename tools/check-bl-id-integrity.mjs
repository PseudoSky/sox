#!/usr/bin/env node
/**
 * check-bl-id-integrity — RETIRED ([ADR-0011] Stage 3, see SPEC-DELETE-FILES.md D4/D5).
 *
 * This tool used to guard against BL-id collisions between two write surfaces — a hand-edited
 * `### BL-<n>` heading in the shared root `BACKLOG.md` and a tool-filed graph item — the exact
 * split-brain the two-store migration (ADR-0011) was designed to eliminate. `BACKLOG.md` and
 * `CHANGELOG.md` were deleted in this same change, and the backlog graph is now the ONLY place a
 * `BL-*` id can be minted (`backlog_create_item`, no `idOverride` — `computeNextHumanId` is safe
 * now that there is no "elsewhere" left for an id to exist without the graph knowing about it; see
 * SPEC-DELETE-FILES.md D8). The id-collision category this script existed to catch is therefore
 * now STRUCTURALLY IMPOSSIBLE, not merely unguarded.
 *
 * This script's internal delegation to `check-backlog-markers.mjs` (itself retired in the same
 * change) has been removed entirely — calling a retired script and treating its exit 1 as "a real
 * rule-1 violation" would have produced a confusing false failure.
 *
 * IMPORTANT: unlike `check-backlog-markers.mjs`, this script was invoked UNCONDITIONALLY by
 * `.husky/pre-commit` on every single commit (no staged-file gate). That unconditional call has
 * been REMOVED from `.husky/pre-commit` in this same change (see SPEC-DELETE-FILES.md D4) — its
 * entire reason for running on every commit no longer applies once nothing writes markdown for
 * `BL-*` at all. This file is now, like `check-backlog-markers.mjs`, reachable only by direct
 * manual invocation, and gets the identical retirement treatment.
 *
 * Use the `backlog` CLI/MCP tools directly to query BL-* status. See CONTRIBUTING.md §1.9.
 *
 * Usage:
 *   node tools/check-bl-id-integrity.mjs               # RETIRED — prints a retirement message, exits 1
 *   node tools/check-bl-id-integrity.mjs --help | -h    # print this usage, no git/file I/O at all
 */

const USAGE = `check-bl-id-integrity — RETIRED (ADR-0011 Stage 3)

Usage:
  node tools/check-bl-id-integrity.mjs               # RETIRED — prints a retirement message, exits 1
  node tools/check-bl-id-integrity.mjs --help | -h    # print this usage, no git/file I/O at all

BACKLOG.md/CHANGELOG.md no longer exist, and this script is no longer wired into
.husky/pre-commit (it used to run unconditionally on every commit). The BL-id collision it
guarded against is now structurally impossible — the graph is the only place a BL-* id can be
minted. Use the backlog CLI/MCP tools directly to query BL-* status. See CONTRIBUTING.md §1.9.`;

const RETIREMENT_MESSAGE = `check-bl-id-integrity: RETIRED (ADR-0011 Stage 3). This tool used to guard against a hand-edited
BACKLOG.md heading colliding with a tool-filed graph item — both BACKLOG.md and CHANGELOG.md were
deleted (see docs/decisions/0011-backlog-tool-write-destination.md §4 Stage 3), and the graph is
now the only surface a BL-* id can be minted on. The collision category is structurally impossible,
not merely unguarded. This script was also removed from the unconditional .husky/pre-commit call —
see that file's history if you expected it to still run on every commit.

Use instead:
  backlog create / backlog_create_item (no idOverride)   # file a new BL-* item
  backlog query / backlog get                             # query the graph directly

See CONTRIBUTING.md §1.9 for the full procedure. No BACKLOG.md/CHANGELOG.md read occurred.`;

// [BL-446] Parse argv BEFORE any git/file I/O — --help must never touch git or the filesystem,
// and an unrecognized flag must never fall through to running the (retired) check silently.
const args = process.argv.slice(2);
const HELP = args.includes('--help') || args.includes('-h');
const recognized = new Set(['--help', '-h']);
const unrecognized = args.filter((a) => !recognized.has(a));

if (HELP) {
  console.log(USAGE);
  process.exit(0);
}
if (unrecognized.length > 0) {
  for (const a of unrecognized) {
    console.error(`check-bl-id-integrity: unrecognized argument '${a}'. Run with --help for usage.`);
  }
  process.exit(1);
}

console.error(RETIREMENT_MESSAGE);
process.exit(1);
