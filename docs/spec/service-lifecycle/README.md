# `docs/spec/service-lifecycle/` — supporting material

The **authoritative** Service & Daemon Lifecycle specification is the single file one level up:
[`../service-lifecycle.md`](../service-lifecycle.md) (spec v1.0.0). Read that first — it is the
binding contract.

This directory holds optional supporting/expanded material that does not belong in the authoritative
flow. As of spec v1.0.0 the authoritative document is self-contained; nothing here overrides it.

When a section of the main spec grows large enough to split out (e.g. the full launchd/systemd unit
templates for §9, or the reconcile-pass pseudocode for §10), place it here as
`<section-slug>.md` and link to it from the corresponding section of `../service-lifecycle.md`. Keep
`../service-lifecycle.md` as the entry point and table of contents.
