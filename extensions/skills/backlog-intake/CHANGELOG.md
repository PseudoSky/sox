# Changelog

## 1.5.0

- **Immediate cataloguing (step 0).** A user request is catalogued the moment it arrives, with the user's message verbatim and immutable; corrections append, new work is a new item, enrichment never removes the verbatim, and a user note carries no citation. Cataloguing is never deferred.

## 1.4.0

- Initial release. Ingested verbatim from `claude-agents` (`categories/dispatch/skills/backlog-intake/SKILL.md`,
  v1.4.0, commit `6ffe0db1`) as part of the `dispatcher` v1.4.0 ingestion. Declares a `dependencies`
  edge on `backlog-operator`.
