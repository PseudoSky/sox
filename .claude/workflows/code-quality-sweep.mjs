/**
 * code-quality-sweep — a reusable 3-stage, multi-agent code-quality sweep.
 *
 * WHAT IT DOES
 *   Stage 0 "Discover"   — (only when `args.packages` is omitted) seeds the roster from nx
 *                          project metadata, sizes each project, and packs oversized ones into
 *                          several evenly-sized review units so a 20k-line package is not handed
 *                          to a single agent that can only sample it.
 *   Stage 1 "Isolated"   — one cheap specialist agent per unit. Each agent is given an EXACT
 *                          file/dir list it may not read outside of and a required structured
 *                          schema. Findings without file:line + verbatim evidence are dropped.
 *   Stage 2 "Second lens"— every unit is re-read by a DIFFERENT specialist. Still blind.
 *
 * EVERY AGENT IS BLIND. No agent is ever told what to look for, what a previous pass found,
 * or what vocabulary to use. Concepts are an OUTPUT — coined independently by each agent and
 * clustered afterwards in post-processing. This is load-bearing, not stylistic:
 *   - Handing an agent a concept to hunt makes it file borderline cases under that concept,
 *     so the sweep "discovers" whatever it was sent to find and buries rare, severe defects.
 *   - It also destroys the independence that makes agreement meaningful. Two passes primed
 *     with the same tag vocabulary agreeing is one prior counted twice, not corroboration.
 * Coverage therefore comes from PERSPECTIVE DIVERSITY (a second, different specialist) rather
 * than from directed hunting, and cross-agent agreement at a file:line is reported to the
 * synthesiser as a genuine confidence signal.
 *   Stage 3 "Synthesize" — an architect agent turns the aggregated evidence into an EPIC SPEC:
 *                          coherent themes, each with 3-8 independently-shippable child items
 *                          carrying file:line citations, acceptance criteria, and a named
 *                          red->green test expectation.
 *
 * IT RETURNS THE EPICS — IT DOES NOT FILE THEM.
 *   Filing to the backlog graph deliberately stays with the INVOKING session: dedupe
 *   (backlog_list_items grep by symbol/path/error-string), backlog_create_item, backlog_link_related,
 *   and backlog_get_item verification all need the caller's judgement and repo context. The
 *   workflow returns `{ epics, findings, concepts, dropped }`; the caller files them.
 *
 * SAFETY
 *   Every worker is instructed READ-ONLY: no Edit/Write, and no build/test/lint/nx/tsc/vitest/pnpm
 *   command of any kind. Several nx build targets `rm -rf dist` and these sweeps commonly run
 *   against a live shared checkout.
 *
 * INVOKE
 *   Workflow({ name: 'code-quality-sweep', args: { packages: [...], agentBudgetPerStage: 20 } })
 *   See .claude/workflows/code-quality-sweep.md for the full argument reference.
 */

export const meta = {
  name: 'code-quality-sweep',
  description: 'Blind multi-agent code-quality sweep: nx-seeded scopes, two independent specialist passes, adversarial verification, then synthesis into a filed-by-caller epic spec',
  whenToUse: 'A broad quality/debt audit across many packages, where you want evidence-backed, adversarially-verified findings clustered into shippable epics rather than a flat list of nits',
  phases: [
    { title: 'Discover', detail: 'nx-seeded project roster, sized and split into even review units' },
    { title: 'Isolated', detail: 'one specialist per unit, blind, structured findings with file:line evidence' },
    { title: 'Second lens', detail: 'every unit re-read by a different specialist, still blind' },
    { title: 'Verify', detail: 'skeptics attempt to refute each critical/high finding; uncertain means refuted' },
    { title: 'Synthesize', detail: 'architect turns surviving evidence into an epic spec' },
  ],
}

// ---------------------------------------------------------------------------
// Arguments & defaults
// ---------------------------------------------------------------------------

// `args` SHOULD arrive as a real object, but some callers (and some harness
// paths) deliver it JSON-encoded. Parsing defensively costs nothing and turns a
// hard "args.packages is required" failure — which looks exactly like a caller
// forgetting the argument — into a working run.
const a = (typeof args === 'string' ? JSON.parse(args) : args) || {}
const BUDGET = a.agentBudgetPerStage || 20
const WORKER_MODEL = a.workerModel || 'haiku'
const SYNTH_MODEL = a.synthesisModel || undefined // undefined => inherit session model
const ROOT = a.root || '.'
const MAX_CONCEPTS = a.maxConcepts || 10
// Existing backlog items the synthesiser must reconcile against: [{id, title}, ...].
// Without this the sweep cannot tell a new defect class from one already filed, and a
// second run re-derives epics that already exist (measured 2026-08-12: 5 of 9 epics were
// duplicates of a prior sweep's, at ~3.7M tokens).
const PRIOR_ART = Array.isArray(a.priorArt) ? a.priorArt : []
const MIN_CONCEPT_COUNT = a.minConceptCount || 2

/**
 * A roster entry maps an agent specialty onto the kind of scope it should analyse.
 *   agentType       — a registered subagent type (code-reviewer, performance-engineer, ...)
 *   lensDescription — what THAT specialist should look for, written as an instruction
 *   packageSelector — substring/regex matched against a package path to claim it. '*' = fallback.
 * Entries are tried in order; the first whose selector matches claims the package.
 */
const DEFAULT_ROSTER = [
  { agentType: 'database-administrator', lensDescription: 'transaction correctness, connection/statement lifecycle, migration ordering and safety, index coverage, string-interpolated SQL, dialect divergence, close/cleanup leaks', packageSelector: 'store|db|sql|turso|sqlite|graph-store|blob' },
  { agentType: 'performance-engineer', lensDescription: 'algorithmic complexity in hot paths, N+1 IO, sequential awaits that should batch, unbounded in-memory accumulation, redundant passes, synchronous fs/crypto on hot paths', packageSelector: 'search|vector|embed|ingest|analysis|cluster|queue' },
  { agentType: 'security-auditor', lensDescription: 'command injection via exec/spawn with interpolated input, path traversal, TOCTOU on file writes, unvalidated env/manifest input, missing integrity/checksum verification, secrets in logs, unsafe file permissions', packageSelector: 'install|runtime|host|cli|apps/|service|proxy' },
  { agentType: 'error-detective', lensDescription: 'swallowed or untraced catches, unhandled rejections, lost work on failure, retry/backoff defects, shutdown and lifecycle races, state that can report success while the underlying operation failed', packageSelector: 'supervisor|reaper|task|worker|daemon|queue' },
  { agentType: 'typescript-pro', lensDescription: 'type-safety erosion: `any` leakage across module boundaries, unsafe assertions and casts, non-exhaustive unions, weak or absent runtime validation at IO boundaries, exactOptionalPropertyTypes violations', packageSelector: 'manifest|schema|types|authoring|registry|source-provider' },
  { agentType: 'qa-expert', lensDescription: 'test-suite defects: assertions guarded so the failing case is skipped, tests that pass vacuously, missing coverage for the risky branch, fixtures that hide the real failure mode', packageSelector: 'test|spec|e2e|fixtures' },
  { agentType: 'refactoring-specialist', lensDescription: 'god functions and god modules, duplicated blocks, poor cohesion, missing extraction seams — each cited with concrete line ranges and the cost it imposes', packageSelector: 'refactor' },
  { agentType: 'code-reviewer', lensDescription: 'general code quality: error handling, validation gaps, duplication, dead code, silent failure paths, missing coverage of risky branches', packageSelector: '*' },
]

// Caller-chosen review panel. `args.agents` is the ergonomic form — a list of agent-type
// names, e.g. agents: ['typescript-pro', 'performance-engineer', 'product-manager'] — whose
// lenses are looked up from DEFAULT_ROSTER when known. `args.roster` remains for fully
// custom {agentType, lensDescription, packageSelector} entries.
// This chooses WHO reviews, never WHAT they are told to find: a specialist's expertise is a
// perspective the agent already has, not a concept planted in its prompt.
const ROSTER = (() => {
  if (a.roster && a.roster.length) return a.roster
  const picked = Array.isArray(a.agents) && a.agents.length ? a.agents : null
  if (!picked) return DEFAULT_ROSTER
  const GENERIC = 'whatever defects your own specialty makes you best placed to catch — apply your expertise, do not go looking for any particular predetermined category'
  const out = picked.map((p) => {
    const type = typeof p === 'object' && p !== null ? p.agentType : String(p)
    const base = DEFAULT_ROSTER.find((r) => r.agentType === type)
    const custom = typeof p === 'object' && p !== null ? p : {}
    return {
      agentType: type,
      lensDescription: custom.lensDescription || (base && base.lensDescription) || GENERIC,
      packageSelector: custom.packageSelector || (base && base.packageSelector) || '*',
    }
  })
  // Guarantee a catch-all entry so matchRoster always resolves to something.
  if (!out.some((r) => (r.packageSelector || '*') === '*')) {
    out[out.length - 1] = { ...out[out.length - 1], packageSelector: '*' }
  }
  return out
})()

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const FINDING_PROPS = {
  file: { type: 'string', description: 'repo-relative path' },
  line: { type: 'integer', description: '1-indexed line number' },
  severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
  // DELIBERATELY NO EXAMPLE VOCABULARY. Naming candidate tags here primes the agent
  // to go looking for those categories and to file borderline findings under them,
  // which manufactures the very cluster the sweep then "discovers". Agents coin tags
  // blind; `canonicalTag()` merges the spelling variance afterwards, in post-processing,
  // where it cannot bias what was found.
  concept: { type: 'string', description: 'short kebab-case tag naming the PATTERN this finding is an instance of, not the instance itself' },
  summary: { type: 'string' },
  evidence: { type: 'string', description: 'verbatim snippet copied from the file, at most 3 lines' },
}

const ISOLATED_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['scope', 'findings'],
  properties: {
    scope: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['file', 'line', 'severity', 'concept', 'summary', 'evidence'],
        properties: FINDING_PROPS,
      },
    },
  },
}

// (A CONCEPT_SCHEMA once lived here, for agents dispatched to hunt a named concept with
// exemplars. That dispatch shape is deliberately gone — see the Stage 2 comment. Both passes
// now return ISOLATED_SCHEMA, because both are blind and structurally identical.)

const EPIC_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['epics'],
  properties: {
    epics: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'problem_statement', 'scope_packages', 'severity', 'children'],
        properties: {
          title: { type: 'string' },
          problem_statement: { type: 'string', description: 'crisp, grounded in the aggregated evidence, names the cost' },
          prior_art_relation: {
            type: 'string',
            description: 'NEW when no supplied prior-art item covers this theme; "CORROBORATES <id>" when an existing item covers the same defect class (the caller should append evidence to it, not file a duplicate); "EXTENDS <id>" when it covers part of this theme and this epic adds materially new scope. Never NEW just because the wording differs.',
          },
          scope_packages: { type: 'array', items: { type: 'string' } },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          family: { type: 'string', enum: ['DEBT', 'BUG'], description: 'BUG only when the evidence shows live incorrect behaviour' },
          children: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['title', 'body', 'citations', 'acceptance_criteria', 'test_expectation'],
              properties: {
                title: { type: 'string' },
                body: { type: 'string' },
                family: { type: 'string', enum: ['DEBT', 'BUG'] },
                severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
                citations: { type: 'array', items: { type: 'string', description: 'path:line' } },
                acceptance_criteria: { type: 'array', items: { type: 'string' } },
                test_expectation: { type: 'string', description: 'named test that must go red before the fix and green after' },
              },
            },
          },
        },
      },
    },
  },
}

// ---------------------------------------------------------------------------
// Scope construction
// ---------------------------------------------------------------------------

function matchRoster(pkgPath, i = 0) {
  for (const entry of ROSTER) {
    const sel = entry.packageSelector || '*'
    if (sel === '*') return entry
    let hit = false
    try {
      hit = new RegExp(sel, 'i').test(pkgPath)
    } catch (e) {
      hit = pkgPath.toLowerCase().includes(sel.toLowerCase())
    }
    if (hit) return entry
  }
  return ROSTER[ROSTER.length - 1]
}

// ---------------------------------------------------------------------------
// Stage 0 — project discovery (nx-seeded) and size-aware unit splitting
// ---------------------------------------------------------------------------

const DISCOVERY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['projects'],
  properties: {
    nxAvailable: { type: 'boolean' },
    projects: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'path', 'loc'],
        properties: {
          id: { type: 'string' },
          path: { type: 'string', description: 'repo-relative project root' },
          sourceRoot: { type: 'string' },
          loc: { type: 'integer', description: 'non-test source lines, from wc -l' },
          largestFiles: {
            type: 'array',
            description: 'up to 12 biggest non-test source files, largest first, for size-aware splitting',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['file', 'loc'],
              properties: { file: { type: 'string' }, loc: { type: 'integer' } },
            },
          },
        },
      },
    },
  },
}

/** Split one oversized project into <=N sub-units by packing its largest files. */
function splitBySize(proj, maxLoc) {
  const files = (proj.largestFiles || []).filter((f) => f && f.file)
  if (!files.length || proj.loc <= maxLoc) return [{ id: proj.id, files: [proj.path], loc: proj.loc }]
  const parts = []
  let cur = { files: [], loc: 0 }
  for (const f of files) {
    if (cur.files.length && cur.loc + f.loc > maxLoc) {
      parts.push(cur)
      cur = { files: [], loc: 0 }
    }
    cur.files.push(f.file)
    cur.loc += f.loc
  }
  if (cur.files.length) parts.push(cur)
  // Anything not in largestFiles stays with a final catch-all unit scoped to the project root.
  const covered = parts.reduce((n, p) => n + p.loc, 0)
  if (proj.loc - covered > maxLoc * 0.25) parts.push({ files: [proj.path], loc: proj.loc - covered, rest: true })
  return parts.map((p, i) => ({
    id: parts.length > 1 ? `${proj.id}#${i + 1}` : proj.id,
    files: p.files,
    loc: p.loc,
    ...(p.rest ? { hint: `Everything in this project NOT already covered by sibling units ${proj.id}#1..${parts.length - 1}. Do not re-report findings in those files.` } : {}),
  }))
}

let RAW_PACKAGES = a.packages && a.packages.length ? a.packages : []

if (!RAW_PACKAGES.length) {
  // Self-seed from nx rather than demanding the caller hand-build a roster. The workflow
  // script has no filesystem access of its own, so discovery runs in a cheap agent.
  phase('Discover')
  log('No args.packages supplied — seeding the roster from nx project metadata.')
  const disc = await agent(
    `Enumerate this repository's projects so a code-quality sweep can be scoped to them.

1. Run \`npx nx show projects --json\` (fall back to globbing \`**/project.json\`, excluding node_modules/dist/.worktrees, if nx is unavailable — set nxAvailable:false in that case).
2. For each project resolve its root directory and its source root.
3. Size each project: count lines of NON-TEST source only (exclude \`*.spec.*\`, \`*.test.*\`, \`__tests__\`, \`dist/\`, generated files). \`wc -l\` is fine.
4. For each project also list its up-to-12 LARGEST non-test source files with their line counts, largest first — a later step packs these into evenly-sized review units.

Rules: READ-ONLY. Use \`rg\`/\`ls\`/\`wc\`; never \`grep\`/\`find\`. NEVER run a build/test/lint target — \`nx show projects\` is metadata-only and safe, but \`nx build\`/\`nx test\` are destructive here. Return ONLY the structured output; report every project you find, do not pre-filter by importance.`,
    { schema: DISCOVERY_SCHEMA, model: WORKER_MODEL, label: 'discover:nx', phase: 'Discover' },
  )
  const projects = ((disc && disc.projects) || []).filter((p) => p && p.path && (p.loc || 0) > 0)
  projects.sort((x, y) => (y.loc || 0) - (x.loc || 0))
  log(`Discovered ${projects.length} projects${disc && disc.nxAvailable === false ? ' (nx unavailable — globbed project.json)' : ' via nx'}; largest: ${projects.slice(0, 3).map((p) => `${p.id}(${p.loc})`).join(', ')}`)
  RAW_PACKAGES = projects.flatMap((p) => splitBySize(p, MAX_UNIT_LOC))
  if (RAW_PACKAGES.length > BUDGET) {
    log(`NOTE: discovery produced ${RAW_PACKAGES.length} units for a budget of ${BUDGET}; keeping the ${BUDGET} largest by LOC and DROPPING: ${RAW_PACKAGES.slice(BUDGET).map((u) => u.id).join(', ')}`)
  }
} else {
  // Caller-supplied packages are still size-split when they carry LOC information.
  RAW_PACKAGES = RAW_PACKAGES.flatMap((p) =>
    typeof p === 'object' && p !== null && p.loc && p.loc > MAX_UNIT_LOC ? splitBySize(p, MAX_UNIT_LOC) : [p],
  )
}

const UNITS = RAW_PACKAGES.slice(0, BUDGET).map((p, i) => {
  const isObj = typeof p === 'object' && p !== null
  const path = isObj ? p.path || (p.files && p.files[0]) || `unit-${i}` : p
  const roster = matchRoster(isObj && p.agentType ? p.agentType : path, i)
  return {
    id: (isObj && p.id) || path,
    files: isObj && p.files && p.files.length ? p.files : [path],
    agentType: (isObj && p.agentType) || roster.agentType,
    lens: (isObj && p.lensDescription) || roster.lensDescription,
    hint: isObj ? p.hint : undefined,
    ...(isObj && p.loc ? { loc: p.loc } : {}),
  }
})

if (RAW_PACKAGES.length > BUDGET) {
  log(`NOTE: ${RAW_PACKAGES.length} packages supplied but agentBudgetPerStage=${BUDGET}; DROPPED from Stage 1: ${RAW_PACKAGES.slice(BUDGET).map((p) => (typeof p === 'object' ? p.id || p.path : p)).join(', ')}`)
}

const READONLY_RULES = `## Hard rules
- READ-ONLY. Never Edit or Write any file.
- NEVER run a build, test, lint, nx, tsc, vitest, pnpm, or npm command. Several build targets delete dist/ before rebuilding and this may be a live shared checkout — a "just to see the error" build is destructive.
- Bash is permitted ONLY for read-only inspection. Use \`rg\` for text search and \`wc -l\`/\`ls\` for sizing. **NEVER \`grep\` or \`find\`** — \`rg\` respects ignore files and is the repo standard.
- To understand code structure — what calls a symbol, what a change would affect, where a flow goes — prefer the **gitnexus** CLI over text search: \`gx query "<concept>"\`, \`gx context <symbol>\`, \`gx impact <target>\`. It is a local pre-built index and answers symbol/flow questions directly. Fall back to \`rg\` only when gitnexus returns nothing useful. (If \`gx\` is unavailable in your environment, say so in your return rather than silently reverting to text search for structural questions.)
- Read the files in your scope properly — use offset/limit chunking on large files rather than skimming the first screen.
- Every finding MUST carry a real file path, a real 1-indexed line number, and a VERBATIM evidence snippet (at most 3 lines) copied out of the file. If you cannot produce verbatim evidence, DROP the finding.
- No speculation, no "consider adding", no formatting or style nits. Only defects with a concrete cost.
- \`concept\`: name the PATTERN this finding instantiates, in short kebab-case, as YOU would describe it. Do not try to match a house vocabulary and do not reach for a familiar-sounding label if it does not fit — a precise tag you invented is better than a common one that approximates. Tag spellings are reconciled after the fact.
- Return ONLY the structured output.`

// ---------------------------------------------------------------------------
// Stage 1 — Isolated
// ---------------------------------------------------------------------------

phase('Isolated')

function isolatedPrompt(u) {
  return `You are performing a READ-ONLY code-quality analysis of ONE isolated scope in the repository at ${ROOT}.

## Your scope (do NOT read files outside this list)
${u.files.map((f) => `- ${ROOT}/${f}`).join('\n')}
${u.hint ? `\nNote: ${u.hint}` : ''}

## Your lens (analyse what YOUR specialty covers, not everything)
${u.lens}

${READONLY_RULES}

Aim for 5-15 high-signal findings. Quality over volume. Set \`scope\` to "${u.id}".`
}

const stage1 = await parallel(
  UNITS.map((u) => () =>
    agent(isolatedPrompt(u), {
      agentType: u.agentType,
      model: WORKER_MODEL,
      label: `${u.id}:${u.agentType}`,
      phase: 'Isolated',
      schema: ISOLATED_SCHEMA,
    }).then((r) => ({ unit: u.id, agentType: u.agentType, files: u.files, findings: (r && r.findings) || [] }))
  )
)

const s1ok = stage1.filter(Boolean).filter((r) => r.findings)
const s1dropped = UNITS.map((u) => u.id).filter((id) => !s1ok.some((r) => r.unit === id))
const s1findings = s1ok.flatMap((r) => r.findings.map((f) => ({ ...f, unit: r.unit, stage: 1 })))
log(`Stage 1: ${s1ok.length}/${UNITS.length} units returned, ${s1findings.length} findings.${s1dropped.length ? ` DROPPED (no result): ${s1dropped.join(', ')}` : ''}`)

// ---------------------------------------------------------------------------
// Stage 2 — cross-package concept sweeps
// ---------------------------------------------------------------------------

const SEV_WEIGHT = { critical: 8, high: 4, medium: 2, low: 1 }

/**
 * Agents coin near-identical tags for one pattern, and keying on the raw string splits the
 * cluster so BOTH halves rank lower than the real thing. Measured 2026-08-12: the same defect
 * arrived as `path-traversal-via-manifest` (13) and `path-traversal-manifest-entrypoint` (2)
 * and was ranked as two concepts of 13 and 2 rather than one of 15.
 *
 * Canonicalise by token set: a tag whose tokens are a subset of an earlier tag's — or which
 * overlaps it by Jaccard >= 0.5 — folds into that earlier tag. Order-independent within a run
 * because candidates are considered most-frequent-first.
 */
function canonicalTag(raw, canon) {
  const norm = (raw || 'unclassified').trim().toLowerCase().replace(/_/g, '-')
  const toks = new Set(norm.split('-').filter((t) => t && !['a', 'the', 'in', 'on', 'of', 'via', 'to'].includes(t)))
  for (const [existing, exTokens] of canon) {
    const inter = [...toks].filter((t) => exTokens.has(t)).length
    if (inter === 0) continue
    const union = new Set([...toks, ...exTokens]).size
    const subset = inter === toks.size || inter === exTokens.size
    if (subset || inter / union >= 0.5) return existing
  }
  canon.set(norm, toks)
  return norm
}

function rankConcepts(findings) {
  const byConcept = new Map()
  // Seed canonical tags most-frequent-first so the dominant spelling wins the merge.
  const freq = new Map()
  for (const f of findings) {
    const n = (f.concept || 'unclassified').trim().toLowerCase().replace(/_/g, '-')
    freq.set(n, (freq.get(n) || 0) + 1)
  }
  const canon = new Map()
  for (const [n] of [...freq.entries()].sort((x, y) => y[1] - x[1])) canonicalTag(n, canon)

  for (const f of findings) {
    const k = canonicalTag(f.concept, canon)
    if (!byConcept.has(k)) byConcept.set(k, { concept: k, count: 0, weight: 0, units: new Set(), exemplars: [] })
    const c = byConcept.get(k)
    c.count += 1
    c.weight += SEV_WEIGHT[f.severity] || 1
    c.units.add(f.unit)
    if (c.exemplars.length < 3) c.exemplars.push(f)
  }
  return [...byConcept.values()]
    .map((c) => ({ ...c, units: [...c.units], score: c.count * (c.weight / c.count) }))
    .sort((x, y) => y.score - x.score)
}

// ---------------------------------------------------------------------------
// Stage 2 — SECOND BLIND PASS under a different specialist lens
//
// This stage deliberately does NOT tell any agent what to look for. An earlier design
// ranked Stage 1's concept tags and dispatched agents to hunt the top ones across the
// remaining packages. That is invalid on two counts and both were observed live:
//   1. It manufactures its own result. An agent told "hunt error-swallowing here" files
//      borderline cases under that tag, so the sweep then "discovers" that the concepts it
//      went looking for are the most prevalent — circular, and it crowds out rare-but-severe
//      defects that no one was sent to find.
//   2. It destroys independence. Two sweeps primed with the same tag vocabulary converging
//      on the same clusters is not corroboration; it is the same prior, twice.
// Coverage now comes from PERSPECTIVE DIVERSITY instead: each unit is re-read by a
// different specialist than saw it first. The lens is the agent's own expertise, never a
// planted concept, and the agent is told nothing about what the first pass found.
// ---------------------------------------------------------------------------

phase('Second lens')

/** Pick a lens for `unit` that differs from the one that already reviewed it. */
function alternateLens(unit, i) {
  const pool = ROSTER.filter((r) => r.agentType !== unit.agentType)
  if (!pool.length) return null
  return pool[i % pool.length]
}

const secondPass = UNITS.map((u, i) => ({ unit: u, lens: alternateLens(u, i) }))
  .filter((x) => x.lens)
  .slice(0, BUDGET)

if (UNITS.length > secondPass.length) {
  log(`NOTE: second-lens pass capped at budget ${BUDGET}; NOT re-reviewed: ${UNITS.slice(secondPass.length).map((u) => u.id).join(', ')}`)
}
log(`Stage 2: ${secondPass.length} units re-read under a different lens (blind — no concepts supplied).`)

const stage2 = secondPass.length
  ? await parallel(
      secondPass.map((x) => () =>
        agent(isolatedPrompt({ ...x.unit, agentType: x.lens.agentType, lens: x.lens.lensDescription }), {
          agentType: x.lens.agentType,
          model: WORKER_MODEL,
          label: `${x.unit.id}:${x.lens.agentType}`,
          phase: 'Second lens',
          schema: ISOLATED_SCHEMA,
        }).then((r) => ({ unit: x.unit.id, agentType: x.lens.agentType, findings: (r && r.findings) || [] })),
      ),
    )
  : []

const s2ok = stage2.filter(Boolean)
const s2dropped = secondPass.length - s2ok.length
const s2findings = s2ok.flatMap((r) => r.findings.map((f) => ({ ...f, unit: r.unit, agentType: r.agentType, stage: 2 })))
log(`Stage 2: ${s2ok.length}/${secondPass.length} re-reads returned, ${s2findings.length} findings.${s2dropped ? ` DROPPED (no result): ${s2dropped}.` : ''}`)

// Both stages are blind, so their findings are directly comparable and rank together.
const rawFindings = [...s1findings, ...s2findings]

// ---------------------------------------------------------------------------
// Stage 2.5 — ADVERSARIAL VERIFY
//
// Discovery must be blind; verification must NOT be. A verifier is told the claim precisely
// because its job is to destroy it. This exists because agreement between finders is not
// proof: in an earlier run TWO independent agents both reported a `__PLACEHOLDER__` token as
// a critical SQL syntax error when it was a documented caller-substituted seam — a human
// caught it. Agents share blind spots, so consensus among finders can be confidently wrong.
//
// Each verifier is told to REFUTE and to default to refuted when uncertain, which is the
// asymmetry that makes this useful: a finding survives only by being defensible, not by
// being unchallenged. Refuted findings are REPORTED, never silently dropped.
// ---------------------------------------------------------------------------

const VERIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdicts'],
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['ref', 'refuted', 'reason'],
        properties: {
          ref: { type: 'string', description: 'the exact ref string given to you, e.g. "file.ts:123#2"' },
          refuted: { type: 'boolean', description: 'true if the finding does NOT hold as stated — including when you cannot confirm it' },
          reason: { type: 'string', description: 'one sentence, citing what you actually read' },
          severity_overstated: { type: 'boolean', description: 'true if real but less severe than claimed' },
        },
      },
    },
  },
}

const VERIFY_SEVERITIES = a.verifySeverities || ['critical', 'high']
const VERIFY_BATCH = a.verifyBatchSize || 6
const refOf = (f, i) => `${f.file}:${f.line}#${i}`

const toVerify = rawFindings
  .map((f, i) => ({ ...f, ref: refOf(f, i) }))
  .filter((f) => VERIFY_SEVERITIES.includes(f.severity))

let verdictByRef = new Map()
if (toVerify.length && a.skipVerify !== true) {
  phase('Verify')
  const batches = []
  for (let i = 0; i < toVerify.length; i += VERIFY_BATCH) batches.push(toVerify.slice(i, i + VERIFY_BATCH))
  const capped = batches.slice(0, BUDGET)
  if (batches.length > capped.length) {
    log(`NOTE: verification capped at budget ${BUDGET}; ${(batches.length - capped.length) * VERIFY_BATCH} findings go to synthesis UNVERIFIED.`)
  }
  log(`Stage 2.5: adversarially verifying ${capped.reduce((n, b) => n + b.length, 0)} ${VERIFY_SEVERITIES.join('/')} findings in ${capped.length} batches.`)

  const verifyResults = await parallel(
    capped.map((batch, bi) => () =>
      agent(
        `You are a SKEPTIC. Other agents reviewed this repository at ${ROOT} and produced the claims below. Your job is to REFUTE them, not to confirm them.

## Claims to attack
${batch.map((f) => `### ref: ${f.ref}\n- file: ${ROOT}/${f.file}, line ${f.line}\n- claimed severity: ${f.severity}\n- claim: ${f.summary}\n- evidence they quoted:\n\`\`\`\n${(f.evidence || '').split('\n').slice(0, 3).join('\n')}\n\`\`\``).join('\n\n')}

## How to attack each claim
1. OPEN the real file and read the cited line IN CONTEXT — enough surrounding lines to understand it. The quoted evidence may be accurate but misleading out of context.
2. Ask specifically: is this actually reachable? Is there a guard, an early return, a caller contract, a type constraint, or a documented convention upstream that makes the claimed failure impossible? Is the cited construct a deliberate, documented seam rather than a defect? Does a test already cover it?
3. Use \`gx context <symbol>\` / \`gx impact <target>\` to check callers before asserting something is unreachable or unguarded — a claim about how a symbol is used cannot be settled from its definition alone.

## Verdict rules — read carefully
- \`refuted: true\` if the claim does not hold as stated, OR if after genuinely looking you CANNOT CONFIRM it. Uncertainty means refuted. Do not give a claim the benefit of the doubt.
- \`refuted: false\` ONLY when you have read the code and the defect is real as described.
- \`severity_overstated: true\` when the defect is real but cannot cost what the claim implies.
- Judge each claim independently. Several may be about the same file; that is not evidence for or against any of them.

${READONLY_RULES}

Return a verdict for EVERY ref given to you, using the exact ref strings above.`,
        {
          agentType: 'code-reviewer',
          model: WORKER_MODEL,
          label: `verify:b${bi}`,
          phase: 'Verify',
          schema: VERIFY_SCHEMA,
        },
      ).then((r) => (r && r.verdicts) || []),
    ),
  )
  for (const v of verifyResults.filter(Boolean).flat()) verdictByRef.set(v.ref, v)
}

const withVerdicts = rawFindings.map((f, i) => {
  const ref = refOf(f, i)
  const v = verdictByRef.get(ref)
  return { ...f, ref, verified: v ? !v.refuted : null, verifyReason: v ? v.reason : null, severityOverstated: v ? !!v.severity_overstated : false }
})

const refuted = withVerdicts.filter((f) => f.verified === false)
const allFindings = withVerdicts.filter((f) => f.verified !== false)
if (refuted.length) {
  log(`Stage 2.5: ${refuted.length} finding(s) REFUTED and excluded from synthesis (reported in result.refuted, not discarded).`)
}

// ---------------------------------------------------------------------------
// Stage 3 — synthesis into an epic spec
// ---------------------------------------------------------------------------

phase('Synthesize')

// Both passes were blind, so their findings are comparable and rank together. Concepts are
// discovered here, in post-processing, from tags the agents coined independently — they are
// an OUTPUT of the sweep, never an input to it.
const finalRanked = rankConcepts(allFindings)

// Agreement is meaningful precisely BECAUSE neither pass was primed: when two different
// specialists, each blind to the other, flag the same file:line, that is independent
// convergence rather than a shared prior. Surfaced to the synthesiser as a confidence signal.
const agreement = new Map()
for (const f of allFindings) {
  const k = `${f.file}:${f.line}`
  if (!agreement.has(k)) agreement.set(k, new Set())
  agreement.get(k).add(f.agentType || `stage${f.stage}`)
}
const convergent = [...agreement.entries()].filter(([, v]) => v.size > 1).map(([k]) => k)

/**
 * CRITICAL SINGLETONS ARE NEVER TRUNCATED.
 *
 * A severity sort plus a hard cap silently loses the tail, and the tail is where the rare,
 * severe, single-site defects live — exactly the ones no frequency-based process surfaces.
 * Observed 2026-08-12: blob-store ordering every mutation backwards (guaranteed data loss)
 * came from ONE scope and would never have ranked on commonality.
 *
 * So: every `critical` finding and every independently-convergent site is emitted in full,
 * REGARDLESS of cap. The cap then applies only to what remains, and any real truncation is
 * stated in the prompt rather than being invisible.
 */
function digest(findings, cap) {
  const order = { critical: 0, high: 1, medium: 2, low: 3 }
  const convergentSet = new Set(convergent)
  const isProtected = (f) => f.severity === 'critical' || convergentSet.has(`${f.file}:${f.line}`)
  const line = (f) =>
    `- [${f.severity}${f.severityOverstated ? ' (severity disputed)' : ''}]${f.verified ? ' [verified]' : ''} (${f.concept}) ${f.file}:${f.line} — ${f.summary}`

  const protectedOnes = findings.filter(isProtected)
  const rest = findings
    .filter((f) => !isProtected(f))
    .sort((x, y) => (order[x.severity] ?? 9) - (order[y.severity] ?? 9))
  const room = Math.max(0, cap - protectedOnes.length)
  const shown = rest.slice(0, room)
  const omitted = rest.length - shown.length

  return (
    [...protectedOnes, ...shown].map(line).join('\n') +
    (omitted > 0
      ? `\n\n(${omitted} further finding(s) of severity medium/low omitted for length. Every critical and every independently-convergent site above is shown in full — nothing severe was truncated.)`
      : '')
  )
}

const epicSpec = await agent(
  `You are the architect synthesising a multi-agent code-quality sweep of the repository at ${ROOT} into a set of EPICS that will be filed as backlog items.

## Concept ranking (concept, occurrences, scopes, severity-weighted score)
Every agent in this sweep worked BLIND — none was told what to look for or what anyone else
found. These tags were coined independently and clustered afterwards, so the ranking reflects
what is actually in the code, not what anyone was sent to look for. Do not treat a low count
as unimportant: a single CRITICAL finding in one scope can outrank a common shallow pattern.
${finalRanked.map((c) => `- ${c.concept}: ${c.count} occurrences across ${c.units.length} scopes, score ${Math.round(c.score)}`).join('\n')}

## Independently convergent sites (${convergent.length})
Flagged by MORE THAN ONE blind specialist at the same file:line. Because no agent saw another's
output, agreement here is genuine independent convergence — weight these highest.
${convergent.slice(0, 40).map((k) => `- ${k}`).join('\n') || '(none)'}

## Findings (${allFindings.length} total, highest severity first)
${digest(allFindings, 220)}
${PRIOR_ART.length === 0 ? `
## Prior art
NONE SUPPLIED. The caller did not pass \`args.priorArt\`, so you cannot tell which of these themes
are already filed. Set \`prior_art_relation\` to "UNKNOWN — no prior art supplied" on every epic so
the caller knows to dedupe before filing.` : `
## Prior art — items ALREADY FILED in this repo's backlog
${PRIOR_ART.map((p) => `- ${p.id}: ${p.title}`).join('\n')}

For EVERY epic you produce, set \`prior_art_relation\`:
- "CORROBORATES <id>" if an item above already covers this defect class. Independent re-derivation is
  valuable EVIDENCE, so still produce the epic — but say what it confirms and, critically, what it
  found that the existing item does NOT name. The caller will append to that item instead of filing a duplicate.
- "EXTENDS <id>" if an item covers part of this theme and you are adding materially new scope.
- "NEW" only when no item above covers it. Differing wording is NOT grounds for NEW; the same defect
  described differently is CORROBORATES.`}

## What to produce
A set of EPICS. Each epic is ONE coherent quality theme — not a package, not a grab-bag. For each:
- \`problem_statement\`: crisp, grounded in the evidence above, naming the concrete cost (what breaks, what it slows, what it hides). No hedging, no "consider".
- \`scope_packages\`: the scopes actually touched.
- \`family\`: 'BUG' ONLY where the evidence shows live incorrect behaviour today; otherwise 'DEBT'.
- \`children\`: 3-8 items, each INDEPENDENTLY SHIPPABLE. Every child needs
  * \`citations\`: concrete path:line refs drawn from the findings above — never invent one;
  * \`acceptance_criteria\`: binary, checkable statements;
  * \`test_expectation\`: a NAMED test that must be seen to FAIL before the fix and PASS after. Not "add tests" — name it.

Rules: prefer fewer, sharper epics over many thin ones. Do not create an epic for a single low-severity finding. Do not restate the findings list — architect it. Return ONLY the structured output.`,
  {
    label: 'synthesize-epics',
    phase: 'Synthesize',
    ...(SYNTH_MODEL ? { model: SYNTH_MODEL } : {}),
    effort: 'high',
    schema: EPIC_SCHEMA,
  }
)

const epics = (epicSpec && epicSpec.epics) || []
log(`Stage 3: ${epics.length} epics, ${epics.reduce((n, e) => n + (e.children || []).length, 0)} child items.`)

return {
  epics,
  concepts: finalRanked,
  findings: allFindings,
  // Refuted findings are RETURNED, not discarded: a skeptic can be wrong, and the caller
  // deserves to see what was thrown out and on what grounds.
  refuted: refuted.map((f) => ({ file: f.file, line: f.line, severity: f.severity, summary: f.summary, reason: f.verifyReason })),
  convergentSites: convergent,
  verification: {
    severitiesVerified: VERIFY_SEVERITIES,
    attempted: toVerify.length,
    adjudicated: verdictByRef.size,
    unverified: Math.max(0, toVerify.length - verdictByRef.size),
    refuted: refuted.length,
    skipped: a.skipVerify === true,
  },
  roster: UNITS.map((u) => ({ id: u.id, agentType: u.agentType, ...(u.loc ? { loc: u.loc } : {}) })),
  dropped: {
    stage1_units_over_budget: RAW_PACKAGES.length > BUDGET ? RAW_PACKAGES.slice(BUDGET).map((p) => (typeof p === 'object' ? p.id || p.path : p)) : [],
    stage1_no_result: s1dropped,
    stage2_no_result: s2dropped,
    stage2_units_not_rereviewed: UNITS.length > secondPass.length ? UNITS.slice(secondPass.length).map((u) => u.id) : [],
  },
  note: 'Epics are RETURNED, not filed. The invoking session must dedupe against the backlog graph (see prior_art_relation on each epic) and file them with backlog_create_item / backlog_link_related / backlog_get_item.',
}
