/**
 * Command template — scaffolds a slash-command extension.
 *
 * Files:
 *   extension.json   (born-conformant manifest: type=command, runtime=node)
 *   package.json
 *   tsconfig.json
 *   src/index.ts     (run(input) stub)
 *   CHANGELOG.md
 *   README.md
 *
 * [inv:nx-free-core] — no nx-packages imports.
 */

import type { FileSet } from '../../index.js';
import type { TemplateOpts } from '../_shared.js';
import { manifestJson, packageJson, tsconfigJson, changelogMd, readmeMd } from '../_shared.js';

export function commandTemplate(opts: TemplateOpts): FileSet {
  return {
    'extension.json': manifestJson(opts, {
      runtime: 'node',
      entrypoint: 'dist/index.js',
      invocation: {
        protocol: 'function-export',
        handler: 'run',
      },
    }),

    'package.json': packageJson(opts),

    'tsconfig.json': tsconfigJson(),

    'src/index.ts': [
      `// Command: ${opts.title}`,
      `// ${opts.description}`,
      `// Slash-invoked, deterministic shell operation — no LLM calls.`,
      ``,
      `import { execSync } from 'node:child_process';`,
      ``,
      `export interface CommandInput {`,
      `  args: string[];`,
      `}`,
      ``,
      `export interface CommandOutput {`,
      `  stdout: string;`,
      `  exitCode: number;`,
      `}`,
      ``,
      `/**`,
      ` * Command handler — invoked via slash command /${opts.id}`,
      ` * Deterministic: no LLM calls, predictable output.`,
      ` */`,
      `export function run(input: CommandInput): CommandOutput {`,
      `  try {`,
      `    const stdout = execSync(\`echo "Command ${opts.id}: \${input.args.join(' ')}"\`, {`,
      `      encoding: 'utf8',`,
      `      timeout: 5000,`,
      `    });`,
      `    return { stdout: stdout.trim(), exitCode: 0 };`,
      `  } catch (e) {`,
      `    return { stdout: String(e), exitCode: 1 };`,
      `  }`,
      `}`,
    ].join('\n'),

    'CHANGELOG.md': changelogMd(),

    'README.md': readmeMd(opts, [
      '## When to use',
      '',
      `<!-- Describe when to invoke this command. -->`,
      '',
      '## Invocation',
      '',
      '```',
      `/${opts.id} [args...]`,
      '```',
      '',
      '## Constraints',
      '',
      '- Deterministic: no LLM calls inside the command handler.',
      '- Exits non-zero on failure; stdout is the result.',
      '',
      '## Usage',
      '',
      '```bash',
      `sox install ${opts.id}`,
      '```',
    ]),
  };
}
