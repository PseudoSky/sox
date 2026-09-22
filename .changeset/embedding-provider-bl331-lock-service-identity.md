---
'@adhd/sox-embedding-provider': patch
---

fix(embedding-provider): record the owning service in the BL-331 fastembed host lock and suppress a
same-service competing lock (BL-432).

The advisory fastembed-host lock stored only `{ pid, startedAt, poolGroup? }`, so the BL-331 warning
named a bare pid and fired on the sequential-CLI false positive — a single service's own earlier or
second host. `FastembedLockInfo` now carries `service`, resolved from `SOX_FASTEMBED_SERVICE`
(mirroring `SOX_FASTEMBED_POOL_GROUP`), the warning prints the service name, and a competing lock
owned by the same service is suppressed rather than warned about. `competing_service` and
`competing_host_service` are added to telemetry, so genuine cross-service contention is
distinguishable from the self-contention case.

`sharedFastembedProcess.ts` threads `SOX_FASTEMBED_SERVICE` into the fork env and surfaces the
competing service in `detectCompetingFastembedHost`. Writer, reader, and end-to-end telemetry tests
ship with negative controls.
