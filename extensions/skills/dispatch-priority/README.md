# dispatch-priority

> Order buckets by consequence-to-objective — and escalate with the trigger recorded.

## Overview

Defines **priority** for dispatch as the ordering of buckets by consequence-to-objective when the
order is not user-pinned. It gives an explicit escalation ladder (P0 run-blocker, P1
objective-critical, P2 in-scope normal, P3 deferrable) with observable triggers, lists the triggers
that raise a bucket's priority, and grants the dispatcher the freedom to escalate or reorder — every
escalation recording its trigger in the rule-16 run line. The high/critical filter applies only to
immediate corrections arising from reviews, and a finding qualifies only via the four review-finding
materiality classes. HARD contradiction — the dispatcher's structuring-vs-verbatim check — is a
distinct term, defined canonically in dispatcher rule 0.

## When to use

Load when ordering buckets, when a bucket's priority changes, or when deciding whether a review
finding enters this run. Skip it and dispatch `product` instead when the order matters, the user did
not pin it, and there are more than three items (rule 7).

## Runtime

`declarative` — the host reads `SKILL.md` and injects it at invocation time.

## Dependencies

None. The skill references the dispatcher's own rules 0, 5, 7, 12, and 16, and `product` as a peer
playbook; it declares no dependency extensions.

## Source

Authored for the sox dispatcher-family change-set.

## Usage

```bash
soxe install dispatch-priority --host claude --scope user
soxe install dispatch-priority --host opencode --scope user
```

## License

MIT
