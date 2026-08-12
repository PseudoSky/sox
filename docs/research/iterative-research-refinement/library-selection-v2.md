# Library Selection Decision Process v2

A structured process for determining the correct coding library for a given task.
Apply each phase in order.

## Phase 0 — Task Definition
- State the specific task in implementation terms: "parse TOML" not "config library"
- State the runtime environment: Node version, browser targets, Deno, workerd
- State module system constraints: ESM-only acceptable? CJS required? Dual?
- State bundle size budget if applicable: "cannot exceed 50KB gzipped"
- State native addon policy: allowed? forbidden? only if prebuilt?
- State license constraints: must be MIT/Apache? GPL acceptable?
- State the minimum API surface: list the exact functions/classes you need

## Phase 1 — Candidate Discovery
- Search for the task, not popularity: `"toml parser javascript"` not `"best toml library 2026"`
- Collect 3-5 candidates from: npm search (sorted by relevance, not popularity), GitHub Topics, awesome-* lists, and the npm "Discover" page
- Exclude packages that: haven't been updated in 2+ years, have <100 weekly downloads (unless niche), or are marked deprecated
- Record name, npm URL, GitHub URL for each

## Phase 2 — Surface Screening

Score each candidate in four categories. Score 0-2 per signal, sum per category.

### Maintenance (max 10 points)
- [0-2] Days since last publish: >365=0, 90-365=1, <90=2
- [0-2] Release cadence: irregular/unreliable=0, seasonal=1, consistent=2
- [0-2] Open issue ratio (open/total): >20%=0, 10-20%=1, <10%=2
- [0-2] Maintainer count: 1=0, 2-3=1, 4+=2
- [0-2] CI/CD visible on GitHub: none=0, partial=1, green badges=2
- Threshold: <6 points is a REJECT

### Adoption (max 10 points)
- [0-2] Weekly downloads: <1K=0, 1K-100K=1, >100K=2
- [0-2] GitHub stars: <100=0, 100-5K=1, >5K=2
- [0-2] Dependents count: <10=0, 10-500=1, >500=2
- [0-2] Used by known projects/companies: unknown=0, some=1, well-known=2
- [0-2] Has a community (Discord, GitHub Discussions, Stack Overflow presence): none=0, minimal=1, active=2
- Threshold: <4 points is a REJECT (exception: niche/specialized libraries)

### Quality (max 10 points)
- [0-2] README quality: missing/broken=0, basic install+usage=1, comprehensive with examples=2
- [0-2] TypeScript types: none=0, community types (@types/)=1, bundled=2
- [0-2] Tests visible: none=0, some=1, comprehensive CI-tested=2
- [0-2] Documentation: README only=0, API docs=1, full docs site+tutorials=2
- [0-2] CHANGELOG or release notes: none=0, exists=1, well-maintained=2
- Threshold: <5 points is a REJECT

### Weight (max 10 points)
- [0-2] Package size (unpacked): >1MB=0, 100KB-1MB=1, <100KB=2
- [0-2] Transitive dependencies: >20=0, 5-20=1, <5=2
- [0-2] Has native addons: yes=0, optional=1, no=2
- [0-2] Runtime compatibility: targets older Node than yours=0, matches yours=1, supports your exact range=2
- [0-2] Tree-shakeable / side-effect-free (ESM exports): no=0, partial=1, yes=2
- Threshold: <5 points is a REJECT (unless native addons are explicitly acceptable per Phase 0)

### License Check
- [PASS/FAIL] License is compatible with your project (e.g., MIT/Apache for commercial, GPL only if acceptable)
- FAIL = REJECT regardless of other scores

### Scoring Summary
| Category | Score (/10) | Threshold | Status |
|----------|-------------|-----------|--------|
| Maintenance | | ≥6 | PASS/FAIL |
| Adoption | | ≥4 | PASS/FAIL |
| Quality | | ≥5 | PASS/FAIL |
| Weight | | ≥5 | PASS/FAIL |
| License | PASS/FAIL | PASS | PASS/FAIL |

Any FAIL = reject candidate. Move to next candidate.

## Phase 3 — Deep Comparison

For candidates that PASS all categories in Phase 2:

### API Fit
- Read the full API documentation
- Does it expose every function/class you need from Phase 0?
- Does it have features you explicitly do NOT want? (bloat)
- Does it require a specific framework or runtime version?
- **Rate:** Full / Partial (with workarounds) / None

### Hidden Risk Check
- `npm audit` — are there known vulnerabilities?
- Check the LICENSE file exists and matches the SPDX identifier (not just the package.json field)
- Check GitHub Issues tab for your specific use case — search for issue titles
- Check if there's a `.github/FUNDING.yml` or corporate sponsor (indicates sustainability)
- Check the Node version requirement in `engines` field

### Dependency Audit
- `npm ls --all <package>` — examine the full transitive dependency tree
- Are there any deprecated sub-dependencies? (`npm outdated`)
- Any peer dependency conflicts with your existing stack?

## Phase 4 — Decision

### Rules:
1. If exactly one candidate passes all phases with Full API fit → select it
2. If multiple candidates pass → prefer the one with HIGHEST WEIGHT score (smallest footprint), then HIGHEST MAINTENANCE score (most reliable)
3. If NONE pass all phases → consider alternatives in this order:
   a. Revisit Phase 1 with broader search terms
   b. Write the functionality yourself using lower-level primitives
   c. Accept a candidate with partial scores by documenting the risk explicitly (BL number or ADR)
4. If the ONLY viable candidate has a warning in MAINTENANCE (single maintainer, slow releases) → pin the exact version and set up Dependabot alerts

### Documentation Requirement
Record the decision rationale in a format that another developer can review:
```
Task: <from Phase 0>
Selected: <candidate>
Rationale: <2-3 sentences explaining why this candidate over alternatives>
Risk accepted: <any warnings that were overridden>
Alternatives considered: <list and why rejected>
```

## Phase 5 — Retrospective
After using the library for the actual implementation:
- Did the API surface match expectations?
- Were there any surprises (missing features, bugs, performance issues)?
- Would you choose differently next time?
- Update this document with learnings.
