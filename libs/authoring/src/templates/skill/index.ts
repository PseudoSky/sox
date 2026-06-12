/**
 * Skill template — scaffolds a run(input) → output skill extension.
 *
 * Files:
 *   extension.json   (born-conformant manifest: type=skill, runtime=node)
 *   package.json
 *   tsconfig.json
 *   src/index.ts     (run(SkillInput) → SkillOutput stub)
 *   CHANGELOG.md
 *   README.md
 *   SKILL.md         (LLM invocation guidance for skills)
 *
 * [inv:nx-free-core] — no nx-packages imports.
 */

import type { FileSet } from '../../index.js';
import type { TemplateOpts } from '../_shared.js';
import { manifestJson, packageJson, tsconfigJson, changelogMd, readmeMd } from '../_shared.js';

export function skillTemplate(opts: TemplateOpts): FileSet {
  return {
    'extension.json': manifestJson(opts, {
      runtime: 'node',
      entrypoint: 'dist/index.js',
      run_interface: {
        input_schema: {
          type: 'object',
          properties: {
            input: { type: 'string', description: 'Input to process' },
          },
          required: ['input'],
        },
        output_schema: {
          type: 'object',
          properties: {
            result: { type: 'string', description: 'Processed output' },
          },
          required: ['result'],
        },
      },
    }),

    'package.json': packageJson(opts),

    'tsconfig.json': tsconfigJson(),

    'src/index.ts': [
      `// Skill: ${opts.title}`,
      `// ${opts.description}`,
      ``,
      `export interface SkillInput {`,
      `  /** Input to process */`,
      `  input: string;`,
      `}`,
      ``,
      `export interface SkillOutput {`,
      `  result: string;`,
      `}`,
      ``,
      `export async function run(input: SkillInput): Promise<SkillOutput> {`,
      `  // TODO: implement skill logic`,
      `  return { result: \`Processed: \${input.input}\` };`,
      `}`,
    ].join('\n'),

    'CHANGELOG.md': changelogMd(),

    'README.md': readmeMd(opts, [
      '## When to use',
      '',
      `<!-- Describe the conditions under which to invoke this skill. -->`,
      '',
      '## Inputs',
      '',
      '| Field   | Type   | Required | Description |',
      '| ------- | ------ | -------- | ----------- |',
      '| `input` | string | yes      | The text or data to process |',
      '',
      '## Outputs',
      '',
      '| Field    | Type   | Description           |',
      '| -------- | ------ | --------------------- |',
      '| `result` | string | The processed output  |',
      '',
      '## Usage',
      '',
      '```bash',
      `sox install ${opts.id}`,
      '```',
    ]),

    'SKILL.md': [
      `# Skill: ${opts.title}`,
      ``,
      `## Invocation guidance`,
      ``,
      `**When to invoke:** ${opts.description}`,
      ``,
      `**Do NOT invoke when:**`,
      ``,
      `<!-- Describe situations where this skill should NOT be used. -->`,
      ``,
      `## Input contract`,
      ``,
      `\`\`\`typescript`,
      `interface SkillInput {`,
      `  input: string; // The text or data to process`,
      `}`,
      `\`\`\``,
      ``,
      `## Output contract`,
      ``,
      `\`\`\`typescript`,
      `interface SkillOutput {`,
      `  result: string; // The processed output`,
      `}`,
      `\`\`\``,
      ``,
      `## Examples`,
      ``,
      `\`\`\`json`,
      `{ "input": "example input" }`,
      `// → { "result": "Processed: example input" }`,
      `\`\`\``,
      ``,
      `## Skill id`,
      ``,
      `\`${opts.id}\``,
    ].join('\n'),
  };
}
