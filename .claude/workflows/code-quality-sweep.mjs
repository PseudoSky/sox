/**
 * code-quality-sweep — a reusable 3-stage, multi-agent code-quality sweep.
 *
 * WHAT IT DOES
 *   Stage 1 "Isolated"   — one cheap specialist agent per package scope. Each agent is given an
 *                          EXACT file/dir list it may not read outside of, a lens matched to the
 *                          agent type, and a required structured schema. Findings without
 *                          file:line + verbatim evidence are dropped by instruction.
 *   Stage 2 "Concepts"   — the script clusters Stage 1's `concept` tags, ranks them by
 *                          (frequency x severity weight), and fans specialists back out to sweep
 *                          the OTHER packages for each top concept. Each agent gets one concept
 *                          plus a disjoint package subset, so scopes never overlap.
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
  description: 'Three-stage multi-agent code-quality sweep: isolated per-package analysis, cross-package concept sweeps, then synthesis into a filed-by-caller epic spec',
  whenToUse: 'A broad quality/debt audit across many packages, where you want evidence-backed findings clustered into shippable epics rather than a flat list of nits',
  phases: [
    { title: 'Isolated', detail: 'one specialist per package scope, structured findings with file:line evidence' },
    { title: 'Concepts', detail: 'cross-package sweeps for the top-ranked recurring concepts' },
    { title: 'Synthesize', detail: 'architect turns aggregated evidence into an epic spec' },
  ],
}

// ---------------------------------------------------------------------------
// Arguments & defaults
// ---------------------------------------------------------------------------

const a = args || {}
const BUDGET = a.agentBudgetPerStage || 20
const WORKER_MODEL = a.workerModel || 'haiku'
const SYNTH_MODEL = a.synthesisModel || undefined // undefined => inherit session model
const ROOT = a.root || '.'
const MAX_CONCEPTS = a.maxConcepts || 10
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

const ROSTER = a.roster && a.roster.length ? a.roster : DEFAULT_ROSTER

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const FINDING_PROPS = {
  file: { type: 'string', description: 'repo-relative path' },
  line: { type: 'integer', description: '1-indexed line number' },
  severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
  concept: { type: 'string', description: 'short reusable kebab-case tag naming the PATTERN, e.g. error-swallowing, n-plus-one-io, sync-fs-in-hot-path, type-assertion-abuse, missing-test-coverage' },
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

const CONCEPT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['concept', 'findings'],
  properties: {
    concept: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['file', 'line', 'severity', 'concept', 'summary', 'evidence', 'matches_stage1_pattern'],
        properties: {
          ...FINDING_PROPS,
          matches_stage1_pattern: { type: 'boolean', description: 'true if this is the same underlying defect shape as the exemplars supplied, false if it is a related but distinct variant' },
        },
      },
    },
  },
}

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

function matchRoster(pkgPath) {
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

// `packages` may be plain paths, or objects giving an explicit file list / agentType / lens.
const RAW_PACKAGES = a.packages && a.packages.length ? a.packages : []
if (!RAW_PACKAGES.length) {
  throw new Error('code-quality-sweep: args.packages is required — pass the package paths (or {id, path, files, agentType, lensDescription} objects) discovered by the calling session.')
}

const UNITS = RAW_PACKAGES.slice(0, BUDGET).map((p, i) => {
  const isObj = typeof p === 'object' && p !== null
  const path = isObj ? p.path || (p.files && p.files[0]) || `unit-${i}` : p
  const roster = matchRoster(isObj && p.agentType ? p.agentType : path)
  return {
    id: (isObj && p.id) || path,
    files: isObj && p.files && p.files.length ? p.files : [path],
    agentType: (isObj && p.agentType) || roster.agentType,
    lens: (isObj && p.lensDescription) || roster.lensDescription,
    hint: isObj ? p.hint : undefined,
  }
})

if (RAW_PACKAGES.length > BUDGET) {
  log(`NOTE: ${RAW_PACKAGES.length} packages supplied but agentBudgetPerStage=${BUDGET}; DROPPED from Stage 1: ${RAW_PACKAGES.slice(BUDGET).map((p) => (typeof p === 'object' ? p.id || p.path : p)).join(', ')}`)
}

const READONLY_RULES = `## Hard rules
- READ-ONLY. Never Edit or Write any file.
- NEVER run a build, test, lint, nx, tsc, vitest, pnpm, or npm command. Several build targets delete dist/ before rebuilding and this may be a live shared checkout — a "just to see the error" build is destructive.
- Bash is permitted ONLY for read-only inspection: \`rg\`, \`wc -l\`, \`ls\`. Never \`grep\` or \`find\`.
- Read the files in your scope properly — use offset/limit chunking on large files rather than skimming the first screen.
- Every finding MUST carry a real file path, a real 1-indexed line number, and a VERBATIM evidence snippet (at most 3 lines) copied out of the file. If you cannot produce verbatim evidence, DROP the finding.
- No speculation, no "consider adding", no formatting or style nits. Only defects with a concrete cost.
- \`concept\` must be a SHORT, REUSABLE kebab-case tag naming the PATTERN, not this instance. Prefer a generic existing-sounding tag (error-swallowing, n-plus-one-io, unbounded-accumulation, string-interpolated-sql, god-function, toctou-file-write, unhandled-rejection, type-assertion-abuse, missing-test-coverage) over inventing a hyper-specific one — these tags get clustered across packages afterwards.
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

function rankConcepts(findings) {
  const byConcept = new Map()
  for (const f of findings) {
    const k = (f.concept || 'unclassified').trim().toLowerCase()
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

const ranked = rankConcepts(s1findings)
const overridden = a.conceptsOverride && a.conceptsOverride.length
const concepts = overridden
  ? a.conceptsOverride.map((c) => ranked.find((r) => r.concept === c) || { concept: c, count: 0, weight: 0, units: [], exemplars: [], score: 0 })
  : ranked.filter((c) => c.count >= MIN_CONCEPT_COUNT).slice(0, MAX_CONCEPTS)

log(`Stage 2 concepts (${concepts.length}): ${concepts.map((c) => `${c.concept}(${c.count})`).join(', ') || 'none — Stage 2 skipped'}`)

// Assign each concept a DISJOINT subset of the units it has NOT already been found in,
// keeping total Stage 2 agents within budget.
function conceptAssignments(cs) {
  if (!cs.length) return []
  const perConcept = Math.max(1, Math.floor(BUDGET / cs.length))
  const out = []
  for (const c of cs) {
    const candidates = UNITS.filter((u) => !c.units.includes(u.id))
    if (!candidates.length) continue
    const chunk = Math.ceil(candidates.length / perConcept)
    for (let i = 0; i < candidates.length; i += chunk) {
      const slice = candidates.slice(i, i + chunk)
      if (!slice.length) continue
      out.push({ concept: c, units: slice, part: out.length })
      if (out.length >= BUDGET) return out
    }
  }
  return out
}

const assignments = conceptAssignments(concepts)
if (assignments.length >= BUDGET) log(`NOTE: Stage 2 assignments capped at budget ${BUDGET}; some concept x package pairs were not swept.`)

phase('Concepts')

function conceptPrompt(asg) {
  const c = asg.concept
  const files = asg.units.flatMap((u) => u.files)
  return `You are sweeping a repository at ${ROOT} for ONE specific recurring defect pattern that was already confirmed elsewhere in this codebase.

## The concept you are hunting
\`${c.concept}\`

## Confirmed exemplars of this pattern (found in OTHER packages)
${c.exemplars.map((e) => `- ${e.file}:${e.line} [${e.severity}] ${e.summary}\n  \`\`\`\n  ${(e.evidence || '').split('\n').slice(0, 3).join('\n  ')}\n  \`\`\``).join('\n') || '(none supplied — use your judgement about what this tag means)'}

## Your scope (do NOT read files outside this list)
${files.map((f) => `- ${ROOT}/${f}`).join('\n')}

## Task
Find every instance of THIS pattern within your scope. Do not report unrelated defects — a different problem, however real, is out of scope for this sweep. Set \`matches_stage1_pattern\` to true when the instance is the same underlying defect shape as the exemplars, false when it is a related-but-distinct variant worth recording anyway.

${READONLY_RULES}

Set \`concept\` on every finding to exactly "${c.concept}".`
}

const stage2 = assignments.length
  ? await parallel(
      assignments.map((asg) => () => {
        const roster = matchRoster(asg.units[0].agentType || asg.units[0].id)
        return agent(conceptPrompt(asg), {
          agentType: asg.units[0].agentType || roster.agentType,
          model: WORKER_MODEL,
          label: `${asg.concept.concept}:p${asg.part}`,
          phase: 'Concepts',
          schema: CONCEPT_SCHEMA,
        }).then((r) => ({ concept: asg.concept.concept, units: asg.units.map((u) => u.id), findings: (r && r.findings) || [] }))
      })
    )
  : []

const s2ok = stage2.filter(Boolean)
const s2dropped = assignments.length - s2ok.length
const s2findings = s2ok.flatMap((r) => r.findings.map((f) => ({ ...f, unit: r.units.join('+'), stage: 2 })))
log(`Stage 2: ${s2ok.length}/${assignments.length} sweeps returned, ${s2findings.length} findings.${s2dropped ? ` DROPPED (no result): ${s2dropped} sweeps.` : ''}`)

const allFindings = [...s1findings, ...s2findings]

// ---------------------------------------------------------------------------
// Stage 3 — synthesis into an epic spec
// ---------------------------------------------------------------------------

phase('Synthesize')

const finalRanked = rankConcepts(allFindings)

function digest(findings, cap) {
  const order = { critical: 0, high: 1, medium: 2, low: 3 }
  return findings
    .slice()
    .sort((x, y) => (order[x.severity] ?? 9) - (order[y.severity] ?? 9))
    .slice(0, cap)
    .map((f) => `- [${f.severity}] (${f.concept}) ${f.file}:${f.line} — ${f.summary}`)
    .join('\n')
}

const epicSpec = await agent(
  `You are the architect synthesising a multi-agent code-quality sweep of the repository at ${ROOT} into a set of EPICS that will be filed as backlog items.

## Concept ranking across the whole sweep (concept, occurrences, severity-weighted score)
${finalRanked.map((c) => `- ${c.concept}: ${c.count} occurrences across ${c.units.length} scopes, score ${Math.round(c.score)}`).join('\n')}

## Findings (${allFindings.length} total, highest severity first)
${digest(allFindings, 220)}

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
  roster: UNITS.map((u) => ({ id: u.id, agentType: u.agentType })),
  dropped: {
    stage1_units_over_budget: RAW_PACKAGES.length > BUDGET ? RAW_PACKAGES.slice(BUDGET).map((p) => (typeof p === 'object' ? p.id || p.path : p)) : [],
    stage1_no_result: s1dropped,
    stage2_no_result: s2dropped,
    stage2_capped: assignments.length >= BUDGET,
  },
  note: 'Epics are RETURNED, not filed. The invoking session must dedupe against the backlog graph and file them with backlog_create_item / backlog_link_related / backlog_get_item.',
}
