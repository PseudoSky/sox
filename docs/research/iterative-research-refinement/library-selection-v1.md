# Library Selection Decision Process v1

A structured process for determining the correct coding library for a given task.
Apply each phase in order. Record output at each step.

## Phase 0 — Task Definition
- State the specific task the library needs to perform (NOT the library name)
- List constraints: runtime (Node/browser/Deno), module system (ESM/CJS), bundle size budget, native addon policy
- List non-requirements: features the library MUST NOT include (bloat, peer deps you won't use)
- State the minimum API surface needed: "I need to parse TOML" not "I need a config library"

## Phase 1 — Candidate Discovery
- Search for the task, not the library: `"toml parser javascript"` not `"best toml library"`
- Collect 3-5 candidates from: npm search, GitHub topics, curated lists (awesome-*), and blog roundups
- Record each candidate's name, npm page URL, and GitHub URL
- Do NOT evaluate yet — just discover

## Phase 2 — Surface Screening
For each candidate, check these signals from the npm registry page and GitHub README:

**Maintenance signals:**
- When was the last version published? (npm "Published: X ago")
- How many versions? (frequent releases = active maintenance)
- Open issues count / ratio to total issues
- Is there a clear deprecation or replacement notice?

**Adoption signals:**
- Weekly downloads (npm)
- GitHub stars
- Number of dependents (packages that depend on this one)

**Quality signals:**
- Does the README have clear installation + usage examples?
- Are there TypeScript types? (bundled or DefinitelyTyped)
- Does the package have a license?
- Is there a CHANGELOG?

**Weight signals:**
- Bundle size (check bundlephobia or package-size)
- Number of transitive dependencies (npm ls --all)
- Does it require native compilation? (node-gyp, prebuild)

Grade each candidate on a 3-point scale for each signal category:
- ✅ Pass (meets threshold)
- ⚠️ Warning (below threshold but acceptable with justification)
- ❌ Fail (dealbreaker)

Any ❌ in MAINTENANCE or WEIGHT is a reject. ⚠️ in ADOPTION is acceptable for niche tasks.

## Phase 3 — Deep Comparison
For the top 2-3 candidates that passed Phase 2:

- Read the API documentation — does it match the API surface needed from Phase 0?
- Check the dependency tree — does it pull in unnecessary transitive deps?
- Check GitHub issues for the specific use case — have others reported problems?
- Check the last meaningful commit date (not just version publish — actual code change)
- Check for security advisories (npm audit)
- Check the license is compatible with your project

Build a comparison table:

| Criterion | Candidate A | Candidate B | Candidate C |
|-----------|-------------|-------------|-------------|
| Maintenance score | ✅/⚠️/❌  | ✅/⚠️/❌  | ✅/⚠️/❌  |
| Adoption score | ✅/⚠️/❌  | ✅/⚠️/❌  | ✅/⚠️/❌  |
| Quality score | ✅/⚠️/❌  | ✅/⚠️/❌  | ✅/⚠️/❌  |
| Weight score | ✅/⚠️/❌  | ✅/⚠️/❌  | ✅/⚠️/❌  |
| API fit | Full/Partial/None | Full/Partial/None | Full/Partial/None |

## Phase 4 — Decision

Rules:
- If one candidate passes ALL categories and has Full API fit → select it
- If multiple pass → select the one with FEWER transitive dependencies (smallest install weight)
- If NONE pass all categories → consider: writing the functionality yourself, or using a lower-level building block instead of a full library
- If the only candidate with Full API fit has ❌ in MAINTENANCE → document the risk and only use if accepting maintenance burden explicitly

## Phase 5 — Audit
Record:
- Task defined in Phase 0
- Candidates discovered
- Which passed/failed each phase
- Final decision
- Rationale
- What would you do differently next time?
