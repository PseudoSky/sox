---
"@adhd/sox-manifest": minor
---

Additive: opencode host support in manifests, plus new validation-set exports.

`ExtensionManifest.hosts?: Array<'claude' | 'codex'>` widened to `Array<'claude' | 'codex' |
'opencode'>` — an array-of-union widening on a field consumers write into when authoring a manifest,
not one they narrow-match against; old manifests remain valid, new manifests may now legally include
`'opencode'`. Four new top-level exports: `VALID_TYPES`, `VALID_RUNTIMES`, `VALID_HOOK_EVENTS` (all
`Set<string>`), and `KNOWN_HOSTS: Set<string>`. No removed or narrowed export — minor.
