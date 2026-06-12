/**
 * MCP-server template — scaffolds a stdio MCP server extension.
 *
 * Real shape (from ~/dev/node/adhd/packages/ai/agent-mcp):
 *   - Uses @modelcontextprotocol/sdk with StdioServerTransport (not raw readline).
 *   - Entry: src/index.ts with #!/usr/bin/env node shebang.
 *   - Registers handlers via server.setRequestHandler(ListToolsRequestSchema, ...)
 *     and server.setRequestHandler(CallToolRequestSchema, ...).
 *   - lifecycle: background=true, singleton=true (one process per install).
 *   - runtime: node, transport: stdio.
 *
 * Files:
 *   extension.json   (born-conformant manifest: type=mcp-server, runtime=node, lifecycle)
 *   package.json     (includes @modelcontextprotocol/sdk dep)
 *   tsconfig.json
 *   src/index.ts     (@modelcontextprotocol/sdk StdioServerTransport stub)
 *   CHANGELOG.md
 *   README.md
 *   CLAUDE.md        (LLM tool-call guidance)
 *
 * [inv:nx-free-core] — no nx-packages imports.
 */

import type { FileSet } from '../../index.js';
import type { TemplateOpts } from '../_shared.js';
import { manifestJson, tsconfigJson, changelogMd, readmeMd } from '../_shared.js';

export function mcpServerTemplate(opts: TemplateOpts): FileSet {
  // Custom package.json includes @modelcontextprotocol/sdk dependency
  const mcpPkg = JSON.stringify(
    {
      name: `@sox/extension-${opts.id}`,
      version: '0.1.0',
      description: opts.description,
      private: true,
      main: 'dist/index.js',
      types: 'dist/index.d.ts',
      files: ['dist'],
      scripts: {
        build: 'tsc --project tsconfig.json',
        typecheck: 'tsc --noEmit --project tsconfig.json',
        test: 'vitest run',
      },
      dependencies: {
        '@modelcontextprotocol/sdk': '>=1.0.0',
      },
      license: 'MIT',
      ...(opts.author !== undefined && opts.author !== '' ? { author: opts.author } : {}),
      ...(opts.keywords !== undefined && opts.keywords.length > 0 ? { keywords: opts.keywords } : {}),
    },
    null,
    2,
  );

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

    'package.json': mcpPkg,

    'tsconfig.json': tsconfigJson(),

    'src/index.ts': [
      `#!/usr/bin/env node`,
      `// MCP Server: ${opts.title}`,
      `// ${opts.description}`,
      `// Transport: stdio — uses @modelcontextprotocol/sdk StdioServerTransport`,
      `// Real shape reference: @adhd/agent-mcp (~/dev/node/adhd/packages/ai/agent-mcp)`,
      ``,
      `import { Server } from '@modelcontextprotocol/sdk/server/index.js';`,
      `import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';`,
      `import {`,
      `  CallToolRequestSchema,`,
      `  ListToolsRequestSchema,`,
      `} from '@modelcontextprotocol/sdk/types.js';`,
      ``,
      `const server = new Server(`,
      `  { name: '${opts.id}', version: '0.1.0' },`,
      `  { capabilities: { tools: {} } },`,
      `);`,
      ``,
      `server.setRequestHandler(ListToolsRequestSchema, async () => ({`,
      `  tools: [`,
      `    {`,
      `      name: 'example_tool',`,
      `      description: 'A stub tool for ${opts.id}',`,
      `      inputSchema: {`,
      `        type: 'object',`,
      `        properties: { query: { type: 'string', description: 'Query string' } },`,
      `        required: ['query'],`,
      `      },`,
      `    },`,
      `  ],`,
      `}));`,
      ``,
      `server.setRequestHandler(CallToolRequestSchema, async (request) => {`,
      `  const { name, arguments: args } = request.params;`,
      `  if (name === 'example_tool') {`,
      `    const query = (args as { query: string }).query;`,
      `    return {`,
      `      content: [{ type: 'text' as const, text: \`Result for: \${query}\` }],`,
      `    };`,
      `  }`,
      `  throw new Error(\`Unknown tool: \${name}\`);`,
      `});`,
      ``,
      `async function main(): Promise<void> {`,
      `  const transport = new StdioServerTransport();`,
      `  await server.connect(transport);`,
      `  // Server runs until stdin closes`,
      `}`,
      ``,
      `main().catch((err) => {`,
      `  process.stderr.write(String(err) + '\\n');`,
      `  process.exit(1);`,
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
