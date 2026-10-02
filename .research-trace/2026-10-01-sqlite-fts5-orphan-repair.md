# Research trace — SQLite FTS5 orphaned-index repair (embedded drivers)

- Date: 2026-10-01
- Slug: sqlite-fts5-orphan-repair
- Agent: researcher (opencode host)
- Repo: /Users/nix/dev/ai/sox-ecosystem
- General question: How do you safely repair an FTS5 virtual table whose `sqlite_master`
  meta-row was deleted out-of-band, when the driver refuses `DROP INDEX`/`DROP TABLE`
  and rejects `PRAGMA writable_schema` writes — in an embedded-driver context?

## Step 0 — Quantitative measurement

| Metric | Baseline | Result | Delta | Target |
|---|---|---|---|---|
| Search terms executed | 0 | ~24 (ddg/google/arxiv/npm/github/stackoverflow + curl+jq GitHub API + fetch) | +24 | >=9 |
| Phases completed (0–7) | 0 | 8 | +8 | 8 |
| Tools approved/blocked | 0 | 5 (3 approved, 2 blocked) | +5 | >=3 |
| Confidence-labeled claims | 0 | HIGH (error surface, ordering), LOW (0.7.x rollback text) | +2 | >=1 |
| Sources verified per approved tool | 0 | Turso >=4; better-sqlite3 2; node:sqlite 1 | — | >=2 (Turso, better-sqlite3 met) |
| Rate limit / block events | 0 | 0 | 0 | <=2 |

**Promotion gate: PASSED** (>=3 useful search terms; >=2 tools found; 0 rate limits/blocks).

## Findings written to memory (topic `tool-catalog`, project_path sox-ecosystem)

Tools: 01M3W6RT2BVHS90DZS0G4A7F90 (Turso, approved) ·
01M3W6RWB8NR64M3CEPCE99YSC (better-sqlite3, approved) ·
01M3W6RYNRTTT24AMR70DFFER3 (node:sqlite, approved) ·
01M3W6S4N1TNMDRJ7K9PYTS1J7 (sqlite3 CLI, blocked) ·
01M3W6S6AZF9Y2NK3NFET7MRDQ (@libsql/client, blocked).

Patterns: 01M3W6S9EHXMQTMV9PTNQR5E4H · 01M3W6SGFTRCFY0AFZMTKSPZEA ·
01M3W6SKJ8PXM9261TMQFKRV7H · 01M3W6SZSVTZN2M5ATXA4T34B7 (antipattern) ·
01M3W6T64A8CEX26XKHXABHFFB · 01M3W6T92KF5XAVDWRVVZA94RM (antipattern) ·
01M3W6TGVR7EWD26QH7XHMX2AG.

Use cases: 01M3W6TJ0NAMHJNG9HWB3HAVFS · 01M3W6TM51VGNHJX1PVQ8F6SS9 ·
01M3W6TVK7E5NR9X16VXFCWYPZ.

## Post-write validation

`memory_topics({search:"tool-catalog"})` → episode_count 2532, last_written
`2026-10-01T16:57:19Z` (matches the Phase 5 write window) ⇒ writes landed.
Combined `tags + t_created_after` filters returned empty on two attempts — a filter
quirk, NOT missing writes (an unfiltered semantic recall on the same query returned a
large result set). Next run: validate with topic + last_written, not tag+time.

## What worked well

- Memory-first: prior-art episodes on this exact problem (BL-361/BL-362/BL-518, Turso
  FTS-v1→v2 migration) removed most of the discovery work and gave source-pinned facts.
- Primary sources over summaries: the GitHub REST API via `curl | jq` was the single
  most productive channel for the Turso error-surface question (issues #8216/#8373/#9383/
  #9006/#9009), because it returns verbatim issue bodies and commit SHAs.
- SQLite primary docs (fts5.html, pragma.html, howtocorrupt.html, wal.html) settled the
  vanilla-semantics half without ambiguity.

## What failed / was corrected

- **MCP `github` code search (`type:code`) is non-functional here** — returns the search
  UI shell, 0 results, for every query. Substitute used: `curl -s "https://api.github.com/
  search/issues?q=repo:tursodatabase/turso+..."` piped through `jq`. Substitution noted
  in the output.
- **`stackoverflow` and `arxiv` MCP providers returned `outcome: empty`** on this topic;
  the canonical SO answers surfaced only via `duckduckgo`/`google` with a `site:` qualifier.
- Initial Phase-0 assumption that "second-connection repair is the safe path" was
  **confirmed** (not merely assumed) by upstream evidence, but a *better* in-process
  ordering was also surfaced (close-before-write + reopen-and-verify), so the bias did not
  distort the conclusion.

## Process-failure classifications

- **Search formulation** — the arxiv/stackoverflow queries were too literal; should have
  gone straight to general web providers for a practitioner topic, reserving arxiv for the
  scholarly angle which turned out to be empty.
- **Source/tool selection** — relied initially on the MCP `github` provider for code search;
  it is dead here. Corrected to the REST API. No finding was published from the dead tool.
- **Inference leakage (contained)** — the 0.7.x rollback failure text is asserted LOW
  confidence and flagged; every other claim is source-pinned.

## LOW-confidence findings carried forward (flagged, not presented as settled)

- The exact error text a **0.7.x** driver emits when opening a **0.8.x (v2-format)** store is
  unconfirmed (reasoned from "no control-row concept", not observed). LOW.
- Whether any *released* version fixes the FTS OPTIMIZE orphan-page leak (#8170) is NOT
  established; 0.8.0 is the plausible first candidate. LOW.

## One actionable improvement for next run

For any Turso/libsql question, query the GitHub **REST API** (`api.github.com/search/issues`)
via `curl | jq` as a first-class channel alongside the MCP providers — it is immune to the
broken `type:code` path and returns verbatim bodies + SHAs.

## Stable process?

No process failure reached the findings (all were tool-channel issues, corrected in-run),
and the only LOW-confidence items are explicitly flagged and out of scope of the core
recommendation. Process judged **stable**; two LOW items carried forward by design.
