<!-- markdownlint-disable MD013 MD033 -->
# schema-delta — Host-keyed install descriptor + lifecycle deprecation

> **Slug is identity.** This filename and the `schema-delta` slug are immutable once assigned.
> Ordering comes from `dag.json` (`depends_on`), not from this name. Splitting or inserting a state
> never renames this one.

**Phase:** foundation · **Depends on:** (none) · **Guard:** `./node_modules/.bin/nx run manifest:test && ./node_modules/.bin/nx run manifest:build`

---

## Goal

After this state the manifest schema describes the **hybrid install descriptor** instead of the
old single-string `install-target`: a host-agnostic `type` plus chosen `profiles`/`hosts` plus
per-host overrides, with new `config`, `serves`, `profiles`, and `source` (provenance) fields. The
validator enforces the new shape and — critically — **rejects** the vestigial `lifecycle` block on
`type: agent` (the schema accepted what the runtime ignored). This is the foundation every
downstream state builds on: the capability engine, host registry, generators, and install
lifecycle all consume this descriptor (**[shape:install-descriptor]**).

It exists first because nothing else can be authored against a descriptor that doesn't yet exist.
The change is **additive** to existing manifests except for the `agent` `lifecycle` rejection
(**[dod.6]**), so back-compat holds for everything else.

---

## Semantic Distillation

- **Primitive:** MODIFY `libs/manifest/src/schema.json` + `libs/manifest/src/index.ts` — generalize
  the install contract and tighten `validate()`.

- **Reference Pattern:** the current `install-target` handling in `libs/manifest/src/index.ts` and
  the existing schema; spec §3.1 (three layers), ADR resolved #2 (hybrid descriptor), spec §4/§4b
  for the surface/key constraints `validate()` must enforce.

- **Delta Spec:**
  - Add the **[shape:install-descriptor]** to the schema: `install.{type,hosts,profiles,serves,
    source,overrides}`. Keep the old `install-target` accepted (back-compat) but normalized to the
    new shape internally.
  - Add `config` (permissions/env carried on the built extension), `serves` (**[def:serves]**),
    `profiles` (**[def:profile]**), and `source` (**[def:source-provenance]**).
  - `validate()` now enforces: `profiles ⊆ serves`; every referenced host surface is a **known**
    surface; refuses the Claude **[def:managed-tier]** and Codex **[def:project-forbidden-keys]**
    (**[inv:never-managed]**); **rejects `lifecycle` when `type === "agent"`** (**[dod.6]**).
  - `validate()`'s **signature is unchanged** (behavior only) — no symbol churn, so no `changes`.

- **Invariants:** **[inv:never-managed]** (validator refuses managed/forbidden keys);
  **[inv:host-agnostic-type]** (the descriptor stores a host-agnostic type; targets are not
  hard-coded here). Additive back-compat for non-agent manifests.

- **Validation:** `./node_modules/.bin/nx run manifest:test && ./node_modules/.bin/nx run manifest:build`
  — unit tests assert the new fields validate, `profiles ⊆ serves` is enforced, managed/forbidden
  keys are refused, and an `agent` manifest carrying `lifecycle` now **fails** validation; the build
  compiles the schema + types.

---

## Acceptance criteria

Checked by `audit-foundation` as slug-keyed criterion IDs. The audit script contains one check per
item. None may be deferred.

- [ ] **[schema-delta.1]** The schema declares the hybrid install descriptor fields.
      `grep -nE '"(profiles|serves|source)"' libs/manifest/src/schema.json` → non-empty.
- [ ] **[schema-delta.2]** `validate` rejects `lifecycle` on `type: agent` (**[dod.6]**).
      A manifest fixture with `type:"agent"` + `lifecycle` makes `manifest:test` assert a validation
      error; `grep -n 'lifecycle' libs/manifest/src/index.ts` shows the agent-reject branch.
- [ ] **[schema-delta.3]** `validate` enforces `profiles ⊆ serves`.
      `grep -nE 'serves|profiles' libs/manifest/src/index.ts` shows the subset check; `manifest:test`
      covers a profile-not-in-serves rejection.
- [ ] **[schema-delta.4]** `validate` refuses managed (claude) / project-forbidden (codex) keys
      (**[inv:never-managed]**). `manifest:test` covers a managed-key rejection.
- [ ] **[schema-delta.5]** Existing (non-agent) manifests still validate — back-compat preserved.
      `./node_modules/.bin/nx run manifest:build` exits 0 and `manifest:test` green.

---

## Reservations

```text
read_only:  ["docs/plans/extension-install-and-reinjection-model.md",
             "docs/decisions/0002-extension-install-model.md"]
mutates:    ["libs/manifest/src/index.ts",
             "libs/manifest/src/schema.json",
             "libs/manifest/src/manifest.spec.ts"]
```

---

## Contract Promise

- **Added:** install-descriptor fields (`profiles`, `serves`, `source`, `config`, `overrides`) to
  `schema.json`; validation branches in `index.ts`.
- **Modified:** `validate()` behavior (signature unchanged) — enforces subset/known-surface/
  no-managed and rejects `agent.lifecycle`.
- **Deleted:** nothing (single-string `install-target` is normalized, not removed here; its
  *consumer* path is replaced in `install-lifecycle`).

---

## Commit points

- [ ] **After the schema + validator land and `manifest:test` is green** (mandatory) — commit source
      changes **and** the `state.json` / `dag.json` updates together:
      `feat(eim): schema-delta complete — hybrid descriptor + agent-lifecycle reject — guard green`

Single-commit state.

---

## Notes for executor

- The `agent.lifecycle` rejection is a **behavior change** that other manifests may trip on — grep
  `extensions/**/extension.json` for any `agent` carrying `lifecycle` before you tighten, and fix
  the manifest, not the validator.
- Do not hard-code host paths here — targets belong in `host-registry`. This state only describes
  the *shape*; resolution is downstream (**[inv:host-agnostic-type]**).
- Keep the descriptor additive: a manifest with the old single-string `install-target` must still
  validate (back-compat, **[schema-delta.5]**).
