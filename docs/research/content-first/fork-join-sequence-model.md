# Fork-Join Sequence Model — 4 Tasks, 6 Agents, File Server

## Scenario

- 1 file server (small codebase — let's say 4K tokens as seed)
- 6 agents: Planner, Architect, TypeScript, Tester, Reviewer, Deployment
- 4 sequential tasks: T1, T2, T3, T4 (each must finish before next starts)
- Within each task, agents run in order due to dependency chain:

```
Planner → Architect → TypeScript → Tester → Reviewer → Deployment
```

- Each agent produces ~500 tokens of output
- Each role instruction: ~100 tokens (suffix in content-first, system prompt in role-first)

---

## Comparison Summary

Both paradigms execute the same 6-agent × 4-task workflow. The only difference is where the role instruction lives:

- **Role-first**: `[sys_role, shared_context]` — role at position 0
- **Content-first**: `[shared_context, role_suffix]` — role at end

---

## Role-First — Sequence Diagram

```
Task 1 ──────────────────────────────────────────────────────────
                                                                 
  Agent (Planner):     [sys_Pln▮ 4K_seed]              → 500t    
                       ↑ position 0 cache boundary              
                       Cold: 4K + 100 + 500 = 4,600t new              
                                                                 
  Agent (Architect):   [sys_Arc▮ 4K_seed + Pln_500t]   → 500t    
                       ↑ position 0 cache boundary!              
                       sys_Arc ≠ sys_Pln → FULL CACHE MISS       
                       Cold: 4,500 + 100 + 500 = 5,100t new      
                                                                 
  Agent (TypeScript):  [sys_TSc▮ 4K_seed + Pln + Arc]  → 500t    
                       ↑ FULL MISS again — different sys prompt  
                       Cold: 5,000 + 100 + 500 = 5,600t new      
                                                                 
  Agent (Tester):      [sys_Tst▮ 4K_seed + Pln + Arc + TS]→500t  
                       ↑ FULL MISS                              
                       Cold: 5,500 + 100 + 500 = 6,100t new      
                                                                 
  Agent (Reviewer):    [sys_Rev▮ +Pl+Ar+TS+Te]          → 500t    
                       ↑ FULL MISS                              
                       Cold: 6,000 + 100 + 500 = 6,600t new      
                                                                 
  Agent (Deployment):  [sys_Dep▮ +Pl+Ar+TS+Te+Re]      → 500t    
                       ↑ FULL MISS                              
                       Cold: 6,500 + 100 + 500 = 7,100t new      
                                                                 
Task 2 ──────────────────────────────────────────────────────────
  Same pattern, but context is now 7K bigger (T1's full output): 
  7,100t + 6 more cold starts with accumulating context…
                                                                 
Role-first TOTAL across 4 tasks:  ~186,400 tokens new compute    
                                 (24 cold starts × growing context)
```

### Cache reuse across all 24 agent invocations: **ZERO**

Every single one is a cold start at position 0 because every agent has a different `sys_` prompt.

---

## Content-First — Sequence Diagram

Within each task, agents are still sequential (Architect needs Planner's spec). But the structure allows the **shared prefix to grow incrementally while staying cached**.

```
Task 1 ──────────────────────────────────────────────────────────
  Seed: [4K_codebase]                                            
                                                                 
  Agent (Planner):     [4K_seed            ▮ "Plan approach"] →500t
                       ↑ cold — pays 4K                          
                       New: 4,000 + 100 + 500 = 4,600t           
                         └→ cache: [4K_seed] now stored          
                                                                 
  Agent (Architect):   [4K_seed + Pln_500t  ▮ "Design spec"] →500t
                       ↑ 4K_seed CACHED from Planner             
                       ↑ Pln_500t is the ONLY new prefix content  
                       New: 500 + 100 + 500 = 1,100t             
                                                                 
  Agent (TypeScript):  [4K_seed + Pln+Arc   ▮ "Implement"]  →500t
                       ↑ 4K_seed + Pln_500t CACHED               
                       New: 500 + 100 + 500 = 1,100t             
                                                                 
  Agent (Tester):      [4K_seed + Pln+Arc+TS▮ "Test"]      →500t
                       ↑ 4K+ Pln+ Arc CACHED                    
                       New: 500 + 100 + 500 = 1,100t             
                                                                 
  Agent (Reviewer):    [4K_seed + Pln+Arc+TS+Te▮ "Review"] →500t
                       ↑ prior 5,700 CACHED                      
                       New: 500 + 100 + 500 = 1,100t             
                                                                 
  Agent (Deployment):  [4K_seed + Pln+Arc+TS+Te+Re▮ "Deply"]→500t
                       ↑ prior 6,200 CACHED                      
                       New: 500 + 100 + 500 = 1,100t             
                                                                 
Task 2 ──────────────────────────────────────────────────────────
  New seed: [4K_codebase + T1_full_output_7K]                    
                                                                 
  Agent (Planner):     [seed_T1█ "Plan T2"]              → 500t  
                       ↑ full seed (11K) CACHED from T1-Dep      
                       New: 100 + 500 = 600t                     
                                                                 
  Agent (Architect):   [seed_T1 + Pln_T2▮ "Spec T2"]    → 500t  
                       ↑ 11K+500t CACHED                       
                       New: 500 + 100 + 500 = 1,100t             
  … (pattern repeats)
                                                                 
Content-first TOTAL across 4 tasks:  ~24,400 tokens new compute  
```

### Cache behavior across 24 agent invocations:

| Agent | Task 1 | Task 2 | Task 3 | Task 4 |
|-------|--------|--------|--------|--------|
| Planner | Cold seed (4,600t) | Warm (600t) | Warm (600t) | Warm (600t) |
| Architect | 1,100t | 1,100t | 1,100t | 1,100t |
| TypeScript | 1,100t | 1,100t | 1,100t | 1,100t |
| Tester | 1,100t | 1,100t | 1,100t | 1,100t |
| Reviewer | 1,100t | 1,100t | 1,100t | 1,100t |
| Deployment | 1,100t | 1,100t | 1,100t | 1,100t |

Only the **first agent of the first task** pays a full cold start. All subsequent agents in all subsequent tasks get partial or full prefix cache hits.

---

## Visual Comparison

### Role-First: Every agent is a vertical line from position 0

```
Task 1                  Task 2                  Task 3                  Task 4
P A T Te R D          P A T Te R D          P A T Te R D          P A T Te R D
| | | | | |          | | | | | |          | | | | | |          | | | | | |
| | | | | |          | | | | | |          | | | | | |          | | | | | |
v v v v v v          v v v v v v          v v v v v v          v v v v v v
▓▓▓▓▓▓▓▓▓▓▓▓▓  ← cold. All 24 are cold starts.
▓▓▓▓▓▓▓▓▓▓▓▓▓      Each pays full context cost.
▓▓▓▓▓▓▓▓▓▓▓▓▓      No cache sharing across any boundary.
▓▓▓▓▓▓▓▓▓▓▓▓▓
```

**24 cold starts. Total: ~186K tokens new compute.**

### Content-First: Only the first seed is cold

```
Task 1                  Task 2                  Task 3                  Task 4
P A T Te R D          P A T Te R D          P A T Te R D          P A T Te R D
| | | | | |          | | | | | |          | | | | | |          | | | | | |
v v v v v v          v v v v v v          v v v v v v          v v v v v v
▓░░░░░░░░░░░░  ← only first seed is cold
                  → everything else partial cache
░░░░░░░░░░░░  ← prior agent's output is the only NEW prefix content
░░░░░░░░░░░░      Role suffix is trivial (100t)
░░░░░░░░░░░░
```

**4 partial cold starts (first agent of each task only pays the inter-task delta). Total: ~24K tokens new compute.**

---

## The "One Sequential Pass" Constraint

Even in content-first, agents within a task run sequentially (Architect needs Planner's spec). But **sequential does not mean cold**. The prior agents' outputs accumulate at the END of the prefix — after the shared seed, before the next agent's role suffix:

```
Agent A: [seed, "role_A"] → output_A
Agent B: [seed, output_A, "role_B"] → output_B
                    ↑
              cached from A: only output_A is new prefix
```

This is different from role-first where the new prefix includes EVERYTHING because the system prompt at position 0 invalidates the cache:

```
Agent A: [sys_A, seed] → output_A
Agent B: [sys_B, seed, output_A] → sys_B ≠ sys_A → cache miss at 0
                    ↑
              NOT cached — sys_B is different from sys_A
```

The cache boundary determines the economics:

| | Position of cache boundary | New tokens per sequential step |
|---|---|---|
| **Role-first** | Position 0 (every agent) | seed + prior outputs + sys + generation |
| **Content-first** | After prior agent's output | prior output + role suffix + generation (seed cached) |

---

## Summary Table (4 Tasks × 6 Agents)

| Metric | Role-First | Content-First | Savings |
|--------|-----------|---------------|---------|
| Cold starts | 24 | 4 (partial) | 83% fewer |
| Total compute | ~186,000t | ~24,000t | 87% |
| Cost ($15/M input) | ~$2.79 | ~$0.36 | 87% |
| Cost for 100 runs | $279 | $36 | $243 saved |
| Marginal agent (within existing task) | $0.10 | $0.02 | 5× cheaper |
| Marginal task (after T1) | $0.70 | $0.05 | 14× cheaper |

The difference compounds over time because each new task adds a full round of 6 cold starts in role-first but only ~600t (the inter-task delta) in content-first.
