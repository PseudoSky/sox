# Extension Framework Contracts — guideline set

Seven per-type documents, one shared model. Each grades the **framework's contracts** for one
extension type — never a tenant — on the principle that **tenant correctness is downstream of contract
clarity**: where the framework leaves a contract absent or implicit, every tenant is forced to
improvise it, and improvisation is indistinguishable from drift.

- **Model + method:** `_TEMPLATE.md` (the reusable skeleton; method and quality bar in its header).
- **Reference instances:** `mcp.md` (written first), `hook.md`.
- **Companion (current state, not target):** `../architecture-audit.md` — the independent audit of which
  of these contracts actually exist today. The guideline set is the *target*; the audit is the *gap*.

## Contract-clarity legend

| Clarity | Meaning |
|---|---|
| **Defined** | Specified *and* enforced — a tenant cannot violate it silently. |
| **Implicit** | Relied on by convention; not specified or not enforced. |
| **Declared-unimplemented** | A contract *shape* exists but nothing honors it at runtime. |
| **Absent** | The framework provides nothing; every tenant invents its own. |

A hole is any contract that is not **Defined**.

## The five-layer model

| Layer | Section | Question |
|---|---|---|
| 0 | Ecosystem User Actions (Usage) | Who uses this type and what do they do? |
| 1 | Action-Supporting Systems | Which system serves each action? |
| 2 | Output Contracts | What artifacts pass between systems? |
| 3 | Contract Sources | Where does each artifact originate? |
| 4 | Producing Subsystems | Which subsystem produces each artifact — and is that production contracted? (the hole map) |

Every document separates a **type-invariant spine** (scaffold → schema → validate → build → version →
install/cascade → capability gate) from a **type-variable seam** (build → activation → consumption →
eventing). The spine is where the framework holds the line; the seam is what each document exists to
specify.

## The seven types

| Type | Doc | Runtime model |
|---|---|---|
| mcp-server | [`mcp.md`](./mcp.md) | long-lived background server; agent calls tools over MCP |
| hook | [`hook.md`](./hook.md) | fired by the host on a lifecycle event |
| agent | [`agent.md`](./agent.md) | delegated to by an orchestrator; runs to completion |
| skill | [`skill.md`](./skill.md) | invoked by an agent/orchestrator: `run(input)` |
| prompt | [`prompt.md`](./prompt.md) | static template rendered with parameters (no runtime entrypoint) |
| command | [`command.md`](./command.md) | invoked by the operator via a host CLI verb |
| bundle | [`bundle.md`](./bundle.md) | aggregation construct consumed at **install time** via expansion |

## Cross-type synthesis

| Type | Spine contracted / seam not? | Build (#4) | Seam character | Divergence already visible between tenants |
|---|---|---|---|---|
| mcp-server | holds | Absent | transport + descriptors + activation + registrar | — |
| hook | holds (sharper) | Absent | event-binding + dispatch + isolation | `event` vs `events`; `HookContext` re-declared |
| agent | holds (widest seam) | Absent | *no* invocation protocol at all | `tools[]` vs `organizeItems()` |
| skill | holds (deepest per-row) | Absent | one missing call: `run(input)` | — |
| command | holds (full delivery gap) | Absent | no verb→handler dispatch | `run(input)` vs `runCli(argv)` |
| prompt | holds **with deviation** | **N/A** (source *is* artifact) | param-decl + template-syntax + load + inject | — |
| bundle | **does not cleanly reproduce** | **N/A** (nothing to build) | install-time composition, not runtime | — |

### Three findings the set produces that no single document shows

1. **Build/output-generation (#4) is Absent for every *process* type** (mcp-server, hook, agent, skill,
   command) and only N/A for the two non-process types (prompt, bundle). It is the single most
   universal framework hole, and it silently nullifies the otherwise-Defined lockfile (#3) and release
   (#7) contracts — you can pin and publish an artifact that was never generated.
2. **The activation/consumption seam is Absent for all five runtime types.** `prompt` and `bundle` are
   the *only* types whose distribution contracts are genuinely (not nominally) trustworthy — precisely
   because they have nothing to build and nothing to activate.
3. **Every absent contract has *already* produced divergence** between the mere one-or-two existing
   tenants of each type (`event`/`events`, `tools[]`/`organizeItems`, `run`/`runCli`). The causal
   thesis is therefore not predictive but observed: no shared contract → tenants diverge immediately.

## How to add or revise a type document

Copy `_TEMPLATE.md` to `<type>.md`, keep the invariant blocks verbatim, fill the type-specific blocks
from repo evidence, and **strip all `<!-- ... -->` authoring annotations** before saving. If a type's
finding does not reproduce the "spine contracted, seam not" shape (as `bundle` does not), say so and
explain why — the deviation is itself a result.
