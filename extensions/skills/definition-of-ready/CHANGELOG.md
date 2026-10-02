# Changelog

## 1.0.1

- **Consistency fix.** The bucketing sentence now sizes a bucket by cohesion and separability, never maximal size (aligned with the dispatcher rule 8 refinement).

## 1.0.0

- Initial release. Routes each bucket after bucketing into `needs-triage` /
  `needs-research` / `needs-spec` / `ready` by an observable check; sizing is driven
  by what is unknown, not by bucket size; defines the shared notion of readiness
  split across the filing boundary (`backlog-operator`) and this routing gate.
