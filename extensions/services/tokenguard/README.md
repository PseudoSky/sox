# tokenguard — LLM API Proxy for Sensitive-Data Pseudonymization

**Intercept, tokenize, and detokenize LLM API traffic** — works with any provider via base-URL redirection.

## Overview

TokenGuard is a **transparent proxy service** that sits between your client and any LLM API. It:

1. **Tokenizes requests** — replaces sensitive identifiers (hostnames, emails, IPs, etc.) with stable pseudo-tokens
2. **Forwards to the upstream** LLM provider with the sanitized request
3. **Detokenizes responses** — restores the original values so your code sees unmodified answers
4. **Audits traffic** — captures request/response pairs for leak detection and token swap analysis

The result: your LLM provider sees pseudo-tokens; your code sees the real data; audit trails reveal any accidental leaks.

## Workflow: Install → Start → Adopt

### 1. Install

```bash
./bin/sox install tokenguard --scope=org
# or --scope=user, --scope=project, --scope=local
```

This scaffolds the extension in your sox ecosystem.

### 2. Configure

Edit the extension's config (injected via `SOX_CONFIG_*` environment variables, set by the sox supervisor from the install-time schema):

| Variable | Default | Description |
|----------|---------|-------------|
| `SOX_CONFIG_PORT` | `9099` | Proxy port (walks to +1, +2, ... if occupied) |
| `SOX_CONFIG_UPSTREAM` | `https://api.anthropic.com` | Upstream API base URL |
| `SOX_CONFIG_PROVIDER` | `anthropic` | Provider adapter: `anthropic` or `generic` |
| `SOX_CONFIG_CAPTURE` | `truncated` | Body capture mode: `full` / `truncated` / `none` |
| `SOX_CONFIG_CAPTURE_MAX_BYTES` | `4096` | Max bytes per body in truncated mode |
| `SOX_CONFIG_MAP_PATH` | `~/.tokenguard/token-mapping.json` | Where to persist the token map |
| `SOX_CONFIG_CAPTURE_DIR` | `~/.tokenguard` | Where to write audit.jsonl |
| `SOX_CONFIG_SEEDS` | `[]` | Pre-seeded identifiers (JSON array of `{real, type?, token?}`) |
| `SOX_CONFIG_NEVER` | `[]` | Never-tokenize list (JSON array of strings) |
| `SOX_CONFIG_DETECT_PHONE` | `false` | Enable phone number detection |
| `SOX_CONFIG_DETECT_IPV6` | `true` | Enable IPv6 detection |

**Provider-Specific Base URLs** — the key to transparent adoption:

- **Anthropic**: Set `SOX_CONFIG_UPSTREAM=https://api.anthropic.com` and have your client point `ANTHROPIC_BASE_URL=http://localhost:9099` (or the configured port).
- **OpenAI**: Set `SOX_CONFIG_UPSTREAM=https://api.openai.com` and have your client point `OPENAI_API_BASE=http://localhost:9099`.
- **Generic (any provider)**: Set `SOX_CONFIG_UPSTREAM=<your-provider-url>` and `SOX_CONFIG_PROVIDER=generic`, then redirect the client's base-URL env var.

Example: if your client code uses `OPENAI_API_BASE` or `OPENAI_BASE_URL`, set it to the proxy address. The proxy forwards to the real upstream.

### 3. Start

```bash
./bin/sox start tokenguard
# Runs in service mode; spawns supervisor + proxy on the configured port
```

Or via direct invocation:

```bash
npx tsx extensions/services/tokenguard/src/index.ts
```

### 4. Adopt — Point Your Client

Set your **client's base-URL env var** to the proxy:

```bash
# For Anthropic
export ANTHROPIC_BASE_URL=http://localhost:9099

# For OpenAI
export OPENAI_API_BASE=http://localhost:9099
export OPENAI_BASE_URL=http://localhost:9099  # some libs check both

# For any provider
export <YOUR_PROVIDER>_BASE_URL=http://localhost:9099
```

Then run your code as normal. All requests flow through the proxy; responses are seamlessly detokenized.

### 5. Seed Identifiers (Optional)

Pre-populate the token map with known identifiers:

**Via config** (at install time):

```json
{
  "SOX_CONFIG_SEEDS": "[{\"real\":\"prod.internal\",\"type\":\"host\"},{\"real\":\"alice@example.com\",\"type\":\"email\"}]"
}
```

**Via CLI** (at any time):

```bash
./bin/sox exec tokenguard -- seed prod.internal host
./bin/sox exec tokenguard -- seed alice@example.com email
```

Both produce output like:

```json
{"token":"<HOST_1>"}
```

## CLI Tools

The proxy exposes three CLI tools via `sox exec`:

### `seed — <real> <type> [token]`

Append a custom entry to the live token map.

```bash
./bin/sox exec tokenguard -- seed internal.db host
# Output: {"token":"<HOST_1>"}
```

### `map`

Print all current entries (JSON):

```bash
./bin/sox exec tokenguard -- map
# Output: { "entries": [...] }
```

### `summary`

Per-identifier swap counts from the audit log + leak check:

```bash
./bin/sox exec tokenguard -- summary
# Output: { "entries": [...], "leak_count": 0 }
```

## Provider Adapters

TokenGuard includes adapters for different provider behaviors:

### `anthropic` (default)

- **Scopes tokenization** to `system`, `messages`, and `metadata` fields; leaves `tools`, `model`, `max_tokens` verbatim.
- **Handles SSE streams** — reassembles tokens that split across delta boundaries and detokenizes them atomically.
- **Preserves thinking blocks** — never modifies signed `thinking` fields.

### `generic`

- **Tokenizes the full request body** (entire JSON).
- **Detokenizes the full response** (plain string reversal, no SSE-aware reassembly).
- Use this for OpenAI, Anthropic Claude (non-streaming), or any JSON-based API.

## Architecture

```
Client Code
    ↓
[PROVIDER_BASE_URL=http://localhost:9099]
    ↓
TokenGuard Proxy
    ├─ Tokenize request (detectors → mapper → @adhd/sox-tokenguard-core)
    ├─ Forward to upstream
    ├─ Receive response
    ├─ Detokenize response
    └─ Return to client
    ↓
Client sees original values
```

The proxy is **provider-agnostic** — any HTTP API becomes a secure target. The engine (@adhd/sox-tokenguard-core) handles all cryptographic/string work; the service (@adhd/sox-tokenguard) handles HTTP forwarding and audit logging.

## Audit Log

Every request/response pair is logged to `audit.jsonl` (in the configured `SOX_CONFIG_CAPTURE_DIR`):

```json
{"event":"inbound","timestamp":"2025-06-16T10:00:00Z","method":"POST","path":"/v1/messages","capture":"..."}
{"event":"outbound","timestamp":"2025-06-16T10:00:01Z","swap_count":3,"leak_count":0,"outbound_body":"..."}
```

Fields:

- `event`: `inbound` or `outbound`
- `timestamp`: ISO 8601
- `swap_count`: number of tokens that appeared in the outbound response
- `leak_count`: number of unswapped real values (potential breach)
- `outbound_body`: captured response (truncated if capture mode is `truncated`)

Use the `summary` CLI tool to aggregate leak counts.

## Security Notes

- **Tokenization is deterministic** — the same real always maps to the same token. This allows detokenization but means an attacker who observes the proxy traffic could learn the mapping over time.
- **The map file is not encrypted** — store `token-mapping.json` in a secure location (e.g., `~/.tokenguard` with restrictive permissions).
- **Thinking blocks and tools are not tokenized** in the Anthropic adapter to preserve API semantics (thinking is cryptographically signed; tools are untouched).
- **Detection relies on regex patterns** — false positives and false negatives are possible. Audit logs help identify gaps.
- **The proxy does not sandbox the upstream** — it is a transparency mechanism, not a sandbox. Do not rely on it for defense-in-depth against a hostile provider.

## Examples

### Example 1: Anthropic

```bash
# Install
./bin/sox install tokenguard --scope=org

# Configure for Anthropic (already default)
# (leave SOX_CONFIG_UPSTREAM and SOX_CONFIG_PROVIDER as default)

# Start
./bin/sox start tokenguard

# In your client code:
export ANTHROPIC_BASE_URL=http://localhost:9099

# Make your request:
python -c "
import anthropic
client = anthropic.Anthropic()
msg = client.messages.create(
    model='claude-3-5-sonnet-20241022',
    max_tokens=100,
    messages=[
        {'role': 'user', 'content': 'My host is prod.internal and email is alice@example.com. What is 2+2?'}
    ]
)
print(msg)
"

# The proxy sees:
# "My host is <HOST_1> and email is <EMAIL_1>. What is 2+2?"
# Claude responds with tokens; the proxy detokenizes to the original.
```

### Example 2: OpenAI

```bash
# Install & start tokenguard
./bin/sox install tokenguard --scope=org
# Set config:
SOX_CONFIG_UPSTREAM=https://api.openai.com
SOX_CONFIG_PROVIDER=generic

./bin/sox start tokenguard

# In your client:
export OPENAI_API_BASE=http://localhost:9099
export OPENAI_API_KEY=sk-...  # your real key

# Your code routes through the proxy; sensitive data is tokenized en route.
```

### Example 3: Seeding & Audit

```bash
# Pre-seed a list of internal hosts
./bin/sox exec tokenguard -- seed prod.internal host
./bin/sox exec tokenguard -- seed staging.internal host

# Run your workflow

# Check what got tokenized and if there were leaks
./bin/sox exec tokenguard -- summary
# Output: entries (with swap_count), leak_count
```

## Troubleshooting

- **"Connection refused"** — is the proxy running? `./bin/sox start tokenguard` or check logs.
- **"Port already in use"** — the proxy walks up (9099 → 9100 → ...). Check `SOX_CONFIG_PORT` or let it auto-search.
- **"Tokens not reverting"** — is the client using the proxied base URL? Check your env var (e.g., `ANTHROPIC_BASE_URL`).
- **Audit log missing** — check the configured `SOX_CONFIG_CAPTURE_DIR` and that capture mode is not `none`.
- **Leak count > 0** — audit.jsonl shows which responses contained unswapped reals. Review detectors or adjust `SOX_CONFIG_SEEDS` / `SOX_CONFIG_NEVER`.
