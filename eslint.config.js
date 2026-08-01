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
  },
};

export default [
  // Ignore build outputs and tooling dirs
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/.tmp-*/**'],
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
];
