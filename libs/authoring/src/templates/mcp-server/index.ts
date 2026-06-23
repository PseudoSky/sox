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
 *   - Install target resolved from libs/host-registry at install time.
 *     [ref:host-keyed-target] — NO hardcoded ~/.claude/ paths here.
 *
 * Files:
 *   extension.json   (born-conformant manifest: type=mcp-server, runtime=node,
 *                     lifecycle, install block with type+serves+profiles)
 *   package.json     (includes @modelcontextprotocol/sdk dep)
 *   tsconfig.json
 *   src/index.ts     (@modelcontextprotocol/sdk StdioServerTransport stub)
 *   CHANGELOG.md
 *   README.md
 *   CLAUDE.md        (LLM tool-call guidance)
 *
 * [inv:nx-free-core] — no nx-packages imports.
 * [inv:host-agnostic-type] — install.type used; target resolved from host-registry.
 */

import type { FileSet } from '../../index.js';
import type { TemplateOpts } from '../_shared.js';
import { buildInstallDescriptor, changelogMd, manifestJson, readmeMd, tsconfigJson } from '../_shared.js';

/** Default transports for mcp-server: stdio only. Override with --transports. */
const DEFAULT_SERVES = ['stdio'];

/**
 * Default profiles: keyed by transport name (satisfies profiles ⊆ serves invariant).
 * Each profile key MUST appear in the serves array; validate() enforces this.
 * [inv:never-managed] profiles ⊆ serves: profile name must equal a transport in serves.
 */
function defaultProfiles(serves: string[]): Record<string, unknown> {
  const profiles: Record<string, unknown> = {};
  // Profile key = transport name (stdio/sse/http) — must be in serves.
  if (serves.includes('stdio')) {
    profiles['stdio'] = { transport: 'stdio' };
  }
  if (serves.includes('sse')) {
    profiles['sse'] = { transport: 'sse' };
  }
  if (serves.includes('http')) {
    profiles['http'] = { transport: 'http' };
  }
  return profiles;
}

export function mcpServerTemplate(opts: TemplateOpts): FileSet {
  // Effective transports: from --transports flag, or default stdio
  const serves = opts.transports !== undefined && opts.transports.length > 0
    ? opts.transports
    : DEFAULT_SERVES;

  // Custom package.json includes @modelcontextprotocol/sdk dependency
  const mcpPkg = JSON.stringify(
    {
      name: `@adhd/sox-extension-${opts.id}`,
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

  // [mcp-as-service]: build the install descriptor and augment it with `transports`
  // so newly-scaffolded mcp-servers are born on the unified service model.
  // serves = back-compat alias; transports = the new unified field ([def:transport]).
  // Both are emitted; validate() accepts either. profiles ⊆ {serves∪transports}.
  const installDescriptor = buildInstallDescriptor('mcp-server', opts, serves, defaultProfiles(serves));
  // Emit transports as the unified field — maps stdio serves to service[transport=stdio].
  const stdioTransports = serves.filter((s) => s === 'stdio' || s === 'http' || s === 'sse' || s === 'socket');
  if (stdioTransports.length > 0) {
    installDescriptor['transports'] = stdioTransports;
  }

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
      // [shape:install-descriptor] — host-agnostic; engine resolves target from
      // libs/host-registry via unified run-service path ([mcp-as-service]).
      // [def:serves] — back-compat alias; [def:transport] — new unified field.
      // profiles ⊆ {serves∪transports} enforced by validate().
      // [ref:host-keyed-target] — NO literal ~/.claude/ path here.
      install: installDescriptor,
      // Install-time configuration schema. Keys listed in "required" are prompted
      // during `sox install` (interactive) or warned about (CI/non-TTY).
      // x-sox-prompt: text shown to the user; x-sox-default: value if user hits enter.
      // At spawn time, values are injected as SOX_CONFIG_<KEY> environment vars.
      // Remove this block if your server needs no persistent configuration.
      config_schema: {
        type: 'object',
        additionalProperties: false,
        required: [],
        properties: {
          example_setting: {
            type: 'string',
            description: 'An example configurable setting. Replace with your extension\'s actual config.',
            'x-sox-prompt': `Enter a value for ${opts.id} example_setting:`,
            'x-sox-default': 'default-value',
          },
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
      `// Real shape reference: @adhd/sox-agent-mcp (~/dev/node/adhd/packages/ai/agent-mcp)`,
      `//`,
      `// Install-time config is injected as SOX_CONFIG_<KEY> environment variables`,
      `// at spawn time (values from extensions.json "config" block, cascade-resolved).`,
      `// Example: const exampleSetting = process.env['SOX_CONFIG_EXAMPLE_SETTING'] ?? 'default-value';`,
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
      `// [R6: signal-contract] sox guarantees SIGKILL after stop_timeout_ms if this handler`,
      `// does not exit. Complete in-flight requests and flush writes before calling process.exit(0).`,
      `process.on('SIGTERM', () => {`,
      `  // TODO: complete in-flight requests, flush writes.`,
      `  // sox guarantees SIGKILL after stop_timeout_ms if this handler does not exit.`,
      `  process.exit(0);`,
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

    // Pre-compiled stub so sox validate passes the P0 entrypoint-reachability gate
    // immediately after scaffold (before the author runs `npm run build`).
    // This file is overwritten by the real build; treat it as a placeholder.
    'dist/index.js': [
      `#!/usr/bin/env node`,
      `// ${opts.id} — MCP server stub (replace with real build output)`,
      `"use strict";`,
      `process.stderr.write('${opts.id}: run npm run build to compile the real server\\n');`,
      `process.exit(1);`,
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
