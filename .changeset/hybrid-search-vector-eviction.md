---
'@adhd/sox-hybrid-search': minor
---

**Behaviour change (ranking, bug fix).** `StoreSearchBackend.search` no longer evicts
vector-only hits when the text channel alone fills `limit` (7bbc2883).

The backend merged its two channels into ONE insertion-ordered `Map` — every TEXT hit
before any vector-only hit — and applied `.slice(0, limit)` to that insertion order. So a
vector-only semantic near-duplicate whose wording shares too few FTS tokens to enter the
text page was appended after the text page and silently dropped — even at cosine 1.0. The
merged candidates are now ranked with the package's own `fuse()` (the same min_max score
fusion the top-level `search()` applies) and the limit is applied to that fused rank, so a
vector-only hit is selected on its calibrated signal rather than by text-first insertion
order. The raw `textScore`/`vecScore` on every returned row are unchanged; only which rows
survive the cap, and their order, are fused.

Regression test (red before, green after): `hybrid-search.spec.ts` →
"7bbc2883: a vector-only exact-match hit survives when the text channel alone fills `limit`".
