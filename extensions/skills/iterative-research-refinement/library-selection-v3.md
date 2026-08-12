# Library Selection Decision Process v3

A structured process for determining the correct coding library for a given task.
Apply each phase in order. Record output at each step.

## Phase 0 — Task Definition
- State the specific task in implementation terms: "parse TOML" not "config library"
- State runtime environment: Node version, browser targets
- State module system constraints: ESM-only acceptable? CJS required?
- State bundle size budget if applicable
- State native addon policy: allowed? only if prebuilt?
- State license constraints
- **Removal test**: if this package disappeared tomorrow, could you replace it? If the answer is "no", apply stricter scrutiny.

## Phase 1 — Candidate Discovery
- Search for the task, NOT the package name: `"toml parser node"` not `"best toml library"`
- Collect 3-5 candidates from: npm search (relevance sort), GitHub Topics, awesome-* lists
- **If an LLM suggested a package**: verify it actually exists, has real history, and has provenance before installing (slopsquatting risk)
- Record name, npm URL, GitHub URL for each

## Phase 2 — Surface Screening

### Tier 1: Security-Critical Signals (fastest checks, highest weight)
Check these first. Any fail here should usually reject the candidate.

- [ ] **Provenance attestation**: go to npmjs.com/package/<pkg>. Is there a green "Provenance" badge? Click it. Does it link to a real commit in a real repo?
- [ ] **Install scripts**: `npm pack --dry-run 2>/dev/null | grep -E "preinstall|postinstall|install"`. Are there unexplained install scripts?
- [ ] **Known vulnerabilities**: check snyk.io or osv.dev for unpatched CVEs

If the package fails Tier 1 with no acceptable justification → REJECT. Move to next candidate.

### Tier 2: Maintenance & Operational Signals
- [ ] **Last meaningful commit**: when did a human last make a source change (not a bot dep bump)?
- [ ] **Issue responsiveness**: look at the oldest open issues. Are they acknowledged?
- [ ] **Maintainer concentration**: is there one person doing everything? (bus factor)
- [ ] **Release cadence**: consistent releases or 2-year gaps?
- [ ] **CHANGELOG quality**: does it describe what changed and why, or just list commit hashes?
- [ ] **CI runs on PRs**: open a recent merged PR. Did CI run before merge?
- [ ] **Security policy**: is there a SECURITY.md or GitHub Security tab with disclosure instructions?

Score: count ✅ out of 7. Threshold: ≥4 to proceed.

### Tier 3: Quality Signals
- [ ] **Documentation**: README with install + usage examples, API docs
- [ ] **TypeScript types**: bundled (@types/ is acceptable but weaker)
- [ ] **Tests visible**: test directory structure, coverage thresholds in config
- [ ] **Linting config**: eslint.config.js or equivalent exists and is non-trivial
- [ ] **exports field**: modern package.json with conditional exports (import/require/types)
- [ ] **strict: true** (for TypeScript packages): in tsconfig.json
- [ ] **Low `any` / `@ts-ignore` usage**: scan for these in source

Score: count ✅ out of 7. Threshold: ≥4 to proceed.

### Weight Check
- [ ] **Dependency count**: few deps = smaller attack surface
- [ ] **Bundle size**: check bundlephobia if applicable
- [ ] **Native addons**: only acceptable if explicitly allowed in Phase 0

### License Check
- [ ] License is compatible with your project
- FAIL = REJECT

## Phase 3 — Deep Comparison

For candidates passing Phase 2:

- Read the full API documentation. Does it match what you need from Phase 0?
- `npm ls --all <pkg>` — examine the full transitive dependency tree
- Check if the package has a migration guide for breaking changes
- Check for corporate sponsorship or funding (`.github/FUNDING.yml`) — sustainability signal

## Phase 4 — Decision

### Rules:
1. If one candidate passes all phases → select it
2. If multiple pass → prefer lower dependency count, then higher maintenance score
3. If none pass → consider building the functionality yourself, or revisit Phase 1 with different search terms
4. If accepting a package with maintainer concentration risk → pin the exact version, set up Dependabot

### Documentation:
```
Task: <from Phase 0>
Selected: <candidate>
Tier 1 (Security): ✅/❌ — notes
Tier 2 (Maintenance): X/7 — notes
Tier 3 (Quality): X/7 — notes
Weight: ✅/⚠️/❌
License: ✅/❌
Rationale: <2-3 sentences>
Risk accepted: <any warnings overridden>
```

## Phase 5 — Retrospective
After implementation: did the library meet expectations? Update this document.
