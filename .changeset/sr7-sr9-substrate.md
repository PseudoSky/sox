---
'@adhd/sox-memory-core': minor
---

SR-7 (`memory_claim_upsert` + a memory-side, queryable claim) and SR-9 (an
observable global `recluster`) — the two substrate capabilities D-C's knowledge
layer consumes.

**SR-7 — `claim.ts` (new).** `memoryClaimUpsert(adapter, {uid, caller, patch?})`
claims a node for a caller, or updates it if that caller already holds it, as one
atomic compare-and-swap — a conditional `UPDATE` inside an `IMMEDIATE`
transaction, whose `rowsAffected` is the verdict. Correctness is the store
primitive, never an advisory lock (ADR-0012): two callers racing for one node
yield exactly one winner; a distinct caller is refused with a typed
`E_CLAIM_HELD` (naming the holder); the same caller re-claiming is idempotent.
`memoryClaimGet` / `memoryClaimList` read it back — the claim is a first-class,
queryable record stored at `node.meta.claim`, durable across a store reopen.
New MCP tools: `memory_claim_upsert`, `memory_claim_get`, `memory_claim_list`.
No graph-store change was needed — SR-6's node-level `revision`/CAS does not
exist yet, so the claim degrades to conflict-on-`E_CLAIM_HELD` per the D-C
migration note.

**SR-9 — `recluster-job.ts` (new).** A global `memory_curate {op:'recluster'}`
now returns an observable job handle (`{job_id, status:'pending', seq}`) instead
of the bare `{enqueued:true, seq}` claim-with-no-check. The job state lives on
the full-pass `organizer_queue` trigger row it describes (under
`payload.job`) — deliberately **no new table**, so a store that never reclusters
keeps its post-open WAL baseline byte-for-byte (the adapter idle-flush tests
BL-586/BL-572 measure that baseline, and BL-625 records schema growth breaking
them). The in-process enrich tick settles the job in place via
`settleReclusterJobs` — `completed` (with the resulting partition) or `failed`
(with the error), terminal, snapshot-disciplined to `seq <= maxSeq`. A new
`memory_curate {op:'recluster_status', job_id}` op polls it to that terminal
state; "enqueued" is never the final answer.

Tests: `claim.spec.ts`, `recluster-job.spec.ts`, and the memory-server
`sr7-sr9-substrate.spec.ts` drive each capability through the real entrypoints,
with negative controls (SR7_NEGATIVE / SR9_NEGATIVE) proven red→green and the
claim race proved under two real connections (sqlite `BEGIN IMMEDIATE`).
