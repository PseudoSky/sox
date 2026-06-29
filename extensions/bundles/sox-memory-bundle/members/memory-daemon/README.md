# Memory Daemon

> Supervised Unix-socket daemon that drains the batch-enrich queue and runs deterministic enrichment (clustering, importance, auto-links) via `@adhd/sox-memory-core` — zero LLM calls, no provider required.

## Overview

<!-- Describe what this service does and the problem it solves. -->

## When to use

<!-- Describe when to reach for this service. -->

## Transports

| Transport | Description |
| --------- | ----------- |
| `socket` | Unix socket |

## Health

stdio-ping

## Usage

```bash
sox install memory-daemon
sox start --id=memory-daemon
```

## License

MIT
