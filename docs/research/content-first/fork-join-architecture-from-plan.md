## 4. Fork-Join Architecture — Separate, Larger Concept

### 4.1 Concept Overview

Beyond the SOX protocol itself, the research uncovered a broader architectural pattern that emerged from the user's use-case exploration. This pattern is a **complete planning-to-execution pipeline** for multi-agent systems, consisting of four distinct layers:

```
┌──────────────────────────────────────────────────────────┐
│ PHASE 1: DIVERGE                                          │
│ N:N Room (SOX channel with role-specialized agents)       │
│   Shared context loaded once → forked per agent system    │
│   prompt → independent analysis → all posted to channel   │
│   ├── Fork: "You are Architect" + shared context          │
│   ├── Fork: "You are Security" + shared context           │
│   ├── Fork: "You are Performance Eng" + shared context    │
│   ├── Fork: "You are PM" + shared context                 │
│   └── Human as peer participant (same affordances)        │
├──────────────────────────────────────────────────────────┤
│ PHASE 2: FILTER                                           │
│ Judge (Human or LLM)                                      │
│   Reviews channel history                                 │
│   Weighs ACK/NACK signals as structured consensus data    │
│   Produces condensed context document for execution       │
├──────────────────────────────────────────────────────────┤
│ PHASE 3: CONVERGE                                         │
│ Sequential Agent (Claude Code, etc.)                      │
│   Receives condensed context from judge                   │
│   Executes the plan — no role-switching needed            │
│   Single focused context window                           │
└──────────────────────────────────────────────────────────┘
```

### 4.2 Key Architectural Innovations

This architecture inverts the fundamental topology of existing multi-agent frameworks. Current frameworks (CrewAI, LangGraph, OpenAI SDK) pre-wire a fixed interaction graph — who talks to whom, in what order, what they're responsible for. This architecture replaces fixed topology with **emergent topology**: rooms are instantiated and closed dynamically based on task need.

| Property | Existing frameworks | Fork-Join architecture |
|---|---|---|
| Topology | Pre-wired (turn graph, state machine) | Emergent (rooms instantiated per task) |
| Context distribution | Each agent loads independently | Shared context cached once, forked per agent |
| Human role | Supervisor / approver | Peer participant + judge (two distinct roles) |
| Planning vs. execution | Same topology for both | N:N for planning, sequential for execution |
| Context curation | Implicit (whatever fits in prompt) | Explicit judge layer |
| Scalability | N independent context reads | 1 shared read + N forks |

### 4.3 Novel Feature Analysis

Each component was analyzed against published literature (40+ papers surveyed) to determine novelty. Features are rated as **UNCONTESTED** (no published work found), **PARTIAL** (some related work but distinguishable), or **EXISTING** (well-established).

#### Feature 1: Fork-join context sharing for LLM agents

**Rating: UNCONTESTED (with refined claim)**

**Claim:** Loading a shared artifact ONCE, broadcasting it to all agents via a channel, and having each agent FORK from the shared context with their role-specific system prompt is not described in published literature.

**Refined claim after adversarial testing:** "Shared context with per-agent system prompt branching for multi-perspective analysis of a single artifact, with an explicit judge layer for context curation."

**Evidence from adversarial search:**
- RAG retrieves different chunks per query — each agent sees different information. RAG is for finding answers, not generating perspectives. Different problem.
- Multi-agent frameworks (AutoGen, CrewAI, LangGraph) give each agent independent tool access and knowledge, but do not share a cached common context that each agent then forks from. Each agent independently loads what it needs.
- **DeLM (Mao & Mirhoseini, Stanford, arXiv 2606.10662)** is the closest prior art. Proposes "shared verified context" for decentralized task decomposition. Agents claim subtasks, read progress, write verified updates. SWE-bench gains 10.5pp. DISTINGUISHABLE: DeLM uses shared context for TASK DECOMPOSITION (different agents work on different subtasks with the same system prompt), not MULTI-PERSPECTIVE ANALYSIS (different agents analyze the same artifact with different system prompts). DeLM has no judge layer, no ACK/NACK signals, no per-agent system prompt forking.
- SlackAgents (EMNLP 2025) uses Slack channels but no fork-join context pattern.
- LLM-X (AGENT 2026) uses message bus for negotiation but each agent has independent context.
- The specific combination of: ingest-once-broadcast + per-agent system prompt fork + multi-perspective analysis + judge layer with ACK/NACK signals remains uncontested.

**Adversarial search terms used:** "shared context multi-agent LLM parallel analysis same document perspective," "context branching agent LLM fork prompt multi-perspective," "prompt forking multi-agent parallel context," "broadcast context multiple agents system prompt per-agent."

#### Feature 2: Room topology vs. turn topology

**Rating: UNCONTESTED**

**Claim:** Dynamically instantiating and closing N:N "rooms" for specific planning sessions (rather than pre-wiring a fixed interaction graph) is not described in published multi-agent frameworks.

**Evidence from adversarial search:**
- Every surveyed framework pre-defines agent interactions: CrewAI has sequential/hierarchical processes, LangGraph has a compiled graph, OpenAI SDK has handoff chains, AutoGen has topic subscriptions but still within a fixed agent topology.
- The concept of "rooms" as ephemeral, purpose-specific, role-populated channels that are created for a session and disbanded when done is not described.
- Closest related concept is JADE's agent mobility (1999) — agents can move between containers — but this is about process migration, not room-based collaboration topology.
- SlackAgents uses persistent Slack channels, not ephemeral rooms created per session.

**Adversarial search terms used:** "ephemeral agent room channel instantiated session," "dynamic agent topology room-based," "emergent agent interaction graph not pre-wired," "populated channel role-specific agents instantiated closed."

#### Feature 3: Human as peer participant (not supervisor)

**Rating: PARTIAL — some related work exists but distinguishable**

**Claim:** A human participating in a multi-agent channel with the SAME affordances as AI agents (same read/post/thread/ack capabilities, no special authority) is a distinct human-AI interaction model.

**Evidence:**
- Most multi-agent systems with human involvement cast the human as: supervisor (LangGraph human-in-the-loop), approver (CrewAI human approval), tool caller (human invokes agents), or user (human gives task, agents execute). In all cases, the human has DIFFERENT affordances from the agents — they approve/reject, not participate.
- The Deng et al. (ICML 2026) clarification paper has human-in-the-loop for question answering, but the human is an information source, not a peer collaborator.
- No paper describes human and AI agents sharing the same channel with symmetric read/write/thread capabilities.
- **Distinction holds:** peer participation ≠ supervisory approval ≠ tool invocation ≠ user query.

**Adversarial search terms used:** "human AI agent symmetric affordances collaboration," "human peer multi-agent system," "human participant same capabilities as AI agent channel."

#### Feature 4: ACK/NACK as structured input to a synthesis judge

**Rating: UNCONTESTED**

**Claim:** Using protocol-level ACK/NACK signals from a messaging channel as structured input to a judge/synthesis layer (which decides what enters execution context) is not described in published literature.

**Evidence:**
- Consensus mechanisms in multi-agent systems typically use voting, majority rules, or LLM-as-judge on natural language outputs. None use protocol-level ACK/NACK as the input signal.
- ACK/NACK in SOX is a formal protocol signal with forward-only state transitions (pending → received → processing → done/nack). This is richer than a simple upvote/downvote.
- The combination: channel messages accumulate → ACK/NACK signals indicate per-agent stance → judge reads both content and signals → condensed context produced for executor. This pipeline is novel.

**Adversarial search terms used:** "ACK NACK multi-agent consensus decision synthesis," "protocol signal aggregation judge layer context curation," "consensus signal structured input synthesis agent."

#### Feature 5: Context curation as explicit architectural layer

**Rating: UNCONTESTED**

**Claim:** Having an explicit "context curation" layer whose job is to decide what fits in the execution agent's context window (filtering the room's output) is not described in published literature. Existing systems either fit everything in context (window overflow) or rely on implicit truncation (losing information without decision).

**Evidence:**
- Agent context management papers focus on: context window compression (Lost in the Middle, RULER), retrieval strategies (RAG), memory management (MemGPT, Letta). None describe a curation layer that explicitly decides what information is WORTH keeping vs. discarding based on structured quality signals (ACK/NACK).
- The closest is summarization — but summarization compresses everything, it doesn't FILTER based on signal quality.
- The judge's decision is not "summarize the conversation" but "what from this conversation should the executor act on?" — a fundamentally different task.

**Adversarial search terms used:** "context curation layer agent execution filter," "context window budget allocation decision explicit," "what to keep in agent context selection signal."

#### Feature 6: Three-phase pipeline with topology-per-phase

**Rating: UNCONTESTED**

**Claim:** The specific pattern of diverge (N:N room) → filter (judge, 1:N) → converge (sequential, 1:0), with a different communication topology per phase mapped to the phase's intrinsic needs, is not described in published work.

**Evidence:**
- The Sander et al. taxonomy paper and Yang et al. survey both discuss individual protocols but not multi-protocol composition into phased pipelines.
- The ProtocolBench paper (ICML 2026) proposes ProtocolRouter for per-scenario protocol selection but selects ONE protocol per scenario — not a pipeline where each phase uses a different protocol.
- No paper explicitly maps communication topology to phase of work (planning needs N:N, execution needs 1:0) and builds a pipeline around it.

**Adversarial search terms used:** "multi-phase multi-agent pipeline different communication topology per phase," "diverge converge agent planning execution pipeline," "topology per phase multi-agent architecture."

### 4.4 Summary of Novelty

| Feature | Rating | Publication potential | Effort |
|---|---|---|---|
| Fork-join context sharing | **UNCONTESTED** | High — core architecture paper | Moderate (draft + evidence) |
| Room vs. turn topology | **UNCONTESTED** | High — paradigm paper | Moderate |
| Human as peer participant | **PARTIAL** | Medium — HCI angle | Low (framing + related work) |
| ACK/NACK → judge pipeline | **UNCONTESTED** | High — systems paper | Low (spec + example) |
| Context curation layer | **UNCONTESTED** | High — systems paper | Moderate |
| Three-phase topology pipeline | **UNCONTESTED** | Very high — visionary paper | Low (position) |

### 4.5 Relationship to Existing Papers

This architecture is bigger than SOX itself. SOX is the substrate that enables the N:N room phase. The full architecture includes:

- **SOX** (the protocol) → N:N room substrate
- **Fork-join pattern** → how agents use the room
- **Judge pattern** → how the room's output becomes execution context
- **Mixed model** → when to use N:N vs. sequential
- **Pipeline** → how the phases compose

Existing papers cover fragments: SlackAgents (EMNLP 2025) covers N:N via Slack but without fork-join or judge. LLM-X (AGENT 2026) covers message-bus LLM communication but for negotiation only, not for general planning. Sander et al. taxonomy covers protocols but not multi-protocol pipelines.

### 4.6 Publication as Standalone Paper

**Proposed Paper P10: "Fork-Join Architecture for Multi-Agent Planning and Execution"**

**Target:** Vision paper (arXiv) or conference (NeurIPS 2027 systems track, or a multi-agent systems venue)

**Length:** 8-12 pages

**Outline:**
```
1. Introduction — the topology mismatch problem
2. Related Work — why existing frameworks pre-wire topology
3. Fork-Join Context Sharing — shared cache, per-agent system prompt branching
4. Room Topology — ephemeral role-populated channels vs. fixed turn graphs
5. Judge Layer — ACK/NACK as structured input for context curation
6. Three-Phase Pipeline — diverge → filter → converge
7. Human-AI Symmetry — peer participation model
8. Implementation Sketch — SOX as the substrate
9. Research Agenda — open questions, evaluation methodology
10. Conclusion
```

**Novelty claims (all tested adversarially):**
- Fork-join context sharing is not described in literature (distinct from RAG, independent agent loading)
- Room topology (ephemeral, role-populated, dynamically instantiated) is not described in literature
- ACK/NACK as structured input to a synthesis judge is not described in literature
- Context curation as explicit architectural layer is not described in literature
- Three-phase pipeline with topology-per-phase is not described in literature

**Evidence needed:** Summaries of adversarial searches for each claim (already stored in memory).

