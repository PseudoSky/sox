#!/usr/bin/env node
/**
 * new-extension.ts — scaffold generator for LLM extension types
 *
 * Generates exactly 4 files per extension:
 *   extension.json, package.json, <content-file>, CHANGELOG.md
 *
 * Content file is prompt.md for type=prompt; src/index.ts for all others.
 *
 * Usage: npx tsx scripts/new-extension.ts
 * Or non-interactive: TYPE=skill ID=my-ext TITLE="My Ext" DESC="..." npx tsx scripts/new-extension.ts
 *
 * Contract (Section 4.4): id validated ^[a-z][a-z0-9-]*$; id must NOT end with type name.
 * Aborts on invalid id or pre-existing directory. Zero external scaffold deps.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';

// G-B: 'bundle' is the one new type in v2. It is install-time-only and has no entrypoint.
// A bundle is a named, independently-versioned set of members; the installer expands it.
const VALID_TYPES = ['agent', 'skill', 'mcp-server', 'prompt', 'hook', 'command', 'bundle'] as const;
type ExtensionType = (typeof VALID_TYPES)[number];

const DIR_MAP: Record<ExtensionType, string> = {
  agent: 'agents',
  skill: 'skills',
  'mcp-server': 'mcp-servers',
  prompt: 'prompts',
  hook: 'hooks',
  command: 'commands',
  bundle: 'bundles',
};

function validateId(id: string, type: ExtensionType): string | null {
  if (!/^[a-z][a-z0-9-]*$/.test(id)) {
    return `id "${id}" must match ^[a-z][a-z0-9-]*$`;
  }
  if (id.endsWith(`-${type}`) || id === type) {
    return `id "${id}" must not end with the type name "${type}"`;
  }
  return null;
}

function contentFileFor(type: ExtensionType): string {
  if (type === 'prompt') return 'prompt.md';
  if (type === 'bundle') return ''; // bundles have no content file
  return 'src/index.ts';
}

function makeContentFile(type: ExtensionType, id: string, title: string, description: string): string {
  switch (type) {
    case 'agent':
      return [
        `// Agent: ${title}`,
        `// ${description}`,
        ``,
        `export interface AgentDefinition {`,
        `  name: string;`,
        `  description: string;`,
        `  systemPrompt: string;`,
        `  tools: string[];`,
        `}`,
        ``,
        `const agent: AgentDefinition = {`,
        `  name: '${id}',`,
        `  description: '${description}',`,
        `  systemPrompt: 'You are a helpful assistant. ${description}',`,
        `  tools: ['read_file', 'write_file'],`,
        `};`,
        ``,
        `export default agent;`,
      ].join('\n');

    case 'skill':
      return [
        `// Skill: ${title}`,
        `// ${description}`,
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
      ].join('\n');

    case 'mcp-server':
      return [
        `// MCP Server: ${title}`,
        `// ${description}`,
        `// Transport: stdio`,
        ``,
        `import { createInterface } from 'node:readline';`,
        ``,
        `const tools = [`,
        `  {`,
        `    name: 'example_tool',`,
        `    description: 'A stub tool for ${id}',`,
        `    inputSchema: {`,
        `      type: 'object',`,
        `      properties: { query: { type: 'string' } },`,
        `      required: ['query'],`,
        `    },`,
        `  },`,
        `];`,
        ``,
        `async function handleRequest(req: unknown): Promise<unknown> {`,
        `  const r = req as { method: string; id?: unknown };`,
        `  if (r.method === 'tools/list') return { tools };`,
        `  if (r.method === 'tools/call') return { content: [{ type: 'text', text: 'stub response' }] };`,
        `  return { error: { code: -32601, message: 'Method not found' } };`,
        `}`,
        ``,
        `const rl = createInterface({ input: process.stdin });`,
        `rl.on('line', async (line) => {`,
        `  try {`,
        `    const req = JSON.parse(line) as unknown;`,
        `    const res = await handleRequest(req);`,
        `    process.stdout.write(JSON.stringify(res) + '\\n');`,
        `  } catch (e) {`,
        `    process.stdout.write(JSON.stringify({ error: String(e) }) + '\\n');`,
        `  }`,
        `});`,
      ].join('\n');

    case 'prompt':
      return [
        `---`,
        `id: ${id}`,
        `title: ${title}`,
        `description: ${description}`,
        `version: 0.1.0`,
        `parameters:`,
        `  - name: topic`,
        `    type: string`,
        `    required: true`,
        `    description: The topic to address`,
        `---`,
        ``,
        `# ${title}`,
        ``,
        `${description}`,
        ``,
        `## Instructions`,
        ``,
        `Please address the following topic carefully: {{topic}}`,
        ``,
        `Provide a thorough, well-structured response.`,
      ].join('\n');

    case 'hook':
      return [
        `// Hook: ${title}`,
        `// ${description}`,
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
        `  const logLine = \`[\${ctx.timestamp}] \${ctx.event}: \${JSON.stringify(ctx.payload)}\n\`;`,
        `  fs.appendFileSync('/tmp/${id}.log', logLine);`,
        `}`,
        ``,
        `export const event = 'PreToolUse';`,
      ].join('\n');

    case 'command':
      return [
        `// Command: ${title}`,
        `// ${description}`,
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
        ` * Command handler — invoked via slash command /${id}`,
        ` * Deterministic: no LLM calls, predictable output.`,
        ` */`,
        `export function run(input: CommandInput): CommandOutput {`,
        `  try {`,
        `    const stdout = execSync(\`echo "Command ${id}: \${input.args.join(' ')}"\`, {`,
        `      encoding: 'utf8',`,
        `      timeout: 5000,`,
        `    });`,
        `    return { stdout: stdout.trim(), exitCode: 0 };`,
        `  } catch (e) {`,
        `    return { stdout: String(e), exitCode: 1 };`,
        `  }`,
        `}`,
      ].join('\n');

    case 'bundle':
      // A bundle has no content file — it is manifest-only (extension.json + package.json).
      // This case returns an empty string; scaffold() skips writing a content file for bundles.
      return '';
  }
}

function makeExtensionJson(type: ExtensionType, id: string, title: string, description: string): string {
  const base: Record<string, unknown> = {
    $schema: 'https://your-registry/schemas/extension/v1.json',
    id,
    version: '0.1.0',
    type,
    title,
    description,
    compatibility: { host: '>=1.0.0 <2.0.0' },
    license: 'MIT',
    author: '',
  };

  if (type === 'bundle') {
    // G-B: bundle has no entrypoint (no runtime — expanded away at install time) and no runtime field.
    // Populate a placeholder members array; authors fill in the actual member ids+versions.
    // 'dependencies' and 'members' are orthogonal: 'members' is a packaging relation.
    base['members'] = [
      { id: 'example-member-a', version: '^0.1.0' },
      { id: 'example-member-b', version: '^0.1.0' },
    ];
  } else {
    // G-D: runtime contract. 'node' = TS/Node (can call the provider abstraction).
    // 'stdio-any' = language-agnostic stdio process; MUST NOT declare provider requires.
    // Absent defaults to 'node'; kept explicit here so authors see the contract at creation.
    base['runtime'] = 'node';

    if (type !== 'prompt') {
      base['entrypoint'] = 'dist/index.js';
    }
    if (type === 'hook') {
      base['order'] = 100;
    }
  }

  return JSON.stringify(base, null, 2);
}

function makePackageJson(id: string): string {
  return JSON.stringify(
    {
      name: `@sox/extension-${id}`,
      version: '0.1.0',
      description: '',
      main: 'dist/index.js',
      types: 'dist/index.d.ts',
      files: ['dist'],
      scripts: {
        build: 'tsc',
        typecheck: 'tsc --noEmit',
      },
      license: 'MIT',
    },
    null,
    2,
  );
}

async function prompt(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

async function scaffold(
  type: ExtensionType,
  id: string,
  title: string,
  description: string,
): Promise<void> {
  const idErr = validateId(id, type);
  if (idErr) {
    console.error(`ERROR: ${idErr}`);
    process.exit(1);
  }

  const root = process.cwd();
  const dir = path.join(root, 'extensions', DIR_MAP[type], id);

  if (fs.existsSync(dir)) {
    console.error(`ERROR: Directory already exists: ${dir}`);
    process.exit(1);
  }

  // G-B: bundle has a smaller footprint — no entrypoint and no behavior tests.
  // It is manifest-only: extension.json + package.json (+ CHANGELOG.md).
  // This relaxes I6's four-files-per-extension downward for the install-time-only type.
  if (type === 'bundle') {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'extension.json'), makeExtensionJson(type, id, title, description));
    fs.writeFileSync(path.join(dir, 'package.json'), makePackageJson(id));
    fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), '# Changelog\n\n## 0.1.0\n\n- Initial release\n');

    console.log(`Created bundle "${id}" at extensions/bundles/${id}/`);
    console.log('  extension.json  (edit members[] to list the extensions this bundle ships)');
    console.log('  package.json');
    console.log('  CHANGELOG.md');
    console.log('NOTE: a bundle has no entrypoint — it is expanded to its members at install time.');
    return;
  }

  const contentFile = contentFileFor(type);
  const isTs = contentFile.endsWith('.ts');

  if (isTs) {
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  } else {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(path.join(dir, 'extension.json'), makeExtensionJson(type, id, title, description));
  fs.writeFileSync(path.join(dir, 'package.json'), makePackageJson(id));
  fs.writeFileSync(path.join(dir, contentFile), makeContentFile(type, id, title, description));
  fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), '# Changelog\n\n## 0.1.0\n\n- Initial release\n');

  console.log(`Created ${type} extension "${id}" at extensions/${DIR_MAP[type]}/${id}/`);
  console.log('  extension.json');
  console.log('  package.json');
  console.log(`  ${contentFile}`);
  console.log('  CHANGELOG.md');
}

async function main(): Promise<void> {
  // Non-interactive mode via env vars
  const envType = process.env['TYPE'] as ExtensionType | undefined;
  const envId = process.env['ID'];
  const envTitle = process.env['TITLE'];
  const envDesc = process.env['DESC'];

  if (envType && envId && envTitle && envDesc) {
    if (!VALID_TYPES.includes(envType)) {
      console.error(`ERROR: Invalid type "${envType}". Must be one of: ${VALID_TYPES.join(', ')}`);
      process.exit(1);
    }
    await scaffold(envType, envId, envTitle, envDesc);
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    const typeInput = await prompt(rl, `Extension type (${VALID_TYPES.join('|')}): `);
    if (!VALID_TYPES.includes(typeInput as ExtensionType)) {
      console.error(`ERROR: Invalid type "${typeInput}". Must be one of: ${VALID_TYPES.join(', ')}`);
      process.exit(1);
    }
    const type = typeInput as ExtensionType;
    const id = await prompt(rl, 'Extension id (e.g. hello-world): ');
    const title = await prompt(rl, 'Title: ');
    const description = await prompt(rl, 'Description: ');

    await scaffold(type, id, title, description);
  } finally {
    rl.close();
  }
}

main().catch((err: unknown) => {
  console.error('Error:', err);
  process.exit(1);
});
