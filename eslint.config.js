// @ts-check
import nxPlugin from '@nx/eslint-plugin';
import tsParser from '@typescript-eslint/parser';

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
            { sourceTag: 'type:lib', onlyDependOnLibsWithTags: ['type:lib'] },
            { sourceTag: 'type:app', onlyDependOnLibsWithTags: ['type:lib', 'type:app'] },
            { sourceTag: 'type:extension', onlyDependOnLibsWithTags: ['type:lib'] },
            { sourceTag: '*', onlyDependOnLibsWithTags: ['*'] },
          ],
        },
      ],
    },
  },
];
