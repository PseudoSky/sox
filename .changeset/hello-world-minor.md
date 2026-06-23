---
"@adhd/sox-extension-hello-world": minor
---

Add hook-ordering infrastructure (Gap 2) and CI workflow scaffolding (P5).

Proves independent versioning: only the hello-world skill is bumped here; the
audit-hook, echo-agent, hello-server, greeting-prompt, and status-command
extensions remain at their current versions. This is the canonical fix for the
live sox-cto-system monolith anti-pattern (one semver for many sub-units).
