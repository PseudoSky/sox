/**
 * Hook template — scaffolds a deterministic lifecycle hook extension.
 *
 * Files:
 *   extension.json   (born-conformant manifest: type=hook, runtime=node, events=[PreToolUse])
 *   package.json
 *   tsconfig.json
 *   src/index.ts     (handler(ctx) stub bound to PreToolUse)
 *   CHANGELOG.md
 *   README.md
 *
 * [inv:nx-free-core] — no nx-packages imports.
 */

import type { FileSet } from '../../index.js';
import type { TemplateOpts } from '../_shared.js';
import { manifestJson, packageJson, tsconfigJson, changelogMd, readmeMd } from '../_shared.js';

export function hookTemplate(opts: TemplateOpts): FileSet {
  return {
    'extension.json': manifestJson(opts, {
      runtime: 'node',
      entrypoint: 'dist/index.js',
      order: 100,
      events: ['PreToolUse'],
    }),

    'package.json': packageJson(opts),

    'tsconfig.json': tsconfigJson(),

    'src/index.ts': [
      `// Hook: ${opts.title}`,
      `// ${opts.description}`,
      `// Binds to a lifecycle event and executes deterministically (no LLM calls).`,
      ``,
      `import * as fs from 'node:fs';`,
      ``,
      `export interface HookContext {`,
      `  event: string;`,
      `  timestamp: string;`,
      `  payload?: unknown;`,
      `}`,
      ``,
      `/**`,
      ` * Hook handler — fires on PreToolUse lifecycle event.`,
      ` * order: 100 (default). Hooks should be order-independent where possible;`,
      ` * the order field is an escape hatch, not a dependency mechanism.`,
      ` */`,
      `export function handler(ctx: HookContext): void {`,
      `  const logLine = \`[\${ctx.timestamp}] \${ctx.event}: \${JSON.stringify(ctx.payload)}\\n\`;`,
      `  fs.appendFileSync('/tmp/${opts.id}.log', logLine);`,
      `}`,
      ``,
      `export const event = 'PreToolUse';`,
    ].join('\n'),

    'CHANGELOG.md': changelogMd(),

    'README.md': readmeMd(opts, [
      '## When to use',
      '',
      `<!-- Describe when this hook should be installed. -->`,
      '',
      '## Lifecycle event',
      '',
      '`PreToolUse` (default; change `event` export in `src/index.ts` to rebind)',
      '',
      '## Execution order',
      '',
      '`order: 100` — hooks fire in ascending order; ties broken lexicographically by id.',
      '',
      '## Constraints',
      '',
      '- Deterministic: no LLM calls inside a hook handler.',
      '- Side effects must be idempotent (hooks may fire more than once on retry).',
      '',
      '## Usage',
      '',
      '```bash',
      `sox install ${opts.id}`,
      '```',
    ]),
  };
}
