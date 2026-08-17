# Release flow

Publishing a `@adhd/sox-*` package is not done when the package is published. It is
done when every consumer that needs the change is running it.

## 1. Enumerate consumers before releasing

```
node tools/release-consumers.mjs @adhd/sox-<pkg>
```

Internal consumers are derived from the workspace. External consumers live in other
repos and cannot be derived — each package declares its own:

```json
"sox": { "externalConsumers": [
  { "name": "@adhd/other-pkg", "repo": "/abs/path/to/repo", "path": "sub/dir", "note": "direct dep" }
] }
```

Keep that list current. An undeclared external consumer is invisible to every check
below, and will keep running the old code indefinitely.

## 2. Watch for edges that do not float

An edge that does not float makes a release invisible downstream: the chain appears to
succeed at every step while consumers keep executing the previous version. The tool
exits non-zero when it finds one, so `pnpm release` refuses to proceed.

**Judge the published range, not the source string.** `pnpm publish` rewrites the
`workspace:` protocol, and the form decides whether the edge floats:

| Source | Published as | Floats? |
|---|---|---|
| `workspace:*` | `1.2.3` | **no — frozen at publish time** |
| `workspace:~` | `~1.2.3` | patch only |
| `workspace:^` | `^1.2.3` | yes |

Use `workspace:^` for internal dependencies. `workspace:*` reads as the most permissive
form and is the most restrictive one after publish — the whole internal graph was frozen
this way, invisibly, because the check only looked at the source string (BL-569).

Two remaining cases are still required follow-up bumps, not optional ones: a literal
exact range, and any `^0.x` edge crossing a **minor** bump (`^0.5.8` covers `0.5.x`
only, so `0.6.0` does not reach it).

## 3. Plan the follow-up bumps as part of the release

A multi-hop chain needs each hop bumped and published in order. Record them as release
follow-up tasks at the time of the release, not afterwards — the failure mode is a
published package with no consumer on it, which reads as "shipped" and is not.

## 4. Test consumers in isolation

Never validate a consumer against a live store or live service. Use a scratch store
(`mkdtemp`) or an isolated worktree.

This applies with particular force to storage/adapter-layer packages: a consumer test
that opens a production store can corrupt it, and can hold connections that block
maintenance operations for other processes.

Fix what surfaces before continuing the chain. A consumer that fails on the new version
is the release's problem, not the consumer's.

## 5. Verify the running process, not the artifact

Publishing, installing and restarting are three separate things. A long-lived process
keeps executing the code it started with.

- Reading source proves nothing about what is running.
- Process liveness proves nothing about which version is loaded.
- Confirm the running process reports (or demonstrably behaves as) the new version.

For a change whose whole point is a behavioural guarantee, verify the guarantee itself
end to end — not that the code shipped.

## Checklist

- [ ] `node tools/release-consumers.mjs <pkg>` run; consumer list reviewed
- [ ] `sox.externalConsumers` current for the released package
- [ ] Exact pins in the tree identified and scheduled as follow-up bumps
- [ ] Each consumer tested in isolation, never against a live store or service
- [ ] Issues surfaced by consumer testing fixed before continuing the chain
- [ ] Lockfile changes committed alongside the manifest change
- [ ] Running processes restarted and verified on the new version
