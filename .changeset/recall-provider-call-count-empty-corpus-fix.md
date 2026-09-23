---
'@adhd/sox-memory-core': patch
---

Fix `memoryRecall`'s empty-corpus early return hardcoding `provider_call_count: 0`
regardless of whether a query embed was actually attempted.

`provider_call_count` counts local embed calls **attempted** on this recall
(incremented in `embed.ts` before the provider promise is awaited — BL-254),
not calls that returned a vector; `degradations` is the field that reports
whether an attempted vec embed actually succeeded. The non-empty-results
return path already computed this from the real `getProviderCallCount()`
before/after delta. The empty-corpus early return (`allRowids.size === 0`)
did not — it hardcoded `0` even when the query embed above it had already
been attempted and timed out under the read-path guard
(`SOX_RECALL_EMBED_TIMEOUT_MS`, default 3000ms), producing a response where
`provider_call_count: 0` sat directly beside
`degradations: ["vec: embed() timed out after …"]` — the caller-visible
counter and the degradation string told opposite stories about whether a
provider call happened.

Both return paths now compute `provider_call_count` from the same
before/after delta, so the two fields can never contradict each other in the
same response: a `vec: …` degradation is proof an embed call was attempted,
and `provider_call_count` will reflect that regardless of which branch
returns. No change to the counter's meaning (attempted, not succeeded) —
this closes a hardcoding gap on one branch, it is not a redefinition of the
field.
