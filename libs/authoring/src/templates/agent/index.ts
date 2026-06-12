/**
 * Agent template — scaffolds a tool-calling agent extension.
 *
 * Files:
 *   extension.json   (born-conformant manifest: type=agent, runtime=node)
 *   package.json     (with author/keywords from opts)
 *   tsconfig.json    (per-extension tsconfig — gap fix over new-extension.ts)
 *   src/index.ts     (AgentDefinition stub + default export)
 *   CHANGELOG.md
 *   README.md
 *   CLAUDE.md        (LLM invocation guidance)
 *
 * [inv:nx-free-core] — no nx-packages imports.
 */

import type { FileSet } from '../../index.js';
import type { TemplateOpts } from '../_shared.js';
import { manifestJson, packageJson, tsconfigJson, changelogMd, readmeMd } from '../_shared.js';

export function agentTemplate(opts: TemplateOpts): FileSet {
  return {
    'extension.json': manifestJson(opts, {
      runtime: 'node',
      entrypoint: 'dist/index.js',
      invocation: {
        protocol: 'function-export',
        handler: 'tools',
      },
      requires: {
        tool_calling: true,
      },
    }),

    'package.json': packageJson(opts),

    'tsconfig.json': tsconfigJson(),

    'src/index.ts': [
      `// Agent: ${opts.title}`,
      `// ${opts.description}`,
      ``,
      `export interface AgentDefinition {`,
      `  name: string;`,
      `  description: string;`,
      `  systemPrompt: string;`,
      `  tools: string[];`,
      `}`,
      ``,
      `const agent: AgentDefinition = {`,
      `  name: '${opts.id}',`,
      `  description: '${opts.description}',`,
      `  systemPrompt: 'You are a helpful assistant. ${opts.description}',`,
      `  tools: ['read_file', 'write_file'],`,
      `};`,
      ``,
      `export default agent;`,
    ].join('\n'),

    'CHANGELOG.md': changelogMd(),

    'README.md': readmeMd(opts, [
      '## When to use',
      '',
      `<!-- Describe when to delegate to this agent. -->`,
      '',
      '## Capabilities',
      '',
      '- Tool calling: yes',
      '',
      '## Usage',
      '',
      '```bash',
      `sox install ${opts.id}`,
      '```',
    ]),

    'CLAUDE.md': [
      `# ${opts.title} — LLM Guidance`,
      ``,
      `## Purpose`,
      ``,
      `${opts.description}`,
      ``,
      `## When to delegate to this agent`,
      ``,
      `<!-- Describe the conditions under which an orchestrator should hand off to this agent. -->`,
      ``,
      `## What this agent does`,
      ``,
      `1. Receives task description from host`,
      `2. Uses available tools to complete the task`,
      `3. Returns a structured result`,
      ``,
      `## Tools required`,
      ``,
      `- \`read_file\` — reads file contents`,
      `- \`write_file\` — writes file contents`,
      ``,
      `## Constraints`,
      ``,
      `- This agent does NOT make external network calls unless listed above.`,
      `- Keep task scope narrow: one goal per delegation.`,
      ``,
      `## Agent id`,
      ``,
      `\`${opts.id}\``,
    ].join('\n'),
  };
}
