# SPEC — agent-mcp renderer fidelity: provider binding, permissions, mcpServers, native items

Status: PROPOSED (architect, 2026-10-07; dispatch-2026-10-06-48dc). Ticket: TBD (filed by dispatcher's backlog-operator).
Placement: `docs/spec/` is this repo's existing design-spec home (`docs/spec/cross-platform-install-rendering.md` is the governing renderer spec; this amends its §4.4 field table). No code was changed to produce this spec; no gates were run.
ADRs honoured: 0002 (soxe writes via the host's public surface), 0013 (no env feature switch; one-shot actions are explicit invocations), 0026 (bodies name capabilities, never tools; no inference of bindings from host MCP config). No ADR is violated; none is superseded.

## 1. Current state (verified by reading; `sox` = /Users/nix/dev/ai/sox-ecosystem, `adhd` = /Users/nix/dev/node/adhd)

| # | Finding | Evidence |
|---|---|---|
| F1 | Renderer emits only `{name, description, systemPrompt, provider, mcpServers, permissions, maxToolLoops}`. Nothing else the catalog supports can be produced. | sox `libs/host-registry/src/agent-mcp.ts:336-344,369-386`; dup type `libs/install-engine/src/capabilities/agent-catalog.ts:32-40` |
| F2 | IR `permission` (opencode map) is never read; `permissions` = `override.permissions ?? {}`. Live `typescript` row v2 has `permissions: {}`: its `git reset --hard*`/`rm -rf *`/`git stash*` denials are gone. | `agent-mcp.ts:378`; row in `~/.adhd/agent-mcp/agents.db` (`typescript`, v2) |
| F3 | agent-mcp `permissions` is only `{allowedAgents}`; tool gating lives in `nativeTooling.{fs,shell,dispatch}.permissions` (tool-NAME rules, server-qualified, last-match-wins, deny terminal, empty map => allow). Command text is never matched (ADR-0008 D5). | adhd `agent-base-types/src/domain.ts:266-268`, `agent-core-native-tooling/src/lib/permissions.ts:45-62`, `docs/decisions/0008-agent-mcp-native-tooling.md` D5 |
| F4 | Because `nativeTooling` is never emitted, every installed agent silently gets default-on fs + shell + dispatch with an allow-all gate, regardless of its IR `tools`/`permission`. | adhd ADR-0008 D1; row above has no `nativeTooling` |
| F5 | Provider is welded by substring (`deepseek`, `gpt|qwen|openai`) to hardcoded env-ref sets; an `anthropic/...` slug is mapped to type `openai`. `temperature` (IR+override) is dropped. No path emits `claudecli`/`allowedBuiltinTools`, `maxTokens`, `timeoutMs`, `baseURL`, `retryConfig` except by verbatim `render.agent-mcp.provider`. | `agent-mcp.ts:287-329` (esp. 314-321) |
| F6 | Manifest `agent-mcp.mcpServers` is passed through verbatim, including an `agent` stdio entry launching `@adhd/agent-mcp` with absolute `ADHD_AGENT_DATABASE_PATH`/`REGISTRY_DB_PATH`, plus `/Users/nix/...` paths. The builtin dispatch server key is `agent-mcp` (`DISPATCH_SERVER_KEY`), so the agent gets TWO agent-mcp servers (explicit entries win over builtins). | sox `extensions/agents/typescript/extension.json` (`render.agent-mcp`); adhd `agent-core-native-tooling/src/lib/catalog.ts:35,214`; ADR-0008 D1 |
| F7 | Update semantics: `agent_update` shallow-spreads defined keys (cannot clear a field), merges `mcpServers` (stale keys survive unless sent as `null`), shallow-merges `permissions`; `agentPatchSchema` is a plain `z.object` (unknown keys silently stripped) and lacks `toolAdvertisement`. | adhd `entrypoint/agent-mcp/src/store/agent-store.ts:31-45,105-125`; `validation/agent.ts:212-222` (to be confirmed by a live `agent_update`) |
| F8 | `reconcile` defaults to `provider.type==='anthropic'` rows only and compares only `{type,model,secret}`; any change to the new fields reads "unchanged". `catalogRead`/`catalogList` use default summary reads (no `systemPrompt`, no `fullDefinition`). | sox `reconcile-agent-mcp.ts:60-64,117-132,196`; `agent-mcp-client.ts:249-263` |
| F9 | Provider portability as shipped in adhd: `AgentDefinition.provider` is OPTIONAL (D-G(2)); binding chain `task ?? session ?? agent ?? global`; per-field first-wins; a tier naming a different `providerType` is skipped; none => fail-closed `NO_PROVIDER_SELECTED`. Canonical model slugs (`claude_sonnet_4_6`) resolve per platform; openai has no binding table. Secrets are env-var NAME pointers, `ADHD_AGENT_`-prefixed (server rejects others). | adhd `agent-base-types/src/domain.ts:461-469`, `provider-binding.ts:31-59`, `agent-engine-orchestrator/src/providers/resolve-selection.ts:22-60,84-103`, `validation/agent.ts:125-155`, `entrypoint/agent-mcp/AGENTS.md` (`session_update` row) |
| F10 | PF-1 (types + classifier) is on main; `billingScope`, `tripwire`, `retryWindowMs`, `models[]` exist ONLY on `PartialBinding` (task/session/global tiers). `ProviderConfig` and the provider zod schemas do not carry them, and `providerConfigToBinding` does not map them. The failover loop (PF-4) and tripwire store are specified, not built; `models[]` is "read by nothing". A renderer emitting them would be silently stripped. | adhd `provider-binding.ts:18-50`, `resolve-selection.ts:84-103`, `docs/plan/provider-failure/SPEC.md` (VERDICT item 5, §3) |
| F11 | `sox-typescript-impl` is not in the sox repo nor in either catalog DB (`~/.adhd/agent-mcp/agents.db`, `~/.adhd/agent-mcp/production/data/agents.db`). Evidence uses the installed `typescript` row (v2, openai/DeepSeek env refs). soxe resolves its catalog via `resolveAgentMcpEnv` (`agent-mcp.ts:140-166`); on this machine the two DBs hold different agent sets. | catalog queries 2026-10-07 |
| F12 | `checkProviderCapabilities` runs in the lockfile install flow against an install-config `activeProvider`, not against the agent-mcp row's provider; the manifest `requires.tool_calling` is not evaluated on the agent-mcp path. | sox `install.ts:955-960` |

## 2. Owner decisions required (spec proceeds on the recommendation; do not silently choose)

- O1 Provider welding vs unbound. D-G(2) made `provider` optional; the renderer throws `AgentProviderUnderivableError` when none is derivable (`agent-mcp.ts:244`). Recommend: keep requiring a provider by default (rows must be dispatchable under the existing eb1ab168 guarantee) but allow `render.agent-mcp.provider: null` = deliberately unbound row (resolved from session/task/global tiers). Alternative: default unbound.
- O2 Unrepresentable permissions (bash command deny/ask rules). Recommend fail-closed: shell disabled (`nativeTooling.shell:false`) unless the manifest declares `render.agent-mcp.nativeTooling.shell` explicitly. Alternative: shell on + warning.
- O3 Least-privilege native defaults. Agents whose IR `tools` omit read/edit/glob/grep, bash, task get `fs`/`shell`/`dispatch` = `false`. Recommend yes (behavior change for already-installed rows; see §6).

## 3. Mapping table (sox agent file => agent-mcp definition)

| sox source | agent-mcp field | Rule |
|---|---|---|
| `agent.name`/`description`, `.md` body | `name`, `description`, `systemPrompt` | unchanged (frontmatter stripped) |
| `agent.steps` | `maxToolLoops` | unchanged |
| `agent.temperature` / `render.agent-mcp.provider.temperature` | `provider.temperature` | anthropic/openai only; clamp [0,1]; error on >1; not for claudecli |
| `render.agent-mcp.provider` (object) | `provider` | passthrough after validation (AC4/5); `null` = unbound (O1) |
| `render.agent-mcp.model` / `providerFrom` opencode model | `provider` (derived) | replace substring heuristic with a typed profile table keyed by vendor prefix: `deepseek/`=>openai+DEEPSEEK env refs, `openai/`=>openai+OPENAI refs, `anthropic/`=>type `anthropic`+`ADHD_AGENT_ANTHROPIC_SECRET`; unknown prefix => throw |
| `render.agent-mcp.provider.type='claudecli'` + IR `tools` | `provider.allowedBuiltinTools` | map IR built-ins to Claude Code names (read=>Read, edit=>Edit, glob=>Glob, grep=>Grep, bash=>Bash, webfetch=>WebFetch); no env refs emitted |
| `render.agent-mcp.provider.{maxTokens,timeoutMs,baseURL,retryConfig}` | same | passthrough, typed |
| fallback chain / `billingScope` / `tripwire` / `retryWindowMs` | NONE today | BLOCKED on adhd dependency (F10): manifest validation rejects these keys under `render.agent-mcp.provider` with a message naming the dependency; no silent emit |
| IR `tools` read/edit/glob/grep | `nativeTooling.fs` | `true` or `render.agent-mcp.nativeTooling.fs` overrides; absent => `false` (O3); root hints cwd-relative/alias only, absolute rejected |
| IR `tools` bash | `nativeTooling.shell` | `true` or overrides (`allowCommands`,`allowPatterns`,`timeoutMs`); O2 applies when bash rules are unrepresentable |
| IR `tools` task | `nativeTooling.dispatch` | `true`; replaces any manifest stdio entry that launches agent-mcp (drop it, warn) |
| IR `tools` question | `nativeTooling.hitl` | present => omit (default true); absent => `false`. Emit `hitl`, never legacy `allowHumanInput` |
| IR `permission` entries for read/edit/glob/grep/bash/task | `nativeTooling.<member>.permissions` | tool-NAME rules with server-qualified keys (`fs.*`,`shell.*`,`agent-mcp.*`); a `'*'` rule is NEVER generated unscoped (it gates every server) |
| IR `permission.bash` command patterns | LOST by design | not representable (ADR-0008 D5; shell server is allowlist-only); recorded in a loss report, see AC9 |
| IR `permission.task` as pattern map | `permissions.allowedAgents` | keys with `allow`; scalar `allow` => omit |
| IR `permission` logical capability rules (`memory_*`,`gitnexus_*`) | `nativeTooling.dispatch/fs...` NOT used; `<serverKey>.<tool-glob>` rules in the member that carries gate | serverKey resolved through `render.agent-mcp.toolMap` (logical=>server key); unresolved logical name => warning, rule dropped (ADR-0026 D6: absent means unavailable) |
| IR `tools` `{logical,server}` | `mcpServers[<key>]` | key from `toolMap`; launch config from `render.agent-mcp.mcpServers` (full config; compat) |
| `render.agent-mcp.mcpServers` literal secrets | rejected | secret-named env/header keys (`/secret|token|key|password/i`) with a non-reference literal fail render (AC6) |
| IR `tools` webfetch/websearch | `nativeWebTools` | `false` only if websearch is `deny` and webfetch absent; otherwise omit (provider default); no effect on openai/claudecli |
| `render.agent-mcp.toolAdvertisement` | `toolAdvertisement` | `'names'|'full'`; update path BLOCKED on adhd patch-schema gap (F7); emitted on create only |
| `render.agent-mcp.sanitization` | `sanitization` | `'none'|'prefix'|'wrap'` passthrough |

Secrets rule: provider credentials are env-var NAME pointers; every `provider.env.*` value must match `^ADHD_AGENT_[A-Z0-9_]+$`; a literal credential anywhere in the payload fails the render.

## 4. Required changes by file (sox)

| Path | Change |
|---|---|
| `libs/host-registry/src/internal.ts` (`AgentOverride` ~142-173) | add `nativeTooling`, `toolAdvertisement`, `sanitization`, `nativeWebTools`, `toolMap` use, `acceptLoss` |
| `libs/host-registry/src/agent-mcp.ts` | replace `deriveProvider` heuristic with profile table + validation; new `deriveNativeTooling(ir,override)`, `deriveAllowedAgents`, `deriveMcpServers`; `AgentCatalogPayload` gains the new fields and a `renderReport` side channel (loss/warnings) |
| `libs/install-engine/src/capabilities/agent-catalog.ts:32-40` | single shared payload type (delete the duplicate); upsert sends explicit values for every previously-owned managed field; record `meta.ownedMcpKeys`, `meta.managedFields`, `meta.rowDigest` in the ledger |
| `libs/install-engine/src/agent-mcp-client.ts:249-296` | `catalogRead`/`catalogList` accept `fullDefinition`; `catalogUpsert` adds `mcpServers:{<staleKey>:null}` for owned keys no longer rendered |
| `libs/install-engine/src/install.ts` (`renderAgentCatalogPayload` ~1728) | surface `renderReport` warnings in install results; honour `acceptLoss` |
| `libs/install-engine/src/reconcile-agent-mcp.ts` | compare full managed-field digest against the freshly rendered payload; default = all rows with a local manifest (retire anthropic-only default); outcomes gain `'drift'`; `--accept-loss` explicit |
| `libs/manifest/src/index.ts` (~789 completeness rule) + `schema.json` | validate `render.agent-mcp` sub-keys (closed set above), reject blocked keys, reject absolute fs roots, secret-literal check |
| `docs/spec/cross-platform-install-rendering.md` §4.4 | add rows for the new agent-mcp fields; link this spec |
| `libs/host-registry/CHANGELOG.md`, `libs/install-engine/CHANGELOG.md`, `libs/install-engine/README.md` | document |
| `extensions/agents/*/extension.json` (21 agents) | migrate `render.agent-mcp` to the new shape (drop welded `agent` entry and abs DB paths) |

## 5. Acceptance criteria

- AC1: Rendering `extensions/agents/typescript` yields `nativeTooling.fs`, `.shell`, `.dispatch`, `.hitl` explicitly (never absent).
- AC2: An agent whose IR `tools` omit bash renders `nativeTooling.shell === false`; one omitting task renders `dispatch === false` (O3).
- AC3: The rendered payload for any agent contains no stdio `mcpServers` entry whose command/args reference `agent-mcp`; `nativeTooling.dispatch` carries dispatch.
- AC4: `provider.env` values all match `^ADHD_AGENT_[A-Z0-9_]+$`; any other value, or a literal credential, fails the render with the agent name.
- AC5: Model `anthropic/<m>` renders `provider.type==='anthropic'` with `ADHD_AGENT_ANTHROPIC_SECRET`; `deepseek/<m>` and `openai/<m>` render type `openai`; an unknown prefix throws `AgentProviderUnderivableError`.
- AC6: A `mcpServers` env/header entry with a secret-named key and a non-reference literal value fails the render.
- AC7: `temperature` from IR/override is emitted as `provider.temperature` for anthropic/openai and omitted for claudecli; >1 fails.
- AC8: `type:'claudecli'` renders `allowedBuiltinTools` from IR built-ins and no `env` block.
- AC9: Every IR `permission` rule that cannot be represented (bash command patterns) appears in `renderReport.lost[]`, is printed at install, and with no `acceptLoss`/explicit shell override the row has `shell:false` (O2).
- AC10: IR `permission.read|edit|glob|grep|task` rules render as server-qualified keys in the owning member's `permissions`; no unscoped `'*'` rule is ever generated.
- AC11: `permission.task` pattern map renders `permissions.allowedAgents`.
- AC12: `steps` renders `maxToolLoops`; `sanitization` and `toolAdvertisement` render on create when declared.
- AC13: A manifest declaring `billingScope`, `tripwire`, `retryWindowMs` or a fallback `models[]` under `render.agent-mcp.provider` fails validation naming the adhd dependency; no such key reaches the payload.
- AC14: `provider: null` renders a row with no `provider` key (O1) and install reports it as unbound.
- AC15: Re-install after removing an `mcpServers` key from the manifest nulls that key in the row (owned keys only; keys not owned by soxe are untouched).
- AC16: Second install of an unchanged manifest reports `unchanged` and does not bump the row version.
- AC17: `reconcile --dry-run` lists, per row, the changed managed fields and the loss report, and mutates nothing.
- AC18: `reconcile` apply over a lossy row requires `--accept-loss`; without it the row is `skipped: lossy`.
- AC19: Uninstall deletes only the row recorded in the ledger (`meta.rowName`), as today.
- AC20: Migrated manifests contain no absolute `/Users/` path and no welded `ADHD_AGENT_DATABASE_PATH`.

## 6. Migration / compatibility for installed agents

Installed rows: the catalog is global; `agent_update` never affects open sessions (adhd README/server text), so rolling forward is safe for running work.
1. Ship renderer + manifest-validation changes first; `soxe install` of unchanged manifests still works because new keys are additive and the old welded shape remains valid until step 4 (warn only).
2. Run `reconcile --dry-run` (AC17): review the per-row diff, expected to show F4 (new explicit `nativeTooling`), F6 (agent-mcp dup removal), F2 (permission loss report).
3. Before apply, snapshot each row (`agent_read fullDefinition:true`) to `tmp/agent-mcp-reconcile/<ts>/<name>.json` (gitignored scratch). Rollback = `agent_update` with the snapshot (cannot clear fields; snapshot restore covers all fields the renderer manages because each is emitted explicitly).
4. Apply per row set in batches; lossy rows only with `--accept-loss`. Rows with no local manifest stay `skipped: no-local-manifest` (never deleted). Then migrate the 21 manifests and flip the old-shape warning to an error.
5. `toolAdvertisement` changes on existing rows wait for the adhd patch-schema fix (F7); until then the renderer leaves it untouched and reports it.
No env var gates any step (ADR-0013 D4: explicit invocations only).

## 7. Test plan (spec only; owner declined tests now)

| AC | Test |
|---|---|
| AC1,2,3,10,11,12,14 | host-registry unit: render golden payloads for `typescript` and a no-bash agent fixture |
| AC4,5,6,7,8,13,20 | host-registry/manifest unit: valid + hostile manifests (negative controls must fail red if the check is removed) |
| AC9 | host-registry unit asserting `lost[]` and `shell:false` with/without `acceptLoss` |
| AC15,16,19 | install-engine integration with the real `AgentCatalogClient` fake extended to model patch-merge semantics from adhd `agent-store.ts` |
| AC17,18 | install-engine reconcile spec over a seeded fake catalog |
| End-to-end | install into a real built agent-mcp over stdio (real MCP client, isolated cwd/HOME) and `agent_read fullDefinition:true`; assert gate denial of a rendered `deny` rule at `task` time |

## 8. Risks

- R1 O3/O2 change what already-installed agents can do (fs/shell/dispatch narrowed); mitigated by dry-run + explicit apply.
- R2 Patch semantics cannot clear fields (F7); mitigated by emitting managed fields explicitly and snapshot rollback; clearing `maxToolLoops` stays unsupported.
- R3 F7 (`toolAdvertisement` stripped) is unconfirmed by execution; confirm with a live `agent_update` before relying on it.
- R4 Multi-catalog ambiguity (F11): reconcile must print the resolved DB path and source before mutating.
- R5 `ADHD_AGENT_DEEPSEEK_MODEL` env pointer for the model: behavior when the env var is unset is unverified; prefer an inline `model` for new profiles after checking `getProviderConfig`.
- R6 Server-qualified gate keys depend on adhd server key names (`fs`,`shell`,`agent-mcp`); pin via a contract test reading the catalog constants.

## 9. Independent segments (cheap executors)

| Seg | Scope | Deps | Read/Out tokens |
|---|---|---|---|
| S1 | Types: `AgentOverride`, single shared `AgentCatalogPayload` (internal.ts, agent-mcp.ts, agent-catalog.ts), `renderReport` | none | 1.5k / 0.8k |
| S2 | Provider profile table + validation + claudecli (AC4,5,7,8,13,14) in agent-mcp.ts | S1 | 2k / 1.2k |
| S3 | `deriveNativeTooling`, permissions mapping, allowedAgents, loss report (AC1,2,9,10,11,12) | S1 | 2.5k / 1.5k |
| S4 | `deriveMcpServers`: dup-agent removal, secret check, toolMap (AC3,6) | S1 | 1.5k / 0.8k |
| S5 | Manifest validation + schema (AC13,20) | S2-S4 shape | 2k / 1k |
| S6 | Client/upsert: fullDefinition reads, null stale keys, ledger meta, digest (AC15,16) | S1 | 2k / 1k |
| S7 | Reconcile drift + dry-run + `--accept-loss` + snapshots (AC17,18) | S6 | 2k / 1.2k |
| S8 | Migrate 21 manifests + docs/changelogs/spec §4.4 | S2-S5 | 3k / 2k |
Dependency (outside this repo, separate adhd ticket): `ProviderConfig` + provider zod schemas + `providerConfigToBinding` must carry `models[]`, `billingScope`, `tripwire`, `retryWindowMs`, and `agentPatchSchema` must include `toolAdvertisement` and reject (not strip) unknown keys; PF-4 must consume `models[]`. AC13 flips to an emit AC when that lands.
