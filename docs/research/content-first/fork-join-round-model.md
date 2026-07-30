# Round-by-Round Message Model — Role-First vs Content-First

## Legend

| Symbol | Meaning |
|--------|---------|
| Tn | Task n (T1, T2, T3, T4) — sequential, each depends on prior |
| Rn | Round n within a task (R1..R6) — one agent per round |
| P→M1 | Planner produces Message 1 (plan) |
| A→M2 | Architect produces Message 2 (spec) |
| TS→M3 | TypeScript produces Message 3 (code) |
| Te→M4 | Tester produces Message 4 (tests) |
| R→M5 | Reviewer produces Message 5 (review) |
| D→M6 | Deployment produces Message 6 (deploy) |
| ▓ | Cold start (cache miss — full context recomputed) |
| ░ | Warm start (cache hit — only new suffix computed) |

---

## Role-First

```
Task   Round  →   R1       R2         R3           R4             R5               R6
═══════════════════════════════════════════════════════════════════════════════════════
                  P→M1     A→M2       TS→M3        Te→M4          R→M5             D→M6

T1     Context:  [sys_P   [sys_A     [sys_TS      [sys_Te        [sys_R           [sys_D
                   seed]    seed+M1     seed+M1+M2   seed+..+M3     seed+..+M4       seed+..+M5]
                                                                                    
       Cache:    ▓cold    ▓cold      ▓cold         ▓cold          ▓cold            ▓cold
                 4,600t   5,100t     5,600t        6,100t         6,600t           7,100t

                 sys_P    sys_A ≠    sys_TS ≠      sys_Te ≠       sys_R ≠          sys_D ≠
                 OK       sys_P      sys_A         sys_TS         sys_Te           sys_R
                          miss at 0  miss at 0     miss at 0      miss at 0        miss at 0
═══════════════════════════════════════════════════════════════════════════════════════
                  P→M7     A→M8       TS→M9        Te→M10         R→M11            D→M12

T2     Context:  [sys_P   [sys_A     [sys_TS      [sys_Te        [sys_R           [sys_D
                   T1out]   T1out+M7   T1out+M7+M8  T1out+..+M9   T1out+..+M10     T1out+..+M11]
                                                                                    
       Cache:    ▓cold    ▓cold      ▓cold         ▓cold          ▓cold            ▓cold
                 7,600t   8,100t     8,600t        9,100t         9,600t           10,100t

                 sys_P    sys_A ≠    sys_TS ≠      sys_Te ≠       sys_R ≠          sys_D ≠
                 OK       sys_P      sys_A         sys_TS         sys_Te           sys_R
                          miss at 0  miss at 0     miss at 0      miss at 0        miss at 0
═══════════════════════════════════════════════════════════════════════════════════════
T3     ... same pattern, context even larger ...
T4     ... same pattern, context even larger ...

TOTAL:  24 cold starts = ~186,000 tokens
        Zero cache reuse across any boundary
        Cost per run (4 tasks): ~$2.79
```

**Key pathology:** Every single round in every single task is a full cold start at position 0, because each agent has a unique system prompt (`sys_P`, `sys_A`, `sys_TS`, `sys_Te`, `sys_R`, `sys_D`). The growing accumulated context makes each subsequent cold start more expensive.

---

## Content-First

```
Task   Round  →   R1       R2         R3           R4             R5               R6
═══════════════════════════════════════════════════════════════════════════════════════
                  P→M1     A→M2       TS→M3        Te→M4          R→M5             D→M6

T1     Context:  [seed    [seed+M1   [seed+M1+M2  [seed+..+M3    [seed+..+M4      [seed+..+M5
                   +role_P] +role_A]  +role_TS]    +role_Te]      +role_R]         +role_D]

       New in     seed     M1         M2            M3             M4               M5
       prefix:    (cold)   (500t)     (500t)        (500t)         (500t)           (500t)
       
       Cache:    ▓cold    ░warm      ░warm         ░warm          ░warm            ░warm
                 4,600t   1,100t     1,100t        1,100t         1,100t           1,100t

                 ──── seed persists as cached prefix ──────────────────────────────►
                         ↑M1 new    ↑M1+M2 kept   ↑...kept       ↑...kept          ↑...kept
                 Only the prior round's output is new prefix content.
                 Role suffix (100t) and generation (500t) are constant per agent.
═══════════════════════════════════════════════════════════════════════════════════════
                  P→M7     A→M8       TS→M9        Te→M10         R→M11            D→M12

T2     Context:  [T1out   [T1out+M7  [T1out+M7+M8 [T1out+..+M9   [T1out+..+M10    [T1out+..+M11
                   +role_P] +role_A]  +role_TS]    +role_Te]      +role_R]         +role_D]

       New in     T1out    M7          M8            M9             M10              M11
       prefix:    (7K)     (500t)      (500t)        (500t)         (500t)           (500t)

       Cache:    ░warm    ░warm       ░warm         ░warm          ░warm            ░warm
                 7,600t   1,100t      1,100t        1,100t         1,100t           1,100t

                 ↑T1out cached from D→M6 in T1
                 ──── T1out persists as cached prefix ────────────────────────────►
═══════════════════════════════════════════════════════════════════════════════════════
T3     ... same pattern ...
T4     ... same pattern ...

TOTAL:  1 partial cold seed (T1-R1) + 3 task deltas (T2-R1, T3-R1, T4-R1) + 20 warm
        ~24,000 tokens
        Cost per run (4 tasks): ~$0.36
```

**Key efficiency:** The seed and accumulated task outputs persist in cache across all rounds and all tasks. Only the prior round's output enters as new prefix content. Each agent after the seed is 4× cheaper (1,100t vs 4,600–10,100t).

---

## Comparison Matrix

```
                  R1       R2       R3       R4       R5       R6       Task cost
                ─────────────────────────────────────────────────────────────────
T1 role-first   4,600t   5,100t   5,600t   6,100t   6,600t   7,100t   ~35,100t
T1 content-fst  4,600t   1,100t   1,100t   1,100t   1,100t   1,100t   ~10,100t
                ─────────────────────────────────────────────────────────────────
T2 role-first   7,600t   8,100t   8,600t   9,100t   9,600t   10,100t  ~53,100t
T2 content-fst  7,600t   1,100t   1,100t   1,100t   1,100t   1,100t   ~13,100t
                ─────────────────────────────────────────────────────────────────
T3 role-first   10,600t  11,100t  11,600t  12,100t  12,600t  13,100t  ~71,100t
T3 content-fst  10,600t  1,100t   1,100t   1,100t   1,100t   1,100t   ~16,100t
                ─────────────────────────────────────────────────────────────────
T4 role-first   13,600t  14,100t  14,600t  15,100t  15,600t  16,100t  ~89,100t
T4 content-fst  13,600t  1,100t   1,100t   1,100t   1,100t   1,100t   ~19,100t
```

---

## Cumulative Cost Curves

```
Tokens new compute
  200K ┤                                                       █ role-first
       │                                                     ██
  150K ┤                                                  ███
       │                                               ████
  100K ┤                                            █████
       │                                        ██████
   50K ┤                                     ███████
       │        ░                           ░███   content-first
       │  ░░░░░░░   ░░░░░░░    ░░░░░░░   ░░░    
     0 ┤───┬───┬───┬───┬───┬───┬───┬───┬───┬───┬───┬───
        1   2   3   4   5   6   7   8   9  10  11  12
        T1──────────►  T2──────────►  T3──────────►  T4──►
        
        Role-first climbs ~3,500 tokens per round
        Content-first: seed (cold) + 5× warm per task, plus inter-task delta
```

---

## The Structural Rule

```
Role-first:   cost_per_agent = growing_context + sys_prompt + generation
              Cost compounds because every new system prompt is a full reload.

Content-first: cost_per_agent = prior_output + role_suffix + generation
              Cost is constant per agent. Only the inter-task delta grows.
```

The difference is not a constant factor. It's a different scaling law.

Role-first: $O(R \times T \times C)$ — rounds × tasks × accumulating context
Content-first: $O(C + T \times \Delta + R \times (output + suffix))$ — seed + task deltas + rounds × agent cost
