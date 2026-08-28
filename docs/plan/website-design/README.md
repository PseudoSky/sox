# sox-ecosystem Website — Design Plan

> Plan for the public-facing sox-ecosystem website (memory + agent infrastructure). Mirrors the
> @adhd website plan and the generalized OSS-monorepo playbook in memory
> (`01M100NC06EXVQSFEBF86KQCJQ`). Researched 2026-08-26.

## Current state (audit findings)

- **No GitHub repo** — the repo has no git remote and no public home. This is the single biggest
  blocker: GitHub is where AI engines and developers discover projects. `repository`/`homepage`
  fields are temporarily linked to `github.com/PseudoSky/adhd` (the shared `@adhd` scope home).
- ~28 publishable `@adhd/sox-*` packages are MIT + published with good descriptions; **keywords /
  repository / homepage were missing** (now added).
- Missing root `LICENSE`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `llms.txt` (now added).
- No docs site.

## Information architecture (hub-and-spoke)

1. **Home / hub** — "What is sox": the memory + agent platform thesis, then the package map.
2. **Per-package spokes** — one page per flagship, install-first, Diátaxis docs.
3. **Supporting** — Blog/releases, Changelog, Community, Comparison pages.

### Flagship spokes

| Page | Content |
|---|---|
| **/memory-server** ⭐ | The MCP server — install, "connect to your host" guide, 19 `memory_*` tools reference, hybrid-recall concepts |
| **/graph-store** | Bi-temporal graph model, SQLite storage, supersession, schema/migrations |
| **/hybrid-search** | Vector + text fusion, RRF/max-score, SearchBackend interface |
| **/vector-store** | sqlite-vec vs LanceDB backends, embedding-space invariant, reembed |
| **/mcp-runtime** | stdio + SSE transports, C6 enforcement |
| **/cli** | `soxe` — install, extension lifecycle commands |
| **/extensions** | Agents (researcher, architect, doc-steward, …), skills, bundles |

### AEO layer

- `llms.txt` + `llms-full.txt`, `sitemap.xml`, `robots.txt`
- `SoftwareApplication` JSON-LD per package
- Answer-first copy on every page (first 40–60 words answer "what does X do")

## Follow-up items

- [ ] Create a GitHub repo for sox-ecosystem, then re-point `repository`/`homepage` off the adhd placeholder
- [ ] Scaffold the site (Astro + Starlight + `starlight-llms-txt`)
- [ ] Hub + flagship spokes (memory-server first)
- [ ] AEO files + deploy workflow (GitHub Pages)
- [ ] Update `README.md`/`AGENTS.md`/`CONTRIBUTING.md`/`PUBLISHING.md`
- [ ] CI sync gate: manifest ≡ publishable package set

## Confidence

- HIGH — generalized playbook and exemplar patterns (live-fetched).
- MEDIUM — the sox page map (synthesis onto sox's real package families).
