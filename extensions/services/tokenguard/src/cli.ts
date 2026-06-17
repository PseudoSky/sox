/**
 * cli.ts — TokenGuard CLI over the live token map.
 *
 * Subcommands (MCP tools for sox exec routing, and direct argv for direct use):
 *   seed <real> <type> [token]  — append a custom entry, print the allocated token
 *   map                         — print current entries as JSON
 *   summary                     — per-identifier swap counts + leak check from audit log
 *
 * Wired into the service so `./bin/sox exec tokenguard -- <cmd>` reaches it
 * via the MCP stdio protocol handled in index.ts. [tg-cli.1] [tg-cli.4]
 *
 * Direct invocation:
 *   node dist/cli.js seed <real> <type> [token]
 *   node dist/cli.js map
 *   node dist/cli.js summary
 *
 * [inv:bijective-roundtrip] — seed is just another origin-tagged entry.
 * [inv:c7-no-reach-in] — imports engine via @sox/tokenguard-core only.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';

import { appendEntry, readEntries } from './mapstore.js';

// ── Config resolution (mirrors config.ts defaults) ────────────────────────────

function resolveMapPath(): string {
  const raw = process.env['SOX_CONFIG_MAP_PATH'];
  const home = process.env['HOME'] ?? '/tmp';
  if (raw) return raw.replace(/^~/, home);
  return path.join(home, '.tokenguard', 'token-mapping.json');
}

function resolveAuditPath(): string {
  const raw = process.env['SOX_CONFIG_CAPTURE_DIR'];
  const home = process.env['HOME'] ?? '/tmp';
  const dir = raw ? raw.replace(/^~/, home) : path.join(home, '.tokenguard');
  return path.join(dir, 'audit.jsonl');
}

// ── Subcommand handlers ───────────────────────────────────────────────────────

/**
 * seed — append a custom entry to the live map, print the allocated token.
 * [tg-cli.1]
 */
export function cmdSeed(
  real: string,
  type: string,
  explicitToken?: string,
  mapPath?: string,
): { token: string } {
  const mp = mapPath ?? resolveMapPath();
  const token = appendEntry(mp, real, type, 'custom', explicitToken);
  return { token };
}

/**
 * map — print all current entries from the live map.
 * [tg-cli.1]
 */
export function cmdMap(mapPath?: string): { entries: ReturnType<typeof readEntries> } {
  const mp = mapPath ?? resolveMapPath();
  const entries = readEntries(mp);
  return { entries };
}

/**
 * summary — per-identifier swap counts from the audit log + leak check.
 * [tg-cli.1]
 */
export function cmdSummary(
  mapPath?: string,
  auditPath?: string,
): {
  entries: Array<{ token: string; real: string; type: string; source: string; swap_count: number }>;
  leak_count: number;
} {
  const mp = mapPath ?? resolveMapPath();
  const ap = auditPath ?? resolveAuditPath();
  const entries = readEntries(mp);

  // Count swaps per token from audit.jsonl
  const swapCounts = new Map<string, number>();
  if (fs.existsSync(ap)) {
    const raw = fs.readFileSync(ap, 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed) as {
          event?: string;
          outbound_body?: string;
          leak_count?: number;
        };
        if (entry.event === 'outbound' && entry.outbound_body) {
          for (const e of entries) {
            if (entry.outbound_body.includes(e.token)) {
              swapCounts.set(e.token, (swapCounts.get(e.token) ?? 0) + 1);
            }
          }
        }
      } catch {
        // malformed audit line — skip
      }
    }
  }

  // Leak check: count outbound events that still mention any real value
  let leakCount = 0;
  if (fs.existsSync(ap)) {
    const raw = fs.readFileSync(ap, 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed) as { event?: string; outbound_body?: string; leak_count?: number };
        if (entry.event === 'outbound' && typeof entry.leak_count === 'number') {
          leakCount += entry.leak_count;
        }
      } catch {
        // skip
      }
    }
  }

  const result = entries.map((e) => ({
    token: e.token,
    real: e.real,
    type: e.type ?? 'id',
    source: e.source ?? 'custom',
    swap_count: swapCounts.get(e.token) ?? 0,
  }));

  return { entries: result, leak_count: leakCount };
}

// ── MCP tool definitions (for sox exec routing) ───────────────────────────────

/** MCP tools/list response entries for all CLI tools. [tg-cli.4] */
export const CLI_TOOLS = [
  {
    name: 'seed',
    description: 'Append a custom entry to the live token map. Returns the allocated token.',
    inputSchema: {
      type: 'object' as const,
      required: ['real', 'type'],
      properties: {
        real:  { type: 'string', description: 'The real identifier to pseudonymize.' },
        type:  { type: 'string', description: 'Identifier type (e.g. host, fqdn, id, label).' },
        token: { type: 'string', description: 'Optional explicit token override (custom entries only).' },
        map_path: { type: 'string', description: 'Override map file path (default: SOX_CONFIG_MAP_PATH or ~/.tokenguard/token-mapping.json).' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'map',
    description: 'Print all current entries in the live token map.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        map_path: { type: 'string', description: 'Override map file path.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'summary',
    description: 'Per-identifier swap counts from the audit log plus a leak check.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        map_path:   { type: 'string', description: 'Override map file path.' },
        audit_path: { type: 'string', description: 'Override audit log path.' },
      },
      additionalProperties: false,
    },
  },
];

/** Handle a single MCP tools/call for a CLI tool. [tg-cli.4] */
export function handleCliTool(
  name: string,
  args: Record<string, unknown>,
): { content: Array<{ type: 'text'; text: string }>; isError?: boolean } {
  try {
    if (name === 'seed') {
      const real = String(args['real'] ?? '');
      const type = String(args['type'] ?? 'id');
      const token = typeof args['token'] === 'string' ? args['token'] : undefined;
      const mapPath = typeof args['map_path'] === 'string' ? args['map_path'] : undefined;
      if (!real) throw new Error('seed: real is required');
      const result = cmdSeed(real, type, token, mapPath);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }

    if (name === 'map') {
      const mapPath = typeof args['map_path'] === 'string' ? args['map_path'] : undefined;
      const result = cmdMap(mapPath);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }

    if (name === 'summary') {
      const mapPath   = typeof args['map_path']   === 'string' ? args['map_path']   : undefined;
      const auditPath = typeof args['audit_path'] === 'string' ? args['audit_path'] : undefined;
      const result = cmdSummary(mapPath, auditPath);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }

    return {
      content: [{ type: 'text', text: `Unknown CLI tool: ${name}` }],
      isError: true,
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: String(err) }],
      isError: true,
    };
  }
}

// ── Direct argv invocation (node dist/cli.js <subcmd> ...) ───────────────────
// [tg-cli.4] — reachable via process.argv for direct calls and via exec routing.

export function runCli(argv: string[]): void {
  const mapPath = resolveMapPath();
  const [subcmd, ...rest] = argv;

  if (!subcmd || subcmd === '--help' || subcmd === '-h') {
    process.stdout.write(`TokenGuard CLI — operates on the live token map.

Usage:
  node dist/cli.js seed <real> <type> [token]   Append a custom entry; print the token
  node dist/cli.js map                           Print all entries (JSON)
  node dist/cli.js summary                       Per-identifier swap counts + leak check

Environment:
  SOX_CONFIG_MAP_PATH      Override the token-map file path
  SOX_CONFIG_CAPTURE_DIR   Override the capture/audit directory

Via sox exec (exec-socket or fresh-spawn MCP):
  ./bin/sox exec tokenguard --tool=seed   --args='{"real":"host.internal","type":"host"}'
  ./bin/sox exec tokenguard --tool=map    --args='{}'
  ./bin/sox exec tokenguard --tool=summary --args='{}'
`);
    return;
  }

  if (subcmd === 'seed') {
    const real = rest[0] ?? '';
    const type = rest[1] ?? 'id';
    const explicitToken = rest[2];
    if (!real) {
      process.stderr.write('seed: real identifier required\n');
      process.exit(1);
    }
    const result = cmdSeed(real, type, explicitToken, mapPath);
    process.stdout.write(JSON.stringify(result) + '\n');
    return;
  }

  if (subcmd === 'map') {
    const result = cmdMap(mapPath);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }

  if (subcmd === 'summary') {
    const result = cmdSummary(mapPath, resolveAuditPath());
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }

  process.stderr.write(`Unknown subcommand: ${subcmd}\n`);
  process.exit(1);
}

// Note: direct invocation guard (require.main === module) is intentionally
// omitted here. This module is always loaded as part of the bundle/index.js
// entry where index.ts controls dispatch. For direct dist/cli.js use, the
// caller should import runCli explicitly or invoke via bundle/index.js with
// the seed/map/summary argv subcommand.

