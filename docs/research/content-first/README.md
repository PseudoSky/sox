# Content-First Architecture

## The Big Picture

Every high-stakes field — medicine, aviation, military, finance — uses the same pattern to avoid catastrophic mistakes: put multiple specialists in a room with the same evidence. Tumor boards, NTSB investigations, investment committees. It's the highest-yield decision-making pattern in human history. Nobody applies it continuously because specialists are expensive.

Multi-agent AI inherited the opposite architecture without anyone noticing. Role-first puts identity at position 0. Changing roles invalidates the KV cache. Every agent pays full cost to load the same content. A 20-agent review costs $15.60 when it should cost $1.07.

**Content-first flips the structure.** The shared artifact is the anchor. Roles are ephemeral suffixes. Cost scaling flips from $O(N \cdot C)$ to $O(C)$. The 54-year lineage from Waterfall to PR review to modern agent frameworks — all encoding identity-before-content — is an inherited mental model, not a technical necessity.

**Content-addressable KV cache goes further.** Current caches are position-sequential: any mutation at position N cascading-invalidates everything after it. Worse, every agent call recomputes the entire context into the cache from scratch — millions of redundant cache writes for the same content, over and over, call after call. A content-addressable cache hashes blocks independently. Each block is computed once, stored once, and reused everywhere it appears — across agents, across sessions, across completely unrelated prompts. Mutate one block, the rest stay hot. Two agents with different system prompts and different tasks share cache if they read the same file, because the file IS the cache key. The 845 redundant reads in production logs share 95% of their blocks automatically — one compute, infinite reuse.

**Status: The field is converging here — fast.** Position-Independent Caching (PIC) is a 2026 research area with three published approaches: Irminsul (May 2026, SGLang-based, content-hash keyed over CDC-chunked segments — demonstrated for MLA/partial-RoPE models like DeepSeek), MiniPIC (Jun 2026, IBM, deferred RoPE for general models in <100LOC — conflicts with fused kernels), and COMB (Feb 2026, trained encoder approach — requires model modification). SGLang has an active RFC (#30928) to implement this. CacheBlend (EuroSys '25 Best Paper) already enables non-prefix KV reuse in production via selective recomputation. KVCOMM (NeurIPS 2025) specifically addresses cross-agent cache sharing in multi-agent systems.

**The open gap:** A content-addressable KV cache for full-RoPE GQA models (Llama, Mistral, Qwen — the vast majority of deployed models) that works without deferred RoPE (which breaks kernel fusion) and without model architecture changes. Nobody has solved this elegantly yet. Combined with multi-agent multi-writer semantics (different agents contributing KV blocks concurrently to the same content-addressed pool), this is genuinely unclaimed territory.

**Testable today:** You can test whether any provider's cache is position-independent with a simple litmus: send `[X, roleA]` (X at position 0), then send `[roleB, X]` (same X, different position). If `prompt_cache_hit_tokens` for X > 0 in the second call, PIC is live. We ran this against DeepSeek (V3-chat, MLA-native): **896 tokens cached at same position → 0 tokens cached when X shifted to a different position.** DeepSeek is strictly prefix-based. Content-first is essential, not redundant — the position-shift workaround is the only way to share cache across agents until providers ship PIC.

**N² collapses to N.** In a position-sequential cache, accumulated context recomputes on every role switch. In a content-addressable cache, accumulated history is content-stable — every block matches by hash from any prior call, including calls by completely different agents. The N² only bites on genuinely novel content. As agent count → ∞, per-agent compute → O(1). Not cheaper per agent. Constant per agent.

**The play isn't "cheaper agents."** It's making the highest-yield decision-making pattern in human history — multiple specialized perspectives on shared evidence — continuous for software. Tumor boards for every PR. NTSB investigations for every architecture decision. More perspectives at the same budget, faster, forever.

---

## One API Design Decision, 50+ Frameworks

In 2023, OpenAI introduced the `system` role as the first message in a conversation. Anthropic followed. The design was natural: single-agent chat needs a persistent persona, and the first message is the obvious place for identity.

This choice encoded an assumption: **identity before content**. Every major multi-agent framework inherited it without examination — AutoGen, CrewAI, LangGraph, OpenAI SDK, Semantic Kernel. All of them require `Agent(role=..., system_prompt=...)` as a required primitive.

The assumption was never evaluated for multi-agent workloads.

## The Blind Spot

```
Role-first (current default — every framework):
  Agent A: [sys_A, shared_artifact] → cold: pays full content cost
  Agent B: [sys_B, shared_artifact] → cold: different sys prompt = 0 cached
  Agent C: [sys_C, shared_artifact] → cold
  
  Cost: N × C  (each agent independently loads the artifact)

Content-first (proposed):
  Agent A: [shared_artifact, role_A] → cold: pays full content cost
  Agent B: [shared_artifact, role_B] → warm: artifact cached from A
  Agent C: [shared_artifact, role_C] → warm: artifact cached from A
  
  Cost: C + (N-1) × R  (artifact paid once, only role suffix per agent)
```

The cache boundary position determines the economics:
- **Role-first** places the differentiating element (identity) at position 0 → cache breaks on every role switch
- **Content-first** places the shared element (artifact) at position 0 → cache persists across all roles

## The Numbers

**Parallel fork — 6 agents reviewing the same artifact:**

| | Role-First | Content-First |
|---|---|---|
| Input tokens | 23,947t | 6,921t |
| Cached | 0t (0%) | 5,120t (59%) |
| Cost | $0.0093 | $0.0039 |
| Savings | — | **59%** |

At larger artifact sizes (50K+ tokens), savings converge to **90%+** because the artifact fills multiple cache blocks while the role suffix stays ~30 tokens.

**Sequential chain — same role repeats, context accumulates:**

RF caches the system prompt on same-role repeats (e.g., Architect on rounds 1, 3, 5). CF caches the artifact content across ALL rounds regardless of role. CF wins by **35%** in chained workflows, more at scale.

## Why This Is Not a Feature

A feature is something a competitor adds in a sprint. This is a structural property:

| Dimension | Role-first | Content-first | Advantage |
|-----------|-----------|---------------|-----------|
| Content cost scaling | $O(N \cdot C)$ | $O(C)$ | Compounds with N and C |
| Cache boundary | Position 0 (identity) | After artifact | CF has larger shared prefix |
| Marginal agent cost | $C + S_i$ (full) | $R_i$ (~30t) | CF: fixed per agent |
| Cache failure mode | Role switch → full miss | Suffix only → partial | CF degrades gracefully |

**LLM providers** can't change the `system` parameter without breaking billions of prompts. The system field is their abstraction — admitting it should be a suffix would undermine years of documentation.

**Multi-agent frameworks** build their core abstraction around identity as a required primitive: `Agent(role=...)` in CrewAI, separate classes with `system_message` in AutoGen, per-node system prompts in LangGraph. Removing identity as a required field breaks their mental model.

The insight is simple (put role at end instead of beginning). But adopting it means undoing an assumption embedded across three layers of the stack: provider API → framework abstraction → deployed systems.

## How It Works

**Role-first (current):**
```
messages = [
  { role: "system", content: "You are an architect..." },  ← position 0 = role
  { role: "user",   content: "Review this design..." }      ← position 1 = content
]
```

**Content-first (proposed):**
```
messages = [
  { role: "user", content: "<shared design document>\n\nYou are an architect..." }
]
  ^-- position 0 = content              role at end --^
```

In content-first:
- The **system prompt is empty** — no `system` field in the API call
- The **artifact content** is at the beginning of the user message (the cache anchor)
- The **role instruction** is a short suffix (~30 tokens) at the end of the user message

Every agent in a parallel fork receives the same artifact content. Only the role suffix changes. The provider's prefix cache sees identical first tokens → cache hit on subsequent agents.

## Empirical Validation

Tested against DeepSeek Chat (deepseek-chat, temperature=0) with:
- Real system prompts from production opencode agent definitions (~3,000-5,000 tokens each)
- Real codebase artifacts (namespace isolation spec, supervisor state machine, protocol decisions)
- Both parallel fork (independent agents) and sequential chain (accumulating context) patterns
- 10 hypothesis tests (H1-H10) across 4 experiment scripts

All session data with full input/output per round is preserved in `sessions/`.

## Related Work

The fork-join context sharing pattern for multi-agent systems was found to be **UNCONTESTED** in literature after adversarial search against 40+ papers:

- **RAG** retrieves different chunks per query — each agent sees different information. Different problem.
- **DeLM (Mao & Mirhoseini, Stanford)** uses shared context for task decomposition, not multi-perspective analysis with per-agent system prompt forking.
- **Lumer et al. "Don't Break the Cache" (arXiv 2601.06007)** independently confirms that "placing dynamic content at the end of the system prompt provides more consistent benefits."
- **Neumann et al. "Position is Power" (FAccT 2025)** shows system prompt position measurably shapes model behavior, supporting the recency-optimal claim for suffix placement.

## Document Map

| File | What it contains | Current? |
|------|-----------------|----------|
| `README.md` | **Core idea.** What content-first is, why it matters, how it works, key numbers | ✅ Current |
| `proxy/README.md` | **CF proxy harness.** Dual-model A/B testing (`proxy/rf` passthrough vs `proxy/cf` rewrite), JSONL logging schema, how to route any agent through either paradigm, caveats | ✅ Current |
| `RESUME.md` | **Experimental record.** All 7 experiments, methodology, results, how to reproduce | ✅ Current |
| `content-first-thesis.md` | **Competitive thesis.** Why this is not a feature, the blind spot, why incumbents can't adopt it | ✅ Current |
| `cache-performance-model.md` | **How prefix caching works.** Provider behavior, cache blocks, alignment, TTL | ✅ Current |
| `discovery-record.md` | **Historical narrative.** Day-by-day account of how the idea was discovered and tested | ✅ Historical record |
| `fork-join-cost-model.md` | **Mathematics.** Formal cost model: O(N·C) vs O(C), with N×C dimensions across scenarios | ✅ Current |
| `fork-join-round-model.md` | **Message model.** Round-by-round message structure showing cache status per turn | ✅ Current |
| `fork-join-sequence-model.md` | **Sequence diagrams.** 4 tasks × 6 agents with full conversation tracing | ✅ Current |
| `fork-join-architecture-from-plan.md` | **Broader pipeline concept.** Fork-Join as a full planning-to-execution pipeline (extracted from the research plan — references SOX protocol) | ⚠️ May reference SOX |
| `IMPLEMENTATION.md` | **The actual code.** How the shared library works, runner reference, scenario format, how to run your own experiments | ✅ Current |
| `instruction-hierarchy-experiment.md` | **The gating experiment.** IHE-1: tests whether content-first instruction-following is equivalent to role-first. 6 scenarios × 5 trials with blind LLM judge, TOST equivalence testing, statistical analysis. This is the single experiment that must pass before claiming the thesis as complete. | ✅ Generation complete — evaluation pending |
| `PATTERNS.md` | **Two catalogs.** (1) 8 empirically observed agent workflow patterns (P1-P8) discovered across production logs and experimental sessions, with cost models, CF impact analysis, and interaction matrix. (2) 6 historical SDLC role handoff patterns (H1-H6 spanning 1970-2010) that explain why every multi-agent framework defaults to role-first — 54 years of precedent in Waterfall, Fagan inspection, Chief Programmer teams, PR review, ARBs, and CI/CD pipelines. | ✅ Living document |
| `content-first-empirical.md` | **Original empirical writeup** from earlier experiments (E1-E2 via agent-mcp). Data superseded by E6 results in RESUME.md | ❌ Superseded |
| `lib/deepseek-experiment.mjs` | Shared experiment library — API client, runners, session writer | ✅ |
| `scripts/content-first-proof.mjs` | Comprehensive experiment runner (6 scenarios, chain+fork modes) | ✅ |
| `scripts/content-first-tests.mjs` | Hypothesis test suite (H1-H10 with pass/fail) | ✅ |
| `scripts/content-first-verify.mjs` | Quick smoke test with verification checks | ✅ |
| `scripts/content-first-mcp.mjs` | JSON-output variant for CI/programmatic use | ✅ |
| `scripts/pic-litmus.mjs` | **PIC litmus test.** Empirically verifies whether a provider's cache is position-independent or prefix-only. Result: DeepSeek is strictly prefix-based (896t cached at same position, 0t at different position) | ✅ |
| `sessions/*.json` | All 21 experiment session files with full input+output per round | ✅ Current (21 files) |
