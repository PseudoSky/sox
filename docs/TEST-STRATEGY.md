# Test strategy — sox-ecosystem

Single source of truth for how quality is verified here. Rules already stated elsewhere are cited, not restated:
`CLAUDE.md` (build/test via nx targets, smoke gate, `--skip-nx-cache` ban, tree-state rule, red-to-green rule),
`CONTRIBUTING.md` §1-§4 (pre-ship checklist, live verification).

## Risk map

Ranked by impact x likelihood. "Level" is where the failure is proven.

| # | Failure mode | Impact | Likelihood | Level |
|---|---|---|---|---|
| 1 | Install/uninstall lost update or wrong ownership (`ownership.json`, lockfile, file-drops) | high | measured: 2 of 40 isolated two-process races lost a record, both exit 0 | unit + real two-process integration (`libs/install-engine/src/db-artifact-concurrency.spec.ts`) |
| 2 | Service lifecycle lies (RUNNING without reality, orphans, singleton breach) | high | medium | smoke (`scripts/smoke-test.mjs`), `docs/spec/service-lifecycle.md` invariants |
| 3 | Rendered host artifacts (agents, skills, MCP config) wrong for a host | high | medium | unit (`libs/host-registry`, `libs/manifest`), tools guards (`tools/check-skill-frontmatter.test.mjs`, `tools/test-roster-guard.test.mjs`) |
| 4 | Stale `dist/` makes a suite green or red for the wrong code | high | high | `tools/check-suite-tree-state.mjs` quoted with every result |
| 5 | CLI verb regressions (`apps/sox/src/main.ts`) | medium | medium | unit + a few built-CLI e2e specs |
| 6 | Registry drift from published pins | high | low | release flow (`PUBLISHING.md`), `git diff --exit-code registry/index.json` |

Deliberately not covered at test level: live host loading (`opencode run` / `claude -p` probes) is a manual
live-verification step per `CONTRIBUTING.md` §2, not an automated gate.

## Test pyramid

- Unit (majority): vitest per library through nx; `node --test` for `tools/*.test.mjs` and extension tests.
  Unit tests mock every library that spawns a process or touches a third-party network.
- Integration: real filesystem in a mkdtemp sandbox; real OS processes only where the property under test
  is cross-process (ownership concurrency).
- E2E: drives the built CLI (`dist/apps/sox/main.js`) against a sandboxed workspace and data home. Keep to the
  few critical journeys, share one scaffold per spec, minimise spawns.
- Whole-system: `node scripts/smoke-test.mjs` (service + mcp-server extensions in a disposable scope).

A new test goes at the lowest level that proves the behaviour; promote to e2e only when the CLI wiring is the subject.

## Test-case design

- Equivalence classes per input kind; boundaries (empty, one, many, oversize) for lists and sizes.
- Negative cases are mandatory: malformed, missing, corrupt, and unowned inputs must fail as the contract says.
- State/decision tables for install ownership (owned / unowned / forced) and host attribution.
- Every test that cites a ticket cites `<uid> AC<n>`; a regression test names its ticket and is seen failing
  with the fix disabled before the ticket moves (`CLAUDE.md` red-to-green rule).

## Test data & fixtures

- Per-test temp roots from `fs.mkdtempSync(os.tmpdir())`, removed in `afterEach`; no shared mutable state.
- Fixtures live beside the code (`tools/fixtures/`, `extensions/skills/workspace-standards/fixtures/`).
- No test reads or writes the real data root; the smoke harness proves live files byte-identical before/after.

## Environments

- Local and CI both run through nx in a git worktree (`.worktrees/<name>`); a fresh worktree needs
  `pnpm install --frozen-lockfile`, then `git restore pnpm-lock.yaml`, then `npx nx build sox` and
  `npx nx build host-registry` before cli-spawning specs.
- Reproduce a failure with the same nx target plus the failing spec path; for order-sensitive failures pass
  `-- --sequence.seed=<n>` (a distinct argument is also a distinct nx cache key, so each seed is a real run).
- Smoke requires a full `npx nx run-many -t build` first.

## Automation architecture

- vitest (TypeScript libs and apps), `node --test` (tools and extension scripts), driven only via nx targets.
- Child-process specs use a shared `runCli` helper per spec file and a file-signal barrier for races; no fixed sleeps.
- Selectors/interfaces: tests assert on exit codes and parsed files, not on incidental stdout text.

## Gates

Enforceable today, and blocking a merge:

- `npx nx test <project>` exit 0 for every project the change touches.
- `npx nx run sox-ecosystem:lint` exit 0 (includes roster-guard and skill-header tests).
- `node scripts/smoke-test.mjs` reports 0 failed when install engine, manifests, or host-runtime are touched.
- `node tools/check-suite-tree-state.mjs --project <p>` is quoted with each suite result.
- A flaky test is a failing gate, not a retry: no silent permanent retry.

No numeric coverage gate exists because coverage is not currently measured; adding one requires a measured baseline first.

## Metrics

- Pass/fail counts per nx test target (printed by the runner).
- Smoke summary line (`done - N passed, M failed, K skipped`).
- Flake rate: repeated runs with distinct seeds; record N, failures, and the spec name.
- Coverage: not measured.

## Provenance

- schema: 1
- 2026-10-08: created. No committed document contained every required section, so none could be adopted.
  Baselines recorded from runs on plan branch `feat/testing-harness`: install-engine 318 tests, sox 254, host-registry 262,
  manifest 169, review agent 106, workspace-standards 29; smoke 25 passed, 0 failed. Known flake: install-engine
  `db-artifact-concurrency.spec.ts` AC1 (risk 1).
