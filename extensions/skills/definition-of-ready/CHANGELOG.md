# Changelog

## 1.0.0

- Initial release. Routes each bucket after bucketing into `needs-triage` /
  `needs-research` / `needs-spec` / `ready` by an observable check; sizing is driven
  by what is unknown, not by bucket size; defines the shared notion of readiness
  split across the filing boundary (`backlog-operator`) and this routing gate.
