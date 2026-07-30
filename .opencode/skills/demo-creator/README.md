# demo-creator — generate a project's DEMO.md acceptance script

> Use this skill to produce a project's demo script / DEMO.md / acceptance walkthrough / QA verification doc that both tells the product story like a live demo AND functions as a rigorous acceptance test.

## Overview

Turns a project's context (spec / PRD / README / landing copy / code) into a **DEMO.md**
that is two artifacts fused into one:

1. **An acceptance contract** — the source of truth for the agent implementing the
   project. If a capability isn't exercised in the demo, the implementer has no signal
   to build it, so completeness here defines scope there.
2. **An executable, presentation-grade verification pass** — run top to bottom with
   exact commands, exact data, and binary pass/fail checks, while it reads like a great
   live demo (cold open → climax → teardown).

It writes `DEMO.md` plus an `UNRESOLVED.md` ledger into `docs/plan/<plan-slug>/demo/`.
Uncertainty never hedges the prose — guessed interfaces are tagged `⟦U#⟧` inline and
tracked in the ledger, so a confident demo can never hide fabrication.

## When to use

Whenever you need a demo script, acceptance walkthrough, QA verification doc, or an
end-to-end "prove it works" artifact for a project — even when the word "demo" isn't
used (e.g. "walkthrough for QA", "exercise every path", "verify we built what the spec
says", "a TED/YouTube-style demo of the project").

## Contents

- `SKILL.md` — the entrypoint: goals + the 10-phase authoring process.
- `assets/DEMO.template.md` — the universal template (authoring rules R1–R10, the
  placeholder grammar, and the Definition of Done) the process fills in.
- `scripts/validate_demo.py` — a deterministic pre-emit gate: catches leftover template
  machinery, `⟦U#⟧` markers glued into runnable literals, stub↔ledger orphans, beats
  missing a `📎 Source`, and unproven coverage-matrix ids.

## Runtime

`declarative` — the host reads `SKILL.md` and injects it at invocation time.
Install target resolved from host-registry at install time.

## Usage

```bash
soxe install demo-creator --scope project
```

## License

MIT
