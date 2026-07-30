# Research Plan: Graph-Based Planning System

> **Status:** Research phase complete. Verified sources cataloged. Engineering gaps identified.
> **Date:** 2026-07-16
> **Context:** A graph-native planning system where the plan IS the graph. Every task, dependency, state transition, and schedule lives as nodes and typed edges in a single unified graph. Cross-repository dependency resolution — the original motivation — is one use case, not the system's identity. The graph holds the full plan: task definitions, resource allocations, temporal constraints, dependency contracts, execution states, and planning horizons.

---

## 1. Usage Model

The user interacts with the plan graph through planning tasks — the set of operations a planning system must support. Every operation mutates the graph or queries it. The system enforces consistency invariants at mutation time.

### 1.1 Task lifecycle operations

| Operation | What it does | Constraints enforced |
|---|---|---|
| **CREATE_TASK** | Insert a new work item with description, estimate, scope | Semantic+structural dedup (R4), placement in hierarchy |
| **MODIFY_TASK** | Change description, estimate, priority, assignee | Recompute impact cone if estimate/priority changes (R3) |
| **DELETE_TASK** | Remove a work item | Block if others depend on it (R5); require dep re-routing or consent |
| **CHANGE_STATE** | Mark in-progress, blocked, completed, failed | Verify per-node state machine against neighbor states (R13) |
| **SPLIT_TASK** | Break one task into multiple sub-tasks | Maintain dependency edges across split; propagate parent deps to children |
| **MERGE_TASKS** | Combine multiple tasks into one | Union dependency sets; detect conflicting edges |

### 1.2 Dependency operations

| Operation | What it does | Constraints enforced |
|---|---|---|
| **ADD_DEPENDENCY** | Declare that task X depends on task Y (typed edge) | Type-check against scope (InterfaceDep vs TemporalDep vs DataDep); detect cycles |
| **REMOVE_DEPENDENCY** | Undo a dependency edge | Verify consumer no longer needs it, or update consumer contract |
| **CHANGE_DEP_TYPE** | Change edge type (e.g. InterfaceDep → DataDep) | Re-validate contract against new type |
| **CONSUME_OUTPUT** | Repo B starts depending on repo A's output | Creates cross-repo typed edge; notifies repo A owner |
| **UPDATE_CONTRACT** | Update the contract on a dependency edge | Re-verify all dependent consumers against new contract |

### 1.3 Planning & scheduling operations

| Operation | What it does | Constraints enforced |
|---|---|---|
| **REPRIORITIZE** | Change task priority | Propagate through schedule; recompute critical path (R3) |
| **REORDER** | Change execution order of siblings | Respect dependency ordering; recompute schedule |
| **REASSIGN** | Change resource assignment | Check resource availability across scope |
| **SET_DEADLINE** | Set or change a milestone deadline | Propagate backward: which tasks must complete by when? |
| **WHAT_IF** | Create a speculative plan branch | No constraints enforced — this is exploration (R11) |
| **MERGE_BRANCH** | Commit a speculative branch into main plan | Re-detect all conflicts against current plan state (R1) |
| **ROLLBACK** | Revert to a previous plan state | Temporal query to reconstruct state (Time Agnostic Library) |

### 1.4 Query & presentation operations

| Operation | What it does |
|---|---|
| **QUERY_PLAN** | "What's on my plate?", "What's blocking me?", "What depends on this?" |
| **VIEW_IMPACT** | "If I delay task X by a week, what happens?" — impact cone simulation |
| **VIEW_HISTORY** | "What did the plan look like last week?" — temporal query |
| **REPORT_STATUS** | Generate a summary of plan state: critical path, blockers, at-risk items |
| **SERIALIZE_SUBGRAPH** | Render a subgraph of the plan for LLM or human consumption (R2) |

### 1.5 Insert task → organize → present flow

This is the most common entry point, but not the only one:

```
User: "I need to add a new auth endpoint. It's on repo A, blocks the frontend."
         │
         ▼
  [Plan Graph]  ← CREATE_TASK
         │
         ▼
  [Constraint Engine + Organizer]
      ├─ Where does this task go? (semantic + structural placement — R4)
      ├─ Is this new info or a duplicate? (dedup — R4)
      ├─ What existing outputs does it consume? (backward dep inference)
      ├─ Who consumes the outputs it produces? (forward impact cone)
      ├─ Does it break any contracts? (typed edge check — PG-Schema)
      ├─ How does the schedule shift? (Time+N propagation — R3)
      └─ What does the plan look like now? (serialize for feedback — R2)
         │
         ▼
  [User reviews: accept / adjust / reject]
```

Key principle: every planning task has the same shape — mutate the graph, enforce invariants, present the result. The "insert task" flow is the most complex because it involves placement and dedup; other operations (CHANGE_STATE, ADD_DEPENDENCY, REPRIORITIZE) are simpler but still invoke constraint enforcement.

### 1.6 Who uses which operations

| Role | Primary operations |
|---|---|
| **Individual contributor** | CREATE_TASK, MODIFY_TASK, CHANGE_STATE, CONSUME_OUTPUT, QUERY_PLAN |
| **Tech lead / planner** | ALL operations plus REPRIORITIZE, REORDER, REASSIGN, SPLIT, MERGE |
| **Architect / cross-repo owner** | UPDATE_CONTRACT, MERGE_BRANCH, VIEW_IMPACT, resolve blocks |
| **LLM agent** | CREATE_TASK, MODIFY_TASK, CHANGE_STATE, QUERY_PLAN, SERIALIZE_SUBGRAPH (within constraints) |
| **Automated system (CI)** | CONSUME_OUTPUT, UPDATE_CONTRACT (from detected changes in repos) |

### 1.7 Execution operations

Execution is what happens when planned work is actually carried out. The plan graph tracks execution state, and execution events trigger replanning.

| Operation | What it does | Constraints / Effects |
|---|---|---|
| **START_TASK** | Assign a task to an agent and begin work | Verify preconditions: dependencies met, resource available, state allows transition (R13) |
| **COMPLETE_TASK** | Mark a task as done with its produced outputs | Publish outputs; unblock downstream tasks; recompute schedule (R3); notify consumers of new outputs |
| **FAIL_TASK** | Mark a task as failed with reason | Propagate failure downstream; mark dependents as blocked; trigger replan or escalation |
| **BLOCK_TASK** | Mark a task as blocked (by dependency, resource, decision) | Propagate block to transitively dependent tasks; notify impacted owners |
| **UNBLOCK_TASK** | Remove a block (dependency resolved, resource freed) | Re-check all preconditions; if met, transition to in-progress; recompute schedule |
| **REPORT_PROGRESS** | Update % complete, time spent, remaining estimate | Adjust schedule estimates; if remaining estimate changes significantly, recompute critical path (R3) |
| **VERIFY_OUTPUT** | Check that a completed task's output matches its contract | Run contract check against InterfaceDep/DataDep specifications; log pass/fail |
| **REPORT_VIOLATION** | A consumer discovered post-execution that an output broke their expectations | Feed back into constraint weights; adjust future contract checks (Section 6.6) |
| **SERIALIZE_CONTEXT** | Produce the subgraph context for an agent to execute a task | Subgraph retrieval (SubgraphRAG) + plan-specific serialization (R2); includes task description, dependencies, contract info, inputs |
| **TRACK_TIME** | Log actual time against a task | Compare actual vs estimated; feed into future estimate calibration |
| **QUERY_STATUS** | "What's the state of task X?", "What's blocking the critical path?" | Graph traversal + state aggregation |

### 1.8 Execution → planning feedback loop

Execution events are the primary trigger for replanning:

```
COMPLETE_TASK
  → outputs published
  → downstream tasks unblocked
  → schedule recomputed
  → notification sent: "Task X completed, your task Y is now unblocked"
  → Time+1: next task to start identified

FAIL_TASK
  → failure propagated down dep edges
  → dependent tasks marked BLOCKED
  → escalation sent to task owners
  → replan triggered: find alternative path or reprioritize

REPORT_VIOLATION
  → contract check failed post-execution
  → constraint engine adjusts edge weights or rules
  → future similar mutations blocked or warned
  → root cause analysis: was the edge type wrong? the contract check insufficient?
```

### 1.9 Operations summary: all planning tasks

Consolidated from sections 1.1-1.4 and 1.7:

```
Task lifecycle:     CREATE | MODIFY | DELETE | SPLIT | MERGE | CHANGE_STATE
Dependency ops:     ADD_DEP | REMOVE_DEP | CHANGE_DEP_TYPE | CONSUME_OUTPUT | UPDATE_CONTRACT
Planning & sched:   REPRIORITIZE | REORDER | REASSIGN | SET_DEADLINE | WHAT_IF | MERGE_BRANCH | ROLLBACK
Execution:          START | COMPLETE | FAIL | BLOCK | UNBLOCK | REPORT_PROGRESS | VERIFY_OUTPUT | REPORT_VIOLATION | TRACK_TIME
Query & present:    QUERY_PLAN | VIEW_IMPACT | VIEW_HISTORY | REPORT_STATUS | SERIALIZE_CONTEXT | SERIALIZE_SUBGRAPH
```

Every operation mutates or queries the plan graph. Mutations invoke constraint enforcement. Execution mutations trigger replanning.

## 2. Objectives

### 2.1 Cross-project/plan/task/org dependency resolution within plans
Dependencies do not respect project boundaries. Task A in Repository X blocks Task C in Repository Y, but existing tools model dependencies within a single project scope. The system must resolve dependency edges that cross arbitrary scope boundaries — repos, teams, orgs, plans — without requiring a single global planner.

### 2.2 Intelligent context packing for LLM execution
When an LLM is asked to execute a task, it needs relevant subgraph context — the task's position, its dependencies, its consumers, its state. The full graph is too large for the context window. The system must retrieve and serialize the minimal subgraph that maximizes task accuracy within the LLM's token budget.

### 2.3 Time+1 and Time+N planning based on inferred changes from the graph
When a task completes early, is delayed, or fails, the effect propagates through the dependency graph. The system must compute the cascading impact on downstream tasks and regenerate the plan at multiple horizons:
- **Time+1:** immediate replanning — the next task to schedule after a state change
- **Time+N:** longer-horizon replanning — the revised critical path, resource reallocation, and schedule recomputation across the full planning window
This is event-driven replanning, not periodic batch rescheduling.

### 2.4 Non-redundant task injection — semantic deduplication and structural placement
When a new task is proposed (by an LLM, a user, or an automated process), the system must determine whether it is a genuine new task, a duplicate, a refinement of an existing task, or a sub-task of an existing node. This requires both semantic matching (what does it mean?) and structural reasoning (where does it fit in the graph?).

---

## 3. System Architecture

The graph IS the plan. There is no separate planner — planning is the act of mutating the graph. The constraint engine is a consistency enforcer within the graph itself, not a gate between external components.

```
                         ┌──────────────────────────────────┐
                         │     The Plan Graph                │
                         │  (tasks, deps, states, schedules  │
                         │   — all as typed nodes + edges)   │
                         │                                  │
                         │  Query: "impact cone of P7"      │
                         │  → transitive closure on graph   │
                         │  → filtered by edge type         │
                         │  → cross scope if edges cross    │
                         │  → returns affected subgraph     │
                         └──────────────────┬───────────────┘
                          mutate graph      │ query graph
                              │             │
                       ┌──────┴──────┐      │
                       │  Planner    │      │
                       │  (graph     │      │
                       │  mutation   │      │
                       │  operations)│      │
                       └──────┬──────┘      │
                              │ plan        │
                              ▼             ▼
              ┌─────────────────────────────────────┐
              │  Constraint Engine                   │
              │  (graph consistency enforcer)        │
              │                                      │
              │  1. Impact cone via transitive       │
              │     closure through typed edges      │
              │  2. Contract check per edge          │
              │  3. Conflict detection (other plans) │
              │  4. Staleness verification           │
              │     (Byte-Identity on frozen set)    │
              │  5. PASS / BLOCK / WARN             │
              └─────────────────────────────────────┘
                              │
                              ▼
              ┌─────────────────────────────────────┐
              │  Execution + Monitoring              │
              │  (mutates graph state on completion) │
              └─────────────────────────────────────┘
                              │ violation event
                              ▼
              ┌─────────────────────────────────────┐
              │  Feedback / Learning                 │
              │  (adjusts edge weights, constraints) │
              └─────────────────────────────────────┘
```

Key distinction from the earlier framing: the constraint engine is not an external gate. It is a consistency layer within the graph system. "Planning" is graph mutation. "Cross-repo resolution" is what happens when dependency edges cross scope boundaries — no different architecture than edges within a scope, just a different access control model.

---

## 4. Core Data Structures

### 3.1 Typed Edge Dependency Graph
```
abstract edge type Dependency {
  properties: { created_at, staleness, confidence }
}

edge type InterfaceDep extends Dependency {
  contract: string,          // API signature / schema hash
  version_range: [semver],
  breaking: boolean
}

edge type DataDep extends Dependency {
  schema_hash: string,
  fields_used: [string],
  compatibility: enum{exact, subset, transform}
}

edge type TemporalDep extends Dependency {
  offset: duration,
  slack: duration,
  critical: boolean
}

edge type KnowledgeDep extends Dependency {
  topic: string,
  artifact_id: string
}

edge type BehavioralDep extends Dependency {
  expected_semantics: string
}
```
> **Research basis:** PG-Schema (Angles et al., PODS 2023) — multi-inheritance type hierarchy for property graphs. Verified.

### 3.2 Edge Journal (append-only)
```sql
CREATE TABLE edge_journal (
  edge_id UUID,
  source_repo TEXT, source_output TEXT,
  target_repo TEXT, target_output TEXT,
  dep_type TEXT,
  contract JSONB,
  valid_from TIMESTAMPTZ,
  valid_to TIMESTAMPTZ,  -- NULL = current
  tx_id BIGINT,
  plan_id UUID           -- NULL = not from a plan
);
```
> **Research basis:** Temporal property graph models (Campos et al., TEG-QL, arxiv 1604.08568). Time Agnostic Library (Massari & Peroni, arxiv 2210.02534) — temporal query patterns with sub-linear scaling. Verified.

### 3.3 Planned Graph Stack
> ⚠️ **SPECULATIVE — NOT SUBSTANTIATED BY RESEARCH.** This section describes a proposed data structure with no verified research backing.

```
A stack of delta layers, one per active plan:
  base: CURRENT graph
  plan_A: { edges_added: [...], edges_removed: [...] }
  plan_B: { edges_added: [...], edges_removed: [...] }
  
Query: "what does the graph look like if all current plans land?"
  → apply plan_A deltas to base
  → apply plan_B deltas to result
  → detect conflicts (two plans modifying same edge)
```
No research paper addresses the concept of stacking speculative planned futures on a dependency graph. Temporal query infrastructure exists for *historical* states (Time Agnostic Library) but not for speculative future states. This concept is engineering-novel and needs formalization (see research topic R6/R9).

### 3.4 Plan Timeline
> ⚠️ **SPECULATIVE — NOT SUBSTANTIATED BY RESEARCH.** This section describes a proposed state machine with no verified research backing.

```
CURRENT          — what is deployed now
PLANNED          — a plan has been proposed, being checked
CHECKED          — impact cone computed, contracts verified, snapshot frozen
EXECUTING        — change being applied, dep nodes marked "in transition"
EXECUTED         — now reality
HISTORICAL       — what was true at some past time (for audit)
```
The temporal states (CURRENT, PLANNED, HISTORICAL) are conceptually grounded in temporal database theory, but no paper applies them to plan coordination on dependency graphs. The CHECKED → EXECUTING staleness window protocol is novel.

---

## 5. Verified Research Catalog

Papers are organized by system component. Each entry includes:
- **Memory UID** for cross-reference
- **Status** (VERIFIED/FULLY ANALYZED / VERIFIED/ABSTRACT / LOW / RETRACTED)
- **✓** = full paper read and analyzed (not just abstract)
- Unused papers are listed at the bottom with reasons

### 4.1 Typed Edge Data Model

| Paper | Memory UID | Status | How it applies |
|---|---|---|---|
| **PG-Schema** (Angles et al., PODS 2023, arxiv 2211.10962) | `01KXNWV65C3M3W64VWC1HNXK1Q` | VERIFIED FULLY ANALYZED ✓ | Formal type system for property graphs with multi-inheritance. `InterfaceDep extends Dependency` maps directly to PG-Schema's PG-Types. Designed for ISO GQL Standard. |
| **Property Graph Type System and DDL** (Wu 2018, arxiv 1810.08755) | Not written to memory | NOT USED — superseded by PG-Schema (21 authors, ISO standard). Wu is single-author precursor. |

### 4.2 Impact Cone / Transitive Closure Algorithms

| Paper | Memory UID | Status | How it applies |
|---|---|---|---|
| **Dynamic Shortest Path and Transitive Closure Algorithms: A Survey** (Martin 2017, arxiv 1709.00553) | `01KXNWV65KFJ5YV24SDF89KJB9` | VERIFIED FULLY ANALYZED ✓ | Survey of fully dynamic transitive closure algorithms. O(1) query with O(V²) storage vs O(V+E) query with O(V+E) storage tradeoffs. Directly addresses impact cone computation. |
| **A Review of Software Change Impact Analysis** (Lehnert 2011) | Not written to memory | LOW — PDF unreadable, metadata confirmed at db-thueringen.de | Survey of 150+ impact analysis approaches on dependency graphs. Known to exist, specific claims unverifiable. |

### 4.3 Subgraph / Graph-Context Retrieval

| Paper | Memory UID | Status | How it applies |
|---|---|---|---|
| **SubgraphRAG** (Li et al., ICLR 2025, arxiv 2410.20724) | `01KXNX6T9TTC4AQFD2FEPR695H` | VERIFIED FULLY ANALYZED ✓ | MLP + parallel triple-scoring for subgraph retrieval. Adjustable subgraph size for LLM context window. Addresses exactly the "how much graph context do I give the LLM" tradeoff. |
| **GraphRAG Survey** (Zhang et al., 2025, arxiv 2501.13958) | `01KXNX6X8AR7XJWMHM43GNCHKD` | VERIFIED FULLY ANALYZED ✓ | Comprehensive field survey of graph-based RAG. Graph-structured knowledge, multi-hop retrieval, structure-aware LLM integration. |
| **Awesome-GraphRAG** (GitHub catalog) | `01KXNNWYPV6N1QZMDR336D1SHF` | REFERENCE CATALOG — not a paper | Curated list of 36+ GraphRAG papers. Useful for ongoing discovery. |

### 4.4 Dynamic Task Graphs / Multi-Agent Planning

| Paper | Memory UID | Status | How it applies |
|---|---|---|---|
| **DynTaskMAS** (Yu et al., ICAPS 2025, arxiv 2503.07675) | `01KXNNVV6R674YRH4XWYJBBCPB` | VERIFIED FULLY ANALYZED ✓ | Dynamic task graph generator for LLM MAS. 21-33% faster execution, 35.4% better resource utilization. The dynamic DAG pattern for decomposing and scheduling tasks. |
| **Task Memory Engine (TME)** (Ye 2025, arxiv 2504.08525) | `01KXNNVZVX6CPTF66RYRGQY3YX` | VERIFIED ABSTRACT | Hierarchical Task Memory Tree for per-node state tracking. Dynamic prompt synthesis from active node path. Graph-aware design for DAG. |
| **Plan-on-Graph** (2024, arxiv 2410.23875) | `01KXNNWPX1HK6D7A6EAJV3PYBF` | VERIFIED ABSTRACT | LLM agent plans over KGs via iterative acyclic graph plans with self-correction. AI-driven project planning over task dependency graphs. |
| **Synthesis of State Machines from Scenarios** (Vasilache) | `01KXNNWJC1T1Z3Q4THV3H3PHJB` | VERIFIED ABSTRACT | Formal rules for synthesizing state machines from dependency diagrams. Maps to deriving project planning state machines from task dep graphs. |
| **Advanced Planning & Scheduling with Semantic KGs** (Petrovic 2025, CEUR-WS) | `01KXNNX527NS2PZF46N13DME6P` | VERIFIED ABSTRACT | LLM-based automated KG construction from freeform text for planning and scheduling. Converts project descriptions into structured KGs. |
| **HVR — Hierarchical Planning + KG RAG** (Petruzzellis et al., OpenReview) | `01KXNNWTC8V44P3PA9XAKYAYJB` | LOW — OpenReview 403, never read | Claimed to combine hierarchical planning with RAG over symbolic KGs. Cannot verify. |
| **Graph-Based Task Allocation for Multi-Agent Fleet** (Yalcinkaya et al., MDPI 2026) | `01KXNNX1P14QT9CX9AGK4PY52J` | LOW — MDPI 403, never read | Closed-loop LLM + graph optimization. Mentioned but unverified. |

### 4.5 Temporal / Versioned Graph Queries

| Paper | Memory UID | Status | How it applies |
|---|---|---|---|
| **Time Travel for Knowledge Graphs** (Massari & Peroni, arxiv 2210.02534) | `01KXNWV65NNP5GNPY2YK20TXAH` | VERIFIED FULLY ANALYZED ✓ | Six temporal retrieval patterns (version materialization, delta, cross-version) with sub-linear scaling. Concurrent updates + queries. Closest existing system to plan-scoped snapshots. |
| **Towards Temporal Graph Databases (TEG-QL)** (Campos et al., arxiv 1604.08568) | `01KXNZAZYHFCBW4T4ME27050KF` | VERIFIED ABSTRACT | Temporal attribute graph data model with timestamped properties. Maps to edge journal. |

### 4.6 Conflict Detection / Transaction Isolation

| Paper | Memory UID | Status | How it applies |
|---|---|---|---|
| **GRAIL — Checking Transaction Isolation Violations with Graph Queries** (ICGT 2024) | `01KXNZAWS2JTH7D0YA0CEWH2QS` | VERIFIED ABSTRACT — confirmed via Springer link | Graph-query anti-patterns to detect isolation violations. Detection-after-the-fact, not prevention. |
| **Survey: On the Landscape of Graph Databases** (Coimbra et al., 2025, arxiv 2505.24758) | `01KXNX70MJ2NKR6TYP7WB1A8MC` | VERIFIED FULLY ANALYZED ✓ | 66-page survey: property models, query languages, storage, transaction management. Broader context for graph DB isolation. |
| **SSI — Serializable Snapshot Isolation** (Cahill 2009) | `01KXNS47RTGXC0XN324PCJ0G16` | **RETRACTED** — 403, never read | Originally cited as evidence for plan-conflict detection. Cannot confirm. GRAIL is the verified alternative. |
| **Nx Smart Dependency Graph Cache** (Nx docs) | `01KXNS4AJD6CVSNQRYH7DKQTM0` | **NOT PEER-REVIEWED** — product documentation | Real production pattern for subgraph-tracing invalidation. Useful as engineering reference, not citable as research. |

### 4.7 RAG Enrichment for Graph-Structured Data

| Paper | Memory UID | Status | How it applies |
|---|---|---|---|
| **KG-RAG — KG-Enhanced RAG** (Wang et al., Nature Sci Reports 2025) | `01KXNNW49HX91BQ2R2SKZA4A3B` | VERIFIED FULLY ANALYZED ✓ | Dual-channel retrieval: DPR (text) + GNN path attention (graph). Path attention scores relevance. 13.6% FactScore improvement. |
| **Ontology Learning + KG for RAG** (da Cruz et al., arxiv 2511.05991) | `01KXNNW853J9TBE38H7RZ275W1` | VERIFIED ABSTRACT | One-time ontology learning from relational databases — key for deploying with existing PM data. |
| **KA-RAG — Agentic RAG + KGs** (Gao et al., MDPI 2025) | `01KXNNWBV9Y8GMFBRWV0AX85HF` | LOW — MDPI 403, never read | Agent-based KG navigation. Mentioned but unverified. |

### 4.8 Unused or Peripheral Papers

| Paper | Why not used |
|---|---|
| **Grokers** (Magarshak 2026, arxiv 2606.00050) | Single-author, no venue, theoretical claims unvalidated. Byte-Identity Theorem is conceptually relevant but LOW confidence. Not suitable as primary evidence. |
| **EvolveR** (Wu et al., ICML 2026, arxiv 2510.16079) | ICML venue is strong, but paper addresses agent self-evolution from experience, not dependency graph constraint learning. Tangential. Could become relevant for Section 6.5 self-correction feedback loop. |
| **FoGE — Fock Space Graph Encoding** (Chytas et al., 2025) | Graph encoding for LLM prompts is interesting but addresses graph→text serialization format, not selection of which subgraph to serialize. Relevant to R2 but not core. |
| **Context Graphs for Proactive Enterprise Agents** (Kumar 2026) | Single-author arxiv, no venue. The Proactivity Scorer concept is relevant but unvalidated. |
| **Vedal/Stray 2021 — Managing Dependencies in Large-Scale Agile** | `01KXNZB3ZVC5E5Z9A14WP3EZQB` | SE venue (XP workshops), not on arxiv. Empirical study of human coordination mechanisms. Useful as requirements reference but not as algorithmic foundation. |
| **Berntzen et al. — Coordination Strategies (XP 2021)** | SE venue, binary PDF only. Same Vedal/Stray research group. |
| **Inter-team coordination mechanisms (ACM 2017)** | SE venue, 403. Could not access. |

---

## 6. Unanswered Items

> **Note:** The clarification that the graph IS the plan (not a coordination overlay) changes the framing of several items below. Items 5.1-5.5 were identified under the original "coordination gate" framing. Items 5.6-5.11 are gaps that emerge from the corrected understanding.

### 5.1 Plan-scoped futures stack
The concept of a stack of planned delta branches on the dependency graph — where each plan is a transaction branch that auto-resolves on execution — has no verified research. Temporal query infrastructure exists (Time Agnostic Library) but only for historical queries, not speculative futures.

### 5.2 Cross-repository staleness window protocol
The protocol for verifying that an impact cone computed at T1 is still valid at T2 by comparing frozen edge sets against current edge sets. The Byte-Identity Theorem (Grokers, LOW) provides a theoretical foundation. Nx (product docs) provides a monorepo-scale production pattern. The cross-repo typed-edge version is novel.

### 5.3 Graph mutation constraint enforcement (formerly "write-time blocking gate")
Originally framed as a gate between planner and execution. Under the corrected understanding: the constraint engine is a consistency layer within the graph itself. When a mutation operation would violate a constraint (delete a task others depend on, add a cycle, change a schedule that breaks downstream), the constraint engine must enforce invariants at mutation time. No research paper addresses graph mutation operations with plan consistency constraints.

### 5.4 Planner-consumer negotiation protocol (unchanged)
The socio-technical protocol for what happens when a plan mutation is blocked — who notifies whom, how consent is recorded, how edge updates are negotiated, how escalations work. Partially covered empirically by Vedal/Stray (OKR workshops, Slack, PO role) but not formalized as a system design.

### 5.5 Self-correction feedback loop from violation events (unchanged)
When a violation slips through and breaks a consumer post-deployment, how that event feeds back into stricter future checks. The EvolveR paper (ICML 2026) provides a self-evolution framework for agents, but applying it to dependency graph constraint weights is novel.

### ⬜ 5.6 Full plan graph representation model (NEW)
The graph holds the entire plan — tasks, dependencies, state machines, schedules, resources, planning horizons. There is no separate data model "behind" the graph. What is the formal representation of a project plan as a typed property graph? What node types exist (Task, Milestone, Resource, Scope, Output)? What edge types exist beyond dependencies (assignments, refinements, timelines)? How do temporal constraints (deadlines, durations, offsets) live on edges vs nodes? PG-Schema provides the type system primitives but not a plan-specific schema.

### ⬜ 5.7 Plan graph mutation operations (NEW)
If planning is graph mutation, what are the well-defined primitive operations? Candidates include: CREATE_TASK, DELETE_TASK, ADD_DEPENDENCY, REMOVE_DEPENDENCY, CHANGE_STATE, SPLIT_TASK, MERGE_TASKS, REORDER, ASSIGN_RESOURCE. Each operation has preconditions (task must exist, no cycles, consumer consent) and postconditions (impact cone recomputed, affected subgraph marked stale). No research catalogues plan graph mutation operations and their consistency semantics.

### ⬜ 5.8 Multi-scope ownership and access within a single plan graph (NEW)
The graph spans repos, teams, and orgs. A task in repo A is owned by team A but depends on a task in repo B owned by team B. Team A can see B's task but shouldn't be able to modify it. What is the access control model for subgraphs of a shared plan? How does ownership interact with dependency enforcement (team B can block team A's plan by refusing a contract update)? No research addresses multi-tenant plan graphs with ownership boundaries.

### ⬜ 5.9 Plan graph branching and merging (NEW)
The plan evolves over time. Mutations create new versions. Planners may want to explore speculative variants (what if we delay this task by two weeks?) without committing. This requires branching the plan graph — analogous to git branches but on a property graph. How do branch semantics work on a plan graph? How do merges resolve when two planners independently modify different subgraphs? The Time Agnostic Library handles temporal queries but not branching.

### ⬜ 5.10 State machine per task node (NEW)
Each task has a lifecycle: planned → in-progress → blocked → completed → failed → rolled back. State transitions are constrained by dependencies (can't start if a dep is blocked). This is a distributed state machine coordination problem — the state of one node constrains the legal states of its neighbors. No research combines per-node state machines with typed dependency edge constraints in a single graph model.

### ⬜ 5.11 Plan subgraph serialization for LLM consumption (NEW — reframed from R2)
The graph IS the plan, and LLMs need to see parts of it. Given a subgraph of a plan (not a generic knowledge graph), how do you serialize it into text an LLM can act on? A task node has descriptions, dependencies, state, schedule, resource assignment — all in the graph. The serialization format determines what the LLM can understand and reason about. SubgraphRAG (ICLR 2025) selects which subgraph to retrieve but doesn't address plan-specific serialization.

---

## 7. Outstanding Research Topics

Each of these is a candidate for a dedicated researcher-agent run. Topics with ⬜ are newly identified following the corrected "graph IS the plan" framing.

| # | Topic | Primary Question | Likely Venues | Status |
|---|---|---|---|---|---|
| R1 | **Plan-scoped graph snapshot semantics** | What are the merge/conflict semantics when two plans modify overlapping subgraphs? Can SSI-style cycle detection be adapted to detect conflicting plans before execution? | VLDB, PODS, SIGMOD | Unchanged |
| R2 | **Plan subgraph serialization for LLM context windows** | What is the optimal tradeoff between subgraph size and LLM task accuracy? How do different serialization formats (JSON adjacency, FoGE encoding, natural language) compare in token efficiency for plan subgraphs specifically? | ACL, EMNLP, ICLR | Reframed |
| R3 | **Event-driven schedule propagation through typed dependency graphs** | What algorithms exist for incrementally recomputing the critical path when a single task status changes? How do temporal and resource dependencies interact during propagation across planning horizons (Time+1 vs Time+N)? | ICAPS, AIJ, OR | Unchanged |
| R4 | **Hierarchical task placement — semantic + structural deduplication** | Given an existing plan graph and a new task description, can we determine whether the new task duplicates, refines, siblings, or branches from existing nodes? | AKBC, KR, EDBT | Unchanged |
| R5 | **Graph mutation consistency enforcement** | What are the well-defined mutation operations on a plan graph (CREATE_TASK, DELETE_TASK, ADD_DEP, etc.) and what are their pre/post conditions? How does the system enforce invariants (no cycles, consumer consent, type correctness) at mutation time? | ASE, ICSE, ESEC/FSE | Reframed — was "constraint engine as planner interceptor" |
| R6 | **Temporal property graphs with speculative future states** | Can temporal graph query models be extended to support queries against planned future states, not just historical snapshots? | VLDB, EDBT, SIGMOD | Unchanged |
| R7 | **Graph store selection for plan graph workloads** | What are the performance characteristics of labeled property graphs (Neo4j) vs typed relational (Postgres + CTE) vs Datalog engines (Souffle) for transitive closure over plan graphs with <10K nodes? | SIGMOD, VLDB, CIDR | Unchanged |
| R8 | **Write-time vs query-time precomputation for impact cones** | Under what conditions (graph size, change frequency, query frequency) does precomputing impact cones at write time outperform computing them on demand? What are the staleness tradeoffs? | VLDB, SIGMOD, DEBS | Unchanged |
| R9 | **Constraint severity policy — hard block vs soft block vs warn** | How should the severity of a constraint violation be determined based on edge type, confidence, and historical data? Can a learned policy outperform static rules? | Policy, ICSE, CAV | Reframed — from "gate" to "graph consistency layer" |
| R10 | ⬜ **Full plan graph representation** | What is the formal data model for a project plan as a typed property graph? What node types (Task, Milestone, Resource, Scope, Output), edge types (dependency, assignment, refinement, timeline), and constraints are needed? | VLDB, EDBT, ER | NEW |
| R11 | ⬜ **Plan graph branching and merging** | Can a plan graph support git-like branches for speculative planning variants? How do merges resolve when two planners independently modify different subgraphs? | VLDB, ICSE | NEW |
| R12 | ⬜ **Multi-scope ownership in a shared plan graph** | How do access control, ownership, and write permissions work when a single plan graph spans repos, teams, and orgs? How does ownership interact with dependency enforcement? | ICSE, CCS, SOUPS | NEW |
| R13 | ⬜ **Distributed task state machines on a dependency graph** | Each task has a state machine constrained by neighbor states. What is the formal model for per-node state machines with typed dependency edge constraints? How do state transitions propagate? | ICAPS, KR, FACS | NEW |

---

## 8. Research Sources by Confidence

```
VERIFIED FULLY ANALYZED ✓ (paper read, venue confirmed):
  PG-Schema (PODS 2023)                              — 01KXNWV65C3M3W64VWC1HNXK1Q
  DynTaskMAS (ICAPS 2025)                              — 01KXNNVV6R674YRH4XWYJBBCPB
  KG-RAG (Nature Scientific Reports)                   — 01KXNNW49HX91BQ2R2SKZA4A3B
  Dynamic Transitive Closure Survey (Martin 2017)      — 01KXNWV65KFJ5YV24SDF89KJB9
  SubgraphRAG (ICLR 2025)                              — 01KXNX6T9TTC4AQFD2FEPR695H
  GraphRAG Survey (Zhang et al. 2025)                  — 01KXNX6X8AR7XJWMHM43GNCHKD
  Graph Database Landscape Survey (Coimbra et al. 2025) — 01KXNX70MJ2NKR6TYP7WB1A8MC
  Time Agnostic Library (Massari & Peroni 2022/2026)   — 01KXNWV65NNP5GNPY2YK20TXAH

VERIFIED ABSTRACT (abstract read, lower venue or not fully analyzed):
  TME (Ye 2025, preprint)                              — 01KXNNVZVX6CPTF66RYRGQY3YX
  Plan-on-Graph (2024, preprint)                       — 01KXNNWPX1HK6D7A6EAJV3PYBF
  Ontology Learning for RAG (da Cruz 2025, preprint)   — 01KXNNW853J9TBE38H7RZ275W1
  GRAIL (ICGT 2024)                                    — 01KXNZAWS2JTH7D0YA0CEWH2QS
  TEG-QL (Campos 2016)                                 — 01KXNZAZYHFCBW4T4ME27050KF
  Advanced Planning with Semantic KGs (Petrovic 2025)  — 01KXNNX527NS2PZF46N13DME6P
  State Machine Synthesis (Vasilache)                   — 01KXNNWJC1T1Z3Q4THV3H3PHJB
  Vedal/Stray (2021, XP workshops)                     — 01KXNZB3ZVC5E5Z9A14WP3EZQB

LOW (unverified, unreadable, or non-research):
  HVR (OpenReview 403)                                 — 01KXNNWTC8V44P3PA9XAKYAYJB
  Task Allocation (MDPI 403)                           — 01KXNNX1P14QT9CX9AGK4PY52J
  KA-RAG (MDPI 403)                                    — 01KXNNWBV9Y8GMFBRWV0AX85HF
  Lehnert survey (PDF unreadable)                      — not written to memory
  Grokers (single-author arxiv, no venue)              — not written to memory
  Context Graphs (single-author arxiv, no venue)       — not written to memory

NOT RESEARCH (engineering references):
  Nx cache invalidation (product docs)                 — 01KXNS4AJD6CVSNQRYH7DKQTM0

RETRACTED (claimed but never verified):
  SSI / Cahill (403, never read)                       — 01KXNS47RTGXC0XN324PCJ0G16
```

---

## 9. Resume & Next Steps

### Immediate (this session)

| Step | Action |
|---|---|
| 1 | **Translate 5.6-5.11 into formal research questions** — the ⬜ items are identified but not fully formulated as researcher-agent briefs. Each needs the Phase 0→2 treatment from the Researcher Agent protocol. |
| 2 | **Refine the plan graph type schema** — given PG-Schema's multi-inheritance types, draft the actual node/edge type hierarchy for a project plan. What node types (Task, Milestone, Resource, Scope, Output)? What edge types (dep subtypes, assignment, refinement, timeline)? This is a design exercise, not a research question. |
| 3 | **Prioritize R1-R13** — which gaps are blocking vs nice-to-have for an MVP? R5 (mutation operations), R10 (plan graph representation), and R12 (multi-scope ownership) are likely foundational. R13 (distributed state machines) and R11 (branching) are later. |
| 4 | **Decide on graph store** — R7 needs an answer before implementation starts. The tradeoffs (Neo4j vs Postgres+CTE vs Souffle) determine the entire query architecture. This could be decided by prototyping rather than research. |

### Short-term research dispatches

| Priority | Topic | Why now |
|---|---|---|
| P1 | **R10 — Plan graph representation** | Everything depends on the data model. Without this, all other research lacks a target. |
| P2 | **R5 — Graph mutation operations** | The constraint engine's semantics depend on knowing what operations exist and what they require. |
| P3 | **R7 — Graph store selection** | Architectural decision that blocks implementation. Prototype-driven. |
| P4 | **R12 — Multi-scope ownership** | If the system spans repos/orgs, access control is a hard requirement, not a feature. |

### Key decisions that need making

| Decision | Options | Research basis | Suggested approach |
|---|---|---|---|
| **Graph store** | Neo4j vs Postgres+CTE vs Souffle | Martin survey (transitive closure), PG-Schema (type system) | Prototype all three with a 1000-node plan graph, benchmark query latency |
| **Mutation model** | Direct graph mutation vs transaction log vs plan-as-code | No research exists — this is novel | Design from first principles, informed by Vedal/Stray's empirical coordination mechanisms |
| **State machine model** | Per-node states with neighbor constraints vs global plan state | Vasilache (state machine synthesis) provides partial foundation | Draft per-node state machine, verify against dep types |
| **Scope isolation** | Subgraph-per-scope with cross-edges vs global graph with labels | No research — novel | Subgraph-per-scope gives cleaner access control; cross-edges handle deps |
| **LLM integration** | SubgraphRAG-style retrieval + FoGE-style encoding | SubgraphRAG (ICLR 2025), KG-RAG (Nature) | Plausible starting point; plan-specific serialization is novel R2 work |

### Long-term research program

```
Phase 1: Plan graph representation (R10) + mutation operations (R5)
Phase 2: Graph store prototype (R7) + constraint enforcement (R5 impl)
Phase 3: Multi-scope ownership (R12) + staleness protocol (5.2)
Phase 4: Temporal queries + speculative futures (R6, R1)
Phase 5: Plan branching/merging (R11) + LLM integration (R2)
Phase 6: Distributed state machines (R13) + self-correction (5.5)
```

### Known gaps in this document

- The 5.6-5.11 items were identified in the clarification pass but are not yet formulated as researcher-agent briefs (Phase 0→2). Doing so is the next step.
- Several papers exist at `LOW` confidence that could move to `MEDIUM` with better access (HVR at OpenReview, Task Allocation and KA-RAG at MDPI, Lehnert survey).
- The plan graph type schema (node types, edge types) is a design deliverable not yet written. It should be drafted alongside R10 research.

---

## 10. Recent Research Findings (2026-07-16 dispatch)

### R4 — Task Deduplication via Entity Resolution

Entity resolution (ER) is a mature field but **no paper applies ER to task deduplication specifically**. Two relevant architectures exist:

- **Resolvi** (Olar, arxiv 2503.08087) — Reference architecture for ER systems. Provides design patterns, blocking, matching, and merging pipelines. Not task-specific but architecture is transferable.
- **MERAI** (Kannangara et al., arxiv 2508.03767) — Enterprise ER pipeline processing 15.7M records. Outperforms Dedupe and Splink. Demonstrates that ML-based ER at scale is feasible.

**Gap confirmed:** Task dedup combines semantic similarity (task descriptions) with structural position (graph neighborhood). No existing ER system handles graph-structural features. This is a novel research contribution, not just a known technique to apply.

### R13 — Task State Machines via StateFlow

**StateFlow** (Wu et al., arxiv 2403.11322) — LLM task-solving as state machines. Key contribution: distinguishes between "process grounding" (state/transitions) and "sub-task solving" (actions within a state). Achieves 13-28% higher success rates than ReAct with 3-5x less cost.

**Relevance to plan graph:** StateFlow's state machine model maps directly to per-task state machines in the plan graph. A task's state (planned → in-progress → blocked → completed) corresponds to StateFlow's process grounding. Task execution actions correspond to sub-task solving within a state. The heuristic rules for state transitions in StateFlow map to dependency constraints (can't transition to in-progress if a dependency is blocked).

**Gap:** StateFlow operates on individual LLM tasks in isolation. No paper combines per-task state machines with typed dependency edges between tasks in a shared graph.

### R3 — Event-Driven Schedule Propagation

**No new academic papers found.** The DuckDuckGo search returned mostly practitioner articles on critical path method (CPM), not research on event-driven incremental recomputation. The NDIA paper on CPM in agile environments is a practitioner paper, not research.

**Assessment:** This topic is better addressed by operations research literature (PERT, critical path analysis, resource-constrained project scheduling) than CS literature. The "typed edge" dimension is novel — standard CPM doesn't distinguish between interface, data, temporal, and knowledge dependencies with different propagation semantics.

### R10 — Plan Graph Representation

**No paper found** that represents a project plan as a typed property graph. The "From relational model to property graph" paper (Springer 2025) covers relational→graph mapping generally but not plan-specific schemas.

**Assessment:** This is a design exercise guided by PG-Schema, not a research discovery task. The core question is: what node types, edge types, and constraints constitute a plan? Drafting and iterating this schema is the next engineering step, not a research gap.
