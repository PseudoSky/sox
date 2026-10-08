# qa

> Owner of a project's quality strategy and the evidence that a change works — test planning, automation, coverage, and release gating.

## Overview

`qa` owns one project's quality strategy end to end: the risk-ranked test plan and test pyramid,
test-case design, the automation architecture and its fixtures, flake control, CI integration,
contract/API testing, performance and load testing, accessibility testing, regression and release
gating, and defect reporting.

It is a **single owner, not an unbypassable lock**: it adopts and syncs the repository's testing
IMPLEMENTATION (citing the STRATEGY it binds) and refuses the operations that make verification unmeasured or dishonest. It
never writes product code to make a test pass, and it never approves a change it authored.

## When to use

- "Write the test strategy" / "what should we test" / "design tests for this"
- "Set up the test automation" / "why is coverage low" / "measure coverage"
- "This test is flaky" / "add a regression test"
- "Is this safe to release" / "review this defect report"

## Inputs

- A project with a test surface, and a request to plan, automate, measure, or gate it.
- The repository's testing IMPLEMENTATION (or the authority to apply the standard when none exists).

## Outputs

- A synced IMPLEMENTATION at the repository's binding path; audit records, confirmations, and dispute outcomes in auditor modes.
- Tests, gates, and reports whose every claim carries the command, its exit status, and the
  observed pass/fail counts and measured coverage.

## Usage

```bash
soxe install qa --host claude --scope user
soxe install qa --host opencode --scope user
```

## License

MIT
