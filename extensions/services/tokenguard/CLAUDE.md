# tokenguard — Operator & Agent Guidance

## For Operators

### Installation & Lifecycle

```bash
# Install once in your scope (org/user/project/local)
node bin/soxe install tokenguard --scope org

# Verify it's conformant
node bin/soxe validate extensions/services/tokenguard

# Start the service
node bin/soxe start tokenguard

# Check if it's running
node bin/soxe list | grep tokenguard

# Stop it
node bin/soxe stop tokenguard

# Uninstall (if needed)
node bin/soxe uninstall tokenguard
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
node bin/soxe uninstall tokenguard
node bin/soxe install tokenguard --scope org
# At the "upstream" prompt, enter: https://api.openai.com
# At the "provider" prompt, enter: generic
node bin/soxe start tokenguard
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
node bin/soxe exec tokenguard -- seed <real> <type> [optional-token]
node bin/soxe exec tokenguard -- seed internal.example.com host

# Print all entries currently mapped (JSON)
node bin/soxe exec tokenguard -- map

# Audit: per-token swap counts + total leak count
node bin/soxe exec tokenguard -- summary
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
| "Connection refused" | Service not running | `node bin/soxe start tokenguard` |
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

One-time CLI setup (run by operator):

```bash
node bin/soxe install tokenguard --scope org
# At prompts, set upstream to: https://api.anthropic.com
# At prompts, set provider to: anthropic
node bin/soxe start tokenguard
```

Then agents set the env var:

```bash
export ANTHROPIC_BASE_URL='http://localhost:9099'
# Now the anthropic client uses the proxy.
```

**Setup OpenAI proxying:**

One-time CLI setup (run by operator):

```bash
node bin/soxe install tokenguard --scope org
# At prompts, set upstream to: https://api.openai.com
# At prompts, set provider to: generic
node bin/soxe start tokenguard
```

Then agents set the env var:

```bash
export OPENAI_API_BASE='http://localhost:9099'
# Now the openai client uses the proxy.
```

**Seed identifiers before running a workflow:**

```bash
# Invoke the seed tool three times
node bin/soxe exec tokenguard -- seed prod.db host
node bin/soxe exec tokenguard -- seed alice@internal.com email
node bin/soxe exec tokenguard -- seed 10.0.0.1 ipv4
```

**Check for leaks after a run:**

```bash
node bin/soxe exec tokenguard -- summary | jq '.leak_count'
# If leak_count > 0, real values may have leaked in responses
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

```bash
node bin/soxe list | grep tokenguard
# Shows status (RUNNING, STOPPED, or INACTIVE)
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

```bash
node bin/soxe exec tokenguard -- map | jq '.entries | map("\(.real) → \(.token) (source: \(.source))")'
# Shows all (real, token) pairs currently tracked
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
