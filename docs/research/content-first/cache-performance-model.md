# Cache Performance Model — Fork-Join with Suffix-Cached System Prompts

**Core insight:** The conventional "system prompt first" convention is for single-agent persistence. For multi-agent fork-join, the system prompt (role instruction) should be **last** — appended after the shared conversation history. This maximizes both cache efficiency and behavioral influence.

---

## How Prefix Caching Actually Works

LLMs use autoregressive attention. The Key-Value (KV) cache is computed per token position. When a new request arrives, the provider compares token-by-token from position 0. Every matching prefix position skips recomputation. The first non-matching position — the **cache boundary** — is where new computation begins.

```
Request 1: [token0, token1, token2, token3, token4]  ← fully computed
                        ───── cached ─────
Request 2: [token0, token1, token2, token3, token4']  ← token0-3 cached,
                                               ↑      ← only token4' computed new
                                         cache boundary
```

The cache boundary position determines efficiency: the longer the identical prefix, the more tokens are served from cache.

---

## The Correct Structure: System Prompt Last

In a SOX channel, M messages accumulate. At turn M, N agents are forked by appending different role instructions:

```
History (shared prefix, cached once):
  [msg1, msg2, msg3, ..., msgM]

Agent A (Security):
  [msg1, msg2, msg3, ..., msgM, "You are a Security Engineer. Review this design for threats."]
                                         ↑
                                    cache boundary — only this suffix is new

Agent B (Architect):
  [msg1, msg2, msg3, ..., msgM, "You are an Architect. Review this design for trade-offs."]
                                         ↑
                                    cache boundary — same shared prefix, different suffix

Agent C (PM):
  [msg1, msg2, msg3, ..., msgM, "You are a Product Manager. Review this for scope and timeline."]
                                         ↑
                                    cache boundary
```

**Variables:**

| Symbol | Meaning |
|---|---|
| $H$ | Size of shared conversation history (all prior messages) in tokens |
| $R_i$ | Size of agent $i$'s role instruction (suffix) in tokens |
| $P_i$ | Size of agent $i$'s generated output in tokens |
| $N$ | Number of role-specific agents |

---

## Cache Behavior per Agent

| Agent | Prefix (cached) | Newly computed | Cache hit ratio |
|---|---|---|---|
| 1 (cold) | — | $H + R_1$ | 0% (seed) |
| 2 | $H$ | $R_2$ | $H / (H + R_2)$ |
| 3 | $H$ | $R_3$ | $H / (H + R_3)$ |
| $i$ | $H$ | $R_i$ | $H / (H + R_i)$ |

**Total input tokens newly computed:** $\displaystyle H + R_1 + \sum_{i=2}^{N} R_i = H + \sum_{i=1}^{N} R_i$

**Without caching (N independent calls, each loading full history):** $\displaystyle N \cdot H + \sum_{i=1}^{N} R_i$

**Cache savings:** $\displaystyle (N-1) \cdot H$

### Numerical examples

**Example 1: Design review, N=5, H=12K, R≈100 tokens**

| Metric | Value |
|---|---|
| Without caching | $5 \times 12,000 + 500 = 60,500$ tokens |
| With fork-join | $12,000 + 500 = 12,500$ tokens |
| **Savings** | **79.3%** |
| **Cache hit ratio** | **99.2%** per agent after seed |

**Example 2: Large review, N=20, H=50K, R≈100 tokens**

| Metric | Value |
|---|---|
| Without caching | $20 \times 50,000 + 2,000 = 1,002,000$ tokens |
| With fork-join | $50,000 + 2,000 = 52,000$ tokens |
| **Savings** | **94.8%** |
| **Cache hit ratio** | **99.8%** per agent after seed |

**Example 3: Brief task, N=3, H=4K, R≈100 tokens**

| Metric | Value |
|---|---|
| Without caching | $3 \times 4,000 + 300 = 12,300$ tokens |
| With fork-join | $4,000 + 300 = 4,300$ tokens |
| **Savings** | **65.0%** |
| **Cache hit ratio** | **97.6%** per agent after seed |

---

## Why System Prompt Last is Correct

| Property | System first | System last |
|---|---|---|
| **Cache boundary** | After system prompt. Changing system invalidates entire prefix. | After conversation history. History is stable, role suffix is the only change. |
| **Attention quality** | System at position 0 — attends to nothing before it, subject to "lost in the middle" after a few turns. | System at end — attends to ALL prior context, richest attention, right before generation. |
| **Behavioral influence** | Broadcast but diluted over long conversations. | **Maximum** — last tokens before generation dominate model output. |
| **Multi-turn persistence** | Stable at position 0 forever. | **Stable at end because it's re-appended each turn.** Never drifts into the middle. |
| **Fork-join parallelism** | Changing system → full cache miss per agent. | **All agents share H as cached prefix. Only R_i is new. >99% hit rate.** |

**The system-first convention exists for single-agent persistent personas.** In multi-agent planning, each agent has a task-specific role. There's no persistent persona to maintain across conversations. Appending the role at the end is architecturally correct for fork-join.

---

## Provider Independence

This structure works identically on all three major providers because the cache behavior depends only on token-position prefix matching:

| Provider | Messages structure | Cache behavior |
|---|---|---|
| **Anthropic Claude** | `messages = [H..., {role: "user", content: R_i}]` | H cached, only R_i computed |
| **OpenAI** | Same structure | Identical — prefix matching is token-level |
| **Google Gemini** | Same structure | Identical |

No special `system` parameter needed. The role instruction is simply the last user message.

---

## Cache Hit Ratio as a Function of N and H

$$\text{Cache hit ratio (seed-adjusted)} = \frac{(N-1) \cdot H}{N \cdot H + N \cdot \bar{R}} = \frac{(N-1)}{N} \cdot \frac{H}{H + \bar{R}}$$

As $N \to \infty$: $\displaystyle \text{hit ratio} \to \frac{H}{H + \bar{R}}$

Since $H \gg \bar{R}$ (conversation history is 40-500× larger than a role instruction), the asymptotic hit ratio is **97.5% to 99.8%**.

| N | H=4K | H=12K | H=50K | H=100K |
|---|---|---|---|---|
| 3 | 65% | 79% | 84% | 87% |
| 5 | 77% | 79% | 94% | 97% |
| 10 | 86% | 89% | 97% | 98% |
| 20 | 90% | 94% | 98% | 99% |
| 50 | 93% | 94% | 99% | 99.5% |

---

## Economic Interpretation

The marginal cost of adding one more agent perspective is:

$$\text{cost}_\text{marginal} \approx \bar{R} + P_i$$

Where $\bar{R} \approx 100$ tokens (role instruction) and $P_i$ is the generated analysis. The expensive part — loading the shared history $H$ — is paid exactly once.

Without fork-join, the marginal cost would be $H + \bar{R} + P_i$ — 40-500× more. This is the difference between a 20-agent review being economically feasible vs. prohibitive.

---

## The Group Conversation Baseline

For comparison, a SOX channel with M messages (no forking) behaves as:

| Message | Cache state | New tokens |
|---|---|---|
| 1 | Cold | $H_1$ |
| 2 | Prefix = $H_1$, suffix = $H_2$ | $H_2$ |
| m | Prefix = $\sum_{i=1}^{m-1} H_i$, suffix = $H_m$ | $H_m$ |

**Total new:** $\displaystyle \sum_{m=1}^{M} H_m$ (all messages — each is the new suffix)

**Cache efficiency:** grows with conversation length. The 50th message has a ~98% cache hit ratio because only its own content is new.

**Fork-join vs. group conversation:** fork-join gives N agents the benefit of the group conversation's caching (the history) while only paying the cost of N role suffixes. Without fork-join, N agents would each start a cold conversation, paying N × full history cost.
