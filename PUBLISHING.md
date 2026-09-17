# Publishing Playbook

How to version, build, and publish the `@adhd/sox-*` packages in this monorepo to npm.

> sox-ecosystem publishes via **Changesets** (`.changeset/` + `@changesets/action` in
> `.github/workflows/release.yml`). The full design is `docs/plan/publishing/SCOPE.md` +
> `DECISIONS.md`; the coexistence with content-addressed identity is **ADR-0005**.

---

## Identity vs. release version (read this first)

Per **ADR-0003 / ADR-0005** there are **two axes that never read each other**:

- **npm semver** resolves the *package graph* (`npm i @adhd/sox-install-engine@^0.2`). Changesets
  drives the version + changelog and rewrites `workspace:*` → a real range at publish.
- **content checksum** (`sha256` of the built entrypoint) is the *sole* extension identity +
  integrity authority. The registry `source` may carry a version in its locator
  (`npm-package:@adhd/sox-extension-memory-server@1.1.0`) but that only **selects which bytes to
  fetch**; the fetcher recomputes the checksum and gates on it.

Extensions ship as **self-contained esbuild bundles** (Model A): zero `@adhd/sox-*` runtime deps
(those are devDependencies, inlined by the bundler); native addons (`better-sqlite3`, `sqlite-vec`)
stay external and are declared as real `dependencies`, installed via the `npm-package:` install mode.

---

## Prerequisites

- `npm login` — confirm `npm whoami` is a member of the `@adhd` scope.
- 2FA enabled; use an **automation token** for CI (bypasses OTP). For local, have your authenticator.
- `pnpm install` (pnpm workspace, `pnpm@10.11.1`). **Run `pnpm install` after any package.json dep
  change** or `pnpm publish` will fail to resolve the `workspace:` protocol.

---

## ⚠️ Gate ordering: every gate below runs BEFORE `changeset version`

`check-changeset-surface`, `changeset status` and `cascade-plan` all read the **pending**
`.changeset/*.md` files. `changeset version` **consumes** those files. So once you have run
`version`, all three go red and stay red — not because anything is wrong, but because the evidence
they read no longer exists:

| Gate | Behaviour AFTER `changeset version` |
|---|---|
| `changeset status` | exits **1** — "packages have been changed but no changesets were found" |
| `cascade-plan` | **FAIL** — "could not cross-check against changeset status" / "static-graph closure and changesets-computed closure disagree" |
| `check-changeset-surface` | reports the package you *just versioned* as FAIL, because its changeset is gone |

**Never run `changeset version` EARLY** — before every gate above has passed. It is the ordering
that matters, not the invocation: `version` consumes the evidence the gates read, so running it
first makes a correct release look catastrophic.

`release:prepared` is the **publish half only** — `release-consumers` → `build-index:publish` →
`nx build sox` → `changeset publish`. It does **not** version. Where the bump comes from depends on
the path:

| Path | What versions the packages |
|---|---|
| CI (normal) | `@changesets/action` opens a "Version Packages" PR; merging it runs `version`. The follow-up run calls `release:prepared` to publish. |
| Local manual release | You run `changeset version` yourself, **after** the gates pass and immediately before `release:prepared`. |

So a local release is two deliberate steps, not one. Gates → `version` → publish. Once you have
versioned, do **not** try to make the gates green again — they structurally cannot pass. Use the
post-version verification recipe below instead.

**Never hand-edit the `version` field in a `package.json` either.** Changesets owns version +
changelog together; a hand bump changes the field `changeset publish` sweeps on (see "The sweep
set" below) without producing a changelog entry, and a later `changeset version` run has no way to
know the bump already happened — it will bump again on top of your hand edit. If a version needs
to change, write a changeset (`pnpm changeset add`) and let `changeset version` apply it.

*(Observed live on 2026-09-04: a session ran `changeset version` early, and all three gates read as
catastrophic failures for a release that was in fact correct and safe.)*

---

## Local dry-run (prove before the one-way door)

Run these **with your changesets still pending**:

```bash
npx nx affected -t build,lint,test --base=origin/main   # C3 gate
pnpm run check-publishable                    # structural 404 gate (workspace:*/@adhd-runtime-dep)
pnpm run check-changeset-surface              # BL-460: dist/*.d.ts vs. last-published, no silent surface drift
pnpm changeset status                         # review pending bumps
```

> Do **not** use `npx nx run-many -t build,lint,test` — a repo hook rejects it. Unscoped `run-many`
> expands to the full workspace task graph (486-541 tasks for a ~15-package changeset) and has
> caused resource-contention failures. Use `nx affected` with an explicit `--base`.

`changeset publish --dry-run` **DOES NOT EXIST** (`@changesets/cli@2.31.0` supports only
`--tag`/`--otp`/`--no-git-tag`), so the publish set has to be proven two ways:

```bash
pnpm run cascade-plan                         # computes + cross-checks the exact republish set
npm pack --dry-run --json                     # per package dir being published: tarball proof
bash scripts/acceptance/clean-room-smoke.sh   # verdaccio clean room: G1 + G2 (memory_ping)
```

Run it **with no arguments** as the default. With no `--package`, it auto-detects the target set
from every package named across pending `.changeset/*.md` frontmatter — the same set `changeset
status` would bump — and cross-checks the static dependency-graph closure against it.

`--package <name>[,<name>...]` scopes the check to one package's own closure instead
(`pnpm run cascade-plan -- --package <name>` — `pnpm run` needs `--` before `--package` or pnpm
swallows the flag itself; the first positional arg is the scan ROOT, not the target — see
`scripts/cascade-plan.ts`'s own Usage docstring). Use it only when you deliberately want one
package's closure in isolation. **With more than one pending changeset, scoping to a single
package will report FAIL by construction** — the changesets-computed closure covers every
package named across *all* pending changesets, while the static walk from one `--package` target
only ever covers that target's own closure, so they disagree on every other pending package. That
disagreement is not a hazard; it is the inevitable result of comparing a one-package view against
an all-changesets view. Do not investigate it as a defect — rerun with no target.

Don't hand-derive the republish set — BL-452: a human deriving it by hand is exactly how an
under/over-scoped publish set goes out unverified.

The **canonical gate** is the clean-room smoke (no repo checkout, isolated HOME): `npm i -g
@adhd/sox-cli` → `soxe --version`/`search` (G1), `soxe install sox-memory-bundle` resolving every
member from the registry with native deps (G2), `memory_ping` → `{ ok:true, artifact:"sha256:…" }`.

### The sweep set: measure it, don't assume it

`changeset publish` ships **every** workspace package whose local `package.json` version differs
from npm — not just the ones with changesets. That is how an unrelated package ships as a side
effect (it happened live with `sox-memory-core` 0.2.1→0.3.0 on 2026-07-16).

The sweep keys on the **version field only**. It does *not* look at `.d.ts` drift, changesets, or
git history. So measure it directly — this works in **any** state, including after
`changeset version` when `cascade-plan` cannot run:

```bash
python3 - <<'EOF'
import json,subprocess,glob,os
for pj in sorted(glob.glob('**/package.json',recursive=True)):
    if 'node_modules' in pj or '/dist/' in pj: continue
    try: d=json.load(open(pj))
    except: continue
    n=d.get('name','')
    if not n.startswith('@adhd/') or d.get('private'): continue
    v=d.get('version')
    r=subprocess.run(['npm','view',n,'version'],capture_output=True,text=True)
    npmv=r.stdout.strip() if r.returncode==0 else '404 (first publish)'
    if npmv!=v: print(f'SHIPS: {n}  {npmv} -> {v}   ({os.path.dirname(pj)})')
EOF
```

Everything it prints will publish. Everything it doesn't print will not. Confirm that list is
exactly what you intend **before** opening the one-way door.

### A `check-changeset-surface` FAIL is not automatically a publish hazard

The two failure modes look identical in the output and have opposite urgency:

- **Version already bumped** → the package *will* ship. Real hazard: it is about to publish a
  surface change with no changelog entry. Add a changeset.
- **Version matches npm** → the package will *not* ship (it is not in the sweep set). This is the
  commoner case and means something different: committed public-surface changes that have **never
  been released**, so npm consumers are compiling against stale type contracts. Real defect, but a
  backlog item, not a release blocker.

Cross-reference every surface FAIL against the sweep-set script above before deciding which it is.

### `dist/package.json` is a stale build artifact — it is not what ships

Publishing happens from the **package root**, not from `dist/`: every package declares
`"files": ["dist"]`, so `npm`/`pnpm publish` reads the package's own root `package.json` (name,
version, `main`/`exports`, dependencies) and packs the `dist/` directory as content alongside it.
The root `package.json` is never copied into `dist/` at publish time — whatever
`dist/package.json` happens to contain is irrelevant to the tarball.

That matters because the `build` target's Nx `inputs` do not include `package.json` (only
`src/**/*.ts` and `tsconfig.lib.json`), so a version bump alone does not invalidate the cache entry
that produced the existing `dist/package.json` — it can sit at an older version than the real
`package.json` indefinitely, through any number of rebuilds and even `nx reset`. Seeing an old
version in `dist/package.json` after a bump is expected, not a sign the build is broken and not a
sign the publish will ship the wrong version. Verify what will actually ship with `npm pack
--dry-run --json` from the package root (see above) — that reads the tarball manifest, not
`dist/package.json`.

---

## Publish to PUBLIC npm (irreversible — a published version can never be replaced)

Run from a CLEAN checkout of `main` (a worktree bakes absolute paths), after a final
`npx nx run registry:sync-index` + commit:

```bash
npm whoami                                     # @adhd scope; automation/OTP ready

# 1. VERSION — only now, with every gate above already green. This is the step
#    the "Version Packages" PR performs in CI; locally you run it yourself.
#    It consumes .changeset/*.md, bumps package.json + writes CHANGELOG entries.
pnpm exec changeset version
git add -u && git commit -m "chore: version packages"

# 2. PUBLISH — release:prepared is the publish half only; it does NOT version.
pnpm install                                   # lockfile + workspace links follow the bumps
pnpm run release:prepared                      # = build-index:publish (portable registry) → nx build sox → changeset publish
SOX_REGISTRY_PUBLISH=npm pnpm run build-index  # rewrite registry sources → npm-package: (portable, 0 file://)
git add registry/index.json && git commit -m "chore: portable registry after publish"
```

Skipping step 1 does not fail safe: `changeset publish` would run against unbumped versions and
npm rejects a republish of an existing version ("cannot publish over previously published
versions"), leaving a partially-released cascade.

If `changeset version` was already run (see the ordering warning above), the remaining half is just
`pnpm install && pnpm exec changeset publish` — do not re-run `version`, and do not try to
re-satisfy the pre-flight gates.

In CI this is automated by `.github/workflows/release.yml`: the "Version Packages" PR → on merge,
`pnpm release:prepared` publishes all changed packages and the portable registry is committed back.

After publish, perform the **BL-65 repoint** (see BACKLOG BL-65): point `.mcp.json` /
`~/.claude.json` `mcpServers.memory-server.command` at the installed `soxe`, install
`sox-memory-bundle` from npm, one final reconnect — so a repo build never touches the live server.

---

## Post-publish checklist

Changesets printing `success packages published successfully` and creating git tags is **not**
proof the bytes are on the registry. Verify against npm itself.

- [ ] **Registry actually serves it.** `npm view` reads through a cache that can lag a publish by
      tens of seconds — and a stale hit is indistinguishable from a failed publish. Query the
      registry directly and wait for it rather than concluding the publish failed:
      ```bash
      until curl -s https://registry.npmjs.org/@adhd%2f<name> | grep -q '"<version>"'; do sleep 10; done
      ```
- [ ] **The published tarball is correct** — not the local `dist/`. Fetch and inspect what
      consumers will actually get:
      ```bash
      cd "$(mktemp -d)" && npm pack @adhd/<name>@<version> && tar xzf *.tgz
      grep -c '<expected-symbol>' package/dist/index.js   # the shipped JS, not just .d.ts
      node -p "JSON.stringify(require('./package/package.json').dependencies)"  # no 'workspace:' left
      ```
      A symbol present only in `.d.ts` is a broken publish that type-checks.
- [ ] `npm view @adhd/<name>` shows the new version as `latest`.
- [ ] `registry/index.json` sources are `npm-package:` (zero `file://`, zero `/Users/`).
- [ ] Clean-room smoke green against the real registry.

---

## Troubleshooting

| Error | Fix |
|---|---|
| `changeset status` exits 1 with "no changesets were found" | Expected if `changeset version` already ran — it consumed them. Do not add changesets to silence this; see the gate-ordering section. |
| `cascade-plan: FAIL — closures disagree` naming the package you just versioned | Same cause. `cascade-plan` cannot run post-`version`; use the sweep-set script instead. |
| `cascade-plan: FAIL — closures disagree` naming *other* pending packages, run with `--package <one-target>` | Not a hazard — with multiple pending changesets, scoping to one package guarantees disagreement by construction. Rerun with no arguments (`pnpm run cascade-plan`). |
| `check-changeset-surface` FAIL on a package whose version already matches npm | Not a release blocker — it is unreleased surface drift. File it; do not fabricate a changeset to turn the gate green. |
| `nx run-many` rejected by a hook | Use `npx nx affected -t <target> --base=<ref>`. Unscoped `run-many` expands to the whole workspace. |
| Publish reported success but `npm view` shows the old version | Registry read-cache lag. Poll `https://registry.npmjs.org/<url-encoded-name>` directly before concluding it failed. |
| `404` on `@adhd/sox-<pkg>` during install | The package is unpublished; publish it (the `check-publishable` gate catches the structural case). |
| `check-publishable` reports an unpublished pkg is a `workspace:*` RUNTIME dep | Publish it — but first confirm it is genuinely a runtime dep by reading the consumers' imports. Move to `devDependencies` **only** if nothing imports it at runtime. |
| `check-publishable` reports an EXACT pin on an internal `@adhd/sox-*` dep | Change `workspace:*` → `workspace:^`. Exact pins freeze the dep while siblings float forward, resolving two copies of a stateful runtime (BUG-BACKLOG-TELEMETRY-001). |
| `ERR_PNPM_CANNOT_RESOLVE_WORKSPACE_PROTOCOL` | Run `pnpm install` so the workspace dep is linked before `pnpm publish`. |
| Registry `source` still `file://` after publish | Run `SOX_REGISTRY_PUBLISH=npm pnpm run build-index`. |
| `EOTP` / `E401` | Provide OTP / `npm login` (confirm `@adhd` scope). |
| Some packages missing after `pnpm -r publish` to verdaccio | Parallel publish races verdaccio — publish per-package sequentially (the smoke script does this). |
