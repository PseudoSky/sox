/**
 * Memory CLI — memory init|import|status|list|promote|registry|export
 * Deterministic: no LLM calls, predictable output.
 *
 * P3: multi-scope with registry.json.
 *
 * Usage:
 *   memory init [--scope project|user|org|local] [--path DIR]
 *   memory status [--path DIR]
 *   memory list [--path DIR]
 *   memory registry
 *   memory export [--scope <s>] [--base-path <p>] [--dir <path>] [--db <path>]
 *
 * Scope → default store path (design.md §2.1):
 *   project  → <cwd>/.memory/project.db
 *   user     → ~/.memory/user.db
 *   org      → ~/.memory/org.db
 *   local    → <cwd>/.memory/local.db
 *
 * Export config resolution (highest precedence first):
 *   --dir flag  >  SOX_CONFIG_EXPORT_DIR env var  >  scope-relative default
 *   --db  flag  >  SOX_CONFIG_DB_PATH env var     >  resolveDbPath(scope, basePath)
 *   export_enabled: --enabled/--no-enabled flag  >  SOX_CONFIG_EXPORT_ENABLED env var  >  true
 */

import { exportMarkdown, initScope, openDb, writeRegistry } from '@adhd/sox-memory-core';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

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
  /** --dir override for export subcommand */
  exportDir: string;
  /** --db override for export subcommand */
  dbPathOverride: string;
  rest: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  // argv starts AFTER `node <compiled-entry>`
  const command = argv[0] ?? 'help';
  let scope: ScopeKind = 'project';
  let basePath = '';
  let exportDir = '';
  let dbPathOverride = '';
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
    } else if (arg === '--path' || arg === '--base-path') {
      basePath = argv[++i] ?? '';
    } else if (arg === '--dir') {
      exportDir = argv[++i] ?? '';
    } else if (arg === '--db') {
      dbPathOverride = argv[++i] ?? '';
    } else {
      rest.push(arg ?? '');
    }
  }

  return { command, scope, basePath, exportDir, dbPathOverride, rest };
}

/**
 * Default export directory for a scope when no --dir or SOX_CONFIG_EXPORT_DIR is set.
 *   user/org  → ~/.memory/export
 *   project   → <cwd>/.memory/export
 *   local     → <cwd>/.memory/export
 */
function defaultExportDir(scope: ScopeKind): string {
  const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? '/tmp';
  if (scope === 'user' || scope === 'org') {
    return path.join(home, '.memory', 'export');
  }
  return path.join(process.cwd(), '.memory', 'export');
}

/**
 * Resolve the export directory with precedence:
 *   --dir flag  >  SOX_CONFIG_EXPORT_DIR env var  >  scope-relative default
 */
function resolveExportDir(scope: ScopeKind, dirFlag: string): string {
  if (dirFlag) return path.resolve(dirFlag);
  const envDir = process.env['SOX_CONFIG_EXPORT_DIR'];
  if (envDir) return path.resolve(envDir);
  return defaultExportDir(scope);
}

/**
 * Resolve whether export is enabled:
 *   SOX_CONFIG_EXPORT_ENABLED env var  >  true (default on)
 */
function resolveExportEnabled(): boolean {
  const env = process.env['SOX_CONFIG_EXPORT_ENABLED'];
  if (env === 'false' || env === '0') return false;
  return true;
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

  // BL-95: scan known store dirs for bare memory.db files that aren't
  // registered in the registry. A live store at ~/.memory/memory.db that
  // predates the scope-naming convention is silently skipped by the
  // registry-only lookup, producing "No memory stores found."
  const KNOWN_STORE_DIRS = [
    path.join(os.homedir(), '.memory'),
    path.join(process.cwd(), '.memory'),
  ];
  const registeredPaths = new Set(paths);
  const unregisteredStores: Array<{ path: string; scope: string }> = [];

  for (const dir of KNOWN_STORE_DIRS) {
    if (!fs.existsSync(dir)) continue;
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.db')) continue;
        const p = path.join(dir, f);
        if (registeredPaths.has(p)) continue;
        const scopeName = f.replace('.db', '');
        unregisteredStores.push({ path: p, scope: `(unregistered/${scopeName})` });
        paths.push(p);
      }
    } catch { /* permission error */ }
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

      // BL-95: surface the unregistered note
      const unreg = unregisteredStores.find((s) => s.path === dbPath);
      const scopeLabel = unreg
        ? unreg.scope
        : (meta?.scope ?? '?');

      console.log(`${path.basename(dbPath)}: scope=${scopeLabel} nodes=${nodeCount} model=${meta?.embed_model ?? '?'} path=${dbPath}`);
      db.close();
    } catch (e) {
      console.log(`${path.basename(dbPath)}: error - ${String(e)}`);
    }
  }

  // BL-95: if any bare stores found, print registration guidance
  if (unregisteredStores.length > 0) {
    console.log(`\n${unregisteredStores.length} unregistered store(s) found. Run 'memory init --scope <scope> --path <dir>' to register.`);
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

/**
 * Export live episodes to a markdown mirror.
 *
 * DB resolution (highest precedence first):
 *   --db flag  >  SOX_CONFIG_DB_PATH env var  >  resolveDbPath(scope, basePath)
 *
 * Export-dir resolution:
 *   --dir flag  >  SOX_CONFIG_EXPORT_DIR env var  >  scope-relative default
 *
 * Enabled resolution:
 *   SOX_CONFIG_EXPORT_ENABLED env var  >  true (default on)
 */
function cmdExport(scope: ScopeKind, basePath: string, dirFlag: string, dbFlag: string): void {
  // Resolve db path
  const configDbPath = process.env['SOX_CONFIG_DB_PATH'];
  const dbPath = dbFlag
    ? path.resolve(dbFlag)
    : configDbPath
      ? path.resolve(configDbPath)
      : resolveDbPath(scope, basePath);

  if (!fs.existsSync(dbPath)) {
    console.error(`Memory store not found at ${dbPath} — run 'memory init' first.`);
    process.exit(1);
  }

  const exportDir = resolveExportDir(scope, dirFlag);
  const enabled = resolveExportEnabled();

  if (!enabled) {
    console.log('export disabled');
    return;
  }

  const db = openDb(dbPath);
  try {
    const result = exportMarkdown(db, { dir: exportDir, enabled });
    console.log(`exported ${result.nodesWritten} nodes across ${result.topics} topics → ${result.dir}`);
  } finally {
    db.close();
  }
}

export function runCli(argv: string[]): void {
  const { command, scope, basePath, exportDir, dbPathOverride } = parseArgs(argv);

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
    case 'export':
      cmdExport(scope, basePath, exportDir, dbPathOverride);
      break;
    case 'help':
    default:
      console.log(`sox-memory CLI (P3: multi-scope)
Commands:
  init [--scope project|user|org|local] [--path DIR]   Create a .memory/<scope>.db
  status [--path DIR]                                   Show all store info
  list [--path DIR]                                     List recent memories
  registry                                              Show ~/.memory/registry.json
  export [--scope <s>] [--base-path <p>]               Export live episodes to markdown
         [--dir <path>] [--db <path>]
`);
  }
}

// When invoked directly (not required as a library), run the CLI.
if (require.main === module) {
  runCli(process.argv.slice(2));
}

