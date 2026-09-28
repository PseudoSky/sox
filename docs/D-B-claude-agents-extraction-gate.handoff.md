# D-B handoff — `claude-agents` authoring gate + git-manager binding

> **Status: DESIGN-ONLY / HANDOFF.** These pieces live in the **`claude-agents`**
> repo, which is outside this change's isolated worktree. Per the D-B dispatch
> instruction ("if a required piece lives in the claude-agents repo, implement it as
> a design-only/handoff note and REPORT it rather than reaching into a third repo
> unasked"), this document fully specifies the intended implementation; it is not
> applied here. Ticket `48d7dcea-121c-42f7-b906-f247ee69a799`, segment **S6**.
>
> Spec: `docs/product/feature-research/substrate-fleet/specs/D-B-artifact-lifecycle.spec.md`
> (Files table rows: `claude-agents/tools/authoring/extraction-gate.mjs`,
> `…/extraction-gate.spec.mjs`, `extensions/agents/git-manager/git-manager.md`).

## 1. The extraction gate (AC7 / B-I8 / DESIGN §2 D5)

**Problem.** A mechanism must not be generalized into an agent/skill until it has
≥2 **independent** instances. `user-thinking`'s `generalize` action
(`tools/skills/user-thinking/SKILL.md:45`) currently has no check — the missing gate
`dbd2d393` names. The gate must be a **pure function over a proposal record** so it
is unit-testable, and injected at the `generalize` call site.

**Create `claude-agents/tools/authoring/extraction-gate.mjs`:**

```js
/**
 * A single observed instance of the mechanism being generalized.
 * @typedef {{ path: string, callSite?: string, context?: string }} Instance
 * @typedef {{ mechanism: string, instances: Instance[] }} ExtractionProposal
 */

/** Two instances are independent iff their `path:callSite` identities differ. */
function instanceIdentity(i) {
  const p = String(i?.path ?? '').trim();
  const c = String(i?.callSite ?? '').trim();
  return `${p}::${c}`;
}

/**
 * @param {ExtractionProposal} proposal
 * @returns {{ accepted: boolean, reason: string, instanceCount: number }}
 */
export function evaluateExtractionProposal(proposal) {
  const instances = Array.isArray(proposal?.instances) ? proposal.instances : [];
  const ids = new Set(instances.map(instanceIdentity).filter((id) => id !== '::'));
  if (ids.size < 2) {
    return {
      accepted: false,
      reason:
        `extraction refused: generalizing "${proposal?.mechanism ?? '(unnamed)'}" ` +
        `requires >=2 INDEPENDENT instances (distinct path/call-site); found ${ids.size}. ` +
        `Two spellings of one call site are one instance.`,
      instanceCount: ids.size,
    };
  }
  return { accepted: true, reason: `accepted: ${ids.size} independent instances`, instanceCount: ids.size };
}
```

- A **distinct `path`** or a **distinct `callSite`** counts as an independent
  instance; the *same* `path`+`callSite` counted twice is one instance (the spec's
  "not two spellings of one").
- The refusal is a **typed reason string**, never a bare boolean, so the caller can
  surface *why*.

**Create `claude-agents/tools/authoring/extraction-gate.spec.mjs`** (AC7):
- accepts a 2-instance proposal (distinct paths) → `accepted: true`;
- refuses a 1-instance proposal → `accepted: false` with a reason mentioning `>=2`;
- refuses a 2-"instance" proposal whose two entries share `path`+`callSite` → one
  independent instance → refused (the negative control for the independence rule).

**Wire it into `generalize`.** At `tools/skills/user-thinking/SKILL.md:45`, the
`generalize` action must call `evaluateExtractionProposal(...)` and **refuse**
(no mechanism emitted) unless `accepted === true`, printing the typed `reason`.
Negative control (AC7): bypassing the gate ⇒ a single-instance proposal is
generalized ⇒ RED.

## 2. git-manager binding (BLOCKED phase — out of the critical path)

`extensions/agents/git-manager/git-manager.md` (documented target path; **no file on
disk today** — see the spec's Grounding note) is to be updated so that git-manager
consumes `<project>/docs/GIT-POLICY.md` and **refuses any git op it cannot bind to a
policy clause**. Per the spec this is **blocked by items 1–3** (drift/reconcile must
exist first) and is explicitly **not in the critical path** — so it is intentionally
**not implemented** in this change. When unblocked: the binding is a lookup
`gitOp → policyClause`; an unbound op is a hard refusal naming the missing clause.

## 3. What the sox-side change already provides (dependency for both)

This worktree delivers the sox half of D-B that the gate/binding build on:
`atomicWriteFileSync`, strict `readOwnership`, `detectDrift` (hash-only verdicts),
`reconcile` (read-only), `backfillHashes`, and `planRetention`/`applyRetention`/
`sweepTrash` — committed on `feat/db-artifact-lifecycle`. No `claude-agents` file
was created or modified by this change.
