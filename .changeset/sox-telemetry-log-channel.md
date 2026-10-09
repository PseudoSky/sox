---
"@adhd/sox-telemetry": patch
---

Add the raw log channel (c536ce29): `createLogChannel` (per-process JSONL files, size rotation, async gzip, age and directory-byte retention, typed `sync`/`hybrid` durability, flood breaker, pino-compatible `destination()`), `createRedactor`/`identityRedactor`, bounded `captureBody`/`BodyCapture`, and cross-copy-safe async `withLogContext`/`currentLogContext`. `initTelemetry({ redactor })` redacts `log.*` and span records. Adds an `e2e` lane (4 real processes, `kill -9` durability, gzip replay, cross-copy against 0.4.1).
