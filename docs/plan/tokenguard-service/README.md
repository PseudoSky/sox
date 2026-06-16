<!-- markdownlint-disable MD013 MD033 -->
<!-- gap-check-mode: strict -->
# TokenGuard Service — Implementation Plan

> **Goal:** Promote a first-class `service` extension primitive (transport-parameterized; `mcp-server` folded in as `service[transport=stdio]`), then ship the WOP TokenGuard pseudonymizing proxy as a generalized, provider-agnostic TypeScript `service` extension backed by a reusable `tokenguard-core` engine library.
>
> **Spec:** `scripts/tokenguard/*` (Python source) + `extensions/mcp-servers/memory-server` (reference extension/config system)
> **Executor:** `sox-active:typescript-pro`
> **Author:** planner
> **Created:** 2026-06-16

---

## What this directory is

A **resumable state machine**. The work is decomposed into 9 work states plus 4 audit hold points and a terminal `done`. Each state is a self-contained work order keyed by an immutable **slug**. Structure (`dag.json`) and runtime (`state.json`) are separate so reordering is cheap and progress is durable.

```text
docs/plan/tokenguard-service/
├── README.md
├── dag.json          ← STRUCTURE: nodes (slug → phase, depends_on, guard, artifacts, context)
├── state.json        ← RUNTIME: current_state, per-slug status+timestamps, transition/amendment logs
├── references.json   ← Reference Pattern Catalog ([ref:] idioms the change must mirror)
├── state-machine.md  ← human render of dag.json
├── final-review.md   ← filled Step-7 checklist (publish gate)
├── scripts/          ← audit_tokenguard.py + per-state guard scripts + vendored gap-check/env-pin
└── contexts/
    ├── _shared.md
    └── <slug>.md
```

Identity is the slug. Ordering comes from `dag.json` (`depends_on`), so inserting/splitting a state never renumbers anything; criterion IDs (`[<slug>.n]`) stay stable.

---

## How the executor uses this plan

1. **Read `state.json` + `dag.json`.** Find `current_state`; if `in_progress`, resume. Otherwise pick the first `pending` node whose `depends_on` are all `done`.
2. **Read that state's context** (`contexts/<slug>.md`) + `_shared.md` for referenced definitions. That is the complete work order.
3. **Do the work** inside the declared `mutates` reservation only.
4. **Run the guard.** No advance until it exits 0.
5. **Update runtime + commit (R1).** Every plan-file write is immediately committed; honor each context's `Commit points`.
6. **Stop at the state boundary.** One state per session.

**Never skip a guard. Never leave a plan write uncommitted.**

Drive transitions with the transition engine, never by hand-editing `state.json`:

```bash
node "$SKILL/state-transition.js" docs/plan/tokenguard-service <slug> --start
# … do the work …
node "$SKILL/state-transition.js" docs/plan/tokenguard-service <slug> --complete --note "<what you did + verified>"
```

### If reality diverges from the work order

Classify: *does it alter the dependency graph, target-state invariants, or final-audit coverage?* **No** → amend in place (expand `mutates`/`artifacts`, add a criterion + its audit check, fix a wrong guard), sync all representations, append `amendment_log`, commit, continue. **Yes** → stop, record the reason, escalate to the planner.

---

## Consumer

Two consumers walk through this change; the headline outcome is the operator's.

- **The operator / red-teamer** — a person running an LLM agent who needs the model provider to never see real target identifiers, while their own tools and logs keep operating on the real values. They interact only through the `sox` command line and by pointing their client's base-URL environment variable at the proxy.
- **The extension author** — an engineer who needs to ship a long-running networked background service (one that holds a port, is health-checked, and is stopped cleanly) as a first-class sox extension, scaffolded the same way every other extension is.

---

## Value delta

- **Before:** sox can only supervise stdio servers; there is no first-class, transport-parameterized way to ship a port-holding network service. Pseudonymizing model traffic requires the Python TokenGuard, which is welded to the red-team workspace layout (a rules-of-engagement file, engagement directories, an offensive test harness) and to one model provider.
- **After:** an author scaffolds a born-conformant `service` extension in one command; an operator installs, starts, health-checks, and stops a generalized TypeScript pseudonymizing proxy through the `sox` command line. Pointing the client base-URL variable at it makes real identifiers leave as placeholders and come back restored — exactly — for any model provider, in any repository, with zero red-team coupling, and with the running proxy keeping a live, operator-seedable token map.

---

## Definition of Done

> Agreed interactively with the requester in **Step 1a**. The plan-level success contract — *what the whole change means when finished and correct* — distinct from per-state acceptance criteria. Each clause is IDed `[dod.N]` and proven by ≥1 final-audit check; behavioral clauses are proven **through their declared entrypoint** (tier 3), structural clauses by grep/AST.

- `[dod.1]` **Outcome (behavioral)** — An extension author can scaffold a new long-running networked service that passes conformance with no manual edits.
  - given: a clean checkout of the monorepo with the command line built
  - when: the author scaffolds a new extension of kind `service` and builds it
  - then: conformance validation reports the scaffolded service as valid
  - entrypoint: `bash tools/tg-plan/check-service-scaffold.sh`
  - observable: stdout contains `SCAFFOLD OK` and the validator exits 0
  - negative-control: corrupt a required manifest field in the service scaffold template so `bash tools/tg-plan/check-service-scaffold.sh` prints `SCAFFOLD FAIL`
  - delivered-by: service-type
- `[dod.2]` **Outcome (behavioral)** — An operator can start a port-holding network service through the command line, see it reported healthy, and stop it leaving nothing running.
  - given: a built, installed networked service
  - when: the operator starts it, lists status, then stops it
  - then: status shows healthy while up, and after stop no process or held port remains
  - entrypoint: `bash tools/tg-plan/check-http-service.sh`
  - observable: stdout contains `HTTP SERVICE HEALTHY` and later `STOPPED CLEAN orphans=0`
  - negative-control: point the health endpoint at a dead port in `bash tools/tg-plan/check-http-service.sh` so it prints `HTTP SERVICE UNHEALTHY`
  - delivered-by: http-transport
- `[dod.3]` **Outcome (behavioral, non-regression)** — The existing memory service still starts, answers a ping, and refuses a forbidden write exactly as before the refactor.
  - given: the framework refactored so the stdio server rides the unified service model
  - when: the operator starts the memory service and exercises it plus its permission guard
  - then: it answers healthy and the out-of-policy write is denied with no file created
  - entrypoint: `bash tools/tg-plan/check-memory-nonregress.sh`
  - observable: stdout contains `MEMORY OK` and `C6 DENY OK`
  - negative-control: weaken the permission guard so `bash tools/tg-plan/check-memory-nonregress.sh` prints `C6 DENY FAIL`
  - delivered-by: mcp-as-service
- `[dod.4]` **Outcome (behavioral)** — The pseudonymization engine runs its invariant suite green: every tokenized sample is restored to its exact original and no known identifier reaches the wire.
  - given: the ported engine library
  - when: its invariant suite runs
  - then: round-trip, zero-leak, split-token-reassembly and passthrough invariants all hold
  - entrypoint: `npx --yes nx test tokenguard-core`
  - observable: the core suite reports `PASS` with zero failing tests
  - negative-control: break the reverser in the engine so `npx --yes nx test tokenguard-core` reports failing tests
  - delivered-by: core-engine, core-invariants
- `[dod.5]` **Outcome (behavioral) — HEADLINE** — An operator can route their model traffic through the proxy so real identifiers leave as placeholders and the reply comes back with the real values restored, byte-for-byte.
  - given: the proxy running under the command line with a seeded identifier and a stand-in upstream
  - when: a client sends a request containing the real identifier through the proxy
  - then: the upstream receives only placeholders (zero leak) and the client receives the reply with the real values restored exactly
  - entrypoint: `bash extensions/services/tokenguard/demo/proxy-roundtrip.sh`
  - observable: stdout contains `ROUNDTRIP OK` and `LEAKS 0`
  - negative-control: break the inbound reverser so `bash extensions/services/tokenguard/demo/proxy-roundtrip.sh` prints `ROUNDTRIP FAIL`
  - delivered-by: tg-service
- `[dod.6]` **Outcome (behavioral)** — While the proxy is running, an operator can register a new identifier from the command line and immediately see it applied to live traffic.
  - given: the proxy already running
  - when: the operator registers a new identifier and sends traffic containing it
  - then: the new identifier is present in the live map and is replaced on the wire without a restart
  - entrypoint: `bash extensions/services/tokenguard/demo/live-seed.sh`
  - observable: stdout contains `LIVE SEED REFLECTED`
  - negative-control: disable the live-map reload so `bash extensions/services/tokenguard/demo/live-seed.sh` prints `LIVE SEED MISSED`
  - delivered-by: tg-cli
- `[dod.7]` **Old system gone (structural)** — No engagement-specific coupling remains in the ported engine or service: the red-team workspace assumptions, the rules-of-engagement file dependency, and the bespoke offensive test harness are all absent from the new code.
  - delivered-by: decouple-generalize
- `[dod.8]` **Old system gone (structural)** — The proxy is not welded to a single model provider: a provider-adapter abstraction is present with both a default-provider adapter and a generic passthrough adapter, and no provider hostname is hard-coded inside the engine library.
- `[dod.9]` **Reviewer (structural)** — "Done" is accepted by the founder via a live command-line demonstration, after an architecture review of this plan and a code review of the implementation. The demonstration preserves four artifacts: the prompts the agent sent, a diff of where placeholders were substituted outbound, the raw provider reply, and a diff of where placeholders were restored inbound.
  - delivered-by: code-review
- `[dod.10]` **Non-goal (structural)** — This plan does not add operating-system kernel sandboxing, does not fully supervise the streaming or unix-socket transports (they are declared in the type vocabulary but only the stdio and http transports are fully supervised here), and does not port the offensive red-team test phases.
- `[dod.11]` **Failure / rollback (structural)** — If any audit finds the memory service regressed or the proxy leaking a real identifier onto the wire, the plan halts; partial completion is never "done"; recovery is a revert of the plan commits on the feature branch.

---

## Glossary

> Consumer-owned terms — declared so the DoD builder-token lint allows them in clause prose.

- `tokenguard` — the proxy service the operator runs; the consumer types this name on the command line.
- `tokenguard-core` — the engine library the operator's invariant proof runs against; named by the consumer when validating.
- `sox` — the command line the operator and author drive everything through.
- `pseudonymize` — the operator's word for swapping real identifiers to placeholders on the wire and back.

---

## Execution model

> Decided with the requester in **Step 1b**.

- **Parallel execution:** **yes** — the `framework` track (`service-type → http-transport → mcp-as-service → audit-framework`) and the `core` track (`core-engine → core-invariants → audit-core`) touch disjoint files and run in parallel; they converge at `tg-service`. No shared mutable file crosses the two tracks, so no merge protocol is required.
- **Implementer agent(s):**
  - [ ] `sox-active:typescript-pro` — all work states (framework, core, service, final).
- **Review:** **yes** — reviewer **the founder**, accepting via a live command-line demonstration at `audit-final`; gated first by an **architecture review of this plan** (before execution) and a **code review of the implementation** (state `code-review`, performed by the orchestrator).
- **Automatic dispatch:** **yes (deferred)** — the planner may orchestrate execution itself, but **must not begin until the founder gives the go** after the architecture review of this plan. The Dispatch line is the resumable entry point.

---

## Design invariants

These hold throughout the migration, not just at the end. Full definitions in `contexts/_shared.md`.

- **[inv:no-regress-mcp]** — `mcp-server` stays a valid type name and `memory-server` non-regresses (build/validate/install/start/health/stop + C6 denial) at every audit hold point.
- **[inv:bijective-roundtrip]** — `detokenize(tokenize(x)) === x` for all text under a consistent map; a token never reverses to two reals; IDs are never reassigned.
- **[inv:wire-guarantee]** — after tokenizing the request-scoped regions (system/messages/metadata), no mapped real survives on the wire; `tools` JSON-Schema is left verbatim.
- **[inv:single-registry]** — all transports register through the one service registry the supervisor reads; no parallel service store is introduced.
- **[inv:standard-config]** — service configuration flows exclusively through the standardized `config_schema` → install-prompt → `SOX_CONFIG_*` path; no bespoke config reader.
- **[inv:c7-no-reach-in]** — the service consumes the engine via the `@sox/tokenguard-core` package scope; no cross-package `../dist` reach-in.

---

## Status at a glance

```bash
python3 -c "
import json
dag = json.load(open('docs/plan/tokenguard-service/dag.json'))
st  = json.load(open('docs/plan/tokenguard-service/state.json'))
print('current:', st['current_state'])
for slug, node in dag['nodes'].items():
    status = st['states'].get(slug, {}).get('status', '?')
    print(f'  [{node[\"phase\"]}] {slug}: {status}')
"
```
