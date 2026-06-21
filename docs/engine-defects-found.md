# Engine Defects Found (P7 test track)

Defects discovered during P7 integration testing. Each defect is pinned as a
`// KNOWN-DEFECT` test in the test suite so the suite stays green while the
behavior is recorded for a follow-on fix engagement.

---

## DEFECT-1: HookLoader.fire() aborts hook chain on first throwing hook

**Discovered by:** P7 — `scripts/hook-isolation.test.ts`
**Source location:** `scripts/hook-loader.ts:109–116` (`fire()` method)
**Severity:** Medium — silent data loss (subsequent hooks never execute)
**Status: RESOLVED** — `fireIsolated()` added to `scripts/hook-loader.ts` (Phase A, 2026-06-08).
`fire()` semantics unchanged for back-compat. The two KNOWN-DEFECT tests in
`scripts/hook-isolation.test.ts` now assert the corrected isolated behavior.

### Description

`HookLoader.fire()` iterates hooks sequentially with `for...of` + `await`. If any
hook's handler throws (or returns a rejected Promise), the `for` loop exits immediately
and the error propagates to the caller. Hooks registered after the failing hook are
**never called** — not even attempted.

The comment at line 113 says "callers should wrap in try/catch if isolation is needed",
but this mitigation is per-call-site and does not protect later hooks from being silently
skipped. A single buggy hook in an event can suppress all subsequent hooks for that event
without the host knowing unless it explicitly inspects the thrown error.

### Reproduction

```typescript
const loader = new HookLoader();
const executed: string[] = [];

loader.register({ id: 'fails', event: 'E', order: 1 }, async () => { throw new Error('boom'); });
loader.register({ id: 'victim', event: 'E', order: 2 }, () => { executed.push('victim'); });

try { await loader.fire('E', { timestamp: '' }); } catch (_) {}

// executed is [] — 'victim' never ran
```

### Pinned test

`scripts/hook-isolation.test.ts` — test titled
`"KNOWN-DEFECT: hooks after a throwing hook do NOT execute (chain aborts on first throw)"`
and
`"a hook that throws asynchronously (rejected Promise) also aborts the chain"`

Both tests assert the current (abort-on-throw) behavior so the suite stays green.
If the engine is fixed, these tests must be updated to assert the new isolated behavior.

### Recommended fix (out of scope for P7)

Add an error-isolated variant, e.g.:

```typescript
async fireIsolated(
  event: string,
  ctx: Omit<HookContext, 'event'>,
): Promise<Array<{ id: string; error: unknown } | undefined>> {
  const hooks = this.hooksFor(event);
  const fullCtx: HookContext = { event, ...ctx };
  const results = [];
  for (const hook of hooks) {
    try {
      await hook.handler(fullCtx);
      results.push(undefined);
    } catch (e) {
      results.push({ id: hook.manifest.id, error: e });
      // Continue to next hook regardless of this one's failure
    }
  }
  return results;
}
```

The existing `fire()` semantics (abort-on-throw) can remain for backward compatibility;
`fireIsolated()` becomes the recommended call site for lifecycle events where one hook
must not block others.

**Tracked in:** follow-on engagement (scope expansion flagged in P7 plan note)

---

## DEFECT-2: `pnpm typecheck` exits 2 on latent tokenguard + scripts errors

**Discovered by:** workflow-agent-builder (claude-agents) — surfaced after fixing the
`@sox/tokenguard-core` workspace-protocol resolution bug (`fix/tokenguard-workspace-protocol`,
commit `dabe9ea`). These were previously *masked*: TS aborted on `TS2307 Cannot find module
'@sox/tokenguard-core'` before it could reach them. With resolution fixed, the compiler now
reaches and reports them. They are pre-existing code-quality defects, not regressions from
the protocol fix (a `package.json` dep-spec change cannot introduce `TS6133`).
**Severity:** Low — code hygiene; blocks a green `pnpm typecheck` but no runtime impact.
**Status: OPEN** — not yet fixed.

### Errors (9)

tokenguard source:

- `extensions/services/tokenguard/src/cli.ts(23,1)` — TS6133 `'readline'` declared but never read
- `extensions/services/tokenguard/src/mapstore.ts(32,10)` — TS6133 `'now'` declared but never read
- `extensions/services/tokenguard/src/proxy.ts(170,19)` — TS6133 `'mapper'` declared but never read
- `extensions/services/tokenguard/src/proxy.ts(170,27)` — TS6133 `'adapter'` declared but never read
- `extensions/services/tokenguard/src/proxy.ts(309,19)` — TS2322 `string | string[] | undefined` not assignable to `string | string[]` (needs an undefined guard)

repo scripts (unrelated to tokenguard):

- `scripts/check-registry-sync.ts(35,7)` — TS6133 `'tmpRoot'` declared but never read
- `scripts/check-registry-sync.ts(162,7)` — TS6133 `'liveJson'` declared but never read
- `scripts/new-extension.ts(82,96)` — TS2366 function lacks ending return statement
- `scripts/new-extension.ts(281,91)` — TS2366 function lacks ending return statement

### Fix sketch

Remove the unused declarations; add an `undefined` guard at `proxy.ts:309`; add explicit
returns (or `: void`/`undefined` return types) in `new-extension.ts`. All mechanical;
no behavior change. After: `pnpm typecheck` should exit 0.

**Tracked in:** this backlog entry (follow-on hygiene pass)
