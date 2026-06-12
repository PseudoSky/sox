/**
 * Memory CLI — memory init|import|status|list|promote|registry
 * Deterministic: no LLM calls, predictable output.
 *
 * P3: multi-scope with registry.json.
 *
 * Usage:
 *   memory init [--scope project|user|org|local] [--path DIR]
 *   memory status [--path DIR]
 *   memory list [--path DIR]
 *   memory registry
 *
 * Scope → default store path (design.md §2.1):
 *   project  → <cwd>/.memory/project.db
 *   user     → ~/.memory/user.db
 *   org      → ~/.memory/org.db
 *   local    → <cwd>/.memory/local.db
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { openDb, initScope } from '@sox/memory-core';
import { writeRegistry } from '@sox/memory-core';

export type ScopeKind = 'project' | 'user' | 'org' | 'local';

const VALID_SCOPES: ScopeKind[] = ['project', 'user', 'org', 'local'];

/**
 * Default DB path for a scope when no --path override given.
 * project/local: <cwd>/.memory/<scope>.db
 * user/org:      ~/.memory/<scope>.db
 */
function defaultDbPath(scope: ScopeKind): string {
  const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? '/tmp';
  if (scope === 'user' || scope === 'org') {
    return path.join(home, '.memory', `${scope}.db`);
  }
  return path.join(process.cwd(), '.memory', `${scope}.db`);
}

function resolveDbPath(scope: ScopeKind, basePath: string): string {
  if (basePath) {
    return path.resolve(basePath, '.memory', `${scope}.db`);
  }
  return defaultDbPath(scope);
}

interface ParsedArgs {
  command: string;
  scope: ScopeKind;
  basePath: string;
  rest: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  // argv starts AFTER `node <compiled-entry>`
  const command = argv[0] ?? 'help';
  let scope: ScopeKind = 'project';
  let basePath = '';
  const rest: string[] = [];

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--scope') {
      const s = argv[++i];
      if (!VALID_SCOPES.includes(s as ScopeKind)) {
        console.error(`Invalid scope: ${s}. Valid: ${VALID_SCOPES.join(', ')}`);
        process.exit(1);
      }
      scope = s as ScopeKind;
    } else if (arg === '--path') {
      basePath = argv[++i] ?? '';
    } else {
      rest.push(arg ?? '');
    }
  }

  return { command, scope, basePath, rest };
}

function cmdInit(scope: ScopeKind, basePath: string): void {
  const dbPath = resolveDbPath(scope, basePath);
  const memoryDir = path.dirname(dbPath);
  fs.mkdirSync(memoryDir, { recursive: true });

  const isNew = !fs.existsSync(dbPath);
  const db = openDb(dbPath);

  const existing = db
    .prepare('SELECT scope_id FROM memory_scope WHERE scope = ?')
    .get(scope) as { scope_id: string } | undefined;

  const scopeId = existing?.scope_id ?? crypto.randomUUID();
  const meta = initScope(db, scope, scopeId);

  db.close();

  const verb = isNew ? 'Created' : 'Already exists (idempotent)';
  console.log(`${verb}: ${dbPath}`);
  console.log(`  scope:       ${meta.scope}`);
  console.log(`  scope_id:    ${meta.scope_id}`);
  console.log(`  embed_model: ${meta.embed_model}`);
  console.log(`  embed_dim:   ${meta.embed_dim}`);
  console.log(`  created_at:  ${meta.created_at}`);

  // Write/update registry
  writeRegistry(scope, dbPath);
  const registryPath = path.join(process.env['HOME'] ?? '', '.memory', 'registry.json');
  console.log(`Registry updated: ${registryPath}`);
}

function cmdStatus(basePath: string): void {
  const paths: string[] = [];
  if (basePath) {
    const memDir = path.resolve(basePath, '.memory');
    if (fs.existsSync(memDir)) {
      fs.readdirSync(memDir).filter((f) => f.endsWith('.db')).forEach((f) => paths.push(path.join(memDir, f)));
    }
  } else {
    // Show all stores from registry + cwd
    const home = process.env['HOME'] ?? '';
    const registryPath = path.join(home, '.memory', 'registry.json');
    try {
      const reg = JSON.parse(fs.readFileSync(registryPath, 'utf8')) as Record<string, string>;
      Object.values(reg).forEach((p) => { if (fs.existsSync(p)) paths.push(p); });
    } catch { /* no registry */ }
    const cwdMem = path.join(process.cwd(), '.memory');
    if (fs.existsSync(cwdMem)) {
      fs.readdirSync(cwdMem).filter((f) => f.endsWith('.db')).forEach((f) => {
        const p = path.join(cwdMem, f);
        if (!paths.includes(p)) paths.push(p);
      });
    }
  }

  if (paths.length === 0) {
    console.log('No memory stores found.');
    return;
  }
  for (const dbPath of paths) {
    try {
      const db = openDb(dbPath);
      const meta = db.prepare('SELECT * FROM memory_scope').get() as
        | { scope: string; embed_model: string; created_at: string }
        | undefined;
      const nodeCount = (db.prepare('SELECT COUNT(*) as c FROM node').get() as { c: number }).c;
      console.log(`${path.basename(dbPath)}: scope=${meta?.scope ?? '?'} nodes=${nodeCount} model=${meta?.embed_model ?? '?'} path=${dbPath}`);
      db.close();
    } catch (e) {
      console.log(`${path.basename(dbPath)}: error - ${String(e)}`);
    }
  }
}

function cmdList(basePath: string): void {
  const memoryDir = path.resolve(basePath || process.cwd(), '.memory');
  if (!fs.existsSync(memoryDir)) {
    console.log('No .memory directory found at', memoryDir);
    return;
  }
  const dbs = fs.readdirSync(memoryDir).filter((f) => f.endsWith('.db'));
  for (const dbFile of dbs) {
    const dbPath = path.join(memoryDir, dbFile);
    try {
      const db = openDb(dbPath);
      const nodes = db
        .prepare(
          `SELECT uid, kind, content, t_created FROM node WHERE t_invalid IS NULL ORDER BY t_created DESC LIMIT 20`,
        )
        .all() as { uid: string; kind: string; content: string | null; t_created: string }[];
      console.log(`\n=== ${dbFile} (${nodes.length} recent) ===`);
      for (const n of nodes) {
        const snippet = (n.content ?? '').slice(0, 80);
        console.log(`  [${n.kind}] ${n.uid}: ${snippet}`);
      }
      db.close();
    } catch (e) {
      console.log(`${dbFile}: error - ${String(e)}`);
    }
  }
}

function cmdRegistry(): void {
  const home = process.env['HOME'] ?? '';
  const registryPath = path.join(home, '.memory', 'registry.json');
  try {
    const reg = JSON.parse(fs.readFileSync(registryPath, 'utf8')) as Record<string, string>;
    console.log('Registry:', registryPath);
    for (const [scope, dbPath] of Object.entries(reg)) {
      const exists = fs.existsSync(dbPath) ? 'OK' : 'MISSING';
      console.log(`  ${scope}: ${dbPath} [${exists}]`);
    }
  } catch {
    console.log(`Registry not found at ${registryPath} — run 'memory init' first.`);
  }
}

export function runCli(argv: string[]): void {
  const { command, scope, basePath } = parseArgs(argv);

  switch (command) {
    case 'init':
      cmdInit(scope, basePath);
      break;
    case 'status':
      cmdStatus(basePath);
      break;
    case 'list':
      cmdList(basePath);
      break;
    case 'registry':
      cmdRegistry();
      break;
    case 'help':
    default:
      console.log(`sox-memory CLI (P3: multi-scope)
Commands:
  init [--scope project|user|org|local] [--path DIR]   Create a .memory/<scope>.db
  status [--path DIR]                                   Show all store info
  list [--path DIR]                                     List recent memories
  registry                                              Show ~/.memory/registry.json
`);
  }
}

// Module is loaded; CLI entry is via the compiled package entry or direct node invocation.
// Export runCli for programmatic use.

