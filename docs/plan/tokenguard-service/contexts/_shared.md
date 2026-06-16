# Shared context — TokenGuard Service

> **Single source of truth for definitions.** Every work-state context references entries here by name instead of restating them. Change a definition once, here.

---

## Glossary

Reference as **[def:term]** from any context.

- **[def:service-type]** — the new declarable manifest `type: "service"` carrying a `transports` array (`stdio|http|sse|socket`). A long-running, supervised, port/socket-holding background extension. Lives in `libs/manifest/src/index.ts` (`VALID_TYPES` + the `Manifest`/`ManifestInstall` unions) and `scripts/new-extension.ts` (`VALID_TYPES` duplicate).
- **[def:transport]** — how a service is reached. `stdio` (today's mcp-server), `http` (the proxy), `sse`, `socket` (memoryd-style). This plan fully supervises `stdio` + `http` only; `sse`/`socket` are declarable but not fully routed ([dod.10]).
- **[def:unified-service-model]** — the single install→register→supervise path: install resolves a host-registry `service` surface, registers via the `run-service` capability ([ref:run-service-spec]), and the supervisor spawns + health-probes + stops it ([ref:supervisor-stop]). Both `stdio` and `http` transports flow through it; `mcp-server` is folded onto it as `service[transport=stdio]`.
- **[def:tokenguard-core]** — the ported engine library `@sox/tokenguard-core` at `libs/tokenguard-core/`. Pure, IO-light: the bijective Mapper, detector pipeline, tokenize/detokenize, SSE reassembly. No network, no provider, no red-team vocabulary.
- **[def:tokenguard]** — the `service`-type extension at `extensions/services/tokenguard/` running the generalized HTTP pseudonymizing proxy on top of [def:tokenguard-core].
- **[def:provider-adapter]** — the abstraction that isolates per-provider streaming/format specifics (request scoping, SSE delta reassembly, thinking-block passthrough). Ships a default-provider adapter + a generic passthrough adapter; the engine itself is provider-agnostic.
- **[def:live-map]** — the bijective, origin-tagged token store the running proxy continuously persists. The CLI seeds + inspects the same store; the running proxy reflects CLI seeds without restart.
- **[def:capture-policy]** — the configurable logging surface (body capture mode full/truncated/none + caps, the audit log, the always-on token map) carried in config.

---

## Cross-cutting invariants

- **[inv:no-regress-mcp]** — `mcp-server` remains a valid manifest type name and `memory-server` non-regresses across its full lifecycle (build/validate/install/start/health/stop) **and** the C6 forbidden-write denial, at every audit hold point. Check: `bash tools/tg-plan/check-memory-nonregress.sh` ⇒ `MEMORY OK` + `C6 DENY OK`.
- **[inv:bijective-roundtrip]** — `detokenize(tokenize(x)) === x` for all text under a consistent map; a real always maps to the same token; a token never reverses to two reals; IDs are never reassigned across restarts. Check: the core round-trip suite.
- **[inv:wire-guarantee]** — after tokenizing only the request-scoped regions (`system`/`messages`/`metadata`), no mapped real survives there; `tools` JSON-Schema and `thinking` signatures pass through verbatim. Check: the core leak + scoping suite + the live round-trip leak count.
- **[inv:single-registry]** — every transport registers through the one service registry the supervisor reads ([ref:run-service-spec]); no parallel/second service store. Check: grep that only the one registry write site exists.
- **[inv:standard-config]** — configuration flows only through `config_schema` (`x-sox-prompt`/`x-sox-default`) → install prompt → `SOX_CONFIG_*` env ([ref:config-schema]); no bespoke config-file reader in the service. Check: the service reads `SOX_CONFIG_*`, not a hand-rolled loader.
- **[inv:c7-no-reach-in]** — the service imports the engine via the `@sox/tokenguard-core` scope only; no `../dist` reach-in ([ref:c7-no-reach-in]). Check: `@nx/enforce-module-boundaries` + the C7 lint rule pass.

---

## Shared fixtures and sample data

- **[fix:roundtrip-sample]** — `extensions/services/tokenguard/test/fixtures/roundtrip.json` — a request containing a seeded real identifier + a synthetic streamed reply whose placeholder is split across two deltas; used by the core SSE suite and the live demo to prove exact reversal + split-token reassembly.
- **[fix:mock-upstream]** — `extensions/services/tokenguard/demo/mock-upstream.mjs` — a tiny stand-in HTTP upstream that echoes the received (tokenized) body back as a streamed reply, so the live demo proves wire-content + reversal without a real provider.

---

## Reference patterns (`[ref:]` — pointers, never restated)

Cited by states; verified once each by `audit-final`. Full catalog data in `references.json`.

- **[ref:config-schema]** — anchor `extensions/mcp-servers/memory-server/extension.json:config_schema`. Rule: config via `config_schema` (`x-sox-prompt`/`x-sox-default`, `additionalProperties:false`) read at runtime through `SOX_CONFIG_*` env only.
- **[ref:run-service-spec]** — anchor `libs/install-engine/src/capabilities/run-service.ts:apply`. Rule: preserve the `registry.json` entry shape `{id,command,args,env,cwd,status,storePath}`; one registry for all transports.
- **[ref:supervisor-stop]** — anchor `libs/host-runtime/src/supervisor.ts:stop`. Rule: SIGTERM → `stop_timeout_ms` → SIGKILL; zero orphans, port released.
- **[ref:born-conformant-template]** — anchor `libs/authoring/src/templates/mcp-server/index.ts:mcpServerTemplate`. Rule: the `service` template emits a born-conformant fileset so init→build→validate is clean.
- **[ref:host-keyed-target]** — anchor `libs/authoring/src/templates/_shared.ts:buildInstallDescriptor`. Rule: no literal host paths in the template; host-registry resolves the target.
- **[ref:c7-no-reach-in]** — anchor `eslint.config.js:no-restricted-syntax`. Rule: consume the engine via `@sox/tokenguard-core`; no `../dist` reach-in.
- **[ref:c6-policy-guard]** — anchor `extensions/mcp-servers/memory-server/src/index.ts:compilePolicyFromEnv`. Rule: enforce declared fs/network permissions at the resource sink before the side effect.

---

## Type and config shapes

```text
[shape:token-map]   token-mapping.json v2 — the live bijective cache
  { "version": 2, "entries": [
    { "token": "<HOST_1>", "real": "vulntarget", "type": "host",
      "source": "seed|proxy|tooling|custom", "created_ts": "<ISO-8601>" } ] }

[shape:service-install]  manifest install descriptor for a service
  { "type": "service",
    "transports": ["http"],               // ⊆ the type's transport vocabulary
    "serves": ["http"],                    // back-compat alias kept in sync with transports
    "profiles": { "http": { "transport": "http" } },
    "hosts": ["claude"] }                  // target path resolved by host-registry

[shape:http-health]  lifecycle health block for an http service
  { "background": true, "singleton": true,
    "health": { "type": "http-get", "endpoint": "http://127.0.0.1:${PORT}/_tokenguard/health",
                "interval_ms": 30000, "timeout_ms": 5000 },
    "stop_timeout_ms": 5000 }

[shape:provider-adapter]  the per-provider seam
  interface ProviderAdapter {
    name: string;
    scopeRequest(body: unknown): { tokenizable: unknown; verbatim: unknown };  // request scoping
    reverseStream(raw: string, reverse: (s: string) => string): string;        // SSE/JSON reversal
  }
```
