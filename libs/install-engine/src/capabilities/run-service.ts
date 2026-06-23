/**
 * libs/install-engine/src/capabilities/run-service.ts
 *
 * run-service capability — sox spawns and supervises a process (Role A only).
 * [def:capability], [def:role-a]
 *
 * This capability records intent in a service-manifest file at the scope root.
 * Actual spawning is performed by the host runtime (supervisor), not here.
 * The capability layer creates/removes the service-manifest that the supervisor
 * reads to start/stop the service.
 *
 * Action  : write service-manifest at <dataDir>/services/<ext>.json
 * Reverse : remove the service-manifest (supervisor will stop the service)
 * Update  : compare manifest content vs desired
 * Verify  : manifest present and content matches
 *
 * No shared file — no ledger required.
 *
 * NOTE (ADR-0004 §D2): `target.scopeRoot` is the resolved `.adhd/sox-ecosystem`
 * data directory for the scope. This capability writes directly under it (no
 * extra `.sox` subdir).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

// --- Types ---

export interface ServiceSpec {
  /** Command to run (e.g. path to entrypoint). */
  command: string;
  /** Arguments to pass. */
  args?: string[];
  /** Environment variables to inject. */
  env?: Record<string, string>;
  /** Working directory. */
  cwd?: string;
}

export interface RunServiceTarget {
  /** Resolved data directory (ADR-0004 §D2 `.adhd/sox-ecosystem` for the scope). */
  scopeRoot: string;
  /** Stable service ID (matches ext id). */
  serviceId: string;
}

export interface RunServicePayload {
  spec: ServiceSpec;
}

export interface RunServiceCtx {
  host: string;
  scope: string;
  target: RunServiceTarget;
  payload: RunServicePayload;
}

export interface Diff {
  kind: 'none' | 'update' | 'add' | 'remove';
  currentHash?: string;
  desiredHash?: string;
}

export interface VerifyResult {
  ok: boolean;
  reason?: string;
}

// --- Helpers ---

function manifestPath(scopeRoot: string, serviceId: string): string {
  return path.join(scopeRoot, 'services', `${serviceId}.json`);
}

function specHash(spec: ServiceSpec): string {
  return 'sha256:' + crypto.createHash('sha256').update(JSON.stringify(spec)).digest('hex');
}

// --- Capability ---

/**
 * apply — write service manifest; create store dir; write registry entry; idempotent.
 *
 * [def:store-dir]: materialized extension at <scopeRoot>/.sox/ext/<id>/
 * [mcp-install-modes.3]: creates <scopeRoot>/.sox/ext/ directory.
 * [mcp-install-modes.4]: writes <scopeRoot>/.sox/registry.json with service entry.
 */
export async function apply(ctx: RunServiceCtx): Promise<void> {
  const { scopeRoot, serviceId } = ctx.target;
  const { spec } = ctx.payload;

  // Write per-service manifest (legacy — supervisor reads this for spawning).
  const mp = manifestPath(scopeRoot, serviceId);
  const desired = JSON.stringify({ serviceId, spec }, null, 2) + '\n';
  if (!fs.existsSync(mp) || fs.readFileSync(mp, 'utf8') !== desired) {
    const dir = path.dirname(mp);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(mp, desired, 'utf8');
  }

  // [def:store-dir]: create <dataDir>/ext/<id>/ — the materialized bundle store.
  const storeDir = path.join(scopeRoot, 'ext', serviceId);
  if (!fs.existsSync(storeDir)) {
    fs.mkdirSync(storeDir, { recursive: true });
  }

  // Write/update the global registry.json — the supervisor reads this for all services.
  // Format: { "<id>": { id, command, args, status, storePath } }
  const registryPath = path.join(scopeRoot, 'registry.json');
  let registry: Record<string, unknown> = {};
  if (fs.existsSync(registryPath)) {
    try {
      registry = JSON.parse(fs.readFileSync(registryPath, 'utf8')) as Record<string, unknown>;
    } catch {
      // Start fresh if malformed
    }
  }

  const serviceEntry = {
    id: serviceId,
    command: spec.command,
    args: spec.args ?? [],
    env: spec.env ?? {},
    cwd: spec.cwd ?? storeDir,
    status: 'installed' as const,
    storePath: storeDir,
  };

  const registryDir = path.dirname(registryPath);
  if (!fs.existsSync(registryDir)) fs.mkdirSync(registryDir, { recursive: true });
  registry[serviceId] = serviceEntry;
  fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2) + '\n', 'utf8');
}

/**
 * reverse — remove service manifest (supervisor will stop the service).
 */
export async function reverse(ctx: RunServiceCtx): Promise<void> {
  const { scopeRoot, serviceId } = ctx.target;
  const mp = manifestPath(scopeRoot, serviceId);
  if (fs.existsSync(mp)) {
    fs.unlinkSync(mp);
  }
}

/**
 * update — compare current manifest hash vs desired spec hash.
 */
export async function update(ctx: RunServiceCtx): Promise<Diff> {
  const { scopeRoot, serviceId } = ctx.target;
  const { spec } = ctx.payload;
  const mp = manifestPath(scopeRoot, serviceId);
  const desiredHash = specHash(spec);

  if (!fs.existsSync(mp)) {
    return { kind: 'add', desiredHash };
  }

  try {
    const raw = fs.readFileSync(mp, 'utf8');
    const stored = JSON.parse(raw) as { serviceId: string; spec: ServiceSpec };
    const currentHash = specHash(stored.spec);
    if (currentHash === desiredHash) return { kind: 'none', currentHash };
    return { kind: 'update', currentHash, desiredHash };
  } catch {
    return { kind: 'update', desiredHash };
  }
}

/**
 * verify — manifest present AND spec matches.
 */
export async function verify(ctx: RunServiceCtx): Promise<VerifyResult> {
  const { scopeRoot, serviceId } = ctx.target;
  const { spec } = ctx.payload;
  const mp = manifestPath(scopeRoot, serviceId);

  if (!fs.existsSync(mp)) {
    return { ok: false, reason: `service manifest not found: ${mp}` };
  }

  try {
    const raw = fs.readFileSync(mp, 'utf8');
    const stored = JSON.parse(raw) as { serviceId: string; spec: ServiceSpec };
    const currentHash = specHash(stored.spec);
    const desiredHash = specHash(spec);
    if (currentHash !== desiredHash) {
      return { ok: false, reason: `spec mismatch: current=${currentHash} desired=${desiredHash}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `could not read manifest: ${String(err)}` };
  }
}
