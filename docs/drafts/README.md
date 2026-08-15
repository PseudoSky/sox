# drafts/

Superseded working drafts, archived rather than deleted so their history exists.

They lived untracked at the repo root, where `scripts/build-index.ts` counted them
as checksum-relevant dirt (its ignore list covers root-level `*.md`, but only for
TRACKED files — an untracked root `.md` still blocks a registry sync, BL-390).
On 2026-08-14 that blocked `registry:sync-index` while the smoke gate was red.

- `AGENTS-v3.md` — superseded. 59 of its 65 unique lines are already live in the
  global `~/.claude/CLAUDE.md`; the remainder is a stricter phrasing of the
  code-search hierarchy that is present there in adopted form.
- `dispatcher-v2.md` — superseded by `extensions/agents/dispatcher/dispatcher.md`
  (586 lines vs 282, richer description, and `edit: deny` → `edit: allow`).
  Referenced nowhere in the tree.

Delete freely once you have confirmed nothing here is still wanted.
