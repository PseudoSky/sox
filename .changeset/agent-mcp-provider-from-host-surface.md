---
'@adhd/sox-manifest': major
'@adhd/sox-host-registry': minor
'@adhd/sox-install-engine': minor
---

Derive an agent-mcp catalog row's provider from the host surface it serves, never
from the agent IR's logical Claude tier.

`@adhd/sox-host-registry` — new `agentMcpHost` surface (`agent-mcp`, capability
`agent-catalog`). `HostRenderer` gains an optional `providerFrom`, naming a sibling
`render.<host>` whose `{provider, model}` a row inherits when its own render supplies
neither — so agent-mcp serves whatever host actually runs the agent instead of
minting a vendor default. `deriveProvider` no longer reads the agent IR's `model`
tier, so a row can never silently become `type: 'anthropic'`; with no explicit render
model/provider it now throws `AgentProviderUnderivableError` rather than defaulting
to `claude-sonnet-4-5`. Codex drops its `?? ir.model` fallback to match.

`@adhd/sox-install-engine` — `readAgentRenderInputs` (exported) resolves the host
render override including `providerFrom` inheritance. New `renderAgentCatalogPayload`
renders an `agent` into a catalog payload behind a single renderability gate, and new
`AgentNotRenderableError` names the raw-passthrough case (no `agent` IR, no `render`):
the apply branch and `--dry-run` both reach the renderer only when it is renderable,
so a dry run cannot promise a rewrite apply would reject. New `reconcileAgentMcpCatalog`
one-shot (`soxe reconcile-agent-mcp`) re-renders existing rows through the same
`declarativeInstall` path — agent-catalog rows are not lockfile consumers, so
`upgrade --all` cannot reach them — reporting non-renderable rows as
`skipped: not-renderable` (never a failure) and manifestless rows as
`skipped: no-local-manifest` (never deleted).

`@adhd/sox-manifest` — **BREAKING**: `validate()` now requires that an `agent` with
any entry in `install.hosts` declares a non-null object `render.<host>` for each of
those hosts; a manifest listing a host it has no render for previously inherited
another host's model silently and now fails validation. `agent-mcp` is added to the
known hosts and the manifest schema.
