#!/usr/bin/env node
/**
 * sox-memory CLI entry point.
 * Usage: node dist/memory-cli <command> [options]
 *
 * Commands:
 *   init [--scope project|user|org|local] [--path DIR]   Create .memory/<scope>.db
 *   status [--path DIR]                                   Show store info
 *   list [--path DIR]                                     List recent memories
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { openDb, initScope } from './memory-lib.js';

const VALID_SCOPES = ['project', 'user', 'org', 'local'];

function dbFileName(scope) {
  return `${scope}.db`;
}

function defaultBasePath(scope) {
  if (scope === 'user') return path.join(process.env.HOME ?? '~', '.memory');
  return '.memory';
}

function parseArgs(argv) {
  // argv is process.argv slice starting after the script name
  const command = argv[0] ?? 'help';
  let scope = 'project';
  let basePath = '';
  const rest = [];

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--scope') {
      const s = argv[++i];
      if (!VALID_SCOPES.includes(s)) {
        console.error(`Invalid scope: ${s}. Valid: ${VALID_SCOPES.join(', ')}`);
        process.exit(1);
      }
      scope = s;
    } else if (arg === '--path') {
      basePath = argv[++i] ?? '';
    } else {
      rest.push(arg);
    }
  }

  if (!basePath) {
    // --path sets the BASE directory; .memory/ is created inside it
    basePath = process.cwd();
  }

  return { command, scope, basePath, rest };
}

function cmdInit(scope, basePath) {
  const memoryDir = path.resolve(basePath, '.memory');
  fs.mkdirSync(memoryDir, { recursive: true });

  const dbPath = path.join(memoryDir, dbFileName(scope));
  const isNew = !fs.existsSync(dbPath);

  const db = openDb(dbPath);

  const existingRow = db.prepare('SELECT scope_id FROM memory_scope WHERE scope = ?').get(scope);
  const scopeId = existingRow?.scope_id ?? crypto.randomUUID();
  const meta = initScope(db, scope, scopeId);

  db.close();

  const verb = isNew ? 'Created' : 'Already exists (idempotent)';
  console.log(`${verb}: ${dbPath}`);
  console.log(`  scope:       ${meta.scope}`);
  console.log(`  scope_id:    ${meta.scope_id}`);
  console.log(`  embed_model: ${meta.embed_model}`);
  console.log(`  embed_dim:   ${meta.embed_dim}`);
  console.log(`  created_at:  ${meta.created_at}`);

  // Write registry entry
  const registryPath = path.join(process.env.HOME ?? '', '.memory', 'registry.json');
  let registry = {};
  try {
    registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  } catch {
    // First init
  }
  registry[scope] = dbPath;
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));
  console.log(`Registry updated: ${registryPath}`);
}

function cmdStatus(basePath) {
  const memoryDir = path.resolve(basePath, '.memory');
  if (!fs.existsSync(memoryDir)) {
    console.log(`No .memory directory found at ${memoryDir}`);
    return;
  }
  const dbs = fs.readdirSync(memoryDir).filter(f => f.endsWith('.db'));
  if (dbs.length === 0) {
    console.log(`No databases found in ${memoryDir}`);
    return;
  }
  for (const dbFile of dbs) {
    const dbPath = path.join(memoryDir, dbFile);
    try {
      const db = openDb(dbPath);
      const meta = db.prepare('SELECT * FROM memory_scope').get();
      const nodeCount = db.prepare('SELECT COUNT(*) as c FROM node').get().c;
      console.log(`${dbFile}: scope=${meta?.scope ?? '?'} nodes=${nodeCount} model=${meta?.embed_model ?? '?'}`);
      db.close();
    } catch (e) {
      console.log(`${dbFile}: error - ${String(e)}`);
    }
  }
}

function cmdList(basePath) {
  const memoryDir = path.resolve(basePath, '.memory');
  if (!fs.existsSync(memoryDir)) {
    console.log(`No .memory directory found at ${memoryDir}`);
    return;
  }
  const dbs = fs.readdirSync(memoryDir).filter(f => f.endsWith('.db'));
  for (const dbFile of dbs) {
    const dbPath = path.join(memoryDir, dbFile);
    try {
      const db = openDb(dbPath);
      const nodes = db.prepare(
        `SELECT uid, kind, content, t_created FROM node WHERE t_invalid IS NULL ORDER BY t_created DESC LIMIT 20`
      ).all();
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

function main() {
  const argv = process.argv.slice(2);
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
    default:
      console.log(`sox-memory CLI
Commands:
  init [--scope project|user|org|local] [--path DIR]   Create a .memory/<scope>.db
  status [--path DIR]                                   Show store info
  list [--path DIR]                                     List recent memories
`);
  }
}

main();
