# SPEC — PKT-38 / BL-375

`service enable` rebuilds unit env from the invoking shell and silently drops tunables while
reporting success.

Architect: architect-reviewer. Worktree: `.worktrees/pkt38-service-enable-env`, branch
`feat/pkt38-service-enable-env`. Toolchain verified working in-worktree (`pnpm install` clean,
`npx nx test host-runtime -- os-unit.spec.ts` → 63/63 green) before this spec was written.

---

## 1. Root cause

`buildOsUnitEnv(extId, root)` (`apps/sox/src/main.ts:4679-4687`) composes the env baked into a
generated OS unit as:

```
const env = scrubEnvReported('os-unit');       // ← filters process.env of the SHELL RUNNING `soxe`
Object.assign(env, buildExtConfigEnv(extId, root));  // ← resolved SOX_CONFIG_* cascade, NOT shell
return env;
```

`scrubEnvReported` (`libs/host-runtime/src/env-policy.ts:182-197`, policy in `:135-157`) forwards
`SOX_*`/`NODE_*`/base keys out of **`process.env` of whatever process is currently running
`soxe`**. It has no memory of any unit ever generated before. `resolveOsUnitContext`
(`apps/sox/src/main.ts:4696-4768`) calls `buildOsUnitEnv` at `:4732` and hands the result straight
into `deriveOsUnitSpec` → `OsUnitSpec.env`. `cmdService`'s `enable` branch
(`apps/sox/src/main.ts:4829-4891`) passes that spec straight into `enableOsUnit`
(`libs/host-runtime/src/os-unit.ts:886-937`), which — confirmed by reading it in full — renders
the spec, and if the content hash differs from what's on disk, **unconditionally overwrites the
unit file** (`:921`, `writeFileAtomic`) and reports `created`/`updated` with no comparison against
what the previous unit's env actually contained. `resolveOsUnitDir`/`unitPath` computation already
reads the prior file's bytes at `:904` (`fs.readFileSync(unitPath, 'utf8')`) — **only** to extract
the prior content hash (`readUnitMeta`, `:419-426`), never the env inside it.

Net effect, exactly as filed: any `SOX_*` tunable that was baked into the unit by a *previous*
`enable` call, and is not exported in *this* invocation's shell, disappears from the regenerated
unit with no diagnostic, and `enable` reports success (`:4880-4889`) with a `loaded: yes` line that
says nothing about what changed. `SOX_CONFIG_*`/`SOX_PERM_*` are structurally exempt from this —
they come from `buildExtConfigEnv`'s resolved-config cascade (`apps/sox/src/main.ts:345-366`), not
the shell, so their presence/absence is a legitimate function of stored config, not ambient
environment. The bug is specifically in the **shell-forwarded half** of the merge.

The invariant this violates already has a name in the spec, written the day the incident was
caught: `[inv:env-preserved-on-regenerate]` (`docs/spec/service-lifecycle.md:774-781`, also listed
in the invariant index at `:1046`). That section currently ends with *"Until this is fixed: export
every variable you intend to keep, and diff the plist afterwards"* — §5 below requires updating
that prose once the fix lands; leaving stale "not yet fixed" prose next to a fixed invariant is
itself a footgun for the next reader.

---

## 2. The change, file by file

### `libs/host-runtime/src/os-unit.ts` — the fix lives here (in bounds)

This is the correct choke point, not `main.ts`: `enableOsUnit` is `[inv:os-unit-generated]`'s *one*
sanctioned write path (module header, `:10-12`), it already reads the prior unit's bytes for the
content-hash comparison, and putting the guard here protects every future caller of `enableOsUnit`,
not just `cmdServiceEnable`.

1. **New pure exported function `extractUnitEnv(unitText: string, kind: OsSupervisor):
   Record<string, string>`.** Parses the env this module itself wrote (both renderers are
   self-consuming — `[inv:os-unit-generated]` forbids hand-authoring, so no third-party format ever
   reaches this parser):
   - `kind === 'launchd'`: the `<key>K</key>\n<string>V</string>` pairs between the
     `<key>EnvironmentVariables</key>` marker and its closing `</dict>` (mirror the existing
     line-based style of `readUnitMeta`, `:419-426`). Reverse `xmlEscape` (`:503-505`) — unescape
     `&lt;` → `<`, `&gt;` → `>`, **then** `&amp;` → `&` (that order, `xmlEscape` escapes `&` first
     when writing so the reverse must undo it last).
   - `kind === 'systemd'`: each `^Environment=([^=]+)=(.*)$` line (renderer at `:698`, one key per
     line — confirmed by reading `renderBody`). Split only on the *first* `=` after the key; systemd
     never puts `=` in the key.
   - Malformed/absent `EnvironmentVariables` block (e.g. reading a foreign or hand-edited file) →
     return `{}`, never throw. A parse failure must not block a legitimate enable; it degrades to
     "nothing to diff against," which is the pre-fix behaviour, not a new failure mode.

2. **New pure exported function `droppedShellEnvKeys(priorEnv, nextEnv, unsetKeys): string[]`.**
   Given the prior unit's full parsed env and the freshly-computed `spec.env`, returns prior keys
   that are:
   - present in `priorEnv`, absent from `nextEnv`, **and**
   - "shell-sourced" — i.e. exactly the set `scrubEnvReported` would have forwarded: `key` is one of
     `ENV_BASE_ALLOW` (`env-policy.ts:87-97`), or starts with `NODE_`, or starts with `SOX_` **and
     not** `SOX_CONFIG_`/`SOX_PERM_` (`env-policy.ts:100,110`) — **and**
   - not in `unsetKeys` (the operator's explicit acknowledgment list, see decision D3).

   This function needs `ENV_BASE_ALLOW`/`ENV_ALLOW_PREFIXES`/`ENV_DENY_PREFIXES` from
   `./env-policy.js` — import them (they are already exported: `env-policy.ts:87,100,110`). This
   keeps the *definition* of "shell-sourced" in exactly one place (env-policy.ts), so the guard can
   never drift from what `scrubEnvReported` actually forwards.

3. **`EnableOptions` gains `unsetKeys?: string[]`** (`os-unit.ts:850-862`) — the caller's explicit,
   per-key acknowledgment that a drop is intentional (D3).

4. **`EnableAction` gains `'blocked'`** (`os-unit.ts:839`) alongside `created|updated|unchanged`.

5. **`EnableResult` gains `droppedEnvKeys?: string[]`** (`os-unit.ts:841-848`) — populated only when
   `action === 'blocked'`, so the CLI can print exactly which keys triggered the refusal without
   re-deriving them.

6. **`enableOsUnit` body change** (`os-unit.ts:886-937`): insert the guard **after** `priorHash`/
   `contentSame` are computed (`:903-905`) and **before** the `writeFileAtomic` call (`:921`) — i.e.
   only on the path that is actually about to write, whether or not `load` is requested. (A
   `contentSame` unit, by construction, has identical rendered content to `spec.env`, including
   env — nothing can have been dropped on that path, so it's correctly exempt and the existing
   early return at `:909-912` is untouched.)

   ```
   if (existed) {
     const priorEnv = extractUnitEnv(fs.readFileSync(unitPath, 'utf8'), platform.kind);
     const dropped = droppedShellEnvKeys(priorEnv, spec.env, opts.unsetKeys ?? []);
     if (dropped.length > 0) {
       log(`os-unit ${spec.label}: BLOCKED — regenerating would silently drop ${dropped.length} ` +
           `previously-set env key(s): ${dropped.join(', ')} (BL-375 [inv:env-preserved-on-regenerate]). ` +
           `Export them in this shell before re-running 'service enable', or pass ` +
           `--unset ${dropped.join(',')} to acknowledge the removal is intentional. ` +
           `Unit file NOT written.`);
       return {
         action: 'blocked', unitPath, label: spec.label,
         contentHash: priorHash ?? newHash, loaded: currentlyLoaded, droppedEnvKeys: dropped,
       };
     }
   }
   ```

   Note this re-reads `unitPath` a second time (it was already read once at `:904` for
   `priorHash`). Do **not** try to reuse that read by refactoring `priorHash`'s extraction to share
   a single `fs.readFileSync` — it's one extra syscall on a path that is not hot (an interactive
   CLI command), and forcing a shared read couples two independently-reasoned checks (hash
   comparison vs. env diff) into one variable's lifetime for no measurable benefit. Simplicity wins
   here.

7. **Update `libs/host-runtime/src/index.ts`** to export `extractUnitEnv` and
   `droppedShellEnvKeys` alongside the existing `os-unit.ts` re-exports (`index.ts:213-235`) — the
   implementer/reviewer test files need them importable the same way every other os-unit symbol is
   (`os-unit.spec.ts:23-44` imports directly from `./os-unit.js` inside the lib itself, so this
   step is for any *external* test/tooling; still do it for consistency, `EnableAction`/
   `EnableResult`/`EnableOptions` are already re-exported as types at `index.ts:243-245` and must
   stay in sync with the new fields — no signature change needed there, TS structural typing covers
   it automatically once `os-unit.ts`'s interfaces change).

### `apps/sox/src/main.ts` — CLI surface only, narrowly

1. **New flag `--unset <key>[,<key>...]`** parsed the same way every other `flags[...]` string flag
   in this file is (e.g. `flags['node-path']`, `:4720`) — no new parsing infrastructure needed,
   `flagMap`/`flags` is already `Record<string, string>`.

2. **`cmdService`'s `enable` branch** (`:4829-4891`): pass
   `unsetKeys: (flags['unset'] ?? '').split(',').map((s) => s.trim()).filter((s) => s.length > 0)`
   into the `enableOsUnit(...)` call at `:4857-4861`.

3. **Handle `result.action === 'blocked'`**: the existing success-message block at `:4880-4889`
   must not print `updated`/`created`-style success text for a blocked result. Branch on
   `result.action`:
   - `'blocked'` → the `enableOsUnit` call already logged the detailed BLOCKED message via its
     injected `log` callback (which is wired to `process.stdout.write` at `:4860`, matching every
     other `enable` log line) — print nothing additional beyond that, and `process.exit(1)`.
     (Decision D4: stdout not stderr — see below.)
   - `'created' | 'updated' | 'unchanged'` → existing behavior at `:4880-4890`, unchanged.

4. **Help text** (`:4788-4796`): add one line documenting `--unset` next to
   `--allow-volatile-node`, and update the `service restart` explanatory paragraph at
   `:4798-4803` — it already correctly says "never touches env — see BL-375"; leave that sentence
   as-is (it describes `restart`, which is genuinely unaffected: `restart` calls `kickstart`, never
   `enableOsUnit`, confirmed by reading `cmdServiceRestart`'s use of `restartAndVerify` per
   `docs/spec/service-lifecycle.md:748-750`).

**Files that must NOT change, and why:**

- **`libs/host-runtime/src/os-unit.ts`'s `restartOsUnit`** (`:1027-1140+`) — a *separate*,
  pre-existing unit-rewrite path (its own `platform.render` + `writeFileAtomic` at `:1069-1073` and
  `:1116-1118`, does not call `enableOsUnit`) used by an LKG-rollback/auto-heal flow
  (`apps/sox/src/main.ts:1249`, `:9154`). It carries the identical BL-375 exposure but touching it
  is out of the orientation cap for this packet (main.ts beyond `cmdServiceEnable` and its
  immediate callees) and changes the auto-heal risk profile in a way that needs its own design
  call (should an unattended doctor tick ever *refuse* to write, vs. an interactive operator?).
  **Filed as BL-488**, cross-linked to BL-375, with the exact citations above. Do not fold it into
  this packet — it would blow the orientation cap and conflate two different callers' failure
  semantics.
- **`apps/sox/src/main.ts`'s `cmdServiceRestart`/`kickstart`/`restartAndVerify` path** — confirmed
  by reading `docs/spec/service-lifecycle.md:748-758` and the `kickstart` doc comment
  (`os-unit.ts:483-491`) that this path *deliberately* never rewrites the unit file specifically
  **because of** BL-375 — it's already the documented workaround. No change needed or wanted.
- **`buildExtConfigEnv`** (`main.ts:345-366`) and the `SOX_CONFIG_*`/`SOX_PERM_*` deny-list in
  `env-policy.ts` — these are not shell-sourced and are correctly excluded from the diff (root
  cause, above). Widening the guard to cover them would generate false-positive BLOCKED results
  every time an operator legitimately edits `sox config set` for the extension, which is a
  *different*, working code path with its own audit trail — do not conflate.
- **`enableOsUnit`'s `contentSame` early-return** (`os-unit.ts:909-912`) — untouched; already
  argued why it's safe above.

---

## 3. Every decision, ruled

**D1 — Preserve vs. fail loudly.** Ruling: **fail loudly** (refuse to write, non-zero exit, exact
list of dropped keys) is the failure mode, not silent carry-forward with an optional
`--unset KEY`.

Losing alternative — *preserve by default*: makes `enable` friendlier (never blocks an unrelated
change like the `ProcessType` edit that triggered the original incident), but it means the unit's
env becomes append-only from whoever last regenerated it *ever*, with the source of any given key
lost to history the moment the shell that set it closes. That is precisely the problem this
codebase's culture already rejects elsewhere: the ownership index
(`OwnershipIndex`, `main.ts:4863-4878`) exists so every side effect of an `enable` is
attributable and reversible; a preserved-forever env value with no record of who set it or why is
the opposite of that. It also means a *stale* value (an old, now-wrong tunable) silently survives
forever unless someone remembers to `--unset` it — the same "correct-looking but not actually
current" failure shape as BL-372 (referenced directly in the BL-375 body). Fail-loudly instead
makes every `enable` either a no-op for existing env, or an explicit, single-invocation decision —
consistent with the existing `--allow-volatile-node` precedent (`main.ts:4838-4853`), which already
refuses by default and requires an explicit flag to proceed past a footgun. Same shape, same
codebase, already precedented; preserve-by-default would be the one-off exception.

**D2 — Scope of the diff: everything, or just the shell-forwarded half.** Ruling: **only** keys
that `scrubEnvReported` would have forwarded (`ENV_BASE_ALLOW` ∪ `NODE_*` ∪ `SOX_*` minus
`SOX_CONFIG_*`/`SOX_PERM_*`).

Losing alternative — *diff the entire env, including `SOX_CONFIG_*`*: would false-positive BLOCK
every ordinary `sox config set <ext> <key>` deletion followed by `service enable` (a legitimate,
already-working operation, since `buildExtConfigEnv` recomputes from the current resolved
cascade every time) — punishing a working feature to guard against a broken one conflates two
independent code paths and would make the fix itself the next footgun (an operator "fixes" the
false BLOCK by reaching for a blanket bypass flag, defeating the guard's purpose everywhere).

**D3 — Override mechanism: blanket bypass flag, or named-key acknowledgment.** Ruling: **named-key
only** (`--unset KEY1,KEY2,...`), refusing until *every* dropped key is named. No blanket
`--force`/`--allow-env-drop` flag exists anywhere in this design.

Losing alternative — *a single `--force` that skips the whole check*: this is exactly the shape
that erodes over time into the next incident — a blanket bypass gets copy-pasted into a deploy
script or an agent's default invocation the first time it's needed once, and from then on the
guard is silently defeated for every subsequent unrelated drop, which is the original bug with
extra steps. Requiring each key by name means the operator/agent running `enable` must *read* what
they're about to drop, every time — the same principle as the deny-list in `env-policy.ts` itself
(`:71-77`, "dropped variables are never silent").

**D4 — Where the BLOCKED message goes: stdout or stderr.** Ruling: **stdout**, matching every
other `service enable` status line (`:4839`, `:4847`, `:4880-4889` all write to `process.stdout`
already) and the injectable `log` parameter's existing wiring at `:4860`
(`(m) => process.stdout.write(...)`).

Losing alternative — *stderr*: would be the natural instinct for a "failure," but
`formatDeniedEnvWarning`'s doc comment (`env-policy.ts:163-165`) explains stderr is reserved
specifically for MCP-stdio spawn paths where stdout is a JSON-RPC channel that a stray line would
corrupt — `service enable` is an interactive CLI command, not a stdio spawn, so that constraint
does not apply, and splitting this one status line to stderr while every sibling line in the same
command goes to stdout would be an inconsistency for no protocol reason.

**D5 — Diff granularity: per-key BLOCKED, or all-or-nothing at the "any drop exists" level.**
Ruling: **all-or-nothing** — if the guard fires at all, *nothing* is written (no partial write
preserving some keys and dropping others silently). `enableOsUnit` already either writes the full
rendered unit or doesn't; there is no half-written unit state to reason about, so this ruling is
really "don't invent partial-write semantics," and follows directly from the existing atomic
`writeFileAtomic` (`os-unit.ts:868-873`, temp-file-then-rename).

**D6 — `restartOsUnit`'s identical exposure.** Ruling: **out of scope for this packet**, filed as
BL-488 (§2, "Files that must NOT change"). Not a silent omission — explicitly named, cross-linked,
citations included, and called out to the implementer/reviewer here so it doesn't get "discovered"
again mid-implementation and cause scope creep.

**D7 — `extractUnitEnv` parser robustness against a hand-edited or foreign unit file.** Ruling:
best-effort, return `{}` on anything unparseable, never throw. `[inv:os-unit-generated]` already
forbids hand-editing, so a malformed file is either an operator violation (their problem, not this
guard's job to diagnose) or a genuinely first-ever `enable` for that label with a stale/foreign
file at the path — in either case, degrading to "no prior env known, nothing to protect" is
strictly safer than crashing the CLI or false-blocking on a parse artifact.

---

## 4. Acceptance criteria (each names BL-375, each with a stated RED arm)

All four are `enableOsUnit` unit tests in `libs/host-runtime/src/os-unit.spec.ts`, following the
exact harness already in that file (`makeFakeExec`, `makeSpec`, sandboxed `unitDir`, `tmpDir`
fixture at `:47-64`) — **do not** invoke the real OS supervisor or write outside `tmpDir`, per the
file's own stated guarantees (`:1-16`).

1. **AC1 (BL-375 core).** Enable a unit once with `spec.env = { SOX_DISABLE_EMBED_HEAL: '1', ...base
   }`. Enable it again with a *second* spec whose `env` **omits** `SOX_DISABLE_EMBED_HEAL` (as if
   regenerated from a shell that no longer has it exported) but changes an unrelated field (mirror
   the real incident: `ProcessType`/`processType`, or any other spec field that forces
   `contentSame` to be false). Assert: `result.action === 'blocked'`,
   `result.droppedEnvKeys` includes `'SOX_DISABLE_EMBED_HEAL'`, and the on-disk unit file's bytes
   are **byte-identical** to what was written on the first call (`fs.readFileSync` before/after
   comparison) — i.e. nothing was overwritten.
   **RED arm:** run this exact test against `enableOsUnit` on `main` (pre-fix) — today `result.action
   === 'updated'`, `droppedEnvKeys` doesn't exist on the type, and the unit file on disk changes to
   the new content with `SOX_DISABLE_EMBED_HEAL` gone. Confirm this fails before writing the fix by
   running the test against the unmodified worktree first (`git stash` is banned — instead: write
   the test, run it, observe the failure, *then* make the `os-unit.ts` edit, re-run, observe green;
   commit test+fix together once both are witnessed).

2. **AC2 (`--unset` acknowledgment).** Same setup as AC1, but pass `unsetKeys: ['SOX_DISABLE_EMBED_HEAL']`
   to the second `enableOsUnit` call. Assert `result.action !== 'blocked'` (it proceeds to
   `'updated'`), and the resulting on-disk unit's env genuinely lacks the key (confirm with
   `extractUnitEnv` on the freshly-written file).
   **RED arm:** before the fix, `EnableOptions` has no `unsetKeys` field at all — this test doesn't
   compile pre-fix (a TS error is an acceptable RED arm per BL-225's spirit: the assertion cannot
   even be expressed without the fix existing — note this explicitly in the test's surrounding
   comment so a reviewer doesn't mistake "doesn't compile" for "wasn't run").

3. **AC3 (config-cascade keys exempt — negative case, guards D2).** Enable once with
   `spec.env` containing `SOX_CONFIG_PORT: '4000'`. Enable again with a spec whose `env` omits
   `SOX_CONFIG_PORT` (simulating a legitimate `sox config unset` between calls) and no `unsetKeys`.
   Assert `result.action !== 'blocked'` — the regeneration proceeds normally, because
   `SOX_CONFIG_*` is excluded from `droppedShellEnvKeys` by design (D2).
   **RED arm:** describe, don't necessarily chase pre-fix behavior here — pre-fix there IS no
   blocking at all, so this assertion trivially "passes" before the fix for the wrong reason (no
   guard exists yet). This criterion's real RED arm is a **mutation test on the fix itself**: if an
   implementer accidentally widens `droppedShellEnvKeys` to include `SOX_CONFIG_*`/`SOX_PERM_*`
   keys (the D2 losing alternative), THIS test must go red. Write it as a same-PR regression guard,
   and confirm it catches that specific mutation by temporarily deleting the `SOX_CONFIG_`/
   `SOX_PERM_` prefix exclusion in a scratch edit, observing this test fail, then reverting the
   scratch edit — do not leave the scratch edit in the diff.

4. **AC4 (`extractUnitEnv` round-trip, both platforms).** Render a spec with an env value
   containing characters that need XML-escaping (`&`, `<`, `>`) via `LaunchdPlatform.render`, then
   `extractUnitEnv(rendered, 'launchd')` and assert the recovered value equals the original
   (round-trip through escape/unescape). Repeat for `SystemdPlatform` with a value containing `=`
   (assert only the *value* keeps the embedded `=`, key parsing splits on the first `=` only).
   **RED arm:** `extractUnitEnv` does not exist pre-fix — same "doesn't compile" RED arm as AC2,
   noted the same way.

Also required (not a new test, an updated one): confirm none of the **63 existing** `os-unit.spec.ts`
tests regress — run the full file, not just the new `describe` block, since `enableOsUnit`'s
signature and one of its early branches changed.

---

## 5. Risks

- **`nx build`/`nx test` destructiveness (BL-235/BL-456).** `host-runtime` and `sox` both ship
  `dist/` artifacts consumed elsewhere (`sox` bundles via `tools/bundle-extension.cjs` per
  `docs/standards/extension-bundling.md`). Do not run a diagnostic build "just to see an error" —
  read the TS error from `nx typecheck` output instead (it doesn't `rm -rf dist` first — confirm
  this is still true for this repo's `typecheck` target before relying on it, by reading
  `libs/host-runtime/project.json`'s `typecheck` target definition, not by assuming). `nx test`
  rebuilds dependency `dist/`s per BL-456 — run `node tools/check-suite-tree-state.mjs --project
  host-runtime` (and `--project sox`) alongside every suite result you report, and quote its output.
- **No data/store risk.** This change touches only unit-file rendering/parsing logic and CLI flag
  plumbing — no SQLite, no `~/.memory/*`, no Turso adapter code anywhere in the diff. Nothing here
  should ever need `~/.memory/*` access; if a test tries to touch it, that's a test-authoring bug,
  stop and fix the test's fixture instead.
- **Real launchd/systemd risk.** None — every acceptance test uses the sandboxed `unitDir` +
  `makeFakeExec` harness already proven safe by the existing 63 tests (module header,
  `os-unit.ts:25-34`, and the file's own `describe('safety — never touches the real machine', ...)`
  block at `:655-668`). Do not add a test that passes `load: true` with `exec: realOsExec` — there
  is no reason this fix needs one, and doing so would be the first test in the file to violate its
  own stated guarantee.
- **`git worktree` isolation.** Other agents are live in the main checkout
  (`/Users/nix/dev/ai/sox-ecosystem`) per the dispatch note — everything above stays inside
  `.worktrees/pkt38-service-enable-env`. Commit by explicit pathspec only
  (`git commit libs/host-runtime/src/os-unit.ts libs/host-runtime/src/index.ts
  libs/host-runtime/src/os-unit.spec.ts apps/sox/src/main.ts docs/spec/service-lifecycle.md
  -m "..."`), never `-A`/`.`/bare commit/`--amend` without a pathspec.
- **Spec doc goes stale if not updated.** §2 above requires editing
  `docs/spec/service-lifecycle.md:774-781`'s "Until this is fixed" prose once AC1–AC4 are green —
  otherwise the canonical spec actively lies about a fixed defect, which is its own future
  footgun class (the same shape as BL-372's "green but not deployed").

---

## 6. The gate — exact nx targets, in order

Read `docs/spec/service-lifecycle.md` in full before touching any of the guarded files (already
done for this spec — implementer should too, it's short and directly governs `os-unit.ts`).

1. `npx nx lint host-runtime`
2. `npx nx lint sox`
3. `npx nx typecheck host-runtime`
4. `npx nx typecheck sox`
5. `npx nx test host-runtime -- os-unit.spec.ts` — report `node tools/check-suite-tree-state.mjs
   --project host-runtime` alongside the result.
6. `npx nx test sox` (only if `cmdService`/`cmdServiceEnable` has its own test coverage exercised —
   grep `apps/sox/src` for an existing `main.spec.ts`-style suite touching `service enable` before
   assuming one exists or doesn't; if none exists, do not invent a new heavyweight CLI-level test
   harness for this packet — the `os-unit.spec.ts` unit tests at the `enableOsUnit` boundary are
   the correct level per D-nothing-stated-otherwise, since `cmdService`'s branch is a thin
   pass-through of `unsetKeys` and `result.action` with no independent logic worth a second test
   surface).
7. `npx nx build host-runtime` and `npx nx build sox` — **only after** steps 1–6 are green (BL-235:
   these are destructive; do not run them to "check" anything, only to produce the final artifact
   once the code is proven correct by lint+typecheck+test).
8. `npx nx run registry:sync-index` — required because `sox`'s rebuilt `dist/` (if `sox` ships
   through the registry — confirm by checking whether `apps/sox` appears in `registry/index.json`;
   if it's the CLI itself rather than a bundled extension, this step may not apply — verify, don't
   assume, and state which in your handoff).
9. Whole-repo gate before considering this packet done: `npx nx run-many -t
   build,lint,test,typecheck` is the CLAUDE.md-mandated final check, but given BL-235/BL-456's
   destructiveness, only run it once every project-scoped step above is already green — it should
   change nothing new.

**BL-225 compliance for the RED→GREEN requirement:** every acceptance test above must be watched
failing on the current worktree HEAD (`1f49751b`, pre-fix) and passing after the `os-unit.ts`/
`main.ts` edits, in that literal order, before either `RESOLVED` marker is written anywhere. A test
skip/guard that only exercises the case where the invariant already holds does not count (this is
the exact BL-167 pattern named in CLAUDE.md) — confirm each new `it(...)` actually asserts on
`droppedEnvKeys`/`action === 'blocked'`, not merely that `enableOsUnit` "ran."
