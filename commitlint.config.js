// Commitlint configuration — enforces conventional commits format.
// Used by nx release (D3: nx release replaces Changesets).
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // Scopes matching nx migration states, libs, apps, extensions
    'scope-enum': [
      1, // warn (not error) — scopes are advisory, not blocking
      'always',
      [
        'nx-migration',
        'manifest',
        'authoring',
        'install-engine',
        'host-runtime',
        'registry',
        'memory-core',
        'sox',
        'extensions',
        'scripts',
        'ci',
        'release',
      ],
    ],
  },
};
