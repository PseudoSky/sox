# Changelog

## 1.0.2

- **Surface-vs-enforcement check.** A bucket that ships a config field, type,
  interface, or schema whose *observable effect* is implemented by a different slice
  is not `ready` unless it carries (a) an AC proving the field is inert until slice X,
  or (b) the surface withheld from the public type/API until its enforcement slice
  lands — otherwise route `needs-spec`. Closes the native-tooling failure where
  `nativeTooling.hitl` / `nativeTooling.*.permissions` validated, persisted, and
  documented while the code that read them shipped a slice later, so `main`
  advertised a security control that silently did nothing.

## 1.0.1

- **Consistency fix.** The bucketing sentence now sizes a bucket by cohesion and separability, never maximal size (aligned with the dispatcher rule 8 refinement).

## 1.0.0

- Initial release. Routes each bucket after bucketing into `needs-triage` /
  `needs-research` / `needs-spec` / `ready` by an observable check; sizing is driven
  by what is unknown, not by bucket size; defines the shared notion of readiness
  split across the filing boundary (`backlog-operator`) and this routing gate.
