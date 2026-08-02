# CF Proxy — Harness, Logging, and A/B Testing

> The content-first proxy doubles as an **A/B testing harness** for comparing role-first (RF, passthrough) against content-first (CF, rewrite) — using any agent definition, not just purpose-built ones.

---

## 1. The Two Model Identifiers

The proxy registers as a single opencode provider (`proxy`) with two model identifiers that route the **same agent definition** through either paradigm:

| Model ID | Mode | What happens |
|----------|------|-------------|
| `proxy/rf` | **Passthrough** | Messages forwarded verbatim to DeepSeek. System prompt stays at position 0. This is the control group — role-first baseline. |
| `proxy/cf` | **Rewrite** | Messages rewritten content-first: system prompt moved to the end of the LAST user message. This is the treatment — content-first. |

**Why model-based routing (not agent-based):** Any agent definition can be A/B tested by switching its `model` field between `proxy/rf` and `proxy/cf`. You don't need a separate "CF architect" and "RF architect" — the same `architect` agent definition runs through both paradigms, and the proxy logs which mode handled each call.

This is the correct design: it isolates the **single variable** (message ordering) while holding the agent's system prompt, tools, and permissions constant.

---

## 2. Routing Logic

The proxy routes per-request based on the `model` field in the API call:

```javascript
const isCFModel = /(^|\/)cf$/.test(modelStr) || modelStr === 'cf';
const doPassthrough = PASSTHROUGH || !isCFModel;
```

- `proxy/cf` (or any model string ending in `/cf`, or bare `cf`) → **rewrite**
- `proxy/rf` (or anything else) → **passthrough**
- `CF_PASSTHROUGH=1` env override → force passthrough regardless

In both modes the upstream model is hard-coded to `TARGET_MODEL` (`deepseek-v4-flash`) — the client's model string is only used for routing, never forwarded.

---

## 3. Logging (JSONL)

Every request is appended to `proxy-cf-log.jsonl` (override with `CF_LOG=<path>`). One JSON object per line:

### Passthrough (RF) entries
```json
{
  "_log_tag": "proxy/rf",
  "endpoint": "/v1/chat/completions",
  "passthrough": true,
  "system": "You are an architect...",
  "user_first": "<first 120 chars of first user msg>",
  "user_last": "<last 120 chars of last user msg>",
  "conversation_depth": 89,
  "rf_tokens": 544292,
  "rf_cached": 543744,
  "rf_output": 412
}
```

### Rewrite (CF) entries
```json
{
  "_log_tag": "proxy/cf",
  "endpoint": "/v1/chat/completions",
  "passthrough": false,
  "system_original": "You are an architect...",
  "system": "You are an architect...",           // what actually went upstream (appended)
  "user_first": "<first 120 chars>",
  "user_last": "<last 120 chars>",
  "conversation_depth": 89,
  "agent_switch": true,
  "agent_switch_verdict": "✅ Context survived agent switch (seed cached)",
  "cf_tokens": 541253,
  "cf_cached": 541312,
  "cf_output": 418,
  "savings_pct": "0.0",
  "cached_seed": false,
  "seed_tokens": 16,
  "system_tokens": 3100
}
```

### Fork entries
```json
{
  "endpoint": "/v1/chat/fork",
  "forks": 3,
  "shared_context_tokens": 980,
  "results": [
    {"index": 0, "warm": false, "tokens_in": 1012, "tokens_out": 412, "savings": "0.0 (cold seed)"},
    {"index": 1, "warm": true,  "tokens_in": 130,  "tokens_out": 387, "savings": "89.8"},
    {"index": 2, "warm": true,  "tokens_in": 128,  "tokens_out": 419, "savings": "89.8"}
  ]
}
```

### Key fields

| Field | Meaning |
|-------|---------|
| `passthrough` | `true` = RF (control), `false` = CF (treatment) |
| `conversation_depth` | Number of user turns — how deep the conversation is |
| `rf_tokens` / `cf_tokens` | Total input tokens for that call |
| `rf_cached` / `cf_cached` | Tokens served from DeepSeek's cache (`prompt_cache_hit_tokens`) |
| `agent_switch` | `true` if the conversation has >2 turns (i.e., context carried over) |
| `agent_switch_verdict` | Human-readable verdict on whether cache survived a switch |
| `savings_pct` | Proxy's simulated savings (checks first-user-message block only — **underestimates** real savings on deep conversations) |

---

## 4. How to Run an A/B Test

### Setup
```bash
cd docs/research/content-first
export DEEPSEEK_API_KEY="sk-..."
node proxy/cf-proxy.mjs &        # port 3333
```

### Step 1 — Choose an agent definition
Any agent works. Example: use the existing `architect` agent.

### Step 2 — Run the RF (control) leg
Set the agent's model to `proxy/rf` (or edit the agent definition):
```yaml
model: proxy/rf
```
Run your test conversation. The proxy logs each call with `passthrough: true`.

### Step 3 — Run the CF (treatment) leg
Switch the agent's model to `proxy/cf`:
```yaml
model: proxy/cf
```
Run the **same** conversation. The proxy logs with `passthrough: false`.

### Step 4 — Compare
```bash
python3 -c "
import json, statistics
rf = []; cf = []
for line in open('proxy/proxy-cf-log.jsonl'):
    d = json.loads(line)
    if d.get('passthrough'):
        rf.append(d['rf_cached'] / d['rf_tokens'])
    else:
        cf.append(d['cf_cached'] / d['cf_tokens'])
print(f'RF cache hit rate: {statistics.mean(rf)*100:.1f}%  (n={len(rf)})')
print(f'CF cache hit rate: {statistics.mean(cf)*100:.1f}%  (n={len(cf)})')
"
```

---

## 5. Caveats

1. **Simulated vs real savings.** The proxy's `savings_pct` field checks only the FIRST user message's block size. On deep conversations the real DeepSeek cache (via `cf_cached`) is the ground truth — trust `rf_cached`/`cf_cached` over `savings_pct`.

2. **Cache block minimum.** DeepSeek's cache needs ~1,024 tokens before it engages. Short conversations (<1K tokens total) show 0 cache in both modes — that's expected, not a bug.

3. **The `agent_switch_verdict` heuristic.** The "seed too small" verdict fires when the first user message is <1K tokens, even though the accumulated conversation may be huge and fully cached. The `cf_cached` field is the reliable signal.

4. **Same-family judge bias.** If you evaluate output quality with DeepSeek judging DeepSeek outputs, scores are inflated for both paradigms equally in a paired design, but cross-family confirmation (e.g., GPT-4o judge) is stronger evidence.

---

## 6. Files

| File | Purpose |
|------|---------|
| `proxy/cf-proxy.mjs` | The proxy server (streaming, fork, logging, routing) |
| `proxy/proxy-cf-log.jsonl` | Structured log of every request (RF + CF + fork) |
| `opencode.json` | `proxy` provider with `rf`/`cf` models |
| `~/.config/opencode/agents/cf-review.md` | Example agent using `proxy/cf` |
| `scripts/test-proxy-ihe1.mjs` | End-to-end proxy test (health, completions, fork, negation) |
