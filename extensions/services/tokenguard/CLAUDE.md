# tokenguard — Operator & Agent Guidance

## For Operators

### Installation & Lifecycle

```bash
# Install once in your scope (org/user/project/local)
./bin/sox install tokenguard --scope=org

# Verify it's conformant
./bin/sox validate tokenguard

# Start the service
./bin/sox start tokenguard

# Check if it's running
./bin/sox list | grep tokenguard

# Stop it
./bin/sox stop tokenguard

# Uninstall (if needed)
./bin/sox uninstall tokenguard
```

### Configuration Quick Start

The service reads **only** `SOX_CONFIG_*` environment variables (set by the sox supervisor from the install-time config schema). You configure it at install time via the prompted questions.

**Key variables:**

- `SOX_CONFIG_UPSTREAM` — where the proxy forwards requests (e.g., `https://api.anthropic.com` or `https://api.openai.com`)
- `SOX_CONFIG_PORT` — listening port (default 9099)
- `SOX_CONFIG_PROVIDER` — `anthropic` or `generic`
- `SOX_CONFIG_SEEDS` — pre-seed identifiers as JSON (optional)

**Example: switch from Anthropic to OpenAI**

If you want to proxy OpenAI instead, reconfigure:

```bash
# Uninstall and reinstall with new config
./bin/sox uninstall tokenguard
./bin/sox install tokenguard --scope=org
# At the "upstream" prompt, enter: https://api.openai.com
# At the "provider" prompt, enter: generic
./bin/sox start tokenguard
```

### Client Adoption

Tell users to set their **client's base-URL env var** to point at the proxy:

| Client Library | Env Var | Value |
|---|---|---|
| Anthropic Python | `ANTHROPIC_BASE_URL` | `http://localhost:9099` (or configured port) |
| OpenAI Python | `OPENAI_API_BASE` | `http://localhost:9099` |
| OpenAI Node | `OPENAI_BASE_URL` | `http://localhost:9099` |
| Generic REST | (construct URL manually) | `http://localhost:9099` |

Then their code runs as-is; no logic changes, just env var redirection.

### CLI Usage

Three tools are exposed via `sox exec`:

```bash
# Add a custom identifier to the live map
./bin/sox exec tokenguard -- seed <real> <type> [optional-token]
./bin/sox exec tokenguard -- seed internal.example.com host

# Print all entries currently mapped (JSON)
./bin/sox exec tokenguard -- map

# Audit: per-token swap counts + total leak count
./bin/sox exec tokenguard -- summary
```

### Audit Log

Every request/response is logged to `~/.tokenguard/audit.jsonl` (or configured `SOX_CONFIG_CAPTURE_DIR`):

```bash
cat ~/.tokenguard/audit.jsonl | tail -10
# See recent inbound requests and outbound responses
```

**Key fields:**

- `swap_count` — how many tokens appeared in the response (high means good tokenization)
- `leak_count` — how many real values leaked (should be 0)

Use the `summary` CLI to get aggregate leak count.

### Troubleshooting

| Symptom | Likely Cause | Fix |
|---|---|---|
| "Connection refused" | Service not running | `./bin/sox start tokenguard` |
| Port 9099 already in use | Another process owns it | Change `SOX_CONFIG_PORT` or stop the other service |
| Tokens not reverting in response | Client not using proxied base URL | Check the env var (e.g., `ANTHROPIC_BASE_URL=http://localhost:9099`) |
| `audit.jsonl` not created | Capture mode is `none` | Set `SOX_CONFIG_CAPTURE` to `full` or `truncated` |
| Leak count > 0 | Real values still in responses | Check detectors or add to `SOX_CONFIG_SEEDS` |

---

## For LLM Agents

### High-Level Overview

TokenGuard is a **stateful proxy service** within sox that:

1. **Intercepts requests** between a client and an LLM API.
2. **Tokenizes sensitive data** (hosts, emails, IPs) into stable pseudo-tokens (`<HOST_1>`, etc.).
3. **Forwards sanitized requests** to the real API.
4. **Detokenizes responses** to restore original values for the client.
5. **Audits** all traffic for leak detection.

### API Surface

When invoked via `sox exec tokenguard`, the service exposes three MCP tools:

```
Name: seed
Input: { real: string, type: string, token?: string, map_path?: string }
Output: { token: string }
Effect: Adds/returns the token for a real; bijective (idempotent).

Name: map
Input: { map_path?: string }
Output: { entries: MapEntry[] }
Effect: Lists all (real, token) pairs.

Name: summary
Input: { map_path?: string, audit_path?: string }
Output: { entries: { token, real, type, source, swap_count }[], leak_count: number }
Effect: Audit aggregation — shows token reuse frequency + total leaks.
```

### Configuration (at install time)

The service is configured via `SOX_CONFIG_*` env vars injected by sox. Schema is defined in the extension's `config_schema` metadata.

**Notable defaults:**

- `upstream`: `https://api.anthropic.com` (Anthropic by default)
- `provider`: `anthropic` (use `generic` for other providers)
- `capture`: `truncated` (reduce audit log size; use `full` for forensics)

### Common Tasks

**Setup Anthropic proxying:**

```typescript
// Pseudo-code for an agent workflow
await sox.install('tokenguard', { scope: 'org', config: { upstream: 'https://api.anthropic.com' } });
await sox.start('tokenguard');
process.env.ANTHROPIC_BASE_URL = 'http://localhost:9099';
// Now `anthropic` client uses the proxy.
```

**Setup OpenAI proxying:**

```typescript
await sox.install('tokenguard', { scope: 'org', config: { 
  upstream: 'https://api.openai.com',
  provider: 'generic'
} });
await sox.start('tokenguard');
process.env.OPENAI_API_BASE = 'http://localhost:9099';
// Now `openai` client uses the proxy.
```

**Seed identifiers before running a workflow:**

```typescript
// Invoke the seed tool three times
await sox.exec('tokenguard', { tool: 'seed', args: { real: 'prod.db', type: 'host' } });
await sox.exec('tokenguard', { tool: 'seed', args: { real: 'alice@internal.com', type: 'email' } });
await sox.exec('tokenguard', { tool: 'seed', args: { real: '10.0.0.1', type: 'ipv4' } });
```

**Check for leaks after a run:**

```typescript
const { leak_count } = await sox.exec('tokenguard', { tool: 'summary' });
if (leak_count > 0) {
  console.warn(`⚠️ ${leak_count} real values leaked in responses`);
}
```

### State & Persistence

- **Token map** (`~/.tokenguard/token-mapping.json`): persistent, reload-stable. The same real always gets the same token, even across service restarts.
- **Audit log** (`~/.tokenguard/audit.jsonl`): append-only. Every request/response pair logged (configurable capture size).
- **Service process**: supervised by sox, restartable via `sox restart tokenguard`.

### Key Invariants

- **Bijective**: one real ↔ one token, forever.
- **Idempotent**: calling `seed` with the same `real` twice always returns the same `token`.
- **Provider-agnostic**: the `upstream` and `provider` config fully determine behavior; no hard-coded API keys or hosts.
- **No side effects on failure**: if an upstream request fails, the proxy returns the error; audit is best-effort.

### Typical Workflow for an Agent

1. **Install & start** (once per session or scope).
2. **Seed high-value identifiers** (databases, internal services, admin emails).
3. **Configure the client** to use the proxy (set base-URL env var).
4. **Run your workload** (client code unchanged, uses the proxy transparently).
5. **Audit** with `summary` tool to confirm no leaks and measure tokenization rate.
6. **Adjust** if needed (add more seeds, change providers, etc.) and re-run.

### Debugging

**Check if running:**

```typescript
const state = await sox.list();
const tg = state.find(s => s.name === 'tokenguard');
console.log(tg.status);  // 'RUNNING' or 'STOPPED'
```

**Read audit log directly:**

```typescript
import * as fs from 'fs';
const home = process.env.HOME || '/tmp';
const auditPath = `${home}/.tokenguard/audit.jsonl`;
const lines = fs.readFileSync(auditPath, 'utf8').split('\n');
for (const line of lines.slice(-5)) {
  console.log(JSON.parse(line));  // Last 5 events
}
```

**Inspect the live token map:**

```typescript
const { entries } = await sox.exec('tokenguard', { tool: 'map' });
console.log('Tokens in use:', entries.length);
for (const e of entries) {
  console.log(`  ${e.real} → ${e.token} (source: ${e.source})`);
}
```

---

## Implementation Notes

### Engine (@adhd/sox-tokenguard-core)

- Pure TypeScript, no I/O, provider-agnostic.
- Exports: `Mapper` (bijective store), detectors (regex-based), `tokenizeRequest`/`detokenizeText`, SSE reassembler.
- Used by the service's request/response interceptors.

### Service (extensions/services/tokenguard)

- HTTP proxy (listens on `SOX_CONFIG_PORT`).
- Routes via provider adapter (`anthropic` or `generic`).
- Logs to audit.jsonl.
- Exposes CLI tools via MCP (seed, map, summary).

### Invariants

- **[inv:c7-no-reach-in]**: no reach-in imports; uses `@adhd/sox-tokenguard-core` scope only.
- **[inv:wire-guarantee]**: Anthropic adapter tokenizes only system/messages/metadata; tools/thinking verbatim.
- **[decouple-generalize.1]**: no WOP/red-team vocabulary in shipped source.
- **[decouple-generalize.3]**: no provider hostname hard-coded in the engine.
