---
'@adhd/sox-memory-core': patch
'@adhd/sox-extension-memory-server': patch
---

`memory_ping`'s `enrichment.progress.last_successful_embed_at` now advances on
write-path (funnel) embeds. The field was written only by `recordEnrichPass`,
fed by the periodic heal count, so a healthy pipeline that left the heal nothing
to repair froze the stamp. `schedulePendingEmbeds` now stamps the ledger after
an apply lands (new `stampSuccessfulEmbed`, monotonic; throttled to one stamp
per `EMBED_SUCCESS_STAMP_INTERVAL_MS` = 30 s per queue, as its own short queue
task). (324da3a8)
