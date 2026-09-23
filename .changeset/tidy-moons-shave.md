---
'@adhd/sox-cli': patch
---

Refuse to publish a CLI that embeds a non-portable registry index.

`@adhd/sox-cli@1.2.1` shipped to npm with an embedded registry
(`dist/registry/index.json`) of 31 entries, zero `npm-package:` sources, 31
`file://` sources pointing at absolute paths under a maintainer's home
directory, `provisional: true`, and a `+dirty` build stamp. On a machine with no
repo checkout the CLI falls back to that embedded copy, so every
`soxe install` failed with `install: source file not found: /Users/…` — leaking
the maintainer's path and never reaching the checksum gate.

`embed-registry.cjs` copied whatever sat at `registry/index.json` with no
validation; its header merely *assumed* the publish flow had rewritten sources
first. Two gates now enforce it:

- **Build time** — `embed-registry.cjs` validates before writing whenever
  `SOX_REGISTRY_PUBLISH` is set, and leaves no artifact on refusal. `file://`
  remains valid for local dev builds, so developer workflow is unchanged.
- **Publish time** — `check-bundled-registry.cjs` runs as `prepack` and
  `prepublishOnly`, reading the artifact as it sits on disk. This fires even
  when the build never ran and a stale `dist/` is packed wholesale.

`release:prepared` now carries `SOX_REGISTRY_PUBLISH` into `nx build sox` (it
previously set it only for `build-index:publish`, so the build that produces the
published artifact skipped the build-time gate), and the variable is part of the
build's nx cache key so a cache hit cannot replay a dev-shaped `dist/`.
