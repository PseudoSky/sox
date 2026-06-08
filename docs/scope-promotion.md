# Scope-Promotion Pattern (G-C)

**Status:** Ecosystem pattern + host event specification.
**Source:** `architecture-v2.md` §G-C (design decision), `migration.md` §Phase 10 (implementation).
**Scope:** Documentation-only for the core glue repo. No schema, cascade, or install change.

---

## What scope-promotion is (and is not)

The four install scopes — `org`, `user`, `project`, `local` — form a precedence ladder
governed by the cascade (`cascade.ts`). The cascade resolves *config and install entries*
using a narrowest-scope-wins rule; it has no concept of *content* (memory nodes, learned
facts, user artifacts) moving between scopes.

Scope-promotion is the **data-plane** process of maturing content from a narrower scope
to a wider one:

```
local → project → user → org
```

It is mediated by an **approval**, never by automatic cascade merge. The cascade decides
which *extensions and config* apply at a scope; promotion decides which *content* an
extension is allowed to copy to a wider scope.

The control-plane (cascade) and the data-plane (promotion) share the same scope ladder;
their mechanisms are separate.

---

## The generic host hook event: `ScopePromotionProposed`

To prevent every tenant from reinventing a `promotion_queue`, the ecosystem defines one
standard lifecycle event in the host hook vocabulary (alongside `SessionEnd`, `PreToolUse`,
etc.):

### Event definition

```
Event:   ScopePromotionProposed
Payload: {
  extension_id: string,    // id of the extension proposing the promotion
  from_scope:   string,    // e.g. "project"
  to_scope:     string,    // e.g. "user"
  items:        unknown[], // tenant-defined content items being proposed
  proposed_at:  string,    // ISO timestamp
}
```

### Contract

- The host fires `ScopePromotionProposed` when any extension calls the host API
  `proposePromotion(from_scope, to_scope, items)`.
- Any hook extension bound to this event (order-sorted per the hook-loader) runs the
  approval or policy step.
- The **default host handler** enqueues the proposal to a host-managed promotion log and
  emits a log entry. A tenant MAY bind its own hook to:
  - auto-approve (for org baselines with threshold policies),
  - route to a human reviewer, or
  - veto (return an error to the caller).
- A reference default handler (~40 LOC) is outside the core glue budget and is a host
  responsibility, consistent with v1 treating the host loader as a contract not a built
  artifact.

### How a tenant uses it

A tenant extension calls `proposePromotion(...)` on the host API. The host fires the
event. The tenant's hook (bound to `ScopePromotionProposed`) runs the approval step.
This replaces bespoke `promotion_queue` plumbing — the next tenant reuses the event
instead of reinventing the queue.

Example: `sox-memory`'s `memory promote` command becomes *one binding* of this generic
event, not a standalone plumbing decision.

---

## Approval-locus rule

**The to-scope owner approves.**

| Promotion direction  | Approver                         |
|----------------------|----------------------------------|
| local → project      | project owner (human or policy)  |
| project → user       | user-scope owner                 |
| user → org           | org-baseline owner               |

- **Default:** manual (no auto-widen). Widening content is a trust-expanding action;
  narrower → wider = more exposure. The default is human-in-the-loop.
- **Org baseline MAY auto-approve** via policy (e.g. occurrence/age thresholds) by
  binding an auto-approve hook to `ScopePromotionProposed` — but this is an explicit
  opt-in, not the default.

---

## `config.promotion` convention (reserved shape, not a schema field)

`extensions-config/v1.json`'s `config` object is keyed by extension id and is already
open (`additionalProperties: object`). **No schema change is needed or made.**

The ecosystem documents the recommended shape so tenants align without a per-tenant key
collision and without over-fitting the schema to one tenant's policy:

```jsonc
"config": {
  "<ext-id>": {
    "promotion": {
      "auto_approve":    false,
      "min_occurrences": 3,
      "min_age_days":    60,
      "approver_scope":  "user"   // or "org"
    }
  }
}
```

This is **convention** (documented here), not a new schema property. A typo in
`config.promotion` is tenant-validated at promotion time, not at install — that is an
accepted cost of keeping the schema un-opinionated about policy that is still maturing
across tenants.

---

## Per-identity partitioning is NOT a 5th install scope

The research identified an "agent" scope with no install-scope equivalent. This was
resolved as an **in-store `agent_id` partition** — a filter within a scope's data store —
not a 5th scope level.

**Ecosystem rule:** Per-identity (agent/user) data partitioning is a **tenant concern**,
not an install scope. The four scopes (`org`, `user`, `project`, `local`) are
deployment/precedence scopes; identity is a *filter within* a scope's data.

This rule prevents future tenants from reaching for a 5th install scope when what they
actually need is an in-store partition key. Adding a 5th scope would force changes to the
cascade, `install.ts`, all config schemas, and every host loader implementation — for what
is fundamentally a data-organization decision, not a deployment-precedence decision.

---

## What is NOT done here (host responsibilities)

- No host event bus is implemented in this repo.
- No `proposePromotion(...)` API is implemented in this repo.
- No default handler is implemented in this repo.

The host loader and its event vocabulary are a host contract, consistent with v1 treating
the loader as a contract not a built artifact. This document specifies the contract;
a concrete host implementation may build from it.

---

## Back-compat

This document is purely additive. No schema file changed; `config.promotion` rides the
existing open `config` object. Adding `ScopePromotionProposed` to the host event
vocabulary does not affect any v1 extension that does not bind it. All v1 installs are
unchanged.
