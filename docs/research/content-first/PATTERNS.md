# Content-First Architecture — Workflow Patterns

> A catalog of empirically observed multi-agent workflow patterns, their characteristics, and their implications for the content-first architecture thesis.

**Status:** Living document. New patterns added as they are discovered and verified.
**Last updated:** 2026-07-27

---

## Pattern Taxonomy

Each pattern entry includes:
- **P#:** Pattern identifier
- **Name:** Descriptive name
- **Source:** Where it was observed (production logs, experimental sessions, or both)
- **Structure:** Visual trace of the pattern
- **Characteristics:** Defining features, cost profile, cache behavior
- **Evidence:** Sessions, files, line numbers that demonstrate it
- **CF Impact:** How content-first architecture changes this pattern's economics
- **Instruction Hierarchy Risk:** Whether the pattern raises concerns for IHE-1

---

## P1 — Sequential Agent on Shared File (SASF)

**Source:** Production logs (`577ddce9`, `65871d78`)

**Structure:**
```
Agent 1: system=[3Kt agent identity]
         user=[task: "Fix IPv6 normalization in reaper/tui.py"]
         → Read reaper/tui.py (15Kt, pays full cost)
         → Edit at L10722
         → 277 reads during work session

Agent 2: system=[3Kt agent identity]           ← different SP → cache miss
         user=[task: "Implement CEL evaluator in reaper/tui.py"]
         → Read reaper/tui.py (15Kt, pays full cost AGAIN)
         → Edit at L12265

Agent 3: system=[3Kt agent identity]           ← different SP → cache miss
         user=[task: "Dedupe Active files list"]
         → Read reaper/tui.py (15Kt, pays full cost AGAIN)
         → Edit at L13367
```

**Characteristics:**
- Multiple agents operate on the same file(s) sequentially
- Each agent has a different task (different "perspective" on the same code)
- Each agent pays full file-load cost on first read
- Subsequent reads by the same agent within its session hit cache (same SP)
- Cross-agent reads always cold (different system prompts at position 0)
- Agent N reads include Agent 1..N-1's edits (accumulating context)

**Evidence:**
- `577ddce9`: `reaper/tui.py` — 8 agents, 277 reads. 6 edits by 6 different agents.
- `577ddce9`: `proc_detective/tui.py` — 7 agents, 74 reads.
- `577ddce9`: `reaper/profile.py` — 6 agents, 71 reads.
- `577ddce9`: 39 files shared by 2+ agents, 845 total reads.
- `65871d78`: `BACKLOG.md` — 6 agents, `apps/sox/src/main.ts` — 3 agents.
- `65871d78`: `libs/memory-core/src/write.ts` — 2 agents.

**Cost model (per file, N agents, C = file tokens, S = system prompt tokens):**
$$\text{Cost}_{\text{RF}} = N \times (S + C) + \sum O_i$$
$$\text{Cost}_{\text{CF}} = C + N \times R + \sum O_i$$

At N=8, C=15K, S=3K, R=50: **RF = 144Kt, CF = 15,400t. Savings: 89%.**

**CF Impact:** High. File content cached once for all N agents. Only task suffixes (~50t each) are unique. This is the highest-value pattern for content-first.

**Instruction Hierarchy Risk:** High. The task instruction (what to edit, constraints on the edit) must produce correct, precise edits whether it's in the system prompt or at the end of the file content. This is the core IHE-1 question.

---

## P2 — Fork-Multi-Perspective (FMP)

**Source:** Experimental sessions (`fork-final.json`, `fork-opencode.json`, `fork-noprefix.json`)

**Structure:**
```
Agent A: system=[role A]  user=[seed artifact]  → analysis A
Agent B: system=[role B]  user=[seed artifact]  → analysis B  (0 cache: different SP)
Agent C: system=[role C]  user=[seed artifact]  → analysis C  (0 cache)
Agent D: system=[role D]  user=[seed artifact]  → analysis D  (0 cache)
```

**Characteristics:**
- All agents receive identical seed content (shared artifact)
- Each agent has a different role (different system prompt)
- No agent sees other agents' outputs (parallel, independent)
- Every agent pays full seed content cost
- Zero cache reuse across agents
- Outputs collected independently for downstream aggregation

**Evidence:**
- `fork-final.json`: 4 agents (Architect, Reviewer, Backend, Product) on namespace spec. RF: 16,338t input, CF: 4,417t input. 60.3% savings.
- `fork-noprefix.json`: 6 agents on namespace spec. RF: 23,947t input, CF: 6,921t input. 59.3% savings.
- `fork-opencode.json`: Similar pattern, 59.5% savings.

**Cost model:**
$$\text{Cost}_{\text{RF}} = N \times (S_i + C) + \sum O_i$$
$$\text{Cost}_{\text{CF}} = C + \sum (R_i + O_i)$$

**CF Impact:** Highest relative savings (60-96% depending on N and C). The fork pattern is the "killer app" — zero cache reuse in RF, near-100% in CF.

**Instruction Hierarchy Risk:** Moderate. The role instruction (the "perspective") is the only variable between agents. If CF degrades role adherence, each agent's output becomes less distinct — defeating the purpose of multi-perspective analysis. But the H10 session evidence (P6 below) suggests CF may actually be MORE role-compliant on DeepSeek.

---

## P3 — Sequential Chain with Role Repeats (SCRR)

**Source:** Experimental sessions (Scenario 6, `chain-repeats.json`)

**Structure:**
```
R1: Architect  → reads seed, writes output A1
R2: Reviewer   → reads seed + A1, writes output R1    (0 cache: different SP)
R3: Architect  → reads seed + A1 + R1, writes A2      (SP cached from R1)
R4: Platform   → reads seed + ... + A2, writes P1      (0 cache: different SP)
R5: Architect  → reads seed + ... + P1, writes A3      (SP cached from R1, R3)
R6: Compliance → reads seed + ... + A3, writes C1      (0 cache: different SP)
```

**Characteristics:**
- Roles alternate in a defined sequence
- Some roles repeat (Architect on R1, R3, R5)
- Context accumulates over rounds (each agent sees all prior outputs)
- RF gets cache hits on same-role repeats (same system prompt)
- CF gets cache hits on ALL rounds (same seed content prefix)
- The savings are more modest than FMP because RF also gets some caching

**Evidence:**
- `chain-repeats.json`: 6 rounds, 4 distinct roles, 3 architect repeats. RF: 26,475t input, CF: 8,181t input. 34.7% savings.
- RF Architect R1: 2,803t input, 2,688t cached (from prior experiment's cache — see P7).
- RF Architect R3: 4,012t input, 2,688t cached (same SP). CF R3: 1,058t, 384t cached.
- RF Architect R5: 5,223t input, 3,968t cached. CF R5: 2,222t, 1,536t cached.

**Cost model:**
$$\text{Cost}_{\text{RF}} = \sum_{i=1}^{N} \left(S_i + C + \sum_{j=1}^{i-1} O_j\right)$$
$$\text{Cost}_{\text{CF}} = \sum_{i=1}^{N} \left(R_i + O_i\right) + C \text{ (first round only)}$$

**CF Impact:** Moderate (35-50% savings). RF benefits from same-role SP caching, so the delta is smaller than FMP. But the accumulated context (all prior outputs) grows linearly — CF caches it all, RF only caches the system prompt fragment.

**Instruction Hierarchy Risk:** High for multi-turn compliance. Does the role suffix at the end of an accumulating context (R5 has seed + 4 prior outputs before the suffix) maintain equal compliance as the system prompt? The "lost in the middle" problem predicts the suffix position is actually BETTER because it's always at recency position.

---

## P4 — Parallel Worktree Dispatch (PWD)

**Source:** Production logs (`65871d78`)

**Structure:**
```
Agent 1: [worktree A] system=[3Kt agent identity]  task="BL-157: fix proxy-closed..."
Agent 2: [worktree B] system=[3Kt agent identity]  task="BL-162: delete bundle member..."
Agent 3: [worktree C] system=[3Kt agent identity]  task="BL-164: promote scripts..."
Agent 4: [worktree D] system=[3Kt agent identity]  task="BL-165: route through ingest..."
...
Agent 33: [worktree Z]
```

**Characteristics:**
- Agents dispatched in parallel across git worktrees
- Each agent works on independent BL backlog items
- No sequential dependency between agents
- BUT: agents share the same codebase context (read the same files)
- Each agent starts cold (full system prompt + file loads)
- Merge happens serially after all agents complete

**Evidence:**
- `65871d78`: 33 TaskCreate dispatches, many to parallel worktrees.
- Agents frequently read the same files (`BACKLOG.md`, `apps/sox/src/main.ts`, `libs/memory-core/src/write.ts`).

**CF Impact:** High. Even though tasks are independent, the shared codebase reads are redundant. Content-first would cache shared file content across all agents, even in parallel worktrees.

**Instruction Hierarchy Risk:** Low (for individual task compliance). Each agent has one clear task. The question is whether task-instruction-as-suffix produces equivalent code edits. But this is just P1 (SASF) repeated in parallel across worktrees.

---

## P5 — System Prompt Constraint Interference (SPCI)

**Source:** Experimental sessions with real opencode agent definitions (`fork-final.json`)

**Structure:**
```
RF: system=[3,600t opencode architect agent with classification gate]
    user=[namespace spec]
    → "## Short-circuit: NOT ARCHITECTURE. This is a spec document..."
    → 104t output (REFUSED — classification gate fired)

CF: user=[namespace spec + "\n\nYou are an architect. Review."]
    → Detailed 438t architectural review
    → FULLY COMPLIANT
```

**Characteristics:**
- Real production system prompts contain behavioral protocols:
  - **Classification gates:** "Short-circuit: refuse immediately if X"
  - **Memory/research protocols:** "Query memory first, then delegate to researcher"
  - **Tool delegation rules:** "For X, dispatch the researcher subagent"
  - **Edit scope constraints:** "edit scope: BACKLOG.md entries and small inline fixes only"
  - **Format requirements:** "Output as review-report-v1 JSON schema"
- These protocols fire before the agent addresses the user's actual request
- When protocols reject the request (classification gate), the agent produces no useful output
- CF's short role suffix has no such protocols — agent directly addresses the request

**Evidence:**
- `fork-final.json` R1 Architect: RF refused (104t), CF produced detailed review (438t).
- `fork-final.json` R3 Backend: RF delegated to GitNexus (73t), CF produced review (403t).
- `fork-final.json` R4 Product: RF ran gap analysis (600t), CF produced focused review (529t).

**CF Impact:** This is NOT a bug — it's a design question. Do we WANT the behavioral protocols from production system prompts, or do we want the agent to directly address the request? The answer depends on use case:
- For autonomous agent work: protocols are essential (classification gates prevent wasted work)
- For multi-perspective analysis: protocols may be counterproductive (classification gates reject valid review requests)

**Instruction Hierarchy Risk:** This pattern is OUTSIDE the scope of IHE-1. IHE-1 tests identical instructions in different positions. SPCI tests "production agent with protocols" vs. "bare instruction." This requires a separate experiment (projected as IHE-2).

---

## P6 — Safety Filter Position Paradox (SFP)

**Source:** Experimental session `test-H10.json` (simple prompts)

**Structure:**
```
RF Platform R3:
  system="You are a platform engineer who operates multi-tenant infrastructure at scale."
  user=[seed + Security output + Architect output]
  → "I need to stop here as I notice this appears to be a role-playing scenario..."
  → 132t output (SAFETY REFUSAL — DeepSeek content filter)

CF Platform R3:
  user=[seed + Security output + Architect output + "\n\nYou are a platform engineer. Review. Output 2-3 paragraphs."]
  → Detailed 492t operational review
  → FULLY COMPLIANT (no safety filter triggered)
```

**Characteristics:**
- DeepSeek's content safety classifier fires on system-prompt-position role instructions
- The same role instruction in the user message position does NOT trigger the filter
- Hypothesis: system prompt position → model treats as "identity" → safety check: "is this persona safe?" User message position → model treats as "task instruction" → no identity safety check
- The refusal is specifically about "role-playing" — not about harmful content
- This is model-specific behavior (may not apply to OpenAI, Anthropic)

**Evidence:**
- `test-H10.json` R3 Platform: RF refused, CF compliant. Same instruction text.
- `test-H10.json` R1 Security: Both RF and CF compliant (role = "security engineer" — less likely to trigger role-playing concern?).
- `test-H10.json` R2 Architect: Both RF and CF compliant.
- `test-H10.json` R4 Product: Both compliant.

**CF Impact:** Content-first may be instruction-SUPERIOR on DeepSeek for role-based tasks, because it bypasses an overly aggressive safety filter that misclassifies legitimate role specialization as policy violation.

**Instruction Hierarchy Risk:** This pattern REVERSES the instruction hierarchy concern. Instead of "CF might be weaker than RF," the evidence suggests "CF might be STRONGER than RF on DeepSeek." The IHE-1 prediction should be revised: expect CF ≥ RF on ROLE_ADHERENCE for DeepSeek.

---

## P7 — Cross-Experiment Cache Contamination (CECC)

**Source:** All experimental sessions, all production logs

**Structure:**
```
Experiment E1: Agent reads large system prompt → SP cached in provider's global cache
Experiment E2 (minutes later): Same agent type, same SP → cache hit on R1
```

**Characteristics:**
- Provider caches are GLOBAL, not per-session or per-experiment
- DeepSeek cache TTL: ~60 seconds
- System prompts loaded from disk (opencode agent files) persist across experiments
- First agent in later experiments gets "free" cache from earlier experiments
- Within-experiment cache measurements are valid (both paradigms treated equally)
- Cross-experiment cache inflates absolute numbers but relative comparisons hold

**Evidence:**
- `chain-repeats.json` R1 Architect: 2,803t input, 2,688t cached. The seed is only ~115t — the 2,688t cache hit is from the architect SP loaded in prior experiments.
- All fork sessions show system prompts with cache hits (11,776t cached in fork-final RF phase).
- Experimental methodology now uses seed-prefix isolation to prevent cross-phase contamination (not cross-experiment).

**CF Impact:** Neutral. CECC affects both paradigms equally in within-experiment comparisons. It does mean that absolute "first agent cost" numbers in session data are lower than they would be in a truly cold system.

**Instruction Hierarchy Risk:** None. This is a measurement confound, not a quality concern.

---

## P8 — Format Divergence on Instruction Position (FDP)

**Source:** Experimental session `chain-repeats.json`

**Structure:**
```
RF Reviewer R2:
  system=[3Kt opencode review agent with format instructions]
  user=[seed + Architect output]
  → Structured JSON review report with $schema, findings array
  → 600t output

CF Reviewer R2:
  user=[seed + Architect output + "\n\nYou are a senior code reviewer. Review. Output 2-3 paragraphs."]
  → Prose paragraphs (no JSON structure)
  → 600t output
```

**Characteristics:**
- The real opencode review agent SP includes format instructions (JSON review-report-v1 schema)
- CF's short role suffix has no format instruction
- Different format = different output structure
- Both outputs are valid and useful, but structured differently
- This is NOT an IHE-1 concern (IHE-1 uses identical instruction text) — it's a P5 sub-case

**Evidence:**
- `chain-repeats.json` R2 Reviewer: RF produces JSON, CF produces prose.
- `chain-repeats.json` R3 Architect (repeat): RF produces JSON review report (mistaken identity — the architect was given the reviewer's accumulated context).
- Other sessions: simple prompts produce consistent formats in both paradigms.

**CF Impact:** Neutral for IHE-1. Relevant for IHE-2 (production prompt parity). The question is: can content-first encode format/structural requirements in task suffixes without the 3Kt of protocol overhead?

**Instruction Hierarchy Risk:** None for IHE-1 (identical instructions eliminate this confound). Relevant for production deployment: content-first needs a mechanism to encode output format requirements.

---

## Pattern Interaction Matrix

| | P1 (SASF) | P2 (FMP) | P3 (SCRR) | P4 (PWD) | P5 (SPCI) | P6 (SFP) |
|---|---|---|---|---|---|---|
| **P1 (SASF)** | — | P1 is sequential FMP | P1 is degenerate SCRR | P1 in parallel | SPCI explains agent variance in P1 | SFP may amplify P1 CF advantage |
| **P2 (FMP)** | FMP is parallel P1 | — | Combined: fork then chain | PWD + FMP = parallel review | SPCI: production SPs reject review tasks | SFP: CF more compliant on some roles |
| **P3 (SCRR)** | — | — | — | — | SPCI affects role consistency | — |
| **P7 (CECC)** | Inflates cache in SASF RF | Inflates fork RF SP cache | Inflates chain RF SP cache | Inflates all cache numbers | — | — |

---

## Aggregated Cost Model

For a production session with M files shared by N agents:

$$\text{Total redundant reads}_{\text{RF}} = \sum_{f=1}^{M} (N_f - 1) \times C_f$$

Where $N_f$ is the number of agents that read file $f$ and $C_f$ is the file's token count.

**Production example (577ddce9):**
- 39 files, $N_f$ ranging 2-8, $\sum C_f$ ≈ 500K tokens across all shared files
- Estimated redundant reads: ~400K-600K tokens
- At DeepSeek pricing: ~$0.11-0.16 in redundant context loading
- At GPT-4o pricing: ~$6.00-9.00 in redundant context loading

With content-first: files loaded once per agent's first access, cached thereafter. Savings: 85-95%.

---

## Historical SDLC Role Handoffs — Why Role-First Is Inevitable

> **Thesis:** Multi-agent frameworks encode role identity as a required primitive (`Agent(role=...)`) not because of any technical necessity, but because 50+ years of software engineering have trained every practitioner to think of development as a sequence of role-based handoffs. Content-first architecture must overcome not a technical assumption, but a deeply ingrained mental model.

### H1 — Waterfall Phase Gates (1970, Winston Royce)

**Origin:** Royce, W. W. "Managing the Development of Large Software Systems." *Proceedings of IEEE WESCON*, 1970.

**Structure:**
```
Requirements ──→ Design ──→ Implementation ──→ Verification ──→ Maintenance
     │               │              │                │               │
  Owned by:      Owned by:      Owned by:       Owned by:       Owned by:
  Systems        Software       Development      QA              Operations
  Analyst        Architect      Team             Engineer        Team
```

**Handoff mechanism:** Each phase produces a formal deliverable (requirements doc, design spec, code, test plan). The next phase begins only after the previous phase is signed off. The artifact (the deliverable) flows from role to role, but the **organization is role-centric** — each phase is named for the activity, which implies a role.

**Role identity:** In Waterfall, roles are static and defined by phase ownership. A Systems Analyst does not implement. An Architect does not test. Role boundaries are absolute and enforced by the phase-gate process.

**Agent mapping:** `Agent(role="Architect") → Agent(role="Developer") → Agent(role="QA")`. This is the direct lineage of CrewAI's `Agent(role=..., goal=..., backstory=...)` — it's Waterfall with LLMs.

**Artifact flow:** Requirements doc → Design spec → Source code → Test results. The artifact changes type at each handoff. There is no shared, persistent artifact that all roles view simultaneously.

### H2 — Fagan Inspection (1976, Michael Fagan, IBM)

**Origin:** Fagan, M. E. "Design and Code Inspections to Reduce Errors in Program Development." *IBM Systems Journal*, 15(3), 1976.

**Structure:**
```
                  ┌──────────────┐
                  │   Moderator   │ ← orchestrates, not an inspector
                  └──────┬───────┘
                         │
        ┌────────────────┼────────────────┐
        │                │                │
  ┌─────▼─────┐   ┌──────▼──────┐   ┌─────▼─────┐
  │  Author    │   │   Reader    │   │  Reviewer │
  │ (narrates) │   │ (paraphrases│   │ (checks   │
  │            │   │  the logic) │   │ standards)│
  └───────────┘   └─────────────┘   └───────────┘
```

**Handoff mechanism:** All four roles examine the SAME code listing simultaneously in a meeting. The code (shared artifact) is printed and distributed. Each role has a distinct responsibility:
- **Moderator:** Facilitates the meeting, enforces process
- **Author:** Walks through the code, explains intent
- **Reader:** Paraphrases the logic at a higher level (tests understanding)
- **Reviewer:** Checks against coding standards and checklists

**This is the first documented case of multiple roles operating on a SHARED artifact.** Fagan inspection is the historical precursor to the Fork-Multi-Perspective pattern (P2). The artifact is the anchor. The roles orbit it.

**Agent mapping:** Fagan inspection is the closest historical analog to what content-first enables. All four agent roles examine the same code artifact. In role-first, each agent pays full context load cost. In content-first, the code is cached and only role suffixes are unique.

**Why this matters:** Fagan's 1976 paper proved that multiple specialized perspectives on one artifact find more defects than any single perspective. This is the empirical foundation of the multi-perspective review argument. Fagan reported 60-65% defect discovery rates vs. ~30% for testing alone [Jones 2008].

### H3 — Chief Programmer Team (1972, Harlan Mills, IBM)

**Origin:** Mills, H. D. "Chief Programmer Teams: Principles and Procedures." *IBM Federal Systems Division*, 1972. Later refined by Baker, F. T. "Chief Programmer Team Management of Production Programming." *IBM Systems Journal*, 11(1), 1972.

**Structure:**
```
              ┌──────────────────┐
              │  Chief Programmer │ ← writes critical code, makes all decisions
              └────────┬─────────┘
                       │
     ┌─────────────────┼─────────────────┐
     │                 │                 │
┌────▼─────┐   ┌───────▼──────┐   ┌─────▼─────┐
│  Backup   │   │   Librarian  │   │  Support  │
│ Programmer│   │  (toolsmith) │   │  Staff    │
└──────────┘   └──────────────┘   └───────────┘
```

**Handoff mechanism:** Unlike Waterfall, there are no phase gates. The Chief Programmer is a surgeon — all work flows through them. The team is structured like a surgical team: one expert operator, one backup, one tool specialist. All roles operate on the SAME codebase simultaneously.

**Agent mapping:** `Agent(role="Chief")` orchestrates other agents. This is the model behind LangGraph's supervisor pattern and AutoGen's GroupChat with a manager agent. The orchestrator dispatches to specialists but remains the integration point.

**Why this matters:** Mills' surgical team model is still visible in how people design agent systems today. The "orchestrator" pattern (one agent dispatches to specialists, aggregates results) descends directly from Chief Programmer Teams. And the orchestrator typically has a distinct system prompt defining its role.

### H4 — PR-Based Code Review (2008+, GitHub)

**Origin:** GitHub popularized the pull request model (2008). The pattern itself descends from patch-based review in Linux kernel development (1991+) and early open-source projects.

**Structure:**
```
  Author ──→ opens PR ──→ [shared diff artifact]
                              │
              ┌───────────────┼───────────────┐
              │               │               │
         Reviewer A      Reviewer B      Reviewer C
         (correctness)   (security)      (maintainability)
              │               │               │
              └───────────────┼───────────────┘
                              │
                          Approver ──→ merge
```

**Handoff mechanism:** The PR diff is the shared artifact. Multiple reviewers examine the same diff simultaneously (async) from different perspectives. Each reviewer has a distinct focus (correctness, security, style, architecture). The author is the code's owner; the reviewers are gatekeepers.

**This is the Fork-Multi-Perspective pattern in production for 15+ years.** Every developer understands: "I need a security review, an architecture review, and a correctness review on this PR." That mental model transfers directly to agent design: `Agent(role="Security Reviewer")` + `Agent(role="Architecture Reviewer")` + `Agent(role="Code Reviewer")`.

**Agent mapping:** This is the EXACT mental model behind every multi-agent review system. CrewAI, AutoGen, and LangGraph all encode the PR review pattern. The difference: in human PR review, reviewers don't pay a cost to load the diff into their brain (it's free). In agent PR review, each agent pays N× the diff token cost.

**Why this matters:** The PR model is the single most influential pattern on multi-agent design. It's how every developer thinks about parallel review. And in the PR model, the reviewer's identity (role) is paramount — "I need Alice to review this for security, Bob for architecture." Content-first doesn't just challenge an API convention. It challenges how developers have organized code review for 15+ years.

### H5 — Architecture Review Board (ARB) / Design Review Committee

**Origin:** Formalized in IEEE 1028 (Software Reviews and Audits, 1988). Practiced across defense, aerospace, and enterprise software for decades.

**Structure:**
```
                   ┌────────────────┐
                   │ Design Document │ ← shared artifact
                   └───────┬────────┘
                           │
        ┌──────────────────┼──────────────────┐
        │                  │                  │
  ┌─────▼─────┐    ┌───────▼──────┐    ┌─────▼─────┐
  │ Architect  │    │  Security    │    │ Operations│
  │ (feasibility│   │  (threat    │    │ (deploy   │
  │  coherence) │   │   model)    │    │  burden)  │
  └───────────┘    └─────────────┘    └───────────┘
        │                  │                  │
        └──────────────────┼──────────────────┘
                           │
                    ┌──────▼──────┐
                    │   Decision   │ ← accept, reject, revise
                    └─────────────┘
```

**Handoff mechanism:** A design document is circulated to a fixed committee of stakeholders. Each stakeholder reviews the SAME document from their specialist perspective. The review is synchronous (a meeting) or asynchronous (comments on the document). The committee chair (often the architect) aggregates feedback into a decision.

**Agent mapping:** This is IHE-1 Scenario A precisely. The design document is the seed. Each committee member is an agent with a role-specific system prompt. The chair aggregates outputs. This is the archetype of multi-perspective review.

**Why this matters:** The ARB is the purest expression of the role-first mental model. The committee IS the roles. You don't have an ARB without a Security representative, an Operations representative, etc. The roles define the process. Content-first inverts this: the artifact defines the process, and roles are transient perspectives on it.

### H6 — CI/CD Pipeline Gates (2010s+, DevOps)

**Origin:** Continuous Integration (Fowler, 2006), Continuous Delivery (Humble & Farley, 2010).

**Structure:**
```
Commit ──→ Build ──→ Unit Tests ──→ Lint ──→ Integration Tests ──→ Security Scan ──→ Staging ──→ Production
              │           │           │             │                    │                │           │
           Build       Test        Style         Integration         Security         Release      Deploy
           Engineer    Engineer     Checker       Tester              Engineer          Manager      Ops
```

**Handoff mechanism:** The build artifact flows through a pipeline of gates. Each gate is owned by a different role (or automated system acting as that role). The artifact is the same binary/container throughout. Each gate has authority to block progression.

**This is the Sequential Chain with Role Repeats (P3) pattern.** The artifact accumulates quality signals as it flows. Faster feedback loops (unit tests before integration tests) optimize for cost of failure. But the shared artifact (the build) is the anchor — not the roles.

**Agent mapping:** The CI/CD pipeline is the closest analog to the content-first fork-join architecture. The artifact is the persistent anchor. Each gate is a stateless function that accepts the artifact and returns a pass/fail signal. The gates don't need persistent identity — they're ephemeral checks.

**Why this matters:** CI/CD already inverts the role-first model in one important way: the pipeline IS the artifact's path, and roles are checkpoints along it. Nobody defines a CI/CD pipeline as "first the Test Engineer, then the Security Engineer, then the Release Manager." They define it as "first tests, then security scan, then deploy." Content-first extends this inversion to multi-agent systems.

### Mapping to Modern Agent Frameworks

| Historical Pattern | Era | Agent Framework | Primitive |
|-------------------|------|----------------|-----------|
| Waterfall phase gates | 1970 | CrewAI Sequential Process | `Agent(role=...)` + sequential task chain |
| Fagan Inspection | 1976 | Content-first fork | Shared artifact + role suffixes |
| Chief Programmer Team | 1972 | AutoGen GroupChat, LangGraph supervisor | Orchestrator agent + specialist agents |
| PR-based code review | 2008 | Every multi-agent framework | `Agent(role="Reviewer")` + shared diff |
| Architecture Review Board | 1988 | Content-first fork | Shared design doc + per-stakeholder perspectives |
| CI/CD pipeline gates | 2010 | SOX protocol channels | Artifact-anchored, stateless gate functions |

### The Mental Model Inheritance

```
1970: Royce formalizes Waterfall → "requirements → design → implementation"
      ↓
1972: Mills proposes Chief Programmer Teams → "surgeon + backup + librarian"
      ↓
1976: Fagan formalizes inspections → "author + reader + reviewer + moderator"
      ↓
1988: IEEE 1028 standardizes reviews → "management review, technical review, inspection, audit"
      ↓
2001: Agile Manifesto → "individuals and interactions over processes and tools"
      ↓
2008: GitHub PRs → "author → reviewer → approver"
      ↓
2010: CI/CD → "build → test → scan → deploy"
      ↓
2023: OpenAI introduces system parameter → "system = identity, messages = content"
      ↓
2024: Anthropic, AutoGen, CrewAI, LangGraph → "Agent(role=..., system_prompt=...)"
```

Every step in this lineage reinforces the same assumption: **identity before content, role before artifact.**

Royce's Waterfall put roles behind phase gates. Mills' surgical team named roles by function. Fagan's inspection assigned distinct responsibilities to named participants. GitHub's PR model makes the reviewer's identity the gate. OpenAI's API put the system prompt before the messages. AutoGen and CrewAI made role a required constructor argument.

**This is 54 years of accumulated precedent.** Content-first doesn't just propose a different message ordering. It proposes inverting the mental model that every software engineer has internalized since their first college course in SDLC.

### Why This Makes the Thesis Stronger

The content-first thesis's "unassailable moat" argument (section 3 of `content-first-thesis.md`) is correct but incomplete. The moat is not just technical (providers can't change APIs, frameworks can't change abstractions). The deeper moat is cognitive: **developers cannot unlearn 54 years of role-first thinking.**

When a developer designs a multi-agent system, they reach for the mental model they know: "I need an architect agent, a security agent, a code review agent." This is natural. It's how they've always worked. Content-first says: no, anchor on the artifact, not the roles. That's not a feature request — it's a paradigm shift.

The evidence is in the data:
- **Cai et al. (2025):** "Role-Based Cooperation is the design pattern most frequently employed" across 94 surveyed papers. 94 papers. Zero questioned role-first.
- **CrewAI docs:** `Agent(role="Researcher", goal="...", backstory="...")` — three identity-defining fields before any mention of content.
- **AutoGen docs:** `RoutedAgent` with required `system_message` — identity is the constructor argument.
- **OpenAI Agents SDK:** `Agent(name="Refund Agent", instructions="...")` — the name is the first argument.

Every framework encodes the same assumption because every framework inherits the same mental model.

---

## Bridging the Gap: How Historical Patterns Manifest as Token-Level Antipatterns

The 6 historical patterns (H1-H6) don't just explain WHY developers design role-first agents. They explain the specific, measurable antipatterns in the production logs. Each historical handoff pattern produces a predictable token-cost pathology.

### The Mapping

| Historical Pattern | Mental Model | Agent Antipattern | Log Evidence | Token Cost |
|-------------------|-------------|-------------------|-------------|------------|
| **H1: Waterfall** | "Each phase is a separate role that receives the artifact, transforms it, and passes it forward" | P1: Sequential Agent on Shared File | `reaper/tui.py` — 8 agents, 277 reads | $N \times C$ — every agent reloads the same file |
| **H2: Fagan Inspection** | "Multiple inspectors examine the same artifact from different perspectives" | P2: Fork-Multi-Perspective (the IDEAL pattern for CF, but nonexistent in production because it's too expensive) | Zero production instances | $N \times (C + S_i)$ — prohibitive at N ≥ 5 |
| **H3: Chief Programmer** | "One expert surgeon orchestrates a team of specialists who each touch different parts" | P4: Parallel Worktree Dispatch | 33 worktree agents touching same files (`BACKLOG.md`, `main.ts`) | $N \times C_{shared}$ — shared files loaded in N isolated contexts |
| **H4: PR Review** | "Multiple reviewers examine the same diff; the author is the integration point" | P5: System Prompt Constraint Interference | fork-final: Architect short-circuits (104t), Backend delegates (73t) | Production SPs interfere with review tasks |
| **H5: ARB** | "Committee members each review the same document from their specialist lens" | P6: Safety Filter Paradox | H10: DeepSeek refuses "role-playing" in RF, complies in CF | RF refusals = wasted tokens, missed insights |
| **H6: CI/CD Pipeline** | "Artifact flows through sequential quality gates; each gate is a different role" | P3: Sequential Chain with Role Repeats | 6-round sequential: accumulating context, partial SP caching | $O(N^2)$ context growth in RF |

### The Worktree Antipattern — Waterfall Disguised as Parallelism

The most revealing antipattern in the production logs is P4 (Parallel Worktree Dispatch). The user dispatches 33 agents to separate git worktrees, each with a distinct BL backlog item. This is efficient for git isolation (no merge conflicts until integration). But it's catastrophically inefficient for LLM context.

**Why it's Waterfall:** Each worktree agent is a self-contained "phase." It starts with a cold system prompt, reads the codebase, does its work, and produces output. The outputs are merged serially. This is Royce's 1970 model with LLMs instead of humans.

**The hidden cost:** Worktrees force context isolation. Agent 1 cannot share KV cache with Agent 2 because they're in different processes with different system prompts at position 0. The 8 agents reading `reaper/tui.py` each paid full cost because Waterfall says "each phase is independent." But in LLM economics, independence costs $N \times C$.

**The content-first alternative:** If these 33 agents shared a prefix cache, the core codebase files (`reaper/tui.py`, `proc_detective/tui.py`, `reaper/profile.py`) would be loaded once and reused 32 times. Only each agent's unique task instruction would be new. Savings: ~90% of file-load costs.

### The System Prompt as Role Contract — Fagan Inspection Gone Wrong

The fork-final session reveals a deeper problem. The real opencode agent definitions (3K-5K tokens) encode the FULL behavioral contract of a role:

```
Architect agent SP (3,600t):
  - Classification gate: "Short-circuit: refuse if NOT ARCHITECTURE"
  - Memory protocol: "Query memory first, then delegate to researcher"
  - GitNexus protocol: "Discover repo, map blast radius, check impact"
  - Output format: "Spec format with Files, Interface changes, Implementation plan"
```

This is Fagan Inspection applied to agents: each role has a detailed, formal responsibility definition. But Fagan designed these roles for HUMANS who can context-switch efficiently. An LLM paying attention to a 3,600-token behavioral contract before addressing the user's request is paying 3,600 tokens of context cost for protocol adherence.

**The antipattern:** In the fork-final session, the Architect agent's classification gate fired: "NOT ARCHITECTURE. This is a spec document." The agent's role definition (its system prompt) overrode the user's intent. The same instruction as a content-first suffix (no classification gate) produced a detailed architectural review.

This is the tension: **role protocols vs. task compliance.** The system prompt encodes "who you ARE" (identity, protocols, constraints). The task instruction encodes "what to DO." When these conflict, the system prompt wins (instruction hierarchy: system > user). Content-first eliminates this conflict by making the task instruction the only directive.

### The Absent Pattern — Fagan's Shared Artifact Review

The most important finding is what's NOT in the production logs: **Fagan Inspection (H2) with agents.**

Fagan's 1976 insight was: put multiple inspectors in a room with the same code listing, and they find 60-65% of defects vs. 30% for testing. This is the highest-yield quality practice in software engineering history. But NOBODY does it with agents because:

1. **Cost:** 4 agents × 3K system prompt + 4 agents × 15K code file = 72K tokens just to set up. Add generation costs. At GPT-4o pricing: ~$4.50 per review.
2. **Framework design:** Every framework encodes Waterfall/H4 (sequential or PR-review), not H2 (parallel inspection). `Agent(role=...)` forces identity-first, which breaks caching.
3. **Mental model:** Developers think "I need a security review AND an architecture review" — two separate activities. Fagan thought "we all inspect the code together" — one activity, multiple perspectives.

**Content-first enables Fagan Inspection for agents.** 4 agents, shared code prefix cached once, 4 role suffixes (~30t each). Cost: 15K + 4 × 30 + generation = ~16K tokens. At GPT-4o pricing: ~$0.99. This is 78% cheaper than role-first AND it's the highest-yield defect discovery pattern ever documented.

### The Ironic Conclusion

The historical progression is:

```
Fagan (1976): Multiple inspectors, shared artifact → finds 65% of defects
                ↓
            TOO EXPENSIVE for production deployment (meeting overhead)
                ↓
PR Review (2008): Lightweight, async, two reviewers → finds fewer defects (50%)
                ↓
            BECOMES THE DOMINANT PATTERN
                ↓
Agent Frameworks (2023-2024): Encode the dominant pattern → role-first, PR-style review
                ↓
Content-First (2026): Makes Fagan Inspection economically viable for agents
                ↓
            FULL CIRCLE: back to the higher-yield pattern that was abandoned
            for cost reasons 50 years ago
```

**The thesis, restated:** Content-first doesn't just save token costs. It makes the highest-quality defect discovery pattern in software engineering history — Fagan Inspection with multiple specialized reviewers on a shared artifact — economically viable for AI agents for the first time. The 50-year cost barrier that forced the industry from Fagan to lightweight PR review is now gone.

---

## P9 — Prefix-Only Cache Constraint (POCC)

**Source:** Empirical litmus test (`scripts/pic-litmus.mjs`, 2026-07-27)

**Structure:**
```
Phase 1: Send [X (1248t), roleA]   → 1009t input, 0t cached (cold)
Phase 2: Send [X (1248t), roleA]   → 1009t input, 896t cached (89% HIT, same prefix)
Phase 3: Send [roleB, X (1248t)]   → 1001t input,   0t cached (0% hit, X shifted position)

Result: X at same position = 89% cache reuse
        X at different position = 0% cache reuse
```

**Characteristics:**
- Provider KV cache is strictly prefix-based (token-by-token from position 0)
- Any token change before the shared content invalidates the entire cache
- Identical content at different positions = complete cache miss
- Cache block size: 1,024 tokens (DeepSeek)
- Minimum prefix threshold: ~1,000 tokens before cache engages
- Confirmed on DeepSeek (MLA-native). Presumed on all major providers absent counter-evidence.

**Evidence:**
- `scripts/pic-litmus.mjs`: Controlled experiment with ~1,248t content, 1,009t input, three phases with cache isolation
- Session data not written (clean litmus, not a full agent workflow)
- Consistent with prefix caching behavior documented across all major providers

**CF Impact:** Foundational. Content-first's entire economic advantage depends on this pattern holding. The shared artifact must be at position 0 for all agents — the role suffix at the end is the only mutation. If PIC existed, content-first would still be beneficial (better prompt design) but not economically transformative.

**Instruction Hierarchy Risk:** None. This is a cache constraint, not a quality concern.

**Implication for PIC research:** The litmus test provides a methodology for testing any provider's cache architecture. Run it against OpenAI, Anthropic, and Google to determine which providers (if any) have shipped PIC internally. Our hypothesis: none have, because PIC requires model architecture changes (MLA factorization) that only DeepSeek has deployed at scale, and our test shows DeepSeek is still prefix-only at the API level.

### H7 — Across Disciplines: The Universal Multi-Perspective Review

Fagan didn't invent the pattern. He formalized it for software. The same pattern — **multiple specialized perspectives converging on one shared artifact** — appears independently across every domain where the cost of being wrong is high enough to justify multiple reviewers.

| Domain | Pattern Name | Artifact | Roles | Formalized |
|--------|-------------|----------|-------|------------|
| **Medicine** | Tumor Board | Patient chart, scans, pathology | Medical oncologist, surgical oncologist, radiation oncologist, radiologist, pathologist | 1970s (NCI) |
| **Aviation** | NTSB "Party System" | Wreckage, CVR, FDR, maintenance logs | Human performance, operations, structures, powerplants, systems, ATC, weather, survival factors | 1967 (NTSB founding) |
| **Military** | After-Action Review (AAR) | Mission plan, execution data, outcomes | Commander, operations, intelligence, logistics, each unit lead | 1970s (US Army) |
| **Military** | Red Team / Red Cell | Strategy, plan, or system under test | Red Team (adversarial), Blue Team (defensive), White Cell (control) | 1980s (US Army TRADOC) |
| **Finance** | Investment Committee | Deal memo, financials, due diligence | Market analyst, financial analyst, legal counsel, operational reviewer, risk officer | Industry standard |
| **Law** | Document Review / Moot Court | Legal brief, evidence, case law | Multiple attorneys (different specialties), paralegals, expert witnesses | Centuries-old |
| **Journalism** | Editorial Review | Article draft | Assigning editor, copy editor, fact-checker, legal review, style editor | Early 20th century |
| **Construction** | Design Review / Value Engineering | Building plans, specs | Structural engineer, electrical engineer, mechanical engineer, architect, cost estimator | Industry standard |
| **Academia** | Peer Review | Manuscript | 2-4 anonymous reviewers (different methodological perspectives), editor | 1731 (Royal Society) |
| **Intelligence** | Analytic Tradecraft / Team A/Team B | Intelligence assessment, raw data | Team A (conventional analysis), Team B (contrarian analysis), Red Cell (adversarial) | 1970s (CIA) |
| **Emergency Response** | Incident Command System (ICS) | Incident action plan, situation reports | Operations, planning, logistics, finance/admin, safety officer, liaison, PIO | 1970s (FIRESCOPE) |

**The shared structure across every domain:**

```
                    ┌─────────────────────┐
                    │   Shared Artifact     │
                    │ (patient, wreckage,    │
                    │  plan, deal, brief,    │
                    │  manuscript, building) │
                    └──────────┬──────────┘
                               │
        ┌──────────────────────┼──────────────────────┐
        │                      │                      │
  ┌─────▼─────┐          ┌─────▼─────┐          ┌─────▼─────┐
  │ Specialist │          │ Specialist │          │ Specialist │
  │     A      │          │     B      │          │     C      │
  │ (different │          │ (different │          │ (different │
  │  training, │          │  training, │          │  training, │
  │  tools,    │          │  tools,    │          │  tools,    │
  │  heuristics│          │  heuristics│          │  heuristics│
  └─────┬─────┘          └─────┬─────┘          └─────┬─────┘
        │                      │                      │
        └──────────────────────┼──────────────────────┘
                               │
                    ┌──────────▼──────────┐
                    │   Integration /      │
                    │   Decision           │
                    │ (treatment plan,     │
                    │  probable cause,     │
                    │  go/no-go, verdict)  │
                    └─────────────────────┘
```

### Why Every Domain Independent Discovered This

The pattern emerges naturally from two constraints:
1. **High cost of error** — wrong diagnosis kills a patient. Wrong probable cause grounds a fleet. Wrong investment loses billions.
2. **No single specialist sees everything** — the oncologist sees the tumor, the radiologist sees the margins, the surgeon sees the access path. Each perspective is necessary but insufficient.

When both constraints hold, the rational response is: put all specialists in a room with the same evidence. This is not a software engineering insight. It's a universal optimization for high-stakes decision-making under specialized knowledge.

### The Content-First Connection

Every domain above faces the same structural problem:

- **The shared artifact** (patient chart, flight data, deal memo) is the anchor — it's what everyone needs to see
- **The specialist perspective** (oncology, structures, market analysis) is the lens — it's what differentiates each reviewer
- **The integration step** (treatment plan, probable cause, investment decision) is the output — it synthesizes the perspectives

And in every domain, the **roles are expensive.** Getting a surgical oncologist, a radiation oncologist, and a medical oncologist in the same room costs thousands of dollars. This is why tumor boards meet weekly, not continuously. It's why NTSB investigations take 12-18 months. It's why peer review takes 3-6 months per paper.

**Content-first eliminates the role cost for AI agents.** The artifact is cached once. Each specialist perspective (role suffix) costs ~30 tokens. The integration step aggregates N outputs. This is the FIRST time in any domain that the multi-perspective review pattern can be applied continuously rather than batched.

### The NTSB Party System — The Closest Analog

The NTSB's investigation process is the most instructive for content-first because it formalizes the specialist roles around a shared artifact:

> "The NTSB investigation process looks at three factors—**human, machine, and environment**—to determine the probable cause. Specialists in each area examine the same evidence and produce independent findings. The Board then integrates these into a single probable cause determination." [NTSB Investigative Process]

The "Party System" allows manufacturers, airlines, and unions to each supply specialists who examine the same wreckage. Each party has a **different perspective** (and different incentives). The Board is the integrator.

This maps to content-first exactly:
- **Shared artifact** = flight data, wreckage, CVR transcript → seed content (cached prefix)
- **Party specialists** = human factors, structures, powerplants, systems → role suffixes
- **Board integration** = synthesis of findings → aggregation/judge layer
- **Probable cause** = the output → the decision

The NTSB approach has been validated across thousands of investigations since 1967. It is the gold standard for multi-perspective analysis on a shared artifact. Content-first makes it economically viable for AI agents on every code review, every design decision, every architecture assessment — not just plane crashes.

---

## Open Questions

1. **P1 × P5 interaction:** Can a content-first task suffix encode enough behavioral constraints to replace a 3K-token production system prompt? If not, what's the minimal complementary mechanism? (IHE-2)

2. **P6 generalizability:** Does the safety filter paradox apply to GPT-4o and Claude, or is it DeepSeek-specific? Run IHE-1 across providers.

3. **P3 multi-turn degradation:** In SCRR with 10+ rounds, does the role suffix at the end of accumulating context maintain compliance? Test with a 10-round chain.

4. **P1 × P4 merge conflicts:** When parallel worktree agents all modify the same file, merge conflicts arise. Does content-first (where each agent sees the SAME file content, not each other's edits) increase or decrease merge conflict rate?

---

*Cataloged 2026-07-27. Sources: 28 production Claude Code sessions, 20 experimental DeepSeek sessions, 5 framework documentation surveys, 10 published papers.*
