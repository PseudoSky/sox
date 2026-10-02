# definition-of-ready

> Route each bucket by an observable check — after bucketing, before dispatch.

## Overview

The **definition of ready** is the observable conditions a bucket must satisfy before
it can be routed to a handling path — an entry gate mirroring the definition-of-done
exit gate, and a working agreement rather than bureaucracy. This skill runs after
bucketing and classifies each bucket into one of four paths:

- `needs-triage` — a symptom with no established root cause (or a
  "pre-existing / unrelated / skipped" claim) → `dispatch-triage` → `debug`.
- `needs-research` — an external factual unknown (`which / does / is-it-possible`) no
  repo artifact answers → `researcher` or a time-boxed spike.
- `needs-spec` — the done-state is not yet writable in `dispatch-contract` terms and
  the missing ingredient is a design/contract decision → `architect` →
  `dispatch-direct`.
- `ready` — done-state writable as an observable action, scope named, no blocking
  unknown → `dispatch-direct`.

No verdict stands without the observable check that produced it. Sizing is about what
is unknown, not how big the bucket is — size never fires a path.

## When to use

After items have been grouped by cohesion into buckets (each bucket shares a
file/component and one done-state) and before any bucket is dispatched. Never before
bucketing — classifying individual items produces path churn for buckets that share a
done-state.

## Runtime

`declarative` — the host reads `SKILL.md` directly. No transform.

## Dependencies

None. The skill names `dispatch-triage`, `dispatch-direct`, `researcher`, `architect`,
and `debug` as routes but does not install or own them; every backlog write continues
to route through `backlog-operator`.

## Source

Researcher-sourced. Grounded in the Scrum "definition of ready" as a team working
agreement mirroring the definition of done; INVEST (Bill Wake, 2003) for the
item-quality half; the XP/Scrum spike for the `needs-research` route; and
agentic-SDLC triage for the root-cause-before-fix route.

## Usage

```bash
soxe install definition-of-ready --host claude --scope user
soxe install definition-of-ready --host opencode --scope user
```

## License

MIT
