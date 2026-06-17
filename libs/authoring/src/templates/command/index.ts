/**
 * Command template — scaffolds a CLI command extension.
 *
 * Real shape (from ~/dev/ai/claude-agents/tools/cli/ and
 *              ~/dev/ai/sox-protocol/packages/python/):
 *   - Node variant: ES module with #!/usr/bin/env node entry; uses Commander
 *     or plain process.argv; exports a `run(input)` function for programmatic use.
 *   - Python variant: pyproject.toml + [project.scripts] entry point (separate
 *     template path; this scaffolds the node default).
 *   - runtime: node (default); use runtime: python for Python-based commands.
 *   - invocation: stdio protocol — args from process.argv, output to stdout.
 *   - Commands are deterministic: no LLM calls inside the handler.
 *   - Install target resolved from libs/host-registry at install time.
 *     [ref:host-keyed-target] — NO hardcoded host paths here.
 *
 * Files:
 *   extension.json   (born-conformant manifest: type=command, runtime=node,
 *                     invocation.protocol=stdio, install block with type+hosts)
 *   package.json     (with bin field pointing to dist/index.js)
 *   tsconfig.json
 *   src/index.ts     (#!/usr/bin/env node stub with run() + CLI entry)
 *   CHANGELOG.md
 *   README.md
 *
 * [inv:nx-free-core] — no nx-packages imports.
 * [inv:host-agnostic-type] — install.type used; target resolved from host-registry.
 */

import type { FileSet } from '../../index.js';
import type { TemplateOpts } from '../_shared.js';
import { manifestJson, buildInstallDescriptor, tsconfigJson, changelogMd, readmeMd } from '../_shared.js';

export function commandTemplate(opts: TemplateOpts): FileSet {
  // package.json with bin field for direct CLI invocation
  const cmdPkg = JSON.stringify(
    {
      name: `@sox/extension-${opts.id}`,
      version: '0.1.0',
      description: opts.description,
      private: true,
      main: 'dist/index.js',
      types: 'dist/index.d.ts',
      bin: { [opts.id]: 'dist/index.js' },
      files: ['dist'],
      scripts: {
        build: 'tsc --project tsconfig.json',
        typecheck: 'tsc --noEmit --project tsconfig.json',
        test: 'vitest run',
      },
      license: 'MIT',
      ...(opts.author !== undefined && opts.author !== '' ? { author: opts.author } : {}),
      ...(opts.keywords !== undefined && opts.keywords.length > 0 ? { keywords: opts.keywords } : {}),
    },
    null,
    2,
  );

  // Build install descriptor; apply --surface override if provided
  const installDescriptor = buildInstallDescriptor('command', opts);
  if (opts.surface !== undefined && opts.surface !== '') {
    installDescriptor['overrides'] = { surface: opts.surface };
  }

  return {
    'extension.json': manifestJson(opts, {
      runtime: 'node',
      entrypoint: 'dist/index.js',
      invocation: {
        // stdio: args arrive via process.argv; output goes to stdout.
        // Real CLI commands (briefing.js, program.js) use this pattern.
        protocol: 'stdio',
        handler: 'run',
      },
      // [shape:install-descriptor] — host-agnostic; engine resolves target from
      // libs/host-registry (claude: file-drop at .claude/commands/; codex: config-merge).
      // [ref:host-keyed-target] — NO literal host path here.
      install: installDescriptor,
    }),

    'package.json': cmdPkg,

    'tsconfig.json': tsconfigJson(),

    'src/index.ts': [
      `#!/usr/bin/env node`,
      `// Command: ${opts.title}`,
      `// ${opts.description}`,
      `// Deterministic CLI operation — no LLM calls.`,
      `// Args arrive via process.argv; output goes to stdout.`,
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
      ` * run() — programmatic entry point for /${opts.id} command.`,
      ` * Deterministic: no LLM calls, predictable output for identical inputs.`,
      ` */`,
      `export function run(input: CommandInput): CommandOutput {`,
      `  // TODO: implement command logic`,
      `  const result = \`${opts.id}: \${input.args.join(' ')}\`;`,
      `  return { stdout: result, exitCode: 0 };`,
      `}`,
      ``,
      `// CLI entry — only runs when executed directly (node dist/index.js ...)`,
      `if (process.argv[1]?.endsWith('index.js') || process.argv[1]?.endsWith('${opts.id}')) {`,
      `  const args = process.argv.slice(2);`,
      `  const out = run({ args });`,
      `  process.stdout.write(out.stdout + '\\n');`,
      `  process.exit(out.exitCode);`,
      `}`,
    ].join('\n'),

    // Pre-compiled stub so sox validate passes the P0 entrypoint-reachability gate
    // immediately after scaffold (before the author runs `npm run build`).
    // This file is overwritten by the real build; treat it as a placeholder.
    'dist/index.js': [
      `#!/usr/bin/env node`,
      `// ${opts.id} — command stub (replace with real build output)`,
      `"use strict";`,
      `const run = (i) => ({ stdout: \`${opts.id}: \${i.args.join(' ')}\`, exitCode: 0 });`,
      `exports.run = run;`,
      `if (require.main === module) {`,
      `  const o = run({ args: process.argv.slice(2) });`,
      `  process.stdout.write(o.stdout + '\\n');`,
      `  process.exit(o.exitCode);`,
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
      '```bash',
      `# Via sox`,
      `sox exec ${opts.id} [args...]`,
      '',
      `# Direct`,
      `${opts.id} [args...]`,
      '```',
      '',
      '## Runtime',
      '',
      '`node` (default). For a Python command, set `runtime: python` in `extension.json`',
      'and replace `src/index.ts` + `tsconfig.json` with a `pyproject.toml` +',
      '`[project.scripts]` entry.',
      '',
      '## Constraints',
      '',
      '- Deterministic: no LLM calls inside the command handler.',
      '- Exit non-zero on failure; output to stdout.',
      '',
      '## Usage',
      '',
      '```bash',
      `sox install ${opts.id}`,
      '```',
    ]),
  };
}
