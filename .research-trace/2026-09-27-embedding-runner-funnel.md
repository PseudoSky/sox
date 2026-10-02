# Research trace: embedding runner vs single-proc funnel (2026-09-27)

## Metrics
| Metric | Baseline | Result | Delta | Target |
|---|---|---|---|---|
| Search terms executed | 0 | 13 WebSearch + 16 WebFetch | +29 | >=9 |
| Phases completed | 0 | 8 | +8 | 8 |
| Tools approved/blocked | 0 | 8 (2 approved / 6 blocked) | +8 | >=3 |
| Confidence-labeled claims | 0 | 14 episodes, each labeled | +14 | >=1 |
| Sources verified per approved tool | 0 | onnxruntime-node 3 (npm, downloads API, binding source); node-llama-cpp 4 | - | >=2 |
| Rate limit / block events | 0 | 0 (3 memory-server timeouts; writes landed) | 0 | <=2 |

Promotion gate: PASS.

## What worked
- Reading live telemetry (embed-host jsonl, ps, vmmap) before searching the web. It overturned the premise that warmup is the cost (init p50 467 ms).
- Checking local node_modules typings plus the upstream binding source for the CoreML options.

## What failed
- The search MCP tools were not in the tool list, so I used WebSearch/WebFetch (no attempts/outcome metadata).
- The node-llama-cpp docs site fetch failed; the GitHub docs markdown worked.
- memory_write_batch (8 items) timed out client-side, but all 8 persisted (verified by recall). recall/topics/entities timed out at Phase 3 (embed breaker open).

## Corrections to priors
- Prior: CoreML compile dominates warmup and can be cached. Wrong on both counts: warmup is small, and the Node binding cannot pass ModelCacheDirectory.
- Prior: fastembed 3.x might expose session options. It does not; it still pins ORT 1.21.0.

## Process failures
- Inference leakage risk: the llama.cpp mmap benefit under swap is reasoned, not measured (labeled MEDIUM).
- Source selection: contracollective MLX numbers are graded D and excluded.

## LOW-confidence items (unresolved)
- The proposed vector-compat thresholds (0.999 cosine; 0.95 recall@10 overlap).
- The cause of the 912 MB MALLOC_LARGE (prepacked weights, CoreML copy, or arena). Needs an A/B.

## Improvement for next run
- Ask the memory-server for UIDs via smaller write batches (<=4) to avoid client timeouts under a stalled queue.

## Post-advisor fixes
- "First request" was initially measured on the init call. Recomputed by per-pid request index: the first real embed is p50 491 ms against 378 ms by request #4. Episode 01M3JC6MK0WZAMAGV6PWXKX1C9 updated.
- Added the precondition to the model-tier key (runner version out of the key; adopt via the handshake). Episode 01M3JC5GR5FC6ZSBBC93NECXCZ updated.
- Found the prefix asymmetry: single uses 'query: ' and batch uses none. Added to the batching and vector-compat episodes, plus the tokenizer entry 01M3JCH3C006DEHXKW7JHFJSZF.
