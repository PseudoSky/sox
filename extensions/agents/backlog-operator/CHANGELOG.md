# Changelog

## 0.6.0

- **The `rm` permission ban is removed; the rule lives in the prompt instead.** The 0.5.0 blanket `rm *: deny` (and the `rm -rf *` ask before it) are dropped from the `bash` map — the operator again gets no `rm` guardrail. Why: transcript evidence shows every variable-target delete was the idempotent reset line of an empirical probe (`VAR=…; rm -rf "$VAR"; mkdir -p "$VAR"` → clone the production backlog DB or spin a throwaway `ADHD_ROOT`, then verify a mechanic the docs do not answer), aimed at the operator's own per-user temp dirs — the ban blocked benign work without touching the root. The Protocol *Never delete* bullet now states the rule directly: never `rm -rf` a variable target (unverifiable expansion), give each probe a fresh `mktemp -d` instead of deleting and recreating a scratch dir.
- **Criteria-contradiction warning added.** When the target item's acceptance criteria contradict those of a related issue already in the operator's context (from the request or its own discovery), it now warns the caller, naming both items and the conflicting criteria. The warning is drawn only from issues already in context — no separate search is run for contradictions.

## 0.5.0

- **`rm` is now denied outright, and the prompt forbids it.** Transcript evidence (`agent-transcript-scan`, 343 backlog-operator sessions, 22 R1-rm-var hits) shows the operator repeatedly attempted variable-target recursive-force deletes — `rm -rf "$TMP"`, `rm -rf "$ROOT"`, `rm -rf "$SB"`, `rm -rf $D`, `rm -rf "$ADHD_ROOT"` — scratch-path cleanups whose expansion it cannot verify. The `bash` guardrail `rm -rf *` (ask) becomes `rm *` (deny): `ask` auto-rejects non-interactively, so the operator merely retried, and an interactive approval would have run the delete. The Protocol *Never delete* bullet now states the rule the map enforces — never run `rm`, least of all against a variable target.

## 0.4.0

- **`file`/`enrich` now carry the immutable-verbatim contract.** A user-originated item stores the user's message verbatim and immutably: corrections append to the existing record (never overwrite the verbatim), new work is a new item (never a rewrite), and enrichment runs AFTER and must never remove or alter it. A user note carries no citation — the user's message is truth, not evidence. File where the dispatcher/project says filing goes; cleanly separable items file each within its own boundary, corrections append, new work files new. The verb list stays at eleven.
- **The filing-boundary readiness subset is declared here, explicitly one half of ONE "definition of ready".** `definition-of-ready` (the skill) governs bucket → path routing; the filing-boundary subset — acceptance criteria present, scope stated, citations present, dependencies resolved — is applied quietly and automatically at FILING. An item lacking any of them is transitioned back to needs-triage/scoping, not filed. A user-originated note is exempt from the citation check (truth, not evidence).

## 0.3.1

- **Guardrails restated after the `"*": "allow"` catch-all — probe-proven shadowing.** The agent map merges AFTER the global `opencode.json` rules and wins on last-match-wins, so any global guardrail the map does not restate is overridden. A probe agent whose bash map was a bare `{"*": "allow"}` ran `rm -rf /tmp/...` to completion, while the same command under the config alone was auto-rejected. The tail now restates, appended AFTER the catch-all so each still wins: `git stash*` / `git add -A*` / `git add .` / `git add --all*` / `git reset --hard*` / `git clean *-f*` deny, `git push *--no-verify*` / `git checkout -- *` / `rm -rf *` ask, `*dot/secrets*` deny.

## 0.3.0

- **Similar-item discovery is now operator-initiated on every invocation (70f75751-8a84-47d2-99ed-83fb3bd71b3f).** The operator no longer waits for the caller to ask: every invocation discovers items similar to what the requesting agent is talking about and surfaces them in the return block as candidates for potential execution. The discovery duty is required, not optional, and is never gated on the caller requesting it — a caller who does not know a sibling exists cannot ask for it.
- **Sibling cascade-scan now runs on every closure (70f75751-8a84-47d2-99ed-83fb3bd71b3f).** Every transition that closes an item searches for siblings that may also be closed by the same change and surfaces them as cascade-close candidates with evidence. The search is keyed on the evidence the closure itself rests on — symbol, file path, error string, artifact — never on title similarity alone, and every discovery states what it searched by so an empty result is distinguishable from an unsearched one. Neither duty acts on its candidates; there is no automatic resolve.
- **The unconfirmed-main-sha refusal is now pinned by a red→green guard (0abc01ed).** The rule that a resolution asserting a commit/merge sha not reachable in `main` is refused, not recorded, was already operator prose but carried no guard; `tools/test-0abc01ed-unconfirmed-sha-refused.mjs` now pins it, with the rule-less resolve text embedded as its negative control. The 70f75751 guard likewise pins the two discovery duties, with the pre-fix discovery-less `When called` protocol as its negative control.

## 0.2.0

- **`resolve` now carries an evidence precondition keyed on the artifact class (4fc3704e-56b0-4363-a1fe-ec8a51826f8b).** The `resolve` verb refuses a commit/merge ref alone: it requires acceptance-criteria proof for every item, published-artifact proof for a publishable package, and live-system / deploy proof for a released/deployed service or artifact — otherwise it returns ESCALATE naming the missing evidence class. This closes the bypass where the dispatcher's terminal-resolution gate could be routed around by calling the operator directly. The verb list stays at eleven.
- **A resolution asserting an unconfirmed main-branch sha is refused (0abc01ed).** Any commit/merge sha in the evidence must be confirmed reachable in `main` with read-only git before it is recorded; an unconfirmed ref is refused, not recorded — a ref that is not in `main` is not terminal evidence for any class.
- **Declared tier corrected to match honored reality (92999871).** The prose asserted a flat "you run at haiku tier"; that is an IR declaration (`agent.model` + `render.<host>.model` — `haiku` on Claude Code, `deepseek/deepseek-flash` on opencode), not a runtime guarantee. The prose now states the declaration per host instead of claiming a runtime fact a session can contradict.

## 0.1.1

- Converted to the cross-platform `agent`/`render.<host>` IR pattern (matching `dispatcher` and `researcher`): `backlog-operator.md` is prose-only (frontmatter stripped), and the per-host header is generated by `libs/host-registry/src/agent-renderers.ts` at install time from `extension.json`.
- Logical model tier: `haiku` (claude-haiku-4-5-20251001 in IR, kept as-is in claude render, mapped to deepseek/deepseek-flash in opencode).

## 0.1.0

- Initial release.
- Ingested from `sox-active:backlog-operator` agent catalog.
- Born-conformant declarative agent extension.
- Multi-host: `install.hosts` = `claude`, `opencode`.
- Fixed-playbook operator for the backlog graph with eleven supported verbs.
