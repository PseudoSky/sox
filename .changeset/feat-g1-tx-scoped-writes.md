---
'@adhd/sox-graph-store': minor
---

feat(graph-store): tx-scoped write primitives — `GraphBackend.transaction()` now hands the callback a
`GraphTransaction` (FEAT-SOXGRAPH-001 / G1).

`transaction<T>(fn, opts?)`'s callback used to receive the raw `AdapterTransaction` only, so a
consumer composing an atomic multi-op write had to hand-compose the library's own INSERT/UPDATE
column lists against the tx handle — coupling every consumer to the schema. The callback now
receives a `GraphTransaction`: a structural **superset** of `AdapterTransaction` (the raw
`executeGet`/`executeAll`/`executeRun`/`exec` surface is preserved verbatim, so existing callbacks
keep compiling and behaving identically) that ADDS typed, transaction-bound graph primitives:

```ts
await graph.transaction(async (tx) => {
  const issue = await tx.writeNode('content', { kind: 'episode', name: 'i1' });
  const open = await tx.findOrCreateNode('status', 'OPEN');
  await tx.writeEdge(issue, open, 'MEMBER_OF');
  const seen = await tx.getEdges({ src: issue }); // reads the uncommitted tx state
}, { mode: 'immediate' }); // BEGIN IMMEDIATE — the ADR-0012 §1 CAS primitive
```

New on the callback: `writeNode`, `findOrCreateNode`, `supersede`, `invalidate`, `touch`,
`writeEdge`, `invalidateEdge`, `writeNodeBatch`, `writeGraph`, `writeEdges`, `getNode`,
`getNodeByUid`, `getEdges`, `getNodesByIds`. Each delegates to the same policy-validating internals
the bare backend uses (`writeNodeInTx` → `typePolicy.validateKind` + `uniquenessPolicy.check`;
`writeEdgeInTx` → `typePolicy.validateEdge`/`validateRel`), so the ADR-0010 D2 write-boundary policy
still runs — the tx path is not a raw-SQL bypass.

`opts?: TransactionOptions` is passed straight through to `adapter.transaction(fn, opts)`;
`{ mode: 'immediate' }` is `BEGIN IMMEDIATE`, already in production use for cross-process CAS.
Default remains `'deferred'`.

Also fixed: `writeGraph` and `writeEdges` opened a transaction but then read/wrote through
`this.adapter` inside it; both now run their endpoint-kind lookup and edge writes on the
transaction handle. The bare `writeGraph`/`writeEdges`/`writeNodeBatch`/`supersede` methods open
their own transaction as before — call `tx.writeGraph(...)` etc. from inside a `transaction()`
callback to avoid a nested transaction.

Additive and source-compatible: no existing exported type or method signature changes meaning.
