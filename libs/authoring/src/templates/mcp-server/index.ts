/**
 * MCP-server template — scaffolds a stdio JSON-RPC MCP server extension.
 *
 * Files:
 *   extension.json   (born-conformant manifest: type=mcp-server, runtime=node, lifecycle)
 *   package.json
 *   tsconfig.json
 *   src/index.ts     (readline JSON-RPC stdio stub)
 *   CHANGELOG.md
 *   README.md
 *   CLAUDE.md        (LLM tool-call guidance)
 *
 * [inv:nx-free-core] — no nx-packages imports.
 */

import type { FileSet } from '../../index.js';
import type { TemplateOpts } from '../_shared.js';
import { manifestJson, packageJson, tsconfigJson, changelogMd, readmeMd } from '../_shared.js';

export function mcpServerTemplate(opts: TemplateOpts): FileSet {
  return {
    'extension.json': manifestJson(opts, {
      runtime: 'node',
      entrypoint: 'dist/index.js',
      lifecycle: {
        background: true,
        singleton: true,
        stop_timeout_ms: 5000,
        health: {
          type: 'stdio-ping',
          interval_ms: 30000,
          timeout_ms: 5000,
        },
      },
      tools: [
        {
          name: 'example_tool',
          description: `A stub tool for ${opts.id}`,
          inputSchema: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
          },
        },
      ],
    }),

    'package.json': packageJson(opts),

    'tsconfig.json': tsconfigJson(),

    'src/index.ts': [
      `// MCP Server: ${opts.title}`,
      `// ${opts.description}`,
      `// Transport: stdio (JSON-RPC lines)`,
      ``,
      `import { createInterface } from 'node:readline';`,
      ``,
      `const tools = [`,
      `  {`,
      `    name: 'example_tool',`,
      `    description: 'A stub tool for ${opts.id}',`,
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
    ].join('\n'),

    'CHANGELOG.md': changelogMd(),

    'README.md': readmeMd(opts, [
      '## When to use',
      '',
      `<!-- Describe when to reach for tools from this server. -->`,
      '',
      '## Tools',
      '',
      '| Tool name      | Description               | Inputs         |',
      '| -------------- | ------------------------- | -------------- |',
      `| \`example_tool\` | A stub tool for ${opts.id} | \`query\`: string |`,
      '',
      '## Transport',
      '',
      'stdio (JSON-RPC lines)',
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
      `## When to call tools from this server`,
      ``,
      `<!-- Describe when to reach for tools in this server. -->`,
      ``,
      `## Available tools`,
      ``,
      `### \`example_tool\``,
      ``,
      `**Description:** A stub tool for ${opts.id}`,
      ``,
      `**Input:**`,
      `\`\`\`json`,
      `{ "query": "<string>" }`,
      `\`\`\``,
      ``,
      `**Output:** Plain text response`,
      ``,
      `## Transport`,
      ``,
      `stdio — one JSON-RPC request per line, one JSON response per line.`,
      ``,
      `## Server id`,
      ``,
      `\`${opts.id}\``,
    ].join('\n'),
  };
}
