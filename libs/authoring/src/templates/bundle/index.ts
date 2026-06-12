/**
 * Bundle template — scaffolds a manifest-only bundle extension (no entrypoint).
 *
 * Files:
 *   extension.json   (born-conformant manifest: type=bundle, members=[...placeholders])
 *   package.json
 *   CHANGELOG.md
 *   README.md
 *
 * Bundles have NO src/ directory and NO entrypoint. They are expanded to their
 * members at install time. tsconfig is omitted (nothing to compile).
 *
 * [inv:nx-free-core] — no nx-packages imports.
 */

import type { FileSet } from '../../index.js';
import type { TemplateOpts } from '../_shared.js';
import { manifestJson, changelogMd, readmeMd } from '../_shared.js';

export function bundleTemplate(opts: TemplateOpts): FileSet {
  // Bundles use a simplified package.json (no build/typecheck scripts needed)
  const bundlePkg = JSON.stringify(
    {
      name: `@sox/extension-${opts.id}`,
      version: '0.1.0',
      description: opts.description,
      private: true,
      license: 'MIT',
      ...(opts.author !== undefined && opts.author !== '' ? { author: opts.author } : {}),
      ...(opts.keywords !== undefined && opts.keywords.length > 0 ? { keywords: opts.keywords } : {}),
    },
    null,
    2,
  );

  return {
    'extension.json': manifestJson(opts, {
      // [flex:entrypoint-optional] — bundles have no entrypoint (schema allows omission)
      members: [
        { id: 'example-member-a', version: '^0.1.0' },
        { id: 'example-member-b', version: '^0.1.0' },
      ],
    }),

    'package.json': bundlePkg,

    'CHANGELOG.md': changelogMd(),

    'README.md': readmeMd(opts, [
      '## When to use',
      '',
      `<!-- Describe the scenario where installing this bundle makes sense. -->`,
      '',
      '## Members',
      '',
      '| Extension id       | Role            |',
      '| ------------------ | --------------- |',
      '| example-member-a   | (describe role) |',
      '| example-member-b   | (describe role) |',
      '',
      '## Usage',
      '',
      '```bash',
      `sox install ${opts.id}`,
      '```',
      '',
      'The installer expands the bundle to its members — no entrypoint is required.',
    ]),
  };
}
