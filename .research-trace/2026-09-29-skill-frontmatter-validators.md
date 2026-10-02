# Research trace — 2026-09-29 — skill-frontmatter validators

## Metrics (Step 0)
| Metric | Baseline | Result | Target | Status |
|---|---|---|---|---|
| Search terms executed | 0 | 12 (8 primary + 4 deep) | >=9 | PASS |
| Phases completed | 0 | 6 (0-5,7; 6 partial) | 8 | PARTIAL |
| Tools graded | 0 | 5 | >=3 | PASS |
| Confidence-labelled claims | 0 | 3 | >=1 | PASS |
| Sources verified per approved tool | 0 | 2 (PyPI JSON + rm README/registry) | >=2 | PASS |
| Rate limit / block events | 0 | 0 | <=2 | PASS |

Promotion gate: PASS (>=3 useful searches, >=2 tools found, 0 blocks). One truncation event: the
first `github.com/carlrannaberg/cclint` fetch returned 51,621 bytes and was truncated; recovered by
fetching the raw README instead (no context lost).

## What worked
- Registry providers (`pypi`, `npm`) surfaced the whole candidate set fast; PyPI search's HTML
  noise did not block — candidates were read from `pypi.org/pypi/<pkg>/json` instead.
- Fetching the spec page directly settled the canonical-schema question in one call.

## What failed / gaps
- `github` code search (`type:code`) returned `empty` for "SKILL.md frontmatter validate" — did
  not retry; `duckduckgo` covered discovery. Provider substitution, noted.
- Could not run either candidate to confirm it catches the exact `backlog: product prioritizes`
  YAML error (no benchmarking per the minimal constraint). Both parse frontmatter with a strict
  YAML parser; skillscheck advertises "frontmatter presence and syntax" explicitly (MEDIUM confidence).
- Memory write impossible: memory-server MCP tools absent from this host's tool list.

## Process failure classification
- **Source selection** (minor): nearly accepted the npm `skills-ref` 0.1.5 (third-party publisher
  `yc.ma`, MIT) as the canonical reference before the PyPI `skills-ref` (author Anthropic, Apache-2.0)
  clarified the distinction. Fix applied: report both, name the repo as canonical.

## Assumption corrections
- Prior "the space is thin" — contradicted: at least five independent, actively-released validators exist as of 2026-08.
