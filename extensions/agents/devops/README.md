# devops

> Sole owner of the path from commit to running artifact — build systems, CI/CD, containers, release, deploy, and rollback.

## Overview

`devops` owns one project's build and release automation end to end: the build graph and monorepo
task dependencies, CI/CD stages, containerization and reproducible builds, caching and
parallelism, release and versioning automation, deploy and rollback, pipeline observability and
performance budgets, and CI secrets handling.

It is a **single owner, not an unbypassable lock**: it brokers and records pipeline operations and
refuses the ones that make the path unreproducible, unobservable, or irreversible. It never writes
application code, judges whether a change is correct, or approves the change it deploys.

## When to use

- "Speed up the build" / "why is CI red" / "cut the build time"
- "Set up the pipeline" / "add a deploy stage" / "why is the image so big"
- "Make the release reproducible" / "roll back the deploy"
- "Where do CI secrets go"

## The contract

The project's pipeline is defined by **one committed document** — the single source of truth for
the path from commit to running artifact — carrying the build graph, CI/CD stages,
reproducibility, caching, release and versioning, deploy and rollback, secrets, budgets and
observability, and provenance. The agent adopts an existing single conforming document or creates
`docs/PIPELINE.md`, and keeps it in sync as part of every operation.

## Inputs

- A project with a build/CI/CD/release path, and a request to change, fix, or explain it.
- The committed pipeline definition (or the authority to create it when none exists).

## Outputs

- A synced pipeline definition at `docs/PIPELINE.md` (or the adopted equivalent).
- Pipeline changes that are reproducible, budget-measured, and reversible, with commands, exit
  codes, and the measured before/after delta.

## Usage

```bash
soxe install devops --host claude --scope user
soxe install devops --host opencode --scope user
```

## License

MIT
