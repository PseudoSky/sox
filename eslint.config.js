// @ts-check
import nxPlugin from '@nx/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
/**
 * Local rules. `no-hook-assigned-skip` exists because two dedicated
 * cross-backend tests statically skipped on every run for their entire lifetime
 * while reporting green — see the rule's header.
 */
const soxRules = {
  rules: {
    'no-hook-assigned-skip': require('./tools/eslint-local/no-hook-assigned-skip.cjs'),
    'no-storage-backend-leak': require('./tools/eslint-local/no-storage-backend-leak.cjs'),
    'no-unguarded-listen': require('./tools/eslint-local/no-unguarded-listen.cjs'),
  },
};

export default [
  // Ignore build outputs and tooling dirs
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.tmp-*/**',
      // tools/baseline-capture is its own nx project (see its project.json)
      // with its own `lint` target and lintFilePatterns. Excluding it here
      // (rather than via a negated glob on every OTHER project's
      // lintFilePatterns) keeps double-linting impossible at the source: a
      // negated `!tools/baseline-capture/**` glob entry, once combined with
      // other positive patterns in the same `lintFiles()` call, makes ESLint
      // 10's CLI/API refuse to run at all ("all files matching ... are
      // ignored") — Item 7 first-run discovery.
      'tools/baseline-capture/**',
      // tools/eslint-local/__fixture__ holds deliberate POSITIVE/NEGATIVE
      // example fixtures documenting `no-hook-assigned-skip`'s exact trigger
      // boundary (see the rule's own header). frozen-skip.spec.ts is
      // SUPPOSED to trip the rule it demonstrates — that is the fixture's
      // entire purpose, not a real defect. Neither fixture is consumed by any
      // test runner (verified: no reference to either file anywhere in the
      // repo) — they exist purely as documentation for future readers of the
      // rule. Item 7 first-run discovery.
      'tools/eslint-local/__fixture__/**',
    ],
  },
  // TypeScript files: use @typescript-eslint/parser so syntax is understood
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
    },
    plugins: { '@nx': nxPlugin },
    rules: {
      '@nx/enforce-module-boundaries': [
        'error',
        {
          enforceBuildableLibDependency: true,
          allow: [],
          depConstraints: [
            // area isolation: data↛platform, data↛shared only, platform↛platform|shared, shared↛shared
            { sourceTag: 'area:data',     onlyDependOnLibsWithTags: ['area:data', 'area:shared'] },
            { sourceTag: 'area:platform', onlyDependOnLibsWithTags: ['area:platform', 'area:shared'] },
            { sourceTag: 'area:shared',   onlyDependOnLibsWithTags: ['area:shared'] },
            // libs may depend on other libs
            { sourceTag: 'type:lib', onlyDependOnLibsWithTags: ['type:lib'] },
            // apps may depend on libs
            { sourceTag: 'type:app', onlyDependOnLibsWithTags: ['type:lib', 'type:app'] },
            // extensions may depend on libs only — never on each other
            { sourceTag: 'type:extension', onlyDependOnLibsWithTags: ['type:lib'] },
            // everything else: unrestricted (catch-all for untagged projects during migration)
            { sourceTag: '*', onlyDependOnLibsWithTags: ['*'] },
          ],
        },
      ],
    },
  },
  // JS/JSX/MJS/CJS files: no TypeScript parser needed
  {
    files: ['**/*.js', '**/*.jsx', '**/*.mjs', '**/*.cjs'],
    plugins: { '@nx': nxPlugin },
    rules: {
      '@nx/enforce-module-boundaries': [
        'error',
        {
          enforceBuildableLibDependency: true,
          allow: [],
          depConstraints: [
            { sourceTag: 'area:data',     onlyDependOnLibsWithTags: ['area:data', 'area:shared'] },
            { sourceTag: 'area:platform', onlyDependOnLibsWithTags: ['area:platform', 'area:shared'] },
            { sourceTag: 'area:shared',   onlyDependOnLibsWithTags: ['area:shared'] },
            { sourceTag: 'type:lib', onlyDependOnLibsWithTags: ['type:lib'] },
            { sourceTag: 'type:app', onlyDependOnLibsWithTags: ['type:lib', 'type:app'] },
            { sourceTag: 'type:extension', onlyDependOnLibsWithTags: ['type:lib'] },
            { sourceTag: '*', onlyDependOnLibsWithTags: ['*'] },
          ],
        },
      ],
    },
  },
  // Test files: guard against the frozen-`{ skip }` trap (see the rule header).
  {
    files: ['**/*.spec.ts', '**/*.test.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
    },
    plugins: { sox: soxRules },
    rules: {
      'sox/no-hook-assigned-skip': 'error',
    },
  },
  // Storage boundary: only libs/data/store/store-adapter/** may name a backend
  // (sqlite/turso). See docs/reporting/memory/PLAN.md "Standing architectural
  // rule" and the rule's own header for the BL-377/BL-380/BL-381/BL-385 receipts.
  // Test files are exempt — they legitimately pin/exercise a specific backend.
  {
    files: ['**/*.ts', '**/*.tsx'],
    ignores: [
      '**/*.spec.ts',
      '**/*.test.ts',
      '**/__tests__/**',
      'libs/data/store/store-adapter/**',
    ],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
    },
    plugins: { sox: soxRules },
    rules: {
      'sox/no-storage-backend-leak': 'error',
    },
  },
  // BL-619: repo-wide listen() safety invariant. Every production AND test
  // `.listen()` must be guarded (an error guard before the call, an ephemeral
  // literal-0 port, or an allowlisted guarded-listen primitive). Test files are
  // NOT exempt — an unguarded listen in a test crashes the test runner the same
  // way it crashes a server. See tools/eslint-local/no-unguarded-listen.cjs.
  {
    files: ['**/*.ts', '**/*.tsx'],
    ignores: ['**/dist/**', '**/node_modules/**'],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
    },
    plugins: { sox: soxRules },
    rules: {
      'sox/no-unguarded-listen': 'error',
    },
  },
  {
    // ── Pre-existing debt, deliberately NOT silenced ────────────────────────
    // `libs/data/vectors/vector-store` has 4 known violations that predate this
    // rule: index.ts 143/200/359 (BL-380) and lancedb.ts:3 (BL-389). They are
    // real and tracked. Blast radius WAS measured (2026-08-01) and is trivial:
    // two spec files import this package at value level; everything else is a
    // type-only re-export, and `agent-source` — the consumer originally cited
    // as the risk — is not a package in this repo. The remaining reason for
    // care is narrow: index.ts:196 (`vecEnabled: adapter.capabilities
    // .nativeVectors || true`) is dead code whose deletion turns 15 tests green
    // while fixing nothing, so the fix needs attention, not avoidance.
    //
    // WARN, not off: leaving it at `error` makes `nx lint vector-store` — and
    // therefore the repo-wide `run-many -t build,lint,test,typecheck` gate —
    // permanently red, and a gate that is always red is a gate everyone learns
    // to ignore. That is the exact failure mode this rule exists to prevent, so
    // trading it for a green board would be self-defeating. Turning the rule
    // OFF here would be worse still: the debt would go silent.
    //
    // REMOVE THIS BLOCK when BL-380 and BL-389 land. It is scoped to one
    // directory and one rule precisely so it cannot quietly grow.
    files: ['libs/data/vectors/vector-store/**/*.ts'],
    ignores: ['**/*.spec.ts', '**/*.test.ts', '**/__tests__/**'],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
    },
    plugins: { sox: soxRules },
    rules: {
      'sox/no-storage-backend-leak': 'warn',
    },
  },
];
