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
| `--step A-H` | Lifecycle stage. Only gates bound to it are considered. Required, and rejected (exit 64) unless it is one of `A`-`H` and at least one gate in the table is bound to it. |
| `--class`, `--rigor` | Decide whether a gate has anything to check (a row may list `classes`, `rigors`). The engine has no closed set of either (a table defines its own), so a value that no gate declares in `classes` / `rigors` is rejected (exit 64) as a probable typo. |
| `--changed <path>` (repeatable), or `--base <ref> --head <ref>` | Changed paths (a ref beginning with `-` is rejected; `git diff` is called with `--`); a row may list `paths` globs. Absent, every gate has something to check. |
| `--root <dir>` | Repository root and working directory of every command (default: cwd). The fixture-root flag the tests use. |
| `--table <file>` | Command table (default `<root>/gates.table.json`). |
| `--report <file>` / `-` | One JSON report (default `<root>/gate-report.json`; per-gate logs in `<report>.evidence/`; `*.log` files there for gates not run this time are removed first). `-` prints it on stdout. |
| `--fail-on-obligation` | Count an obligation (no mechanism) as a failure. |

Exit status is the highest exit status of any selected gate (0 when all pass). A gate that times out exits 124, a signal 128+n. The exit status is the only signal; output is evidence, never parsed.

### Selecting nothing

A typo can never be a green run: an unknown `--step`, `--class`, or `--rigor` exits 64 with a named error (above). A *valid* selection can still legitimately select zero gates (every gate bound to the step has nothing to check for this class, rigor, and changed paths, which is the point of "selects the gates that have something to check"). That run exits 0, prints `gate-engine: warning: ... 0 gates selected` on stderr, and records the same text in the report's `warnings` array with `summary.selected: 0`, so a consumer can tell it apart from a run that executed and passed gates.

### Engine errors versus gate statuses

The engine's own errors use exit 64 (usage) and 65 (bad table, including an unsafe gate id); a baseline refusal exits 1; an internal error exits 70. A gate command may itself exit 64, 65, or 70, and "exit with the worst gate's status" means the process exit cannot tell the two apart. The report can:

| `kind` | `engineError` | Meaning |
|---|---|---|
| `gate-report` | `false` | The gates ran; `exit` is the worst gate status, whatever its value. |
| `engine-error` | `true` | The engine refused before running gates; `code` (`E_USAGE`, `E_TABLE`, ...) and `message` say why, and `exit` is the engine's code. |

Usage errors raised while reading the arguments themselves (an unknown flag, a flag missing its value) are reported the same way: `--root`, `--report` and the verb are recovered from the raw arguments, and with no `--report` the default `gate-report.json` (or `check-report.json`) under `--root`/the current directory is overwritten.

The engine-error report is written to the same destination as a gate report (`--report`, default `gate-report.json`; `check-report.json` for `check`), so a stale earlier gate report is never left behind. stderr carries `gate-engine: <CODE>: <message>` for engine errors. Consumers that need the distinction must read the report, not just the exit status.

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

- `id`, `stage` (letters A to H), `mechanism` (`mechanical` or `review`) are required; `command` is a shell command run from `--root`. An `id` becomes an evidence file name, so it must match `[A-Za-z0-9._-]`, start with a letter or digit, and not contain `..`; anything else is a table error (exit 65).
- **No class relaxes G1, G2, G4, G10, G12, or a row with `release: true` / `nonRelaxable: true`** (testing policy section 6.7). Such a row is always selected, and a table that gives it `classes`, `rigors`, or `paths` is rejected. The list of non-relaxable ids is the constant `NON_RELAXABLE_IDS` in `lib.mjs`: it is not configurable per table (a table can add rows with `release: true` / `nonRelaxable: true`, but cannot remove or extend the built-in ids).
- A row with no `command`, or mechanism `review`, is an **obligation**: reported as such, never as a pass.
- The engine releases nothing: no merge, tag, or publish. The report says `"released": false`.

## Checks

```bash
node engine/cli.mjs check <completeness|liveness|reachability|teeth|all> --root <repo> [--baseline b.json [--update-baseline | --init-baseline]]
```

These are the generic entry points T41 fills. Defaults work over the table alone:

| Check | Finding |
|---|---|
| `completeness` | A required clause (`table.clauses` or `--clauses a,b`) with zero or several binding rows. |
| `liveness` | A mechanical row whose command word is not an executable file (on `PATH`, or at the given path relative to `--root`), or any `references` path that does not exist. Leading `VAR=value` assignments are skipped. Only the first command of a shell line is checked: in `a && b`, `a; b`, or `a \| b` only `a` is examined (so `cd x && tool` examines `cd`; `tool` is not checked). A first word that is a POSIX shell builtin (`test`, `[`, `cd`, `true`, `false`, `:`, `echo`, `printf`, `exit`, `export`, `set`, `unset`, `read`, `exec`, `eval`, `wait`, `type`, `command`, `umask`, `ulimit`) is runnable and never reported as `command not found`; any other builtin or shell function is not recognised, so wrap it in a script. |
| `reachability` | A gate its stage does not list in `stages.<S>.invokes`, or a gate bound to no stage. |
| `teeth` | A mechanical row with no `seeded.command`, or whose seeded violation exits 0. |

`--checks-module <file>` loads a module that calls `registerCheck(name, fn)` to add or replace a check; `fn({ table, root, run, clauses })` returns `[{ check, id, key, evidence }]`.

The baseline is a shrink-only ratchet: a finding outside it fails, a baseline entry with no finding fails (delete it), and `--update-baseline` rewrites the file with the current findings only if that adds no entry. It therefore refuses on a missing or empty baseline (every finding would be an addition). The first baseline is created by the separate, explicit `--init-baseline`, which refuses to overwrite an existing file. Both reuse the findings already computed for the report, so a `teeth` seeded command runs once per invocation.

## Verify

```bash
node --test engine/tests/*.test.mjs
```

`unit.test.mjs` injects the process runner and spawns nothing. `e2e.test.mjs` drives the CLI as real child processes in a temp directory with no `nx.json`.
