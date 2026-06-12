// @ts-check
import nxPlugin from '@nx/eslint-plugin';

export default [
  // Ignore build outputs and tooling dirs
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/.tmp-*/**'],
  },
  // Nx module boundary enforcement (workspace-wide)
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx', '**/*.mjs', '**/*.cjs'],
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
];
