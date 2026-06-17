#!/usr/bin/env node
/**
 * new-extension.ts — scaffold generator for LLM extension types
 *
 * Generates type-specific files per extension:
 *   extension.json, package.json, <content-file>, CHANGELOG.md
 *   README.md          (all types)
 *   SKILL.md           (skill only)
 *   CLAUDE.md          (agent, mcp-server — LLM invocation guidance)
 *
 * Content file is prompt.md for type=prompt; src/index.ts for all others.
 * Bundle type is manifest-only (no content file, no src/).
 *
 * Usage (interactive):
 *   npx tsx scripts/new-extension.ts
 *
 * Usage (non-interactive positional):
 *   node scripts/new-extension.ts <type> <id> [flags]
 *   node scripts/new-extension.ts skill my-skill --description "use this when X" --author "Jane" --keywords "foo,bar" --out /tmp/out
 *
 * Usage (legacy env-var non-interactive):
 *   TYPE=skill ID=my-ext TITLE="My Ext" DESC="..." npx tsx scripts/new-extension.ts
 *
 * Contract (Section 4.4): id validated ^[a-z][a-z0-9-]*$; id must NOT end with type name.
 * Aborts on invalid id or pre-existing directory. Zero external scaffold deps.
 *
 * P3: Adds --description, --author, --keywords, --out flags for non-interactive use.
 *     Emits type-specific doc stubs (README.md, SKILL.md, CLAUDE.md).
 *     Pre-fills P2 self-description fields in extension.json.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';

// G-B: 'bundle' is the one new type in v2. It is install-time-only and has no entrypoint.
// A bundle is a named, independently-versioned set of members; the installer expands it.
// 'service' is a supervised long-running extension with a transports array.
const VALID_TYPES = ['agent', 'skill', 'mcp-server', 'prompt', 'hook', 'command', 'bundle', 'service'] as const;
type ExtensionType = (typeof VALID_TYPES)[number];

const DIR_MAP: Record<ExtensionType, string> = {
  agent: 'agents',
  skill: 'skills',
  'mcp-server': 'mcp-servers',
  prompt: 'prompts',
  hook: 'hooks',
  command: 'commands',
  bundle: 'bundles',
  service: 'services',
};

function validateId(id: string, _type: ExtensionType): string | null {
  if (!/^[a-z][a-z0-9-]*$/.test(id)) {
    return `id "${id}" must match ^[a-z][a-z0-9-]*$`;
  }
  return null;
}

/**
 * Return a style-advisory message when the id ends with the type name.
 * This is a WARN-only rule (not an error) — it matches libs/authoring's fallback
 * behavior and allows guard/test IDs like "test-agent" to scaffold without error.
 * [inv:style-only]: the manifest schema does not enforce this restriction.
 */
function warnIdSuffix(id: string, type: ExtensionType): string | null {
  if (id.endsWith(`-${type}`) || id === type) {
    return `warning: id "${id}" ends with the type name "${type}" — consider a more descriptive name`;
  }
  return null;
}

function contentFileFor(type: ExtensionType, id?: string): string {
  if (type === 'prompt') return 'prompt.md';
  if (type === 'bundle') return ''; // bundles have no content file
  // Declarative types: the content IS the markdown definition file, named <id>.md.
  // This is the host-native format for file-drop install (claude: .claude/agents/<id>.md etc.).
  if (type === 'agent' || type === 'command') return `${id ?? type}.md`;
  return 'src/index.ts';
}

function makeContentFile(type: ExtensionType, id: string, title: string, description: string): string {
  switch (type) {
    case 'agent':
      // Declarative markdown agent definition — the host reads this .md file and
      // injects it as a subagent definition. YAML frontmatter + markdown body.
      // Named <id>.md and installed as a file-drop at .claude/agents/<id>.md.
      return [
        `---`,
        `name: ${id}`,
        `description: ${description}`,
        `tools: Read, Write, Edit, Bash, Glob, Grep`,
        `model: sonnet`,
        `---`,
        ``,
        `# ${title}`,
        ``,
        `${description}`,
        ``,
        `## When to invoke this agent`,
        ``,
        `<!-- Describe the conditions under which an orchestrator should hand off to this agent. -->`,
        ``,
        `## What this agent does`,
        ``,
        `1. Receives a task description from the host or orchestrator.`,
        `2. Uses available tools to complete the task.`,
        `3. Returns a structured result to the caller.`,
        ``,
        `## Constraints`,
        ``,
        `- Keep task scope narrow: one goal per delegation.`,
        `- Do NOT make external network calls unless explicitly permitted.`,
        ``,
        `## Agent id`,
        ``,
        `\`${id}\``,
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
      // Declarative markdown slash command — installed as a file-drop at
      // .claude/commands/<id>.md. The host reads this file to register the slash command.
      return [
        `# /${id}`,
        ``,
        `${description}`,
        ``,
        `## Usage`,
        ``,
        `\`\`\``,
        `/${id} [args...]`,
        `\`\`\``,
        ``,
        `## What this command does`,
        ``,
        `<!-- Describe what the slash command does when invoked. -->`,
        ``,
        `1. Receives the command arguments from the host.`,
        `2. Performs the command action.`,
        `3. Returns a result to the user.`,
        ``,
        `## Arguments`,
        ``,
        `<!-- List accepted arguments and their purpose. -->`,
        ``,
        `## Examples`,
        ``,
        `\`\`\``,
        `/${id} example-arg`,
        `\`\`\``,
        ``,
        `## Command id`,
        ``,
        `\`${id}\``,
      ].join('\n');

    case 'bundle':
      // A bundle has no content file — it is manifest-only (extension.json + package.json).
      // This case returns an empty string; scaffold() skips writing a content file for bundles.
      return '';
  }
}

// ── P3: Type-specific doc stub generators ─────────────────────────────────────

/**
 * README.md — emitted for ALL extension types.
 * Section structure is type-specific so P4's content lint can pass once authored.
 */
function makeReadme(type: ExtensionType, id: string, title: string, description: string): string {
  switch (type) {
    case 'skill':
      return [
        `# ${title}`,
        ``,
        `> ${description}`,
        ``,
        `## Overview`,
        ``,
        `<!-- Describe what this skill does and the problem it solves. -->`,
        ``,
        `## When to use`,
        ``,
        `<!-- Describe the conditions under which a host or orchestrator should invoke this skill.`,
        `     Example: "Use this skill when the user asks to summarise a long document." -->`,
        ``,
        `## Inputs`,
        ``,
        `| Field   | Type   | Required | Description |`,
        `| ------- | ------ | -------- | ----------- |`,
        `| \`input\` | string | yes      | The text or data to process |`,
        ``,
        `## Outputs`,
        ``,
        `| Field    | Type   | Description           |`,
        `| -------- | ------ | --------------------- |`,
        `| \`result\` | string | The processed output  |`,
        ``,
        `## Usage`,
        ``,
        `\`\`\`bash`,
        `sox install ${id}`,
        `\`\`\``,
        ``,
        `## Configuration`,
        ``,
        `<!-- List any environment variables or config keys this skill reads. -->`,
        ``,
        `## Development`,
        ``,
        `\`\`\`bash`,
        `pnpm install`,
        `pnpm build`,
        `pnpm test`,
        `\`\`\``,
        ``,
        `## License`,
        ``,
        `MIT`,
      ].join('\n');

    case 'agent':
      return [
        `# ${title}`,
        ``,
        `> ${description}`,
        ``,
        `## Overview`,
        ``,
        `<!-- Describe what this agent does and the tasks it handles autonomously. -->`,
        ``,
        `## When to use`,
        ``,
        `<!-- Describe the conditions under which a host should delegate to this agent.`,
        `     Example: "Delegate to this agent when the user needs an end-to-end code review." -->`,
        ``,
        `## Capabilities`,
        ``,
        `<!-- List the tools and capabilities this agent requires. -->`,
        ``,
        `- Tool calling: yes`,
        ``,
        `## Inputs`,
        ``,
        `<!-- Describe the task description / context this agent expects. -->`,
        ``,
        `## Outputs`,
        ``,
        `<!-- Describe the artefacts or responses this agent produces. -->`,
        ``,
        `## Usage`,
        ``,
        `\`\`\`bash`,
        `sox install ${id}`,
        `\`\`\``,
        ``,
        `## Configuration`,
        ``,
        `<!-- List any environment variables or config keys this agent reads. -->`,
        ``,
        `## Development`,
        ``,
        `\`\`\`bash`,
        `pnpm install`,
        `pnpm build`,
        `pnpm test`,
        `\`\`\``,
        ``,
        `## License`,
        ``,
        `MIT`,
      ].join('\n');

    case 'mcp-server':
      return [
        `# ${title}`,
        ``,
        `> ${description}`,
        ``,
        `## Overview`,
        ``,
        `<!-- Describe what tools this MCP server exposes and the domain it covers. -->`,
        ``,
        `## When to use`,
        ``,
        `<!-- Describe the conditions under which a host or LLM should reach for this server.`,
        `     Example: "Use this server when the task requires reading or writing files." -->`,
        ``,
        `## Tools`,
        ``,
        `| Tool name      | Description               | Inputs         |`,
        `| -------------- | ------------------------- | -------------- |`,
        `| \`example_tool\` | A stub tool for ${id} | \`query\`: string |`,
        ``,
        `## Transport`,
        ``,
        `stdio (JSON-RPC lines)`,
        ``,
        `## Usage`,
        ``,
        `\`\`\`bash`,
        `sox install ${id}`,
        `\`\`\``,
        ``,
        `## Configuration`,
        ``,
        `<!-- List any environment variables or config keys this server reads. -->`,
        ``,
        `## Development`,
        ``,
        `\`\`\`bash`,
        `pnpm install`,
        `pnpm build`,
        `pnpm test`,
        `\`\`\``,
        ``,
        `## License`,
        ``,
        `MIT`,
      ].join('\n');

    case 'prompt':
      return [
        `# ${title}`,
        ``,
        `> ${description}`,
        ``,
        `## Overview`,
        ``,
        `<!-- Describe what this prompt template produces and for whom. -->`,
        ``,
        `## When to use`,
        ``,
        `<!-- Describe the conditions under which a host should load this prompt.`,
        `     Example: "Use this prompt when the user asks for a structured analysis." -->`,
        ``,
        `## Parameters`,
        ``,
        `| Parameter | Type   | Required | Description              |`,
        `| --------- | ------ | -------- | ------------------------ |`,
        `| \`topic\`   | string | yes      | The topic to address     |`,
        ``,
        `## Usage`,
        ``,
        `\`\`\`bash`,
        `sox install ${id}`,
        `\`\`\``,
        ``,
        `## License`,
        ``,
        `MIT`,
      ].join('\n');

    case 'hook':
      return [
        `# ${title}`,
        ``,
        `> ${description}`,
        ``,
        `## Overview`,
        ``,
        `<!-- Describe what lifecycle event this hook binds to and what it does. -->`,
        ``,
        `## When to use`,
        ``,
        `<!-- Describe the conditions under which this hook should be installed.`,
        `     Example: "Install this hook when you want to log every PreToolUse event." -->`,
        ``,
        `## Lifecycle event`,
        ``,
        `\`PreToolUse\` (default; change \`event\` export in \`src/index.ts\` to rebind)`,
        ``,
        `## Execution order`,
        ``,
        `\`order: 100\` — hooks fire in ascending order; ties broken lexicographically by id.`,
        ``,
        `## Constraints`,
        ``,
        `- Deterministic: no LLM calls inside a hook handler.`,
        `- Side effects must be idempotent (hooks may fire more than once on retry).`,
        ``,
        `## Usage`,
        ``,
        `\`\`\`bash`,
        `sox install ${id}`,
        `\`\`\``,
        ``,
        `## Configuration`,
        ``,
        `<!-- List any environment variables or config keys this hook reads. -->`,
        ``,
        `## License`,
        ``,
        `MIT`,
      ].join('\n');

    case 'command':
      return [
        `# ${title}`,
        ``,
        `> ${description}`,
        ``,
        `## Overview`,
        ``,
        `<!-- Describe what slash command this extension implements and what it does. -->`,
        ``,
        `## When to use`,
        ``,
        `<!-- Describe the conditions under which a user invokes this command.`,
        `     Example: "Use /${id} when you need to run X quickly from the chat interface." -->`,
        ``,
        `## Invocation`,
        ``,
        `\`\`\``,
        `/${id} [args...]`,
        `\`\`\``,
        ``,
        `## Arguments`,
        ``,
        `| Argument | Description |`,
        `| -------- | ----------- |`,
        `| \`args\`   | Positional arguments passed to the command |`,
        ``,
        `## Constraints`,
        ``,
        `- Deterministic: no LLM calls inside the command handler.`,
        `- Exits non-zero on failure; stdout is the result.`,
        ``,
        `## Usage`,
        ``,
        `\`\`\`bash`,
        `sox install ${id}`,
        `\`\`\``,
        ``,
        `## License`,
        ``,
        `MIT`,
      ].join('\n');

    case 'bundle':
      return [
        `# ${title}`,
        ``,
        `> ${description}`,
        ``,
        `## Overview`,
        ``,
        `<!-- Describe the purpose of this bundle and the extensions it ships together. -->`,
        ``,
        `## When to use`,
        ``,
        `<!-- Describe the scenario where installing this bundle makes sense.`,
        `     Example: "Install this bundle to get the full memory subsystem in one command." -->`,
        ``,
        `## Members`,
        ``,
        `<!-- List the extensions this bundle includes and their roles. -->`,
        ``,
        `| Extension id       | Role            |`,
        `| ------------------ | --------------- |`,
        `| example-member-a   | (describe role) |`,
        `| example-member-b   | (describe role) |`,
        ``,
        `## Usage`,
        ``,
        `\`\`\`bash`,
        `sox install ${id}`,
        `\`\`\``,
        ``,
        `The installer expands the bundle to its members — no entrypoint is required.`,
        ``,
        `## License`,
        ``,
        `MIT`,
      ].join('\n');
  }
}

/**
 * SKILL.md — emitted for type=skill only.
 * Structured invocation guidance for the LLM orchestrator / host.
 */
function makeSkillMd(id: string, title: string, description: string): string {
  return [
    `# Skill: ${title}`,
    ``,
    `## Invocation guidance`,
    ``,
    `**When to invoke:** ${description}`,
    ``,
    `**Do NOT invoke when:**`,
    ``,
    `<!-- Describe situations where this skill should NOT be used.`,
    `     Example: "Do not invoke this skill for tasks that require real-time data." -->`,
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
    `## Failure modes`,
    ``,
    `<!-- Describe what the skill returns or throws when it cannot complete the task. -->`,
    ``,
    `## Performance characteristics`,
    ``,
    `<!-- Describe expected latency, token usage, or resource requirements. -->`,
    ``,
    `## Skill id`,
    ``,
    `\`${id}\``,
  ].join('\n');
}

/**
 * CLAUDE.md — emitted for type=agent and type=mcp-server.
 * LLM invocation and interaction guidance for the host/orchestrator.
 */
function makeClaudeMd(type: 'agent' | 'mcp-server', id: string, title: string, description: string): string {
  if (type === 'agent') {
    return [
      `# ${title} — LLM Guidance`,
      ``,
      `## Purpose`,
      ``,
      `${description}`,
      ``,
      `## When to delegate to this agent`,
      ``,
      `<!-- Describe the conditions under which an orchestrator should hand off to this agent.`,
      `     Be specific about task boundaries and expected inputs. -->`,
      ``,
      `## What this agent does`,
      ``,
      `<!-- Describe the agent's behaviour step-by-step at a level useful to another LLM. -->`,
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
      `<!-- Add or remove tools as appropriate for this agent. -->`,
      ``,
      `## Constraints`,
      ``,
      `- This agent does NOT make external network calls unless listed above.`,
      `- Keep task scope narrow: one goal per delegation.`,
      ``,
      `## Handoff protocol`,
      ``,
      `Pass the task as a natural-language description string. The agent returns its`,
      `result as the final assistant message.`,
      ``,
      `## Agent id`,
      ``,
      `\`${id}\``,
    ].join('\n');
  }

  // mcp-server
  return [
    `# ${title} — LLM Guidance`,
    ``,
    `## Purpose`,
    ``,
    `${description}`,
    ``,
    `## When to call tools from this server`,
    ``,
    `<!-- Describe the conditions under which an LLM should reach for tools in this server.`,
    `     Be specific so the model selects the right tool. -->`,
    ``,
    `## Available tools`,
    ``,
    `### \`example_tool\``,
    ``,
    `**Description:** A stub tool for ${id}`,
    ``,
    `**Input:**`,
    `\`\`\`json`,
    `{ "query": "<string>" }`,
    `\`\`\``,
    ``,
    `**Output:** Plain text response`,
    ``,
    `**When to use:** <!-- Describe the specific conditions for calling this tool -->`,
    ``,
    `**When NOT to use:** <!-- Describe when to avoid this tool -->`,
    ``,
    `## Error handling`,
    ``,
    `<!-- Describe how to interpret error responses from this server. -->`,
    ``,
    `## Transport`,
    ``,
    `stdio — one JSON-RPC request per line, one JSON response per line.`,
    ``,
    `## Server id`,
    ``,
    `\`${id}\``,
  ].join('\n');
}

// ── Extension manifest generator ──────────────────────────────────────────────

function makeExtensionJson(
  type: ExtensionType,
  id: string,
  title: string,
  description: string,
  author?: string,
  keywords?: string[],
): string {
  const base: Record<string, unknown> = {
    $schema: 'https://your-registry/schemas/extension/v1.json',
    id,
    version: '0.1.0',
    type,
    title,
    description,
    compatibility: { host: '>=1.0.0 <2.0.0' },
    license: 'MIT',
  };

  // P3: pre-fill P2 self-description fields when provided
  if (author !== undefined && author !== '') {
    base['author'] = author;
  }
  if (keywords !== undefined && keywords.length > 0) {
    base['keywords'] = keywords;
  }

  if (type === 'bundle') {
    // G-B: bundle has no entrypoint (no runtime — expanded away at install time) and no runtime field.
    // Populate a placeholder members array; authors fill in the actual member ids+versions.
    // 'dependencies' and 'members' are orthogonal: 'members' is a packaging relation.
    base['members'] = [
      { id: 'example-member-a', version: '^0.1.0' },
      { id: 'example-member-b', version: '^0.1.0' },
    ];
  } else if (type === 'agent' || type === 'command') {
    // Declarative markdown types: runtime=declarative, entrypoint=<id>.md
    // The host reads the .md file directly; no build step, no process spawned.
    // The entrypoint filename MUST match contentFileFor(type, id) so that
    // bin/sox cmdInstall can derive srcPath = extDir/<id>.md for file-drop.
    base['runtime'] = 'declarative';
    base['entrypoint'] = `${id}.md`;
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

async function promptLine(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

// ── P3: Flag parsing for positional non-interactive mode ──────────────────────

interface ScaffoldFlags {
  /** type and id from positional args */
  type?: ExtensionType;
  id?: string;
  /** --description: pre-fills description + extension.json */
  description?: string;
  /** --author: pre-fills extension.json author field */
  author?: string;
  /** --keywords: comma-separated; pre-fills extension.json keywords array */
  keywords?: string[];
  /** --out: alternate output root (defaults to cwd/extensions/<type-dir>/<id>) */
  out?: string;
  /** --title: optional explicit title; defaults to id */
  title?: string;
}

/**
 * Parse positional + flag args from process.argv.
 * Positional form: `node new-extension.ts <type> <id> [flags]`
 * Returns null if no positional args — caller falls back to interactive mode.
 */
function parseCliArgs(argv: string[]): ScaffoldFlags | null {
  // argv = process.argv.slice(2)
  const flags: ScaffoldFlags = {};
  const positionals: string[] = [];
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === '--description' || arg === '-d') {
      flags.description = argv[++i] ?? '';
    } else if (arg !== undefined && arg.startsWith('--description=')) {
      flags.description = arg.slice('--description='.length);
    } else if (arg === '--author' || arg === '-a') {
      flags.author = argv[++i] ?? '';
    } else if (arg !== undefined && arg.startsWith('--author=')) {
      flags.author = arg.slice('--author='.length);
    } else if (arg === '--keywords' || arg === '-k') {
      const raw = argv[++i] ?? '';
      flags.keywords = raw.split(',').map((k) => k.trim()).filter(Boolean);
    } else if (arg !== undefined && arg.startsWith('--keywords=')) {
      const raw = arg.slice('--keywords='.length);
      flags.keywords = raw.split(',').map((k) => k.trim()).filter(Boolean);
    } else if (arg === '--out' || arg === '-o') {
      flags.out = argv[++i] ?? '';
    } else if (arg !== undefined && arg.startsWith('--out=')) {
      flags.out = arg.slice('--out='.length);
    } else if (arg === '--title' || arg === '-t') {
      flags.title = argv[++i] ?? '';
    } else if (arg !== undefined && arg.startsWith('--title=')) {
      flags.title = arg.slice('--title='.length);
    } else if (arg !== undefined && !arg.startsWith('-')) {
      positionals.push(arg);
    }
    i++;
  }

  if (positionals.length === 0) {
    return null; // interactive mode
  }

  const [typeArg, idArg] = positionals;
  if (typeArg !== undefined) {
    if (!VALID_TYPES.includes(typeArg as ExtensionType)) {
      console.error(`ERROR: Invalid type "${typeArg}". Must be one of: ${VALID_TYPES.join(', ')}`);
      process.exit(1);
    }
    flags.type = typeArg as ExtensionType;
  }
  if (idArg !== undefined) {
    flags.id = idArg;
  }

  return flags;
}

// ── Scaffold core ─────────────────────────────────────────────────────────────

async function scaffold(
  type: ExtensionType,
  id: string,
  title: string,
  description: string,
  opts: { author?: string; keywords?: string[]; out?: string } = {},
): Promise<void> {
  const idErr = validateId(id, type);
  if (idErr) {
    console.error(`ERROR: ${idErr}`);
    process.exit(1);
  }
  const idWarn = warnIdSuffix(id, type);
  if (idWarn) {
    console.error(idWarn);
  }

  // P3: --out redirects the output root instead of cwd/extensions/<type-dir>/
  let dir: string;
  if (opts.out !== undefined && opts.out !== '') {
    dir = path.join(opts.out, id);
  } else {
    const root = process.cwd();
    dir = path.join(root, 'extensions', DIR_MAP[type], id);
  }

  if (fs.existsSync(dir)) {
    console.error(`ERROR: Directory already exists: ${dir}`);
    process.exit(1);
  }

  // G-B: bundle has a smaller footprint — no entrypoint and no behavior tests.
  // It is manifest-only: extension.json + package.json (+ CHANGELOG.md + README.md).
  if (type === 'bundle') {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'extension.json'),
      makeExtensionJson(type, id, title, description, opts.author, opts.keywords),
    );
    fs.writeFileSync(path.join(dir, 'package.json'), makePackageJson(id));
    fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), '# Changelog\n\n## 0.1.0\n\n- Initial release\n');
    fs.writeFileSync(path.join(dir, 'README.md'), makeReadme(type, id, title, description));

    console.log(`Created bundle "${id}" at ${dir}/`);
    console.log('  extension.json  (edit members[] to list the extensions this bundle ships)');
    console.log('  package.json');
    console.log('  CHANGELOG.md');
    console.log('  README.md');
    console.log('NOTE: a bundle has no entrypoint — it is expanded to its members at install time.');
    return;
  }

  const contentFile = contentFileFor(type, id);
  const isTs = contentFile.endsWith('.ts');

  if (isTs) {
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  } else {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(
    path.join(dir, 'extension.json'),
    makeExtensionJson(type, id, title, description, opts.author, opts.keywords),
  );
  fs.writeFileSync(path.join(dir, 'package.json'), makePackageJson(id));
  fs.writeFileSync(path.join(dir, contentFile), makeContentFile(type, id, title, description));
  fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), '# Changelog\n\n## 0.1.0\n\n- Initial release\n');

  // P3: emit type-specific doc stubs
  fs.writeFileSync(path.join(dir, 'README.md'), makeReadme(type, id, title, description));

  if (type === 'skill') {
    fs.writeFileSync(path.join(dir, 'SKILL.md'), makeSkillMd(id, title, description));
  }

  // mcp-server still gets CLAUDE.md guidance; agent/command use their <id>.md as primary content
  if (type === 'mcp-server') {
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), makeClaudeMd(type, id, title, description));
  }

  const docFiles: string[] = ['README.md'];
  if (type === 'skill') docFiles.push('SKILL.md');
  if (type === 'mcp-server') docFiles.push('CLAUDE.md');

  console.log(`Created ${type} extension "${id}" at ${dir}/`);
  console.log('  extension.json');
  console.log('  package.json');
  console.log(`  ${contentFile}`);
  console.log('  CHANGELOG.md');
  for (const doc of docFiles) {
    console.log(`  ${doc}`);
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  // ── Mode 1: positional CLI flags (P3 non-interactive)
  const flags = parseCliArgs(argv);
  if (flags !== null && flags.type !== undefined && flags.id !== undefined) {
    const title = flags.title ?? flags.id;
    const description = flags.description ?? `${flags.id} extension`;
    const opts1: { author?: string; keywords?: string[]; out?: string } = {};
    if (flags.author !== undefined) opts1.author = flags.author;
    if (flags.keywords !== undefined) opts1.keywords = flags.keywords;
    if (flags.out !== undefined) opts1.out = flags.out;
    await scaffold(flags.type, flags.id, title, description, opts1);
    return;
  }

  // ── Mode 2: legacy env-var non-interactive
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

  // ── Mode 3: interactive
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    const typeInput = await promptLine(rl, `Extension type (${VALID_TYPES.join('|')}): `);
    if (!VALID_TYPES.includes(typeInput as ExtensionType)) {
      console.error(`ERROR: Invalid type "${typeInput}". Must be one of: ${VALID_TYPES.join(', ')}`);
      process.exit(1);
    }
    const type = typeInput as ExtensionType;
    const id = await promptLine(rl, 'Extension id (e.g. hello-world): ');
    const title = await promptLine(rl, 'Title: ');
    const description = await promptLine(rl, 'Description (use this when...): ');
    const authorRaw = await promptLine(rl, 'Author (name or "Name <email>", optional): ');
    const keywordsRaw = await promptLine(rl, 'Keywords (comma-separated, optional): ');

    const author = authorRaw !== '' ? authorRaw : undefined;
    const keywords =
      keywordsRaw !== ''
        ? keywordsRaw.split(',').map((k) => k.trim()).filter(Boolean)
        : undefined;

    const opts3: { author?: string; keywords?: string[] } = {};
    if (author !== undefined) opts3.author = author;
    if (keywords !== undefined) opts3.keywords = keywords;
    await scaffold(type, id, title, description, opts3);
  } finally {
    rl.close();
  }
}

main().catch((err: unknown) => {
  console.error('Error:', err);
  process.exit(1);
});
