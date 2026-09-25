---
'@adhd/sox-cli': patch
---

- `soxe service restart` finds the backend the OS unit actually runs by reading
  the unit's argv on disk (dc6261c1). `--backend-only` respawns only the backend
  and never kickstarts the unit. When the unit's entrypoint
  differs from the resolved install, it reports `NOT DEPLOYED` instead of
  claiming success.
- `cmdServe` forwards SIGTERM, SIGHUP and SIGINT to its grandchild when running
  without a proxy. A `--grace-ms` of 0 means an immediate SIGKILL, and death is
  verified after escalation.
- The `cli_invoked` telemetry event now carries `subverb` and `target`
  (d5c01be3).
- Picks up the unreleased `@adhd/sox-host-runtime`, `@adhd/sox-install-engine`
  and `@adhd/sox-host-registry` changes, which are bundled into the CLI.
