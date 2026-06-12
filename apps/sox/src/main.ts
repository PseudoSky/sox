/**
 * apps/sox/src/main.ts — sox CLI stub shell
 *
 * This is the apps/sox stub for the engine-libs state. Full behavior is wired
 * in the sox-extension state. This module:
 *   - delegates to libs/install-engine for install/build-index
 *   - delegates to libs/host-runtime for start/stop/status/exec
 *   - A12 fix: parseArgs from install-engine handles both --flag value AND --flag=value
 *
 * [ref:dual-flag-form]: both forms parsed by parseArgs (A12 fix).
 * exec routes via the running server (A11 fix) — see cmdExec below.
 */

import { parseArgs } from '@sox/install-engine';
import {
  getScopePaths,
  getRuntimeFilePath,
  startRuntime,
  stopRuntime,
  getRuntimeRecord,
  reconcileRuntime,
} from '@sox/host-runtime';

const argv = process.argv.slice(2);
const verb = argv[0];
const flags = parseArgs(argv.slice(1));

async function main(): Promise<void> {
  switch (verb) {
    case 'start':
      await cmdStart(flags);
      break;
    case 'stop':
      await cmdStop(flags);
      break;
    case 'status':
      cmdStatus(flags);
      break;
    case 'exec':
      await cmdExec(flags);
      break;
    case 'install':
      await cmdInstall(flags);
      break;
    case '--help':
    case 'help':
      printHelp();
      break;
    default:
      process.stderr.write(`sox: unknown verb '${String(verb)}'\n`);
      process.stderr.write(`Run 'sox --help' for usage.\n`);
      process.exit(1);
  }
}

function printHelp(): void {
  process.stdout.write(`sox — LLM extension ecosystem CLI

Usage: sox <verb> [flags]

Verbs:
  install    --scope=<scope> [--frozen-lockfile] [--update]
  start      --scope=<scope> [--root=<root>]
  stop       --scope=<scope> [--id=<ext-id>]
  status     --scope=<scope>
  exec       --id=<ext-id> --tool=<tool> [--args='<json>']
  help       Show this message

Flags accept both forms: --flag=value  and  --flag value

`);
}

async function cmdInstall(flags: Record<string, string>): Promise<void> {
  const { install } = await import('@sox/install-engine');
  const scope = (flags['scope'] ?? 'user') as 'org' | 'user' | 'project' | 'local';
  const frozen = flags['frozen-lockfile'] === 'true';
  const update = flags['update'] === 'true';
  const mode = frozen ? 'frozen' : update ? 'update' : 'default';

  await install({ scope, mode });
  process.exit(0);
}

async function cmdStart(flags: Record<string, string>): Promise<void> {
  const ROOT = process.cwd();
  const scope = flags['scope'] ?? 'user';
  const root = flags['root'] ?? ROOT;

  let scopePaths: { config: string; lockfile: string };
  try {
    scopePaths = getScopePaths(scope, root);
  } catch (e) {
    process.stderr.write(`sox start: ${String(e)}\n`);
    process.exit(1);
  }

  const lockfilePath = flags['lockfile'] ?? scopePaths.lockfile;
  const configPath = flags['config'] ?? scopePaths.config;
  const runtimeFilePath =
    flags['runtime-file'] ??
    process.env['SOX_RUNTIME_FILE'] ??
    getRuntimeFilePath(lockfilePath);

  try {
    const record = await startRuntime({
      scope,
      lockfilePath,
      configPath,
      runtimeFilePath,
      root,
      overrideHealthToStdioPing: true,
    });

    const runningCount = record.entries.filter((e) => e.running).length;
    process.stdout.write(`sox: runtime started — ${record.entries.length} extension(s) activated, ${runningCount} running\n`);

    process.on('SIGTERM', () => { void (async () => {
      await stopRuntime({ scope, runtimeFilePath });
      process.exit(0);
    })(); });
    process.on('SIGINT', () => { void (async () => {
      await stopRuntime({ scope, runtimeFilePath });
      process.exit(0);
    })(); });
    process.on('SIGHUP', () => { void reconcileRuntime(runtimeFilePath, configPath); });

    // Keep alive
    setInterval(() => { /* heartbeat */ }, 5000);
  } catch (e) {
    process.stderr.write(`sox start: failed — ${String(e)}\n`);
    process.exit(1);
  }
}

async function cmdStop(flags: Record<string, string>): Promise<void> {
  const ROOT = process.cwd();
  const scope = flags['scope'] ?? 'user';
  const root = flags['root'] ?? ROOT;
  const id = flags['id'];

  let scopePaths: { config: string; lockfile: string };
  try {
    scopePaths = getScopePaths(scope, root);
  } catch (e) {
    process.stderr.write(`sox stop: ${String(e)}\n`);
    process.exit(1);
  }

  const lockfilePath = flags['lockfile'] ?? scopePaths.lockfile;
  const runtimeFilePath =
    flags['runtime-file'] ??
    process.env['SOX_RUNTIME_FILE'] ??
    getRuntimeFilePath(lockfilePath);

  const record = getRuntimeRecord(runtimeFilePath);
  if (!record) {
    process.stdout.write(`sox: no runtime record at ${runtimeFilePath}\n`);
    process.exit(0);
  }

  // stop-via-supervisor: signal the supervisor process (not children directly)
  if (!id && typeof record.supervisorPid === 'number') {
    try {
      process.kill(record.supervisorPid, 'SIGTERM');
      process.stdout.write(`sox: signaling supervisor (pid=${record.supervisorPid}) to stop\n`);
    } catch (e) {
      process.stderr.write(`sox: could not signal supervisor: ${String(e)}\n`);
    }
    process.exit(0);
  }

  await stopRuntime({ scope, runtimeFilePath, id });
  process.stdout.write(`sox: stop complete\n`);
  process.exit(0);
}

function cmdStatus(flags: Record<string, string>): void {
  const ROOT = process.cwd();
  const scope = flags['scope'] ?? 'user';
  const root = flags['root'] ?? ROOT;

  let scopePaths: { config: string; lockfile: string };
  try {
    scopePaths = getScopePaths(scope, root);
  } catch (e) {
    process.stderr.write(`sox status: ${String(e)}\n`);
    process.exit(1);
  }

  const lockfilePath = flags['lockfile'] ?? scopePaths.lockfile;
  const runtimeFilePath =
    flags['runtime-file'] ??
    process.env['SOX_RUNTIME_FILE'] ??
    getRuntimeFilePath(lockfilePath);

  const record = getRuntimeRecord(runtimeFilePath);
  if (!record) {
    process.stdout.write(`sox: no runtime record at ${runtimeFilePath} (host not started?)\n`);
    process.exit(0);
  }

  process.stdout.write(JSON.stringify(record, null, 2) + '\n');
  process.exit(0);
}

/**
 * cmdExec — A11 fix: exec via the running server.
 *
 * Routes through the MCP registrar to call a tool on an already-running extension,
 * rather than spawning a throwaway session each time.
 */
async function cmdExec(flags: Record<string, string>): Promise<void> {
  const ROOT = process.cwd();
  const runtimeFilePath = flags['runtime-file'] ?? process.env['SOX_RUNTIME_FILE'] ?? '';
  const extId = flags['id'] ?? '';
  const toolName = flags['tool'] ?? '';
  const argsJson = flags['args'] ?? '{}';

  if (!extId) { process.stderr.write(`sox exec: --id is required\n`); process.exit(1); }
  if (!toolName) { process.stderr.write(`sox exec: --tool is required\n`); process.exit(1); }

  let toolArgs: Record<string, unknown>;
  try {
    toolArgs = JSON.parse(argsJson) as Record<string, unknown>;
  } catch {
    process.stderr.write(`sox exec: invalid --args JSON: ${argsJson}\n`);
    process.exit(1);
  }

  const record = getRuntimeRecord(runtimeFilePath || 'runtime.json');
  if (!record) {
    process.stderr.write(`sox exec: no runtime record. Run 'sox start' first.\n`);
    process.exit(1);
  }

  const entry = record.entries.find((e) => e.id === extId || e.key === extId);
  if (!entry) {
    process.stderr.write(`sox exec: extension '${extId}' not found in runtime record.\n`);
    process.exit(1);
  }

  // A11 fix: try the running server first via the registrar; fall back to fresh spawn
  const { getRegistrar } = await import('@sox/host-runtime');
  const registrar = runtimeFilePath ? getRegistrar(runtimeFilePath) : null;

  if (registrar) {
    try {
      const result = await registrar.call(extId, toolName, toolArgs);
      process.stdout.write(JSON.stringify(result) + '\n');
      process.exit(0);
    } catch (_e) {
      // Registrar call failed — fall through to fresh spawn
      process.stderr.write(`sox exec: registrar call failed, falling back to fresh spawn\n`);
    }
  }

  // Fallback: spawn a fresh MCP session (matches current scripts/host/runtime-cli.ts exec behavior)
  const { resolveExtensionDir } = await import('@sox/host-runtime');
  const { readFileSync, existsSync } = await import('node:fs');
  const path = await import('node:path');

  const extDir = resolveExtensionDir(entry.source, ROOT);
  if (!extDir) {
    process.stderr.write(`sox exec: cannot resolve extension dir from source: ${entry.source}\n`);
    process.exit(1);
  }

  const manifestPath = path.join(extDir, 'extension.json');
  if (!existsSync(manifestPath)) {
    process.stderr.write(`sox exec: manifest not found at ${manifestPath}\n`);
    process.exit(1);
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { entrypoint?: string };
  if (!manifest.entrypoint) {
    process.stderr.write(`sox exec: no entrypoint in manifest at ${manifestPath}\n`);
    process.exit(1);
  }

  const entrypointPath = path.resolve(extDir, manifest.entrypoint);
  if (!existsSync(entrypointPath)) {
    process.stderr.write(`sox exec: entrypoint not found at ${entrypointPath}\n`);
    process.exit(1);
  }

  const { spawn } = await import('node:child_process');
  const { McpClient } = await import('@sox/host-runtime');

  const child = spawn(process.execPath, [entrypointPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  const client = new McpClient(child);
  try {
    await client.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'sox-exec', version: '1.0.0' } }, 10000);
    const result = await client.call('tools/call', { name: toolName, arguments: toolArgs }, 30000);
    process.stdout.write(JSON.stringify(result) + '\n');
    client.close();
    child.kill('SIGTERM');
    process.exit(0);
  } catch (e) {
    client.close();
    child.kill('SIGTERM');
    process.stderr.write(`sox exec: tool call failed: ${String(e)}\n`);
    process.exit(1);
  }
}

void main();
