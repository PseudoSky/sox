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

## Local dry-run (prove before the one-way door)

```bash
npx nx run-many -t build,lint,test          # C3 gate
pnpm run check-publishable                    # structural 404 gate (workspace:*/@adhd-runtime-dep)
pnpm changeset status                         # review pending bumps
changeset publish --dry-run                   # PROVE the publish set without publishing
bash scripts/acceptance/clean-room-smoke.sh   # verdaccio clean room: G1 + G2 (memory_ping)
```

The **canonical gate** is the clean-room smoke (no repo checkout, isolated HOME): `npm i -g
@adhd/sox-cli` → `soxe --version`/`search` (G1), `soxe install sox-memory-bundle` resolving every
member from the registry with native deps (G2), `memory_ping` → `{ ok:true, artifact:"sha256:…" }`.

---

## Owner-gated publish to PUBLIC npm (the one-way door — do NOT run without the owner)

Run from a CLEAN checkout of `main` (a worktree bakes absolute paths), after a final
`npx nx run registry:sync-index` + commit:

```bash
npm whoami                                    # @adhd scope; automation/OTP ready
pnpm install                                  # ensure workspace links current
pnpm run release:prepared                      # = build-index:publish (portable registry) → nx build sox → changeset publish
SOX_REGISTRY_PUBLISH=npm pnpm run build-index  # rewrite registry sources → npm-package: (portable, 0 file://)
git add registry/index.json && git commit -m "chore: portable registry after publish"
```

In CI this is automated by `.github/workflows/release.yml`: the "Version Packages" PR → on merge,
`pnpm release:prepared` publishes all changed packages and the portable registry is committed back.

After publish, perform the **BL-65 repoint** (see BACKLOG BL-65): point `.mcp.json` /
`~/.claude.json` `mcpServers.memory-server.command` at the installed `soxe`, install
`sox-memory-bundle` from npm, one final reconnect — so a repo build never touches the live server.

---

## Post-publish checklist

- [ ] `npm view @adhd/<name>` shows the new version as `latest`.
- [ ] `registry/index.json` sources are `npm-package:` (zero `file://`, zero `/Users/`).
- [ ] Clean-room smoke green against the real registry.

---

## Troubleshooting

| Error | Fix |
|---|---|
| `404` on `@adhd/sox-<pkg>` during install | The package is unpublished; publish it (the `check-publishable` gate catches the structural case). |
| `ERR_PNPM_CANNOT_RESOLVE_WORKSPACE_PROTOCOL` | Run `pnpm install` so the workspace dep is linked before `pnpm publish`. |
| Registry `source` still `file://` after publish | Run `SOX_REGISTRY_PUBLISH=npm pnpm run build-index`. |
| `EOTP` / `E401` | Provide OTP / `npm login` (confirm `@adhd` scope). |
| Some packages missing after `pnpm -r publish` to verdaccio | Parallel publish races verdaccio — publish per-package sequentially (the smoke script does this). |
