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
