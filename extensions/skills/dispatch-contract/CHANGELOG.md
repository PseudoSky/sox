# Changelog

## 1.6.0

- **The brief carries the verbatim user request.** §1 adds `user-request (verbatim):` and `dispatcher-structuring:`, with the HARD-contradiction closed set and the non-contradictions named — never ask on an admissible addition.
- **Review type by changed-file count.** §1a: `>=8` → blind (diff + "Review" only), `<8` → guided, exactly one full-delta blind review at plan completion. §1b: the HIGH/critical filter is narrow — immediate corrections arising from reviews only.
- **Verification section** added before the return block: re-run the done-state checks and re-read the diff before reporting `done`.
- Hard rule: every brief carries the verbatim and the re-checked structuring.

## 1.5.0

- **Post-merge review brief (§1a) and severity-for-bucketing (§1b).** AC2: the reviewer **runs the suite**, it does not judge from reading — gates named (`pnpm test` 0 failures, `tsc --noEmit` exit 0, bundle to a TEMP outDir under the size budget), raw exit codes and **flake measurements across runs** required, and the review runs against the **merged commit by sha, per ticket, from `main`**. Records the gitignored-fixture trap (`public/events.json` / `details.json` — copy from the repo root; a missing fixture is not a code failure). §1b states the HIGH disposition (bucketed as follow-up impl, never a merge blocker), the rails (every finding filed AND scheduled; a red `main` is an immediate fix), and the tradeoff. `templates/brief.md` gains the matching `## Review target` fill-in block (AC3/AC4/AC5).

## 1.4.0

- Initial release. Ingested verbatim from `claude-agents` (`categories/dispatch/skills/dispatch-contract/SKILL.md`,
  v1.4.0, commit `6ffe0db1`) as part of the `dispatcher` v1.4.0 ingestion. Ships `templates/brief.md`
  and `templates/telemetry-row.md`.
