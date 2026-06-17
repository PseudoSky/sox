/**
 * Service template — scaffolds a supervised long-running service extension.
 *
 * A service is a background process with one or more transports (stdio|http|sse|socket).
 * It differs from mcp-server in that:
 *   - transport vocabulary includes 'socket' and 'http' (not MCP-protocol-specific)
 *   - lifecycle health defaults to http-get (for http transport) or stdio-ping (for stdio)
 *   - the extension is not required to implement the MCP wire protocol
 *
 * Files emitted:
 *   extension.json   (born-conformant manifest: type=service, runtime=node,
 *                     lifecycle with http-get health, install block with type+transports+profiles)
 *   package.json
 *   tsconfig.json
 *   src/index.ts     (runnable HTTP service stub)
 *   dist/index.js    (pre-compiled stub for immediate sox validate entrypoint-reachability)
 *   CHANGELOG.md
 *   README.md
 *
 * [inv:nx-free-core] — no nx-packages imports.
 * [ref:host-keyed-target] — NO hardcoded ~/.claude/ host paths here.
 * [shape:service-install] — install descriptor shape.
 * [shape:http-health] — lifecycle health block.
 */

import type { FileSet } from '../../index.js';
import type { TemplateOpts } from '../_shared.js';
import { manifestJson, tsconfigJson, changelogMd, readmeMd } from '../_shared.js';

/** Default transports for a service: http. Override with --transport / --transports. */
const DEFAULT_TRANSPORTS = ['http'];

/**
 * Default profiles keyed by transport name (satisfies profiles ⊆ transports invariant).
 * Each profile key MUST appear in the transports array; validate() enforces this.
 */
function defaultProfiles(transports: string[]): Record<string, unknown> {
  const profiles: Record<string, unknown> = {};
  if (transports.includes('http')) {
    profiles['http'] = { transport: 'http' };
  }
  if (transports.includes('stdio')) {
    profiles['stdio'] = { transport: 'stdio' };
  }
  if (transports.includes('sse')) {
    profiles['sse'] = { transport: 'sse' };
  }
  if (transports.includes('socket')) {
    profiles['socket'] = { transport: 'socket' };
  }
  return profiles;
}

/**
 * Choose the lifecycle health block based on the primary transport.
 * http → http-get health probe; stdio → stdio-ping; others → http-get with placeholder.
 */
function buildLifecycle(transports: string[], id: string): Record<string, unknown> {
  const primaryTransport = transports[0] ?? 'http';
  const PORT = '${PORT:-8080}';

  if (primaryTransport === 'stdio') {
    return {
      background: true,
      singleton: true,
      stop_timeout_ms: 5000,
      health: {
        type: 'stdio-ping',
        interval_ms: 30000,
        timeout_ms: 5000,
      },
    };
  }

  // http, sse, socket — default to http-get health probe
  return {
    background: true,
    singleton: true,
    stop_timeout_ms: 5000,
    health: {
      type: 'http-get',
      endpoint: `http://127.0.0.1:${PORT}/_${id}/health`,
      interval_ms: 30000,
      timeout_ms: 5000,
    },
  };
}

/**
 * Build the install descriptor for a service.
 * Uses 'transports' (not 'serves') as the primary field per [shape:service-install].
 * Also populates 'serves' as a back-compat alias for any transport values that overlap
 * with the mcp VALID_SERVES vocabulary (stdio|sse|http).
 */
function buildServiceInstallDescriptor(
  opts: TemplateOpts,
  transports: string[],
  profiles: Record<string, unknown>,
): Record<string, unknown> {
  const install: Record<string, unknown> = { type: 'service' };

  if (opts.hosts !== undefined && opts.hosts.length > 0) {
    install['hosts'] = opts.hosts;
  }

  // transports — the primary service transport declaration
  install['transports'] = transports;

  // serves — back-compat alias for transports that are in the mcp vocabulary
  const mcpCompatible = transports.filter((t) => t === 'stdio' || t === 'sse' || t === 'http');
  if (mcpCompatible.length > 0) {
    install['serves'] = mcpCompatible;
  }

  if (Object.keys(profiles).length > 0) {
    install['profiles'] = profiles;
  }

  if (opts.source !== undefined && opts.source !== '') {
    install['source'] = opts.source;
  }

  return install;
}

export function serviceTemplate(opts: TemplateOpts): FileSet {
  // Effective transports: from --transport / --transports flag, or default http
  const transports =
    opts.transports !== undefined && opts.transports.length > 0
      ? opts.transports
      : DEFAULT_TRANSPORTS;

  const profiles = defaultProfiles(transports);
  const lifecycle = buildLifecycle(transports, opts.id);

  const pkg = JSON.stringify(
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
      lifecycle,
      // [shape:service-install] — host-agnostic; engine resolves target from libs/host-registry.
      // [ref:host-keyed-target] — NO literal ~/.claude/ path here.
      install: buildServiceInstallDescriptor(opts, transports, profiles),
      // Install-time configuration schema. Values injected as SOX_CONFIG_<KEY> at spawn time.
      // Remove this block if your service needs no persistent configuration.
      config_schema: {
        type: 'object',
        additionalProperties: false,
        required: [],
        properties: {
          port: {
            type: 'string',
            description: 'Port the service listens on.',
            'x-sox-prompt': `Enter the port for ${opts.id}:`,
            'x-sox-default': '8080',
          },
        },
      },
    }),

    'package.json': pkg,

    'tsconfig.json': tsconfigJson(),

    'src/index.ts': [
      `#!/usr/bin/env node`,
      `// Service: ${opts.title}`,
      `// ${opts.description}`,
      `// Transports: ${transports.join(', ')}`,
      `//`,
      `// Install-time config is injected as SOX_CONFIG_<KEY> environment variables`,
      `// at spawn time (values from extensions.json "config" block, cascade-resolved).`,
      `// Example: const port = process.env['SOX_CONFIG_PORT'] ?? '8080';`,
      ``,
      `import * as http from 'node:http';`,
      ``,
      `const PORT = parseInt(process.env['SOX_CONFIG_PORT'] ?? '8080', 10);`,
      ``,
      `const server = http.createServer((req, res) => {`,
      `  if (req.url === '/_${opts.id}/health' && req.method === 'GET') {`,
      `    res.writeHead(200, { 'Content-Type': 'application/json' });`,
      `    res.end(JSON.stringify({ status: 'ok', service: '${opts.id}' }));`,
      `    return;`,
      `  }`,
      `  res.writeHead(404);`,
      `  res.end('Not found');`,
      `});`,
      ``,
      `server.listen(PORT, '127.0.0.1', () => {`,
      `  process.stderr.write(\`${opts.id}: listening on http://127.0.0.1:\${PORT}\\n\`);`,
      `});`,
      ``,
      `process.on('SIGTERM', () => {`,
      `  server.close(() => process.exit(0));`,
      `});`,
      ``,
      `process.on('SIGINT', () => {`,
      `  server.close(() => process.exit(0));`,
      `});`,
    ].join('\n'),

    // Pre-compiled stub so sox validate passes the P0 entrypoint-reachability gate
    // immediately after scaffold (before the author runs `npm run build`).
    // This file is overwritten by the real build; treat it as a placeholder.
    'dist/index.js': [
      `#!/usr/bin/env node`,
      `// ${opts.id} — service stub (replace with real build output)`,
      `"use strict";`,
      `process.stderr.write('${opts.id}: run npm run build to compile the real service\\n');`,
      `process.exit(1);`,
    ].join('\n'),

    'CHANGELOG.md': changelogMd(),

    'README.md': readmeMd(opts, [
      '## When to use',
      '',
      `<!-- Describe when to reach for this service. -->`,
      '',
      '## Transports',
      '',
      `| Transport | Description |`,
      `| --------- | ----------- |`,
      ...transports.map((t) => `| \`${t}\` | ${t === 'http' ? 'HTTP REST' : t === 'stdio' ? 'JSON-RPC over stdio' : t === 'sse' ? 'Server-sent events' : 'Unix socket'} |`),
      '',
      '## Health',
      '',
      transports.includes('http') || transports.includes('sse')
        ? `HTTP GET \`/_${opts.id}/health\` → \`{"status":"ok"}\``
        : 'stdio-ping',
      '',
      '## Usage',
      '',
      '```bash',
      `sox install ${opts.id}`,
      `sox start --id=${opts.id}`,
      '```',
    ]),
  };
}
