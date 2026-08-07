#!/usr/bin/env node
/**
 * pin-changelog-citations.mjs — [ADR-0011 Stage 3, SPEC-DELETE-FILES.md D9]
 *
 * Root `BACKLOG.md`/`CHANGELOG.md` are being deleted. 478 existing `BL`-family citations point at
 * one of those two files by bare name (`{file:"CHANGELOG.md", lines:"N-M"}`) or by a legacy
 * absolute path (`{file:"/…/BACKLOG.md"}`) — once the files are gone from the working tree, those
 * citations no longer resolve via a plain read, only via git history.
 *
 * This script ADDS a new citation per stale citation found, of the form
 * `{ file: "<sha>:<basename>", lines: <same lines, if present>, context: <same context, if
 * present> }` — a commit-pinned reference that resolves cleanly forever via
 * `git show <sha>:<path>`, regardless of whether the file still exists in the working tree.
 *
 * ADD-only, by design and by tool-surface constraint: `backlog add-citation` only appends: there is
 * no `remove-citation`/`update-citation` verb on either the CLI or `backlog_update_item`'s `patch`
 * (confirmed by reading the full command table). The original, now-unresolvable citation is left in
 * place, side-by-side with the pinned one — see SPEC-DELETE-FILES.md Risk R5 for why this residual
 * is accepted rather than silently dropped.
 *
 * Usage:
 *   node tools/pin-changelog-citations.mjs --sha=<sha> --dry-run   # prints the plan, mutates nothing
 *   node tools/pin-changelog-citations.mjs --sha=<sha> --apply     # runs `backlog add-citation` per item
 *
 * Exactly one of --dry-run / --apply is required (house convention — never mutate on a bare
 * invocation with no flags, per AGENTS.md's commit-mine.mjs "always dry-run first" pattern).
 *
 * --sha must name the commit immediately BEFORE the `git rm BACKLOG.md CHANGELOG.md` commit — the
 * last commit where `git show <sha>:CHANGELOG.md` / `:BACKLOG.md` return the exact content every
 * existing citation's `lines` field was measured against (mod the pre-existing citation-drift risk
 * named in Risk R5, which this script does not audit or repair).
 */
import { execFileSync } from 'node:child_process';

const REPO = 'sox-ecosystem';
const FAMILY = 'BL';
const PAGE = 200;
const BACKLOG_BIN = process.env.PLAN_STATUS_BACKLOG_BIN || 'backlog';

const args = process.argv.slice(2);
const HELP = args.includes('--help') || args.includes('-h');
const shaArg = args.find((a) => a.startsWith('--sha='));
const DRY_RUN = args.includes('--dry-run');
const APPLY = args.includes('--apply');

const USAGE = `pin-changelog-citations — commit-pin stale BACKLOG.md/CHANGELOG.md citations before deletion (ADR-0011 Stage 3, D9)

Usage:
  node tools/pin-changelog-citations.mjs --sha=<sha> --dry-run   # print the plan, mutate nothing
  node tools/pin-changelog-citations.mjs --sha=<sha> --apply     # run backlog add-citation for real
  node tools/pin-changelog-citations.mjs --help | -h             # print this usage

--sha must be the commit immediately BEFORE the git rm BACKLOG.md/CHANGELOG.md commit.
Exactly one of --dry-run / --apply is required.`;

if (HELP) {
  console.log(USAGE);
  process.exit(0);
}

if (!shaArg) {
  console.error('pin-changelog-citations: --sha=<sha> is required. Run with --help for usage.');
  process.exit(1);
}
const SHA = shaArg.slice('--sha='.length);
if (!SHA) {
  console.error('pin-changelog-citations: --sha=<sha> must not be empty.');
  process.exit(1);
}
if (DRY_RUN === APPLY) {
  console.error('pin-changelog-citations: exactly one of --dry-run / --apply is required (never both, never neither).');
  process.exit(1);
}

// Verify the sha actually has both files, loudly, before doing anything else — a wrong --sha would
// otherwise silently mint citations pointing at content that never resolves.
for (const f of ['BACKLOG.md', 'CHANGELOG.md']) {
  try {
    execFileSync('git', ['cat-file', '-e', `${SHA}:${f}`], { stdio: 'ignore' });
  } catch {
    console.error(`pin-changelog-citations: \`git show ${SHA}:${f}\` does not resolve — is --sha the commit immediately before the git rm commit?`);
    process.exit(1);
  }
}

const STALE_FILE_RE = /(^|\/)(BACKLOG|CHANGELOG)\.md$/;

function listAllItems() {
  const items = [];
  let offset = 0;
  for (;;) {
    const out = execFileSync(
      BACKLOG_BIN,
      ['list-items', '--filter', JSON.stringify({ repo: REPO, family: FAMILY, excludeArchived: false, limit: PAGE, offset })],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const page = JSON.parse(out);
    items.push(...page);
    if (page.length < PAGE) break;
    offset += PAGE;
  }
  return items;
}

function pinnedCitationFor(citation) {
  const m = citation.file.match(STALE_FILE_RE);
  if (!m) return null;
  const basename = `${m[2]}.md`; // "BACKLOG.md" or "CHANGELOG.md"
  const pinned = { file: `${SHA}:${basename}` };
  if (citation.lines !== undefined) pinned.lines = citation.lines;
  if (citation.context !== undefined) pinned.context = citation.context;
  return pinned;
}

const items = listAllItems();
let itemsTouched = 0;
let citationsToAdd = 0;
let citationsAdded = 0;
const failures = [];
const plan = [];

for (const item of items) {
  const stale = (item.citations ?? []).filter((c) => STALE_FILE_RE.test(c.file));
  if (stale.length === 0) continue;
  itemsTouched += 1;
  for (const citation of stale) {
    const pinned = pinnedCitationFor(citation);
    if (!pinned) continue;
    citationsToAdd += 1;
    plan.push({ humanId: item.humanId, original: citation, pinned });
    if (APPLY) {
      try {
        execFileSync(BACKLOG_BIN, ['add-citation', '--repo', REPO, '--human-id', item.humanId, '--citation', JSON.stringify(pinned)], {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        citationsAdded += 1;
      } catch (err) {
        failures.push({ humanId: item.humanId, citation: pinned, error: err.message });
      }
    }
  }
}

if (DRY_RUN) {
  for (const p of plan) {
    console.log(`[dry-run] ${p.humanId}: ${JSON.stringify(p.original)} -> ADD ${JSON.stringify(p.pinned)}`);
  }
}

console.log(
  `pin-changelog-citations: ${DRY_RUN ? 'DRY RUN — ' : ''}items touched=${itemsTouched}, citations ${DRY_RUN ? 'to add' : 'added'}=${DRY_RUN ? citationsToAdd : citationsAdded}/${citationsToAdd}` +
    (failures.length ? `, FAILURES=${failures.length}` : ''),
);
if (failures.length) {
  console.error('pin-changelog-citations: the following add-citation calls FAILED (re-run is safe — ADD-only, a duplicate is harmless):');
  for (const f of failures) console.error(`  ${f.humanId}: ${JSON.stringify(f.citation)} — ${f.error}`);
  process.exit(1);
}
if (APPLY && citationsAdded !== citationsToAdd) {
  console.error(`pin-changelog-citations: partial run — added ${citationsAdded}/${citationsToAdd}, re-run to complete (idempotent-safe).`);
  process.exit(1);
}
process.exit(0);
