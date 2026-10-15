---
'@adhd/sox-memory-core': minor
'@adhd/sox-extension-memory-server': minor
'@adhd/sox-extension-memory-cli': minor
---

`memory_curate recluster` now runs as a background job. Filtered and whole-store requests both return a job handle within milliseconds instead of running inside the tool call, so a large store no longer hits the client timeout (-32001). The pass runs in the isolated enrichment child process; a filtered job computes its communities there too and keeps a bounded result on the job.

Only one recluster job runs per store, no matter how many servers share it. A second request, from any process, returns the open job's handle instead of starting another pass, and only one server claims a job to run it. A job whose server died is marked failed (`owner_lost`) once its lease expires, and a failed full pass's retry backoff is recorded on the job so it applies to every server.

Job state is queryable after the request returns: `recluster_status` (by `job_id`, or `latest: true`) reports `queued`, `running`, `completed`, `degraded` or `failed` with `created_at`, `started_at`, `finished_at` and a `reason` (`nodeCap`, `budget`, `child_failed`, `owner_lost`). `memory_ping` carries the latest job under `cluster.recluster_job`. Each server also checks every 10 seconds for a waiting request, so a job starts within seconds instead of waiting for the 5-minute tick.

New `memory recluster` command: requests a whole-store or filtered job (`--project-path`, `--topic`, `--tag`, `--importance-min`, `--threshold`) and, with `--wait`, polls it to a terminal state. Exit codes: 0 completed (or queued without `--wait`), 1 usage or error, 2 failed, 3 degraded, 4 timeout. `--json` prints machine-readable output.

Behaviour change: a filtered `recluster` no longer returns the communities inline. Read them from `recluster_status` once the job completes.
