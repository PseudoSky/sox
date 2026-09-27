# test-agent

> Use this when you need an agent that runs test suites and reports results.

## Overview

An execution-only verification agent. It runs the project's own test entry point and returns
an honest, reproducible account of the run: the exact command, the exit code, the first failing
assertion verbatim, the minimal reproduction, and the tree state the suite ran against. It
never writes application code and never edits a test to make it pass.

A suite result is evidence only when the tree state it ran against is stated with it, so the
agent pairs every result with `node tools/check-suite-tree-state.mjs --project <project>`.

## When to use

Delegate to `test-agent` when a claim about behavior needs verification by execution rather
than by reading code:

- a change is declared done and needs its tests actually run
- a suite is red and the failing case must be reduced to the smallest reproducing command
- two runs disagree and the tree state at the time of each was not recorded

## Capabilities

- Reads files, globs, greps, and runs commands via Bash.
- **Declares `edit: deny` and `write: deny`** — a harness-level guarantee, not a hope: the agent
  cannot modify source or tests to make a suite green.
- No external network calls.

## Inputs

A task description naming the project or suite to verify, and the command that is expected to
answer it (for example `npx nx test <project>`).

## Outputs

A structured result: command, exit code, observed outcome, first failing assertion,
minimal reproduction, and the `check-suite-tree-state` line for the tree the run used. A claim
that is not backed by tool output is reported as unattributable, never as a pass.

## Formatter

Source authored for the **cross-platform IR**. Agent config lives in `extension.json`
(`agent` + `render`); the entrypoint `test-agent.md` is prose only and carries no frontmatter —
the host header is generated at install time.

The extension **id** is `test-runner`, not `test-agent`: a manifest id may not end in its type
name (`libs/manifest/src/index.ts`), and `agent` is this extension's type. The agent's **name**
(`test-agent`) is what the directory and the entrypoint basename carry, and the deployed
artifact is therefore `<id>.md` — `test-runner.md` — declaring `name: test-agent`, exactly as
`memory-org.md` (id `memory-org`) declares `name: org-agent`.

## Usage

```bash
soxe install test-runner --host claude --scope user
soxe install test-runner --host opencode --scope user
```

## License

MIT
