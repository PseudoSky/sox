#!/usr/bin/env node
/**
 * scaffold-data-packages.mjs — pre-create the memory-refactor `data/*` package skeletons.
 *
 * STOPGAP until the nx workspace generator (separate team) ships. It produces output conformant to
 * docs/plan/memory-refactor/NX-GENERATOR-HANDOFF.md so agents executing the refactor don't have to
 * scaffold packages by hand. Once `nx g @adhd/sox-nx:library --area data --group <g> <name>` exists,
 * prefer that and retire this script.
 *
 * Generated per package (tsc-built LIBRARY pattern, modeled on libs/memory-core):
 *   libs/data/<group>/<name>/{package.json, project.json, tsconfig.lib.json, vitest.config.ts,
 *                             src/index.ts, README.md, CLAUDE.md}
 *
 * Usage:
 *   node scripts/scaffold-data-packages.mjs            # create (public-ready), skip existing
 *   node scripts/scaffold-data-packages.mjs --dry-run  # print what would be written
 *   node scripts/scaffold-data-packages.mjs --private  # scaffold private (publishConfig omitted)
 *   node scripts/scaffold-data-packages.mjs --force     # overwrite existing files
 *
 * NB: this only scaffolds skeletons + the publish/metadata posture. Moving real code from
 * libs/memory-core / libs/memory-enrich into these packages is the refactor PLAN's job, not this script.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const DRY = args.has('--dry-run');
const PRIVATE = args.has('--private');
const FORCE = args.has('--force');

// ── The package manifest (single source of truth for the data/* set) ─────────
// engines: native carriers (fastembed/better-sqlite3) → >=22 (no Node-20 prebuild); pure JS → >=20.
const PACKAGES = [
  {
    name: 'embedding-provider', group: 'embed', engines: '>=22',
    description: 'Pluggable embedding provider — text→vector, config-driven model resolution + runtime; deterministic variant as a first-class provider; loud-fail (no silent hash downgrade).',
    deps: { fastembed: '^2.1.0' },
    concerns: ['text→vector', 'model resolution', 'deterministic provider', 'loud-fail enforcement'],
    invariants: ['resolver THROWS if the configured real provider cannot load (never silently downgrades)', 'every provider advertises {providerId, modelId, dim, isDeterministic}'],
  },
  {
    name: 'vector-store', group: 'vectors', engines: '>=22',
    description: 'Vector persistence (sqlite-vec vec0) + kNN/cosine search; enforces the embedding space invariant and owns per-record modelId provenance.',
    deps: { 'better-sqlite3': '^12.10.0', 'sqlite-vec': '^0.1.9' },
    concerns: ['vec0 persistence', 'kNN/cosine', 'space invariant', 'per-record modelId'],
    invariants: ['modelId+dim define the vector space — reject any vector whose dim/modelId != the column', 'a model switch is a re-embed migration, never a hot-swap into the same space'],
  },
  {
    name: 'graph-store', group: 'graph', engines: '>=22',
    description: 'Bi-temporal graph store over SQLite — nodes + edges + t_valid/t_invalid + content-hash dedup + FTS sync.',
    deps: { 'better-sqlite3': '^12.10.0' },
    concerns: ['bi-temporal nodes+edges', 'content-hash dedup', 'FTS sync triggers', 'supersession chains'],
    invariants: ['records are never deleted — invalidation sets t_invalid (audit-preserving)'],
  },
  {
    name: 'hybrid-search', group: 'search', engines: '>=20',
    description: 'Hybrid retrieval ranker — fuses vector similarity + BM25/FTS + temporal decay into one ranked result. Generic IR, no domain coupling.',
    deps: {},
    concerns: ['vec+BM25+temporal fusion', 'ranked retrieval', 'token-budgeted results'],
    invariants: ['semantic ranking degrades to BM25/FTS when vectors are unavailable (must stay functional under degraded embeddings)'],
  },
  {
    name: 'analysis', group: 'analysis', engines: '>=20',
    description: 'Batch derivation over a corpus — clustering / community detection, near-duplicate detection, importance & link scoring. No query input.',
    deps: {},
    concerns: ['clustering', 'near-duplicate detection', 'importance/link scoring', 'auto-linking'],
    invariants: ['operates over a corpus (batch), never per-query', 'similarity-based outputs are only as good as the embedding space — must record the modelId they were computed under'],
  },
  {
    name: 'ingest', group: 'ingest', engines: '>=20',
    description: 'Write-path single-item transforms — content-hash, extractive summary, deterministic tagging/topic, future chunk/normalize/redact.',
    deps: {},
    concerns: ['content-hash', 'extractive summary', 'deterministic tagging', 'chunk/normalize (future)'],
    invariants: ['deterministic, zero-LLM, byte-reproducible'],
  },
];

const REL = '../../../../'; // libs/data/<group>/<name> → repo root (4 levels)

function pkgJson(p) {
  const j = {
    name: `@adhd/sox-${p.name}`,
    version: '0.1.0',
    description: p.description,
    license: 'MIT',
    ...(PRIVATE ? { private: true } : { private: false, publishConfig: { access: 'public' } }),
    engines: { node: p.engines },
    type: 'module',
    main: './dist/index.js',
    types: './dist/index.d.ts',
    exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
    files: ['dist'],
    ...(Object.keys(p.deps).length ? { dependencies: p.deps } : {}),
    // Routing metadata harvested by the routing-index generator (see NX-GENERATOR-HANDOFF.md §5).
    sox: {
      area: 'data',
      group: p.group,
      concerns: p.concerns,
      invariants: p.invariants,
      entrypoints: ['dist/index.js'],
    },
  };
  return JSON.stringify(j, null, 2) + '\n';
}

function projectJson(p) {
  const root = `libs/data/${p.group}/${p.name}`;
  return JSON.stringify({
    $schema: `${REL}node_modules/nx/schemas/project-schema.json`,
    name: p.name,
    projectType: 'library',
    root,
    sourceRoot: `${root}/src`,
    tags: ['type:lib', 'area:data', `group:${p.group}`],
    targets: {
      build: {
        executor: 'nx:run-commands',
        outputs: [`{workspaceRoot}/${root}/dist`],
        options: {
          command: `tsc --project ${root}/tsconfig.lib.json && echo '{"type":"module"}' > ${root}/dist/package.json`,
          cwd: '.',
        },
        cache: true,
        inputs: ['{projectRoot}/src/**/*.ts', '{projectRoot}/tsconfig.lib.json'],
      },
      test: {
        executor: 'nx:run-commands',
        options: { command: `vitest run --config ${root}/vitest.config.ts`, cwd: '.' },
        cache: true,
        inputs: ['default', '^production'],
      },
      lint: {
        executor: '@nx/eslint:lint',
        options: { lintFilePatterns: [`${root}/**/*.ts`] },
      },
    },
  }, null, 2) + '\n';
}

const tsconfigLib = () => JSON.stringify({
  extends: `${REL}tsconfig.base.json`,
  compilerOptions: {
    module: 'NodeNext', moduleResolution: 'nodenext', outDir: './dist', rootDir: './src',
    declaration: true, declarationMap: true, sourceMap: true, esModuleInterop: true,
  },
  include: ['src/**/*.ts'],
  exclude: ['src/**/*.spec.ts', 'src/**/*.test.ts', 'node_modules', 'dist'],
}, null, 2) + '\n';

const vitestConfig = (p) => `import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: { root: '${`libs/data/${p.group}/${p.name}`}', include: ['src/**/*.{spec,test}.ts'] } });\n`;

const indexTs = (p) => `// @adhd/sox-${p.name} — ${p.group} (area:data)\n// SKELETON. Implementation lands via the memory-refactor plan (extracted from libs/memory-core|memory-enrich).\n// Concerns: ${p.concerns.join('; ')}\nexport const __scaffold__ = '${p.name}';\n`;

const readme = (p) => `# @adhd/sox-${p.name}\n\n${p.description}\n\n- **area:** data · **group:** ${p.group}\n- **concerns:** ${p.concerns.join(', ')}\n\n## Invariants\n${p.invariants.map((i) => `- ${i}`).join('\n')}\n\n> Skeleton scaffolded by \`scripts/scaffold-data-packages.mjs\`. Implementation is extracted from\n> \`libs/memory-core\`/\`libs/memory-enrich\` by the memory-refactor plan.\n`;

const claudeMd = (p) => `# CLAUDE.md — data/${p.group}/${p.name}\n\nRules for working in this package (agent-routing layer; keep authoritative + minimal).\n\n## Invariants (do not violate)\n${p.invariants.map((i) => `- ${i}`).join('\n')}\n\n## Boundaries\n- \`area:data\` may import \`area:data\` + \`area:shared\` only — NEVER \`area:platform\` (enforced by nx boundary lint).\n- Published npm name (\`@adhd/sox-${p.name}\`) is decoupled from this folder path — never rename it on a move.\n\n## Build/test\n- \`npx nx build ${p.name}\` · \`npx nx test ${p.name}\` · \`npx nx lint ${p.name}\` (nx targets only).\n`;

// ── Write ────────────────────────────────────────────────────────────────────
let created = 0, skipped = 0;
for (const p of PACKAGES) {
  const dir = path.join(ROOT, 'libs', 'data', p.group, p.name);
  const files = {
    'package.json': pkgJson(p),
    'project.json': projectJson(p),
    'tsconfig.lib.json': tsconfigLib(),
    'vitest.config.ts': vitestConfig(p),
    'src/index.ts': indexTs(p),
    'README.md': readme(p),
    'CLAUDE.md': claudeMd(p),
  };
  for (const [rel, content] of Object.entries(files)) {
    const fp = path.join(dir, rel);
    const exists = fs.existsSync(fp);
    if (exists && !FORCE) { skipped++; continue; }
    if (DRY) { console.log(`${exists ? 'OVERWRITE' : 'CREATE'}  ${path.relative(ROOT, fp)}`); created++; continue; }
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, content);
    created++;
  }
}
console.log(`\nscaffold-data-packages: ${DRY ? '[dry-run] ' : ''}${created} file(s) ${DRY ? 'planned' : 'written'}, ${skipped} skipped (existing).`);
console.log(`packages: ${PACKAGES.map((p) => `data/${p.group}/${p.name}`).join(', ')}`);
console.log(PRIVATE ? 'posture: PRIVATE' : 'posture: PUBLIC-ready (private:false + publishConfig.access:public) — publish action remains owner-gated.');
if (!DRY) console.log('next: registry:sync-index is NOT needed (libs are not registry extensions); run `npx nx build <name>` to verify a skeleton compiles.');
