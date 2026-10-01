# Changelog

## 0.1.3

- **Guardrails restated after the `"*": "allow"` catch-all — probe-proven shadowing.** The agent map merges AFTER the global `opencode.json` rules and wins on last-match-wins, so any global guardrail the map does not restate is overridden. A probe agent whose bash map was a bare `{"*": "allow"}` ran `rm -rf /tmp/...` to completion, while the same command under the config alone was auto-rejected. The tail now restates, appended AFTER the catch-all so each still wins: `git stash*` / `git add -A*` / `git add .` / `git add --all*` / `git reset --hard*` / `git clean *-f*` deny, `git push *--no-verify*` / `git checkout -- *` / `rm -rf *` ask, `*dot/secrets*` deny.

## 0.1.2

- Replace the unfilled scaffold with a real operating contract: recall-before-write, one episode
  per finding with an explicit `project_path`, vocabulary curation, invalidation-never-deletion,
  and the ownership guardrail (never repair or restart the store)
- Add the ADR-catalog-first rule carried by every other sox agent
- README: replace the generator placeholders with real overview/when-to-use/inputs/outputs, and
  use the manifest id (`memory-org`) in the install commands

## 0.1.1

- refactor: cross-platform IR — move agent config to extension.json agent/render blocks, strip frontmatter from .md

## 0.1.0

- Initial release
