# Research trace — Turso FTS OPTIMIZE INDEX leak vs driver bump
Date: 2026-09-30 · agent: researcher · project_path: /Users/nix/dev/ai/sox-ecosystem
Slug: turso-fts-optimize-leak-driver-bump

## Question
Does a version of `@tursodatabase/database` past 0.7.2 fix the FTS `OPTIMIZE INDEX`
orphaned-segment page leak, making the repo's automatic offline-reclaim engine unnecessary?

## Verdict carried forward
**NOT ESTABLISHED that any released version fixes it.** 0.8.0 (2026-09-28) is the first
plausible candidate (FTS storage rewrite to the `fts2` append-only segment registry +
write-path segment merging, PR #8085); issue #8170 is still OPEN 2026-09-30; latest
version checked = 0.8.1 (2026-09-29). Decisive artifact = re-run of
`fts-optimize-leak-gate.bl-c5249cdd.spec.ts` against 0.8.1 on a production-store copy.

## Metrics (Step 0)
| Metric | Baseline | Result | Delta | Target | Status |
| --- | --- | --- | --- | --- | --- |
| Search terms executed | 0 | ~18 | +18 | >=9 | PASS |
| Phases completed (0–7) | 0 | 8 | +8 | 8 | PASS |
| Tools approved/blocked | 0 | 1 (approved: @tursodatabase/database) | +1 | >=3 | FAIL (by design — single-dependency question) |
| Confidence-labeled claims | 0 | 3 (LOW on the 0.8.0-fixes-it inference; MEDIUM/HIGH on version facts) | +3 | >=1 | PASS |
| Sources verified per approved tool | 0 | 4 (npm view version/license/repo/time + downloads API) | +4 | >=2 | PASS |
| Rate limit / block events | 0 | 0 | 0 | <=2 | PASS |

**Promotion gate:** search terms >=3 useful → PASS · rate-limit events 0 → PASS ·
"<2 tools found" → the tool-count target is structurally unmet because the brief scoped a
single dependency, not a tool hunt. Run classified **COMPLETE (scoped)**, not INCOMPLETE —
the one-tool count is the question's shape, not a discovery failure.

## What worked
- Treating the repo comment as a *repo claim* and re-deriving the package name from
  `package.json` — confirmed `@tursodatabase/database` (not `@libsql/client`), so the layer
  separation held.
- Reading the upstream **issue threads** (#8170, #9383) rather than only the changelog —
  the changelog never claims a fix; the issue thread is where `0.8.0-pre.2` was measured
  identical, and where PR #8085/#9394 surfaced.
- Reading the **source** (`core/index_method/fts/format.rs`) to find the structural change
  the changelog only gestures at — this is what produced the candidate hypothesis.
- Resisting the brief's framing: the null hypothesis ("no released version fixes it") was
  kept live and is what the verdict rests on.

## What failed / was limited
- `github` repo-search is dom-primary and fragile → substituted duckduckgo + `fetch` for
  discovery and `api.github.com` for issue state. Substitution noted in output.
- No upstream artifact (changelog line, issue close, PR merge) *asserts* the leak is fixed —
  the only positive evidence is structural inference. Hence LOW confidence; flagged unresolved.
- Could not verify 0.8.x against the repo's exact workload — that requires running the repo
  test, which is out of scope for a read-only researcher.

## Corrections to initial assumptions
- Assumed the changelog would name the fix. It does not — it names the *rewrite*. The fix,
  if any, is emergent from the rewrite, not declared.
- Assumed 0.8.1 might be the substantive release; it is CI-only (a dotnet workload pin), so
  the substantive change is 0.8.0. Corrected in the tool entry and decision episode.

## Process-failure classification
- **Inference leakage** (minor, labelled): the "0.8.0 plausibly fixes it" claim is my
  inference, not an upstream assertion. Mitigated by tagging it LOW confidence and naming
  the measurement that would settle it.
- No search-formulation or source-selection failures identified.

## Actionable improvement for next run
For any "is a leak/bug fixed in a later version" question, open the **source file that owns
the on-disk format** alongside the changelog — the changelog omits the mechanism and the
issue thread buries the release mapping. (Applied this run to good effect.)

## Memory episodes written (project_path /Users/nix/dev/ai/sox-ecosystem)
- 01M3TGGSYHDQPGN57AN4H0WYM7 — upstream leak status (issues #8170, #9383)
- 01M3TGGT9ZRA9S56ADPTJP64EB — 0.8.0 FTS storage rewrite (fts2) + breaking format change
- 01M3TGGTJFRW4GWCGVJHAXN87K — VACUUM INTO live-reader safety (docs quote)
- 01M3TGGXYYNT2J2XFJHPSYK0R1 — tool entry @tursodatabase/database (latest 0.8.1)
- 01M3TGH20796QMKSS9C45143K3 — decision: bump before building the reclaim engine

## Unresolved (LOW confidence)
- Whether 0.8.0/0.8.1 actually stops the leak. Settled only by re-running
  `fts-optimize-leak-gate.bl-c5249cdd.spec.ts` against 0.8.1 on a production-store copy.
