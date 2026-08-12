# `code-quality-sweep` — reusable multi-agent quality audit

A blind fan-out that turns a repo into an evidence-backed, adversarially-verified **epic spec**.

| Stage | Phase title | What runs | Output |
|---|---|---|---|
| 0 | `Discover` | *(only when `packages` is omitted)* nx project metadata → sized, evenly-split review units | unit roster |
| 1 | `Isolated` | one specialist per unit, locked to an exact file list, **told nothing about what to look for** | findings with `file:line` + verbatim evidence |
| 2 | `Second lens` | every unit re-read by a **different** specialist, still blind | same schema |
| 2.5 | `Verify` | skeptics attempt to **refute** each critical/high finding | verdicts; refuted findings excluded but reported |
| 3 | `Synthesize` | one architect over the surviving aggregate | `epics[]` with children, citations, acceptance criteria, named tests |

## The rule that shapes everything: agents are blind

**No agent is ever told what to look for, what a previous pass found, or what vocabulary to use.**
Concepts are an *output* — coined independently by each agent, clustered afterwards in
post-processing. This is load-bearing, not stylistic. Two failures were observed live before the
rule existed:

- **Directed hunting manufactures its own result.** An agent told "hunt `error-swallowing` here"
  files borderline cases under that tag, so the sweep "discovers" that whatever it was sent to find
  is the most prevalent thing in the codebase — while rare, severe, single-site defects go unlooked-for.
- **Priming destroys independence.** Two sweeps that share a suggested tag vocabulary converging on
  the same clusters is one prior counted twice, not corroboration. A 2026-08-12 run produced five
  epics that duplicated an earlier sweep's, and the "independent agreement" was largely an artifact
  of both runs reading the same prompt.

Coverage therefore comes from **perspective diversity** (a second, different specialist) rather than
from directed hunting. Because nobody was primed, cross-agent agreement at a `file:line` becomes a
real confidence signal, and it is reported to the synthesizer as `convergentSites`.

Choosing *who* reviews is not priming. A specialist's expertise is a perspective they already have;
a concept in their prompt is an instruction about what to conclude.

## Invocation

```js
// Self-seeding: discovers projects from nx, sizes them, splits the big ones
Workflow({ scriptPath: '.claude/workflows/code-quality-sweep.mjs',
           args: { agentBudgetPerStage: 20 } })

// Explicit scopes + a chosen review panel
Workflow({ scriptPath: '.claude/workflows/code-quality-sweep.mjs', args: {
  packages: ['libs/memory-core', 'libs/data/store/store-adapter', 'apps/sox'],
  agents: ['typescript-pro', 'performance-engineer', 'product-manager'],
  priorArt: [{ id: 'DEBT-011', title: 'EPIC: per-item IO inside loops …' }],
}})
```

> **Pass `args` as a real object, not a JSON string.** The script parses a stringified `args`
> defensively, because that failure surfaces as "`packages` is required" and reads exactly like a
> caller omitting it.

## Arguments

| Arg | Default | Meaning |
|---|---|---|
| `packages` | *(auto-discovered)* | Paths or unit objects. Omit to seed from nx |
| `filter` | — | Narrow the discovered projects before fan-out — see Scoping |
| `agents` | built-in roster | **Agent-type names** for the review panel, e.g. `['typescript-pro','performance-engineer']`. Unknown names get a generic lens |
| `roster` | built-in | Full `[{agentType, lensDescription, packageSelector}]` control; takes precedence over `agents` |
| `priorArt` | `[]` | `[{id, title}]` of already-filed items. Each epic comes back tagged `NEW` / `CORROBORATES <id>` / `EXTENDS <id>` |
| `agentBudgetPerStage` | `20` | Hard cap per stage. Overflow is **logged and returned, never silently dropped** |
| `workerModel` | `'haiku'` | Model for every worker |
| `synthesisModel` | *(inherit)* | Model for the Stage 3 architect |
| `maxUnitLoc` | see script | Split threshold — a project above this is packed into several units |
| `verifySeverities` | `['critical','high']` | Which findings face a skeptic |
| `verifyBatchSize` | `6` | Findings per verifier agent |
| `skipVerify` | `false` | Disable Stage 2.5 |
| `root` | `'.'` | Repo root prefixed onto scope paths |

## Scoping the sweep: `filter`

A human says *"sweep the apigen projects"* or *"sweep agent-mcp and everything it depends on"*.
The invoking agent translates that into a `filter`; the workflow resolves it **deterministically**,
so "all its in-repo deps" is the real nx dependency closure rather than an agent's guess.

```js
filter: {
  projects:       ['agent-mcp'],   // exact nx project names to seed from
  include:        ['apigen'],      // regex/substring over project name OR path
  exclude:        ['-e2e$'],       // applied last, always wins
  tags:           ['area:data'],   // nx tags, any-match
  withDeps:       true,            // add the seeds' transitive in-repo dependencies
  withDependents: false,           // add everything that transitively depends on the seeds
  depDepth:       Infinity,        // cap the walk; 1 = direct edges only
}
```

`projects` + `include` + `tags` union into a **seed set** (no criteria at all = every project);
`withDeps`/`withDependents` expand it across the graph; `exclude` prunes last.

| The request | The filter |
|---|---|
| "projects inside apigen" | `{ include: ['apigen'] }` |
| "agent-mcp and all its in-repo deps" | `{ projects: ['agent-mcp'], withDeps: true }` |
| "just x, y and z" | `{ projects: ['x','y','z'] }` |
| "everything that would break if I change apigen-core" | `{ projects: ['apigen-core'], withDependents: true }` |
| "the data libs, but not e2e" | `{ tags: ['area:data'], exclude: ['-e2e$'] }` |

Failure modes are loud, not silent: a name in `projects` that nx never reported logs a WARNING
naming it, and a filter matching **nothing** throws with the seed criteria and the discovered
project names, rather than quietly sweeping zero projects.

## Size-aware units

A 19.5k-line package handed to one cheap agent produces a skim, not a review. Discovery sizes every
project and packs its largest files into units under `maxUnitLoc`, plus a catch-all unit for the
remainder that is explicitly told not to re-report its siblings' files. Caller-supplied packages are
split the same way when they carry a `loc`.

## The roster convention

```js
{
  agentType: 'security-auditor',
  lensDescription: 'command injection via exec/spawn, path traversal, TOCTOU on file writes, …',
  packageSelector: 'install|runtime|host|cli|apps/',   // regex, case-insensitive; '*' = fallback
}
```

Entries are tried **in order**; the first whose `packageSelector` matches claims the unit, so put
specific selectors first and keep a `'*'` fallback last. A `lensDescription` describes the
specialist's *standing expertise* — it must never name a specific defect to go find in this repo.

Stage 2 automatically assigns each unit a lens **different** from the one that reviewed it first.

## Adversarial verification

Discovery is blind; verification deliberately is not — a skeptic must know the claim to attack it.
Verifiers are told to **default to refuted when uncertain**, so a finding survives by being
defensible rather than merely unchallenged.

This exists because finder agreement is not proof: in one run, *two* independent agents both
reported a `__PLACEHOLDER__` token as a critical SQL syntax error when it was a documented
caller-substituted seam. Agents share blind spots, so consensus among finders can be confidently
wrong. Refuted findings are returned in `refuted[]` with reasons — a skeptic can also be wrong, and
you should be able to see what was thrown out.

## Budgets and truncation

- Overflow anywhere is named in a `log()` line **and** in the returned `dropped` block. There is no
  silent truncation in this workflow; that is the point of that block.
- Concurrency is capped at `min(16, cores-2)` regardless of budget — a budget of 20 queues rather
  than overloading the machine.
- **Every `critical` finding and every convergent site reaches the synthesizer in full**, whatever
  the digest cap. Severity-sort-plus-cap loses the tail, and the tail is where rare severe defects
  live — one such (a blob store ordering every mutation backwards) came from a single scope and
  would never have ranked on commonality.

## Safety

Every worker prompt carries a read-only contract: no `Edit`/`Write`, and **no build, test, lint,
nx, tsc, vitest, pnpm, or npm command**. Several nx build targets `rm -rf dist` before rebuilding,
so a diagnostic build in a shared checkout destroys a live artifact. Bash is permitted for
read-only inspection: `rg` (never `grep`/`find`), `wc -l`, `ls`. For structural questions — callers,
impact, flow — agents are told to prefer the **gitnexus** CLI (`gx query`/`gx context`/`gx impact`)
over text search.

## What comes back — and what you still have to do

```js
{
  epics: [ { title, problem_statement, prior_art_relation, scope_packages, severity, family, children } ],
  concepts: [ { concept, count, weight, units, score, exemplars } ],
  findings: [ ...surviving findings, each with verified / verifyReason... ],
  refuted:  [ { file, line, severity, summary, reason } ],
  convergentSites: [ 'file.ts:123', ... ],
  verification: { severitiesVerified, attempted, adjudicated, unverified, refuted, skipped },
  roster:   [ { id, agentType, loc } ],
  dropped:  { stage1_units_over_budget, stage1_no_result, stage2_no_result, stage2_units_not_rereviewed },
}
```

**The workflow returns the epics; it does not file them.** Filing needs judgement the workflow
cannot exercise:

1. **Dedupe first** — pass `priorArt` so each epic arrives pre-classified, then confirm with
   `backlog_list_items` `grep` by symbol, file path, and error string (never by title alone). A
   match means *enrich that item* with the new citations, not file a duplicate.
2. `backlog_create_item` per epic and child; family `DEBT` unless the evidence shows live incorrect
   behaviour today (then `BUG`).
3. `backlog_link_related` each child to its epic.
4. `backlog_get_item` to verify every write landed — a success response is not proof.
5. End each body with a `Citations:` block of `path:line` refs.

Never hand-edit `BACKLOG.md` / `CHANGELOG.md`; the graph is the source of truth.
