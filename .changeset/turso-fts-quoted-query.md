---
'@adhd/sox-store-adapter': patch
---

Fix a Turso FTS parse error that silently killed the whole BM25 arm for any
recall query containing double quotes.

`normalizeFtsTokens` split on whitespace without stripping quotes, so a query
like `"e68be52c" or "cb47fb79" review` produced tokens with the quotes glued
on. `buildMatchQuery` then escaped each embedded quote by doubling it (the
SQLite FTS5 convention) and wrapped the result, yielding a triple-quoted
token. SQLite FTS5 parses that; Turso's Tantivy parser has no doubled-quote
escape and rejects the entire match query, which memory-core's recall handler
downgrades to a silent `fts:` degradation — so BM25 contributed zero rows and
the caller saw a normal-looking payload.

The strip lands in the shared tokenizer rather than in `TursoFTSDialect`, so
both backends keep receiving identical token sets — the invariant
`normalizeFtsTokens` exists to guarantee. `buildMatchQuery` retains its
escaping as defence-in-depth for callers that build tokens directly.
