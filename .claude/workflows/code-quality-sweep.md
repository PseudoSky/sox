# `code-quality-sweep` — reusable multi-agent quality audit

A three-stage fan-out that turns a package list into an evidence-backed **epic spec**.

| Stage | Phase title | What runs | Output |
|---|---|---|---|
| 1 | `Isolated` | one specialist agent per package scope, each locked to an exact file list | findings with `file:line` + verbatim evidence |
| 2 | `Concepts` | the top recurring `concept` tags swept across the packages they were *not* found in | same schema + `matches_stage1_pattern` |
| 3 | `Synthesize` | one architect agent over the aggregate | `epics[]` with child items, citations, acceptance criteria, named tests |

## Invocation

```js
Workflow({
  name: 'code-quality-sweep',
  args: {
    packages: [ /* required — see below */ ],
    agentBudgetPerStage: 20,
    workerModel: 'haiku',
  },
})
```

`packages` is **required**. The workflow deliberately does not discover packages itself — the
calling session already knows the repo layout and should rank by LOC (`wc -l` over `src` globs)
before handing over a list. Two accepted forms, mixable:

```js
// plain path — roster picks the agent type and lens
'libs/data/store/store-adapter/src'

// explicit unit — full control, and the way to SPLIT a large package across several agents
{
  id: 'memory-core:write-queue',
  files: [
    'libs/memory-core/src/write-queue.ts',
    'libs/memory-core/src/write.ts',
    'libs/memory-core/src/lease.ts',
  ],
  agentType: 'error-detective',
  lensDescription: 'concurrency hazards, re-entrancy, swallowed errors, lost work on failure',
  hint: 'write-queue.ts is ~1300 lines; chunk it with offset/limit',
}
```

Splitting matters. A 19k-line package handed to one cheap agent produces a skim; the same package
split into five lens-specific units produces five focused reads for the same wall-clock.

## Arguments

| Arg | Default | Meaning |
|---|---|---|
| `packages` | *(required)* | Paths or unit objects, as above |
| `agentBudgetPerStage` | `20` | Hard cap on agents in Stage 1 and in Stage 2 each. Overflow is **logged, never silently dropped** |
| `workerModel` | `'haiku'` | Model for every Stage 1/2 worker |
| `synthesisModel` | *(inherit)* | Model for the Stage 3 architect. Omit to inherit the session model — usually correct |
| `root` | `'.'` | Repo root prefixed onto every scope path in the prompts |
| `roster` | built-in | `[{agentType, lensDescription, packageSelector}]`, see below |
| `maxConcepts` | `10` | How many ranked concepts get a Stage 2 sweep |
| `minConceptCount` | `2` | A concept needs this many Stage 1 hits to be swept |
| `conceptsOverride` | — | Skip ranking, sweep exactly these concept tags |

## The roster convention

A roster entry answers "*which specialist, looking for what, on which packages*":

```js
{
  agentType: 'security-auditor',
  lensDescription: 'command injection via exec/spawn, path traversal, TOCTOU on file writes, …',
  packageSelector: 'install|runtime|host|cli|apps/',   // regex, case-insensitive; '*' = fallback
}
```

Entries are tried **in order**; the first whose `packageSelector` matches a package path claims it,
so put the specific selectors first and keep a `'*'` fallback last. The built-in roster covers
database-administrator, performance-engineer, security-auditor, error-detective, typescript-pro,
qa-expert, refactoring-specialist, and code-reviewer.

Two rules make the lenses actually work:

1. **Match the agent to what the package needs analysed**, not to what sounds impressive — a
   storage layer gets `database-administrator`, an fs/exec surface gets `security-auditor`.
2. **Give the same package two units with two lenses** when it deserves it. A 9k-line CLI is
   legitimately both a `refactoring-specialist` job (structure) and a `security-auditor` job
   (exec/env/path handling); those are different reads of the same file, not a duplicate.

## Tuning budgets

- Stage 2's agent count is `min(budget, sum over concepts of package-subsets)`. Each concept gets
  roughly `budget / conceptCount` agents, splitting the un-hit packages into disjoint subsets — so
  raising `maxConcepts` at a fixed budget means *shallower* per-concept coverage, not more agents.
- If a package list exceeds `agentBudgetPerStage`, the overflow is dropped from Stage 1 and named in
  a `log()` line and in the returned `dropped.stage1_units_over_budget`. There is no silent
  truncation anywhere in this workflow — that is the point of the `dropped` block.
- Concurrency is capped at `min(16, cores-2)` regardless of budget; a budget of 20 queues, it does
  not overload the box.

## Safety

Every worker prompt carries a read-only contract: no `Edit`/`Write`, and **no build, test, lint,
nx, tsc, vitest, pnpm, or npm command at all**. Several nx build targets `rm -rf dist` before
rebuilding, so a diagnostic build in a shared checkout destroys a live artifact. Bash is permitted
only for `rg` / `wc -l` / `ls`.

## What comes back — and what you still have to do

```js
{
  epics: [ { title, problem_statement, scope_packages, severity, family, children: [...] } ],
  concepts: [ { concept, count, weight, units, score, exemplars } ],
  findings: [ ...every Stage 1 + Stage 2 finding... ],
  roster:   [ { id, agentType } ],
  dropped:  { stage1_units_over_budget, stage1_no_result, stage2_no_result, stage2_capped },
}
```

**The workflow returns the epics; it does not file them.** Filing stays with the invoking session
because it needs judgement the workflow cannot exercise:

1. **Dedupe first** — `backlog_list_items` with `grep` by symbol name, file path, and error string
   (never by title alone). A match means *enrich that item* with the new citations, not file a new one.
2. `backlog_create_item` per epic and per child, family `DEBT` unless the evidence shows live
   incorrect behaviour today (then `BUG`).
3. `backlog_link_related` each child to its epic.
4. `backlog_get_item` to verify every write actually landed — a success response is not proof.
5. End each item body with a `Citations:` block listing the `path:line` refs.

Never hand-edit `BACKLOG.md` / `CHANGELOG.md`; the graph is the source of truth.
