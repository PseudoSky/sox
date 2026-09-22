// Commitlint configuration — enforces conventional commits format.
// Used by nx release (D3: nx release replaces Changesets).
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // Scope naming convention: most scopes are the literal directory name of
    // an nx project under libs/ or extensions/ (e.g. 'memory-core' ==
    // libs/memory-core, 'memory-server' == the extensions/.../memory-server
    // bundle member, 'vector-store' == libs/data/vectors/vector-store,
    // 'sox-telemetry' == libs/observability/sox-telemetry). A handful of
    // scopes are cross-cutting CONCERN names instead of package names, used
    // for changes that span or precede a single package (e.g. 'memory' for
    // docs/reporting/memory/* and other memory-subsystem-wide work that
    // isn't scoped to one package, 'telemetry' for telemetry-shaped changes
    // that also land in libs/observability/sox-telemetry). Where a
    // package-name scope AND a concern-name scope both exist for the same
    // area ('telemetry' vs 'sox-telemetry'), usage in git history is
    // genuinely inconsistent — both are used interchangeably for commits
    // touching the sox-telemetry package. This is not a deliberate two-tier
    // rule; it reflects actual drift. Prefer the package-name scope for a
    // package-scoped change and the concern-name scope only for work that
    // is genuinely cross-package or docs/process-level.
    'scope-enum': [
      1, // warn (not error) — scopes are advisory, not blocking
      'always',
      [
        'agents',
        'authoring',
        'build-index',
        'ci',
        'citations',
        'data',
        'deps',
        'embed',
        'embedding-provider',
        'extensions',
        'graph-store',
        'handoff',
        'host-registry',
        'host-runtime',
        'hybrid-search',
        'install-engine',
        'manifest',
        'memory',
        'memory-core',
        'memory-server',
        'memory-usage',
        'notes',
        'nx-migration',
        'observability',
        'ops',
        'permissions',
        'plan-status',
        'readme',
        'registry',
        'release',
        'scripts',
        'semantic',
        'service-proxy',
        'sox',
        'sox-telemetry',
        'store-adapter',
        'telemetry',
        'vector-store',
      ],
    ],
  },
};
