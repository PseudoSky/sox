# gate engine

> One command that reads a repository's command table, runs the gates a lifecycle step needs, and exits with the worst gate's status. It knows no build tool.

Reuses: the single-list principle of `tools/gate/lane-gate.mjs` (one table every gate derives from), the shrink-only ratchet baseline of `check-lane-reachability.mjs`, and nx by composition only (a command-table row may be `npx nx run-many ...`; the engine never imports or names it); replaces: none (both adhd mechanisms stay as that repository's nx-specific mechanisms, bound as rows in its gate table).

The decision and its evidence are in [`../decisions/reuse-decision.md`](../decisions/reuse-decision.md). The changed-path filtering shape comes from `tools/run-guards.mjs`.

## Run

```bash
node engine/cli.mjs run --step B --class feature --rigor standard --changed src/a.ts --root <repo>
```

| Flag | Meaning |
|---|---|
| `--step A-H` | Lifecycle stage. Only gates bound to it are considered. Required. |
| `--class`, `--rigor` | Decide whether a gate has anything to check (a row may list `classes`, `rigors`). |
| `--changed <path>` (repeatable), or `--base <ref> --head <ref>` | Changed paths; a row may list `paths` globs. Absent, every gate has something to check. |
| `--root <dir>` | Repository root and working directory of every command (default: cwd). The fixture-root flag the tests use. |
| `--table <file>` | Command table (default `<root>/gates.table.json`). |
| `--report <file>` / `-` | One JSON report (default `<root>/gate-report.json`; per-gate logs in `<report>.evidence/`). `-` prints it on stdout. |
| `--fail-on-obligation` | Count an obligation (no mechanism) as a failure. |

Exit status is the highest exit status of any selected gate (0 when all pass). A gate that times out exits 124, a signal 128+n. Engine errors: 64 usage, 65 bad table. The exit status is the only signal; output is evidence, never parsed.

## Command table

```json
{
  "gates": [
    { "id": "G3", "command": "npx nx run-many -t test", "stage": ["B", "C"], "mechanism": "mechanical",
      "classes": ["feature"], "paths": ["src/**"], "seeded": { "command": "node seeds/break-g3.mjs" } },
    { "id": "G1", "command": "./scripts/g1.sh", "stage": "B", "mechanism": "mechanical" },
    { "id": "G7", "stage": "B", "mechanism": "review" }
  ],
  "stages": { "B": { "invokes": ["G1", "G3", "G7"] } }
}
```

- `id`, `stage` (letters A to H), `mechanism` (`mechanical` or `review`) are required; `command` is a shell command run from `--root`.
- **No class relaxes G1, G2, G4, G10, G12, or a row with `release: true` / `nonRelaxable: true`** (testing policy section 6.7). Such a row is always selected, and a table that gives it `classes`, `rigors`, or `paths` is rejected.
- A row with no `command`, or mechanism `review`, is an **obligation**: reported as such, never as a pass.
- The engine releases nothing: no merge, tag, or publish. The report says `"released": false`.

## Checks

```bash
node engine/cli.mjs check <completeness|liveness|reachability|teeth|all> --root <repo> [--baseline b.json [--update-baseline]]
```

These are the generic entry points T41 fills. Defaults work over the table alone:

| Check | Finding |
|---|---|
| `completeness` | A required clause (`table.clauses` or `--clauses a,b`) with zero or several binding rows. |
| `liveness` | A mechanical row whose command, or any `references` path, does not exist. |
| `reachability` | A gate its stage does not list in `stages.<S>.invokes`, or a gate bound to no stage. |
| `teeth` | A mechanical row with no `seeded.command`, or whose seeded violation exits 0. |

`--checks-module <file>` loads a module that calls `registerCheck(name, fn)` to add or replace a check; `fn({ table, root, run, clauses })` returns `[{ check, id, key, evidence }]`.

The baseline is a shrink-only ratchet: a finding outside it fails, a baseline entry with no finding fails (delete it), and `--update-baseline` refuses to add entries.

## Verify

```bash
node --test engine/tests/*.test.mjs
```

`unit.test.mjs` injects the process runner and spawns nothing. `e2e.test.mjs` drives the CLI as real child processes in a temp directory with no `nx.json`.
