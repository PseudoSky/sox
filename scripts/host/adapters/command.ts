/**
 * scripts/host/adapters/command.ts — Command verb registration adapter.
 *
 * Adapter for type === 'command'. Dynamically imports the built entrypoint and
 * registers the command's verb into a command registry for dispatch via bin/sox.
 *
 * Command module contract (observed in tenants):
 *   Shape A: export function run(input: CommandInput): CommandOutput  (status-command)
 *   Shape B: export function runCli(argv: string[]): void | Promise<void>  (memory-cli)
 *
 * The adapter normalizes both shapes to a common invocation interface.
 * P5 scope: full wiring into bin/sox verb dispatch (closing Gaps C3/C6).
 * P4 scope: load, record, register into the in-memory CommandRegistry.
 *
 * Permission recording: permissions{} is logged at activation (enforcement is P5).
 */

import type { PermissionsBlock } from '../supervisor.js';

// ─── Command registry ─────────────────────────────────────────────────────────

export interface CommandInput {
  args: string[];
  [key: string]: unknown;
}

export interface CommandOutput {
  stdout?: string | undefined;
  stderr?: string | undefined;
  exitCode?: number | undefined;
  [key: string]: unknown;
}

export type CommandHandler = (input: CommandInput) => CommandOutput | Promise<CommandOutput>;

export interface CommandRegistration {
  key: string;
  /** The verb (from manifest.id or manifest.invocation.verb). */
  verb: string;
  handler: CommandHandler;
  permissions: PermissionsBlock | undefined;
}

/**
 * CommandRegistry — in-memory verb→handler map.
 *
 * Populated by the loader at activation time. P5 wires this into bin/sox dispatch.
 * Verb uniqueness: last registration wins (config-scope precedence mirrors install cascade).
 */
export class CommandRegistry {
  private readonly _commands = new Map<string, CommandRegistration>();

  register(reg: CommandRegistration): void {
    if (this._commands.has(reg.verb)) {
      console.warn(
        `[command-registry] Verb "${reg.verb}" already registered — overwriting with "${reg.key}"`,
      );
    }
    this._commands.set(reg.verb, reg);
  }

  has(verb: string): boolean {
    return this._commands.has(verb);
  }

  get(verb: string): CommandRegistration | undefined {
    return this._commands.get(verb);
  }

  verbs(): string[] {
    return [...this._commands.keys()];
  }

  clear(): void {
    this._commands.clear();
  }
}

// ─── Command adapter ──────────────────────────────────────────────────────────

export interface CommandAdapterOptions {
  key: string;
  entrypointPath: string;
  /** Explicit verb override. Falls back to the base id (without @version). */
  verb?: string | undefined;
  permissions?: PermissionsBlock | undefined;
  registry: CommandRegistry;
}

export interface CommandAdapterHandle {
  key: string;
  verb: string;
  permissions: PermissionsBlock | undefined;
  type: 'command';
}

/**
 * Activate a command extension.
 *
 * Dynamically imports the built entrypoint, normalizes the exported handler shape,
 * and registers a CommandHandler into the CommandRegistry under the command's verb.
 */
export async function activateCommand(opts: CommandAdapterOptions): Promise<CommandAdapterHandle> {
  if (opts.permissions) {
    console.log(
      `[command-adapter] Activating "${opts.key}" — permissions declared (P4 record / P5 enforce):`,
      JSON.stringify(opts.permissions),
    );
  } else {
    console.log(`[command-adapter] Activating "${opts.key}" — no declared permissions`);
  }

  const mod = await import(opts.entrypointPath) as Record<string, unknown>;

  // Derive verb: use opts.verb ?? strip @version from key ?? key
  const verb = opts.verb ?? stripVersion(opts.key);

  // Normalize handler: Shape A (run) or Shape B (runCli)
  const handler = normalizeHandler(mod, opts.key);

  opts.registry.register({
    key: opts.key,
    verb,
    handler,
    permissions: opts.permissions,
  });

  console.log(`[command-adapter] "${opts.key}" registered as verb "${verb}"`);

  return {
    key: opts.key,
    verb,
    permissions: opts.permissions,
    type: 'command',
  };
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function normalizeHandler(mod: Record<string, unknown>, key: string): CommandHandler {
  // Shape A: export function run(input: CommandInput): CommandOutput
  if (typeof mod['run'] === 'function') {
    const runFn = mod['run'] as (input: CommandInput) => CommandOutput | Promise<CommandOutput>;
    return (input: CommandInput) => runFn(input);
  }

  // Shape B: export function runCli(argv: string[]): void | Promise<void>
  if (typeof mod['runCli'] === 'function') {
    const runCliFn = mod['runCli'] as (argv: string[]) => void | Promise<void>;
    return async (input: CommandInput): Promise<CommandOutput> => {
      await runCliFn(input.args);
      return { exitCode: 0 };
    };
  }

  // Shape C: export default function(...)
  if (typeof mod['default'] === 'function') {
    const defaultFn = mod['default'] as (input: CommandInput) => CommandOutput | Promise<CommandOutput>;
    return (input: CommandInput) => defaultFn(input);
  }

  throw new Error(
    `[command-adapter] "${key}": entrypoint exports neither 'run' nor 'runCli'. ` +
      `Command modules must export one of these functions.`,
  );
}

function stripVersion(key: string): string {
  // key = "memory-cli@0.1.0" → "memory-cli"
  const atIdx = key.lastIndexOf('@');
  return atIdx > 0 ? key.slice(0, atIdx) : key;
}
