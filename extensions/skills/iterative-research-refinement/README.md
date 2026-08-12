# iterative-research-refinement — meta-cognitive research process (v9)

> Use this when you need to research a question, produce findings, audit your own process,
> and iteratively refine the methodology — not just the answer.

## Overview

A meta-cognitive research process that improves itself through nested feedback loops
(generate → self-feedback → refine → repeat). It forces quantified baselines, measured
deltas, and **MANDATORY runtime metrics** (tool calls, wall-clock, cost, tokens, cache
reads) before any version is promoted — a variant that regresses runtime beyond threshold
does not promote unchanged.

Process shape: Position Declaration → Iteration Manifest → Baseline Measurement →
Pre-Commitment → Observation Generalization → Loop 1 (empirical research) → Loop 2
(process audit) → Loop 3 (propose to new file) → Loop 3a (fresh-subagent real-execution
test + runtime measurement) → Loop 3b (commit) → Loop 4 (structural verification).

## When to use

Any research or refinement engagement that needs quantified baselines, measured deltas,
A/B refinement, or self-auditing methodology. Load by reference at the start of every
engagement. The canonical source is the sox-ecosystem registry extension; installed
copies on both hosts are synced from it.

## Contents

- `SKILL.md` — the entrypoint: full process definition (v9).
- `scripts/runtime-metrics.mjs` — deterministic runtime telemetry companion (mandatory
  for real-execution iterations): reads the opencode session DB, emits the metrics table +
  threshold verdicts. See `SKILL.md` §Runtime Metrics for usage.
- `research-execution-checklist.md` — condensed execution checklist.
- `research-question-generalization.md` — observation generalization reference.
- `library-selection-v3.md` — library evaluation variant.
- `injecting-a-research-process.md` — process injection guide.

## Runtime metrics note (host specifics)

The runtime-metrics companion reads the **opencode** session DB
(`~/.local/share/opencode/opencode.db`) and expects session ids from the task tool — it is
opencode-native by design. The skill body anchors script paths to the opencode user-scope
install (`~/.config/opencode/skills/iterative-research-refinement/`); on a machine without
that install, substitute the actual skill directory. The opencode custom tool
`runtime-metrics` (user config, `~/.config/opencode/tools/`) is a thin wrapper over the
same script.

## Runtime

`declarative` — the host reads `SKILL.md` and injects it at invocation time.
Install target resolved from host-registry at install time.

## Usage

```bash
soxe install iterative-research-refinement --host claude --scope user
soxe install iterative-research-refinement --host opencode --scope user
```

## License

MIT
