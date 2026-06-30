/**
 * TokenGuard service entrypoint.
 *
 * [ref:c6-policy-guard] — reads SOX_POLICY_* and DENIES capture-dir write or
 *   upstream connection outside the declared allowlist BEFORE the side effect.
 *   Mirrors memory-server's vendored compilePolicyFromEnv / checkDbPathCtx pattern.
 *
 * [inv:standard-config] — config only via SOX_CONFIG_*.
 * [inv:c7-no-reach-in] — imports engine via @adhd/sox-tokenguard-core only.
 * [tg-service.5] — SOX_POLICY_ enforcement at the resource sink.
 * [tg-service.10] — config -> Mapper -> proxy -> continuously persist.
 */

import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

import { Mapper } from '@adhd/sox-tokenguard-core';

import { anthropicAdapter } from './adapters/anthropic.js';
import { genericAdapter } from './adapters/generic.js';
import { CLI_TOOLS, handleCliTool, runCli } from './cli.js';
import { resolveConfig } from './config.js';
import { reloadIntoMapper, watchChanges } from './mapstore.js';
import { startProxy } from './proxy.js';

// ─── Vendored compilePolicyFromEnv — matches [shape:policy-env] ───────────────
// Mirrors memory-server/src/index.ts pattern exactly.
// vendored here because spawned tokenguard is a standalone process; @adhd/sox-host-runtime
// is not available in child node_modules at runtime.

function expandTilde(p: string): string {
  if (p === '~' || p.startsWith('~/')) {
    return os.homedir() + p.slice(1);
  }
  return p;
}

function globToRegex(pattern: string): RegExp {
  const expanded = expandTilde(pattern);
  let regexStr = '';
  let i = 0;
  while (i < expanded.length) {
    if (expanded[i] === '*' && expanded[i + 1] === '*') {
      regexStr += '.*';
      i += 2;
      if (expanded[i] === '/') i++;
    } else if (expanded[i] === '*') {
      regexStr += '[^/]*';
      i++;
    } else {
      const ch = expanded[i] as string;
      regexStr += /[.+^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
      i++;
    }
  }
  return new RegExp(`^${regexStr}$`);
}

function matchGlob(pattern: string, absPath: string): boolean {
  return globToRegex(pattern).test(absPath);
}

function normalizePath(p: string): string {
  return path.resolve(expandTilde(p));
}

function isPathAllowed(patterns: string[] | undefined, subject: string): boolean {
  if (patterns === undefined) return true;
  const norm = normalizePath(subject);
  return patterns.some((p) => matchGlob(p, norm));
}

interface Policy {
  enforced: boolean;
  allowsFsRead(absPath: string): boolean;
  allowsFsWrite(absPath: string): boolean;
}

export function compilePolicyFromEnv(): Policy {
  if (!process.env['SOX_PERM_ENFORCE']) {
    return {
      enforced: false,
      allowsFsRead: () => true,
      allowsFsWrite: () => true,
    };
  }

  function parseRaw(raw: string | undefined): string[] | undefined {
    if (raw === undefined) return undefined;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed as string[];
    } catch { /* malformed — treat as unconstrained */ }
    return undefined;
  }

  const fsRead = parseRaw(process.env['SOX_PERM_FS_READ']);
  const fsWrite = parseRaw(process.env['SOX_PERM_FS_WRITE']);

  return {
    enforced: true,
    allowsFsRead: (absPath: string) => isPathAllowed(fsRead, absPath),
    allowsFsWrite: (absPath: string) => isPathAllowed(fsWrite, absPath),
  };
}

// ─── C6 enforcement ──────────────────────────────────────────────────────────

/**
 * Guard the capture dir write BEFORE opening the file.
 * [ref:c6-policy-guard] [tg-service.5]
 */
function enforceCaptureDirPolicy(captureDir: string, policy: Policy): void {
  if (!policy.enforced) return;
  const resolved = path.resolve(expandTilde(captureDir));
  if (!policy.allowsFsWrite(resolved)) {
    throw new Error(
      `tokenguard: permission denied: capture_dir ${resolved} outside declared fs.write allowlist (SOX_POLICY_*)`,
    );
  }
}

/**
 * Guard the map-file path write BEFORE opening it.
 * [ref:c6-policy-guard] [tg-service.5]
 */
function enforceMapPathPolicy(mapPath: string, policy: Policy): void {
  if (!policy.enforced) return;
  const resolved = path.resolve(expandTilde(mapPath));
  if (!policy.allowsFsWrite(resolved)) {
    throw new Error(
      `tokenguard: permission denied: map_path ${resolved} outside declared fs.write allowlist (SOX_POLICY_*)`,
    );
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

// ─── MCP stdio handler (CLI exec mode) ───────────────────────────────────────

/**
 * Run the MCP stdio handler for CLI tools (seed / map / summary).
 *
 * Entered when the process is spawned by `soxe exec` (stdin is a pipe).
 * Speaks JSON-RPC 2.0 line-by-line over stdio — identical protocol to
 * memory-server/src/index.ts. [tg-cli.4] [def:live-map]
 */
function runMcpCli(): void {
  const rl = require('node:readline').createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  }) as import('node:readline').Interface;

  rl.on('line', (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let req: { jsonrpc?: string; id?: unknown; method?: string; params?: unknown };
    try {
      req = JSON.parse(trimmed) as typeof req;
    } catch {
      process.stdout.write(
        JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' } }) + '\n',
      );
      return;
    }

    const { id, method, params } = req;
    const p = (params ?? {}) as Record<string, unknown>;

    if (method === 'initialize') {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'tokenguard-cli', version: '0.1.0' },
          },
        }) + '\n',
      );
      return;
    }

    if (method === 'tools/list') {
      process.stdout.write(
        JSON.stringify({ jsonrpc: '2.0', id, result: { tools: CLI_TOOLS } }) + '\n',
      );
      return;
    }

    if (method === 'tools/call') {
      const toolName = typeof p['name'] === 'string' ? p['name'] : '';
      const toolArgs = (typeof p['arguments'] === 'object' && p['arguments'] !== null
        ? p['arguments']
        : {}) as Record<string, unknown>;
      const result = handleCliTool(toolName, toolArgs);
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
      return;
    }

    process.stdout.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${String(method)}` },
      }) + '\n',
    );
  });
}

// ─── Proxy service mode ───────────────────────────────────────────────────────

async function main(): Promise<void> {
  const config = resolveConfig();
  const policy = compilePolicyFromEnv();

  // C6 enforcement BEFORE any file-system side effects [ref:c6-policy-guard]
  enforceCaptureDirPolicy(config.captureDir, policy);
  enforceMapPathPolicy(config.mapPath, policy);

  // Ensure capture dir + map dir exist (AFTER policy check)
  fs.mkdirSync(config.captureDir, { recursive: true });
  const mapDir = path.dirname(config.mapPath);
  fs.mkdirSync(mapDir, { recursive: true });

  // Build Mapper from seeds + existing map file
  const mapper = new Mapper(config.mapPath);

  // Add never-list entries
  for (const nv of config.never) {
    mapper.never.add(nv.toLowerCase());
  }

  // Seed identifiers
  if (config.seeds.length > 0) {
    mapper.seed(config.seeds, 'seed');
  }

  // Wire mapstore watch → mapper reload on CLI seed change. [def:live-map] [tg-cli.3]
  // The footgun is a stale in-memory map; this subscription ensures the running proxy
  // reflects a CLI-seeded identifier within ~500ms of the seed write, no restart.
  const stopWatch = watchChanges(config.mapPath, () => {
    reloadIntoMapper(config.mapPath, mapper);
    process.stderr.write('tokenguard: map reloaded from disk (CLI seed reflected)\n');
  });

  // Select adapter
  const adapter = config.provider === 'anthropic' ? anthropicAdapter : genericAdapter;

  // storePath: the directory where port.txt lives (= captureDir for co-location)
  const storePath = config.captureDir;
  const auditPath = path.join(config.captureDir, 'audit.jsonl');

  // Start proxy server
  const server: http.Server = await startProxy({
    config,
    mapper,
    adapter,
    storePath,
    auditPath,
  });

  // Continuously persist the live map every 30 s so map reflects CLI seeds without restart.
  // The Mapper already persists on every mutation; this is an additional safety flush.
  const persistInterval = setInterval(() => {
    try {
      const doc = mapper.serialize();
      const tmp = config.mapPath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf8');
      fs.renameSync(tmp, config.mapPath);
    } catch {
      // best-effort
    }
  }, 30_000);

  // Clean shutdown [ref:supervisor-stop]
  function shutdown(): void {
    stopWatch();
    clearInterval(persistInterval);
    server.close(() => {
      // Remove port.txt on clean exit
      try {
        fs.rmSync(path.join(storePath, 'port.txt'), { force: true });
      } catch { /* ignore */ }
      process.exit(0);
    });
    // Force exit after stop_timeout_ms if server.close hangs
    setTimeout(() => process.exit(0), 5000).unref();
  }

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

// ─── Entrypoint — three-way bifurcation ──────────────────────────────────────
//
// 1. Direct CLI mode: process.argv[2] is a CLI subcommand (seed|map|summary).
//    Invoked as: node bundle/index.js seed <real> <type>
//    Used by demo/live-seed.sh for direct seeding without soxe exec overhead.
//
// 2. MCP exec mode: stdin is piped AND no SOX_CONFIG_PORT (spawned by soxe exec).
//    Speaks JSON-RPC 2.0 over stdio for the soxe exec tool-call protocol.
//
// 3. Service mode: everything else — starts the HTTP proxy.
//    Invoked by the supervisor with SOX_CONFIG_* env set.

const CLI_SUBCMDS = new Set(['seed', 'map', 'summary', '--help', '-h']);
const argv2 = process.argv[2];

const isDirectCli = argv2 !== undefined && CLI_SUBCMDS.has(argv2);
const isMcpExecMode = !isDirectCli
  && !process.stdin.isTTY
  && process.env['SOX_CONFIG_PORT'] === undefined;

if (isDirectCli) {
  // Direct CLI invocation: node bundle/index.js seed <real> <type>
  // runCli reads from process.argv[2..]. [tg-cli.4]
  runCli(process.argv.slice(2));
} else if (isMcpExecMode) {
  runMcpCli();
} else {
  main().catch((err: unknown) => {
    process.stderr.write(`tokenguard: fatal: ${String(err)}\n`);
    process.exit(1);
  });
}
