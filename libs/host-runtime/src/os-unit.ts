/**
 * libs/host-runtime/src/os-unit.ts — Slice 2 of docs/spec/service-lifecycle.md.
 *
 * The OS-supervisor control surface: GENERATE / LOAD / UNLOAD an OS unit
 * (macOS launchd LaunchAgent first; the seam is platform-pluggable so systemd
 * --user slots in) from an extension's manifest + resolved config env. This is
 * the reboot-persistence half of BL-50 and all of BL-51 (§9, §14 Slice 2).
 *
 * Invariants honored (spec §13):
 *   [inv:os-unit-generated]          — units are RENDERED here from the manifest;
 *                                      hand-authoring is forbidden. `soxe service
 *                                      enable|disable` is the only sanctioned path.
 *   [inv:os-unit-content-addressed]  — every rendered unit embeds a content hash;
 *                                      `enableOsUnit` is idempotent and rewrites
 *                                      ONLY when the generated content differs
 *                                      (re-enable on artifact change, §9.3).
 *   [inv:unload-then-reap]           — `unloadThenReap` unloads the OS unit BEFORE
 *                                      killing the pid, so launchd/systemd cannot
 *                                      resurrect a just-killed process (§8.4/§8.5).
 *   §7 step 5 / §9.2 env mirror      — the unit's EnvironmentVariables are the
 *                                      resolved SOX_CONFIG_* + the SAME scrub
 *                                      allowlist the supervisor uses (SOX_EMBED_*,
 *                                      XDG_CACHE_HOME, NODE_*). Never widen silently.
 *
 * Leaf-ish: node builtins + reaper.ts only (for the verified-stop reap). It never
 * re-implements process scan/kill. All filesystem + launchctl/systemctl effects
 * are funneled through injectable seams (`unitDir`, `exec`) so tests run entirely
 * against a SANDBOXED unit dir with a FAKE exec — never touching the real OS
 * supervisor in tests. In production, `realOsExec` is used for all platform
 * commands (launchctl/systemctl); the CLI gates destructive load/unload ops
 * behind user intent (spec Appendix B item 3: real activation needs a human
 * node-path ack at the CLI layer), but the module itself has full production
 * capability including `launchctl bootstrap`/`bootout` when `load:true` is passed
 * with `exec:realOsExec`.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  identityToken,
  reapByIdentity,
  type KillOutcome,
  type ReapResult,
} from './reaper.js';

// ─── Platform taxonomy ──────────────────────────────────────────────────────────

export type OsSupervisor = 'launchd' | 'systemd';

/** Detect the OS supervisor for the current platform. */
export function detectOsSupervisor(platform: NodeJS.Platform = process.platform): OsSupervisor {
  return platform === 'darwin' ? 'launchd' : 'systemd';
}

// ─── The platform-neutral unit spec (derived from the manifest, §9.2) ────────────

export interface OsUnitSpec {
  /** Extension id. */
  id: string;
  /** Installation scope (org|user|project|local). In the label so scopes never collide. */
  scope: string;
  /** Reverse-DNS-style label: `com.sox.<scope>.<id>`. */
  label: string;
  /** Absolute node binary the unit launches (pinned realpath, §9.2 / Appendix B item 3). */
  nodePath: string;
  /** Node args BEFORE the entrypoint (e.g. `--enable-source-maps`). */
  nodeArgs: string[];
  /** Absolute entrypoint path (the BL-31 identity token the reaper matches). */
  entrypoint: string;
  /** Resolved EnvironmentVariables — SOX_CONFIG_* + the scrub allowlist (§9.2). */
  env: Record<string, string>;
  /** Store dir (ADR-0004 `ext/<id>`) — the unit's WorkingDirectory. */
  workingDirectory: string;
  /** `lifecycle.background:true` ⇒ run at load (launchd RunAtLoad / systemd default.target). */
  runAtLoad: boolean;
  /** `lifecycle.singleton:true` ⇒ keep alive (launchd KeepAlive / systemd Restart). */
  keepAlive: boolean;
  /** Crash-loop guard (§11.3): launchd ThrottleInterval / systemd RestartSec. ≥10s. */
  throttleIntervalSec: number;
  /** Durable stdout log path (ADR-0004 run/logs/). */
  stdoutPath: string;
  /** Durable stderr log path (ADR-0004 run/logs/). */
  stderrPath: string;
  /** Content address of the served artifact (ADR-0003), when known. */
  artifactHash?: string | undefined;
}

interface ManifestLifecycleShape {
  lifecycle?: {
    background?: boolean;
    singleton?: boolean;
    stop_timeout_ms?: number;
  };
}

/** The reverse-DNS-style label for a (scope, id) unit. */
export function osUnitLabel(scope: string, id: string): string {
  return `com.sox.${scope}.${id}`;
}

/**
 * Derive the platform-neutral unit spec from an extension's manifest + the
 * already-resolved inputs the caller (cmdService) computes: pinned node path,
 * absolute entrypoint, resolved env, store dir, and log dir. Reads ONLY the
 * `lifecycle` block of the manifest (background / singleton / stop_timeout_ms);
 * everything else is passed in resolved so this module stays leaf-ish.
 */
export function deriveOsUnitSpec(opts: {
  id: string;
  scope: string;
  manifestPath: string;
  nodePath: string;
  nodeArgs?: string[];
  entrypoint: string;
  env: Record<string, string>;
  workingDirectory: string;
  logDir: string;
  artifactHash?: string | undefined;
  /** Override the YYYY-MM-DD log date (tests). Default: today. */
  logDate?: string;
}): OsUnitSpec {
  let manifest: ManifestLifecycleShape = {};
  try {
    manifest = JSON.parse(fs.readFileSync(opts.manifestPath, 'utf8')) as ManifestLifecycleShape;
  } catch {
    manifest = {};
  }
  const lc = manifest.lifecycle ?? {};
  const label = osUnitLabel(opts.scope, opts.id);
  const logDate = opts.logDate ?? new Date().toISOString().slice(0, 10);
  return {
    id: opts.id,
    scope: opts.scope,
    label,
    nodePath: opts.nodePath,
    nodeArgs: opts.nodeArgs ?? ['--enable-source-maps'],
    entrypoint: opts.entrypoint,
    env: opts.env,
    workingDirectory: opts.workingDirectory,
    // `background` defaults to true for a service that opts into an OS unit — the
    // whole point of `service enable` is reboot persistence (run at load).
    runAtLoad: lc.background !== false,
    // KeepAlive iff the service declares itself a singleton (the daemons do).
    keepAlive: lc.singleton === true,
    // launchd throttles respawns to ~10s; §11.3 maps the crash-loop guard to it.
    throttleIntervalSec: 10,
    stdoutPath: path.join(opts.logDir, `${opts.id}-os-${logDate}.out.log`),
    stderrPath: path.join(opts.logDir, `${opts.id}-os-${logDate}.err.log`),
    artifactHash: opts.artifactHash,
  };
}

// ─── Stable node-path resolution (§9.2 / Appendix B item 3) ──────────────────────

/** Version-manager dirs whose node binaries are VOLATILE (a version switch orphans the unit). */
const VOLATILE_NODE_PATTERNS = [/\/\.nvm\//, /\/\.asdf\//, /\/\.volta\//, /\/versions\/node\//];

export interface NodePathResolution {
  /** The pinned node path to bake into the unit. */
  nodePath: string;
  /** True when `nodePath` lives under a version-manager dir (a `nvm use` orphans it). */
  volatile: boolean;
  /** Human-readable reason when volatile. */
  volatileReason?: string;
  /** A non-volatile node discovered on PATH (the recommended substitute), if any. */
  preferredNonVolatile?: string;
}

function isVolatileNodePath(p: string): boolean {
  return VOLATILE_NODE_PATTERNS.some((re) => re.test(p));
}

/**
 * Find a node binary on PATH whose realpath is NOT under a version-manager dir.
 * Returns the first such realpath, or undefined. Pure over `pathEnv`.
 */
export function findNonVolatileNode(pathEnv = process.env['PATH'] ?? ''): string | undefined {
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, 'node');
    try {
      if (!fs.existsSync(candidate)) continue;
      const real = fs.realpathSync(candidate);
      // Must be an actual binary file (not a dir / dangling link) and non-volatile.
      if (!fs.statSync(real).isFile()) continue;
      if (!isVolatileNodePath(real)) return real;
    } catch {
      /* unreadable PATH entry / broken symlink — skip */
    }
  }
  return undefined;
}

/**
 * Resolve the stable node path to pin into the unit (§9.2). Recommended default:
 * `fs.realpathSync(process.execPath)` (strips one symlink layer, e.g. brew
 * bin → cellar). FOOTGUN GUARD: if that realpath is under nvm/asdf/volta/versions,
 * mark it volatile and surface a non-volatile node from PATH if one exists. The
 * CLI gates loading a volatile unit behind an explicit `--allow-volatile-node` ack.
 */
export function resolveUnitNodePath(opts: { execPath?: string; pathEnv?: string } = {}): NodePathResolution {
  const raw = opts.execPath ?? process.execPath;
  let real = raw;
  try {
    real = fs.realpathSync(raw);
  } catch {
    real = raw;
  }
  if (!isVolatileNodePath(real)) {
    return { nodePath: real, volatile: false };
  }
  const preferred = findNonVolatileNode(opts.pathEnv ?? process.env['PATH'] ?? '');
  return {
    nodePath: real,
    volatile: true,
    volatileReason:
      `pinned node ${real} is under a version-manager dir — a version switch ` +
      `(e.g. \`nvm use\`) will orphan this unit`,
    ...(preferred !== undefined ? { preferredNonVolatile: preferred } : {}),
  };
}

// ─── Content addressing (§9.3 / [inv:os-unit-content-addressed]) ─────────────────

const UNIT_META_MARKER = 'sox-os-unit';

/**
 * Compute the content hash of a rendered unit — the canonical content address. It
 * is computed over the rendered BODY with any prior `sox-os-unit` metadata comment
 * stripped, so the embedded hash never feeds its own input (a stable fixed point).
 */
export function unitContentHash(renderedWithoutMeta: string): string {
  return createHash('sha256').update(renderedWithoutMeta, 'utf8').digest('hex').slice(0, 16);
}

/** Parse the embedded `{ contentHash, artifactHash }` from an on-disk unit file, if present. */
export function readUnitMeta(unitText: string): { contentHash?: string; artifactHash?: string } {
  const m = new RegExp(`${UNIT_META_MARKER} content-hash:([0-9a-f]+)(?: artifact-hash:([^\\s]+))?`).exec(unitText);
  if (!m) return {};
  return {
    ...(m[1] !== undefined ? { contentHash: m[1] } : {}),
    ...(m[2] !== undefined && m[2] !== 'none' ? { artifactHash: m[2] } : {}),
  };
}

// ─── The pluggable platform seam ─────────────────────────────────────────────────

/** Result of a `launchctl`/`systemctl` invocation (seam-injected for tests). */
export interface OsExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Injectable command runner — the ONLY path to a real launchctl/systemctl call. */
export type OsExec = (cmd: string, args: string[]) => OsExecResult;

/** The default real exec — runs the command, never throws (returns a non-zero code instead). */
export const realOsExec: OsExec = (cmd, args) => {
  try {
    const stdout = execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    const err = e as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
    return {
      code: typeof err.status === 'number' ? err.status : 1,
      stdout: err.stdout?.toString() ?? '',
      stderr: err.stderr?.toString() ?? '',
    };
  }
};

export interface OsUnitPlatform {
  readonly kind: OsSupervisor;
  /** The default per-user unit directory (NEVER hardcoded into callers — overridable). */
  defaultUnitDir(): string;
  /** The unit's filename for a label (e.g. `com.sox.user.x.plist`). */
  unitFileName(label: string): string;
  /** Render the unit text (content-addressed: embeds the content + artifact hash). */
  render(spec: OsUnitSpec): string;
  /** Load (activate) a unit. */
  load(unitPath: string, label: string, exec: OsExec): OsExecResult;
  /** Unload (deactivate) a unit. */
  unload(unitPath: string, label: string, exec: OsExec): OsExecResult;
  /** Query whether a unit is currently loaded. */
  isLoaded(label: string, exec: OsExec): boolean;
}

// ─── XML helpers (launchd plist) ─────────────────────────────────────────────────

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ─── launchd (macOS LaunchAgent) ─────────────────────────────────────────────────

export class LaunchdPlatform implements OsUnitPlatform {
  readonly kind = 'launchd' as const;

  defaultUnitDir(): string {
    return path.join(os.homedir(), 'Library', 'LaunchAgents');
  }

  unitFileName(label: string): string {
    return `${label}.plist`;
  }

  /** Render the plist BODY (no metadata comment) — the content-address input. */
  private renderBody(spec: OsUnitSpec): string {
    const progArgs = [spec.nodePath, ...spec.nodeArgs, spec.entrypoint];
    const argLines = progArgs.map((a) => `    <string>${xmlEscape(a)}</string>`).join('\n');
    const envKeys = Object.keys(spec.env).sort(); // deterministic ⇒ stable content hash
    const envLines = envKeys
      .map((k) => `    <key>${xmlEscape(k)}</key>\n    <string>${xmlEscape(spec.env[k] ?? '')}</string>`)
      .join('\n');

    return [
      '<plist version="1.0">',
      '<dict>',
      '  <key>Label</key>',
      `  <string>${xmlEscape(spec.label)}</string>`,
      '  <key>ProgramArguments</key>',
      '  <array>',
      argLines,
      '  </array>',
      '  <key>EnvironmentVariables</key>',
      '  <dict>',
      envLines,
      '  </dict>',
      '  <key>WorkingDirectory</key>',
      `  <string>${xmlEscape(spec.workingDirectory)}</string>`,
      '  <key>RunAtLoad</key>',
      `  <${spec.runAtLoad ? 'true' : 'false'}/>`,
      '  <key>KeepAlive</key>',
      `  <${spec.keepAlive ? 'true' : 'false'}/>`,
      '  <key>ThrottleInterval</key>',
      `  <integer>${spec.throttleIntervalSec}</integer>`,
      '  <key>StandardOutPath</key>',
      `  <string>${xmlEscape(spec.stdoutPath)}</string>`,
      '  <key>StandardErrorPath</key>',
      `  <string>${xmlEscape(spec.stderrPath)}</string>`,
      '  <key>ProcessType</key>',
      '  <string>Background</string>',
      '</dict>',
      '</plist>',
      '',
    ].join('\n');
  }

  render(spec: OsUnitSpec): string {
    const body = this.renderBody(spec);
    const hash = unitContentHash(body);
    const meta = `<!-- ${UNIT_META_MARKER} content-hash:${hash} artifact-hash:${spec.artifactHash ?? 'none'} generated-by:soxe-service-enable -->`;
    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      meta,
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      body,
    ].join('\n');
  }

  /** The bootstrap domain target for the current user (gui/<uid>). */
  private domain(): string {
    return `gui/${process.getuid?.() ?? 0}`;
  }

  load(unitPath: string, _label: string, exec: OsExec): OsExecResult {
    // Modern launchctl: bootstrap the unit into the user GUI domain.
    return exec('launchctl', ['bootstrap', this.domain(), unitPath]);
  }

  unload(unitPath: string, label: string, exec: OsExec): OsExecResult {
    // bootout by path is most precise; fall back to the service-target form.
    const byPath = exec('launchctl', ['bootout', this.domain(), unitPath]);
    if (byPath.code === 0) return byPath;
    return exec('launchctl', ['bootout', `${this.domain()}/${label}`]);
  }

  isLoaded(label: string, exec: OsExec): boolean {
    const r = exec('launchctl', ['print', `${this.domain()}/${label}`]);
    return r.code === 0;
  }
}

// ─── systemd (Linux --user) — the seam proven pluggable ──────────────────────────

export class SystemdPlatform implements OsUnitPlatform {
  readonly kind = 'systemd' as const;

  defaultUnitDir(): string {
    const xdg = process.env['XDG_CONFIG_HOME'];
    const base = xdg && xdg !== '' ? xdg : path.join(os.homedir(), '.config');
    return path.join(base, 'systemd', 'user');
  }

  unitFileName(label: string): string {
    // sox-<scope>-<id>.service (label is com.sox.<scope>.<id>)
    const tail = label.replace(/^com\.sox\./, '').replace(/\./g, '-');
    return `sox-${tail}.service`;
  }

  private renderBody(spec: OsUnitSpec): string {
    const execLine = [spec.nodePath, ...spec.nodeArgs, spec.entrypoint]
      .map((a) => (/\s/.test(a) ? `"${a}"` : a))
      .join(' ');
    const envKeys = Object.keys(spec.env).sort();
    const envLines = envKeys.map((k) => `Environment=${k}=${spec.env[k] ?? ''}`).join('\n');
    return [
      '[Unit]',
      `Description=soxe service ${spec.id} (${spec.scope})`,
      '',
      '[Service]',
      'Type=simple',
      `ExecStart=${execLine}`,
      `WorkingDirectory=${spec.workingDirectory}`,
      envLines,
      `Restart=${spec.keepAlive ? 'on-failure' : 'no'}`,
      `RestartSec=${spec.throttleIntervalSec}`,
      'StartLimitIntervalSec=60',
      'StartLimitBurst=5',
      `StandardOutput=append:${spec.stdoutPath}`,
      `StandardError=append:${spec.stderrPath}`,
      '',
      '[Install]',
      'WantedBy=default.target',
      '',
    ].join('\n');
  }

  render(spec: OsUnitSpec): string {
    const body = this.renderBody(spec);
    const hash = unitContentHash(body);
    const meta = `# ${UNIT_META_MARKER} content-hash:${hash} artifact-hash:${spec.artifactHash ?? 'none'} generated-by:soxe-service-enable`;
    return [meta, body].join('\n');
  }

  load(_unitPath: string, label: string, exec: OsExec): OsExecResult {
    const unit = this.unitFileName(label);
    exec('systemctl', ['--user', 'daemon-reload']);
    return exec('systemctl', ['--user', 'enable', '--now', unit]);
  }

  unload(_unitPath: string, label: string, exec: OsExec): OsExecResult {
    const unit = this.unitFileName(label);
    return exec('systemctl', ['--user', 'disable', '--now', unit]);
  }

  isLoaded(label: string, exec: OsExec): boolean {
    const unit = this.unitFileName(label);
    const r = exec('systemctl', ['--user', 'is-active', unit]);
    return r.code === 0 && r.stdout.trim() === 'active';
  }
}

/** Get the platform implementation for an OS supervisor kind. */
export function getOsUnitPlatform(kind: OsSupervisor = detectOsSupervisor()): OsUnitPlatform {
  return kind === 'launchd' ? new LaunchdPlatform() : new SystemdPlatform();
}

// ─── enable / disable (idempotent, content-addressed) ────────────────────────────

export type EnableAction = 'created' | 'updated' | 'unchanged';

export interface EnableResult {
  action: EnableAction;
  unitPath: string;
  label: string;
  contentHash: string;
  /** Whether the unit was (re)loaded by the OS supervisor this call. */
  loaded: boolean;
}

export interface EnableOptions {
  /** INJECTABLE unit directory. Defaults to the platform default. Tests pass a temp dir. */
  unitDir?: string;
  /** INJECTABLE command runner. Defaults to realOsExec. Tests pass a fake. */
  exec?: OsExec;
  /**
   * When false (default), the unit is rendered + written to disk but NOT loaded —
   * the safe "render-only" path. When true, the unit is loaded via the platform.
   * The CLI gates `load:true` behind the human node-path ack (Appendix B item 3).
   */
  load?: boolean;
  log?: (m: string) => void;
}

function ensureDir(p: string): void {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function writeFileAtomic(filePath: string, content: string): void {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, filePath);
}

/**
 * Generate + (optionally) load the OS unit for a spec. Idempotent and
 * content-addressed ([inv:os-unit-content-addressed]):
 *
 *   - If the on-disk unit's embedded content hash equals the freshly-rendered
 *     hash AND it is loaded (when load requested) ⇒ `unchanged`, no write/reload.
 *   - Otherwise the new content is written; if it was loaded it is UNLOADED first
 *     (so the reload picks up the new ProgramArguments/env), then loaded.
 *
 * Never writes outside `unitDir`. Never calls the OS supervisor unless `load:true`.
 */
export function enableOsUnit(
  spec: OsUnitSpec,
  platform: OsUnitPlatform,
  opts: EnableOptions = {},
): EnableResult {
  const log = opts.log ?? (() => { /* no-op */ });
  const exec = opts.exec ?? realOsExec;
  const unitDir = opts.unitDir ?? platform.defaultUnitDir();
  const unitPath = path.join(unitDir, platform.unitFileName(spec.label));

  const rendered = platform.render(spec);
  const newHash = readUnitMeta(rendered).contentHash ?? unitContentHash(rendered);

  // Ensure the durable log dirs exist so the OS supervisor can open them.
  ensureDir(path.dirname(spec.stdoutPath));
  ensureDir(path.dirname(spec.stderrPath));

  const existed = fs.existsSync(unitPath);
  const priorHash = existed ? readUnitMeta(fs.readFileSync(unitPath, 'utf8')).contentHash : undefined;
  const contentSame = existed && priorHash === newHash;
  const wantLoad = opts.load === true;
  const currentlyLoaded = wantLoad ? platform.isLoaded(spec.label, exec) : false;

  if (contentSame && (!wantLoad || currentlyLoaded)) {
    log(`os-unit ${spec.label}: unchanged (content-hash ${newHash})`);
    return { action: 'unchanged', unitPath, label: spec.label, contentHash: newHash, loaded: currentlyLoaded };
  }

  // Content changed (or first write, or not loaded yet). If currently loaded with
  // OLD content, unload first so the reload picks up the new unit.
  if (wantLoad && currentlyLoaded) {
    log(`os-unit ${spec.label}: unloading stale unit before rewrite`);
    platform.unload(unitPath, spec.label, exec);
  }

  writeFileAtomic(unitPath, rendered);
  const action: EnableAction = existed ? 'updated' : 'created';
  log(`os-unit ${spec.label}: ${action} ${unitPath} (content-hash ${newHash})`);

  let loaded = false;
  if (wantLoad) {
    const r = platform.load(unitPath, spec.label, exec);
    loaded = r.code === 0;
    if (!loaded) {
      log(`os-unit ${spec.label}: load FAILED (code ${r.code}): ${r.stderr.trim() || r.stdout.trim()}`);
    } else {
      log(`os-unit ${spec.label}: loaded`);
    }
  }

  return { action, unitPath, label: spec.label, contentHash: newHash, loaded };
}

export interface DisableOptions {
  unitDir?: string;
  exec?: OsExec;
  /** Remove the unit file after unloading. Default true. */
  removeFile?: boolean;
  log?: (m: string) => void;
}

export interface DisableResult {
  label: string;
  unitPath: string;
  /** Whether the unit was loaded and is now unloaded. */
  unloaded: boolean;
  /** Whether the unit file was removed. */
  removed: boolean;
}

/**
 * Unload (deactivate) and remove an OS unit. Idempotent: a not-loaded / absent
 * unit is a clean no-op. This UNLOADS but does NOT reap — the survivor reap is the
 * caller's job (see `unloadThenReap` / cmdService disable) so the ordering
 * [inv:unload-then-reap] is explicit at the orchestration layer.
 */
export function disableOsUnit(
  label: string,
  platform: OsUnitPlatform,
  opts: DisableOptions = {},
): DisableResult {
  const log = opts.log ?? (() => { /* no-op */ });
  const exec = opts.exec ?? realOsExec;
  const unitDir = opts.unitDir ?? platform.defaultUnitDir();
  const unitPath = path.join(unitDir, platform.unitFileName(label));

  let unloaded = false;
  if (platform.isLoaded(label, exec)) {
    const r = platform.unload(unitPath, label, exec);
    unloaded = r.code === 0;
    log(`os-unit ${label}: ${unloaded ? 'unloaded' : `unload FAILED (code ${r.code})`}`);
  } else {
    log(`os-unit ${label}: not loaded (nothing to unload)`);
  }

  let removed = false;
  if (opts.removeFile !== false && fs.existsSync(unitPath)) {
    try {
      fs.unlinkSync(unitPath);
      removed = true;
      log(`os-unit ${label}: removed ${unitPath}`);
    } catch (e) {
      log(`os-unit ${label}: could not remove ${unitPath}: ${String(e)}`);
    }
  }

  return { label, unitPath, unloaded, removed };
}

// ─── restart (unload → reap → render → load → loop-guard) ────────────────────

export interface RestartOptions {
  unitDir?: string;
  exec?: OsExec;
  log?: (m: string) => void;
  /** Reason for the restart (config key change, upgrade, etc.). */
  reason?: string;
  /** Optional AbortSignal to cancel the restart. On abort after unload,
   *  the function reverts to last-known-good before re-throwing. */
  signal?: AbortSignal;
}

export interface RestartResult {
  action: 'restarted' | 'unchanged' | 'failed' | 'reverted_to_lkg';
  label: string;
  unitPath: string;
  contentHash: string;
  loaded: boolean;
  /** Reason for the restart (config key change, upgrade, etc.). */
  reason?: string;
}

/**
 * Restart an OS unit: unload the current unit, regenerate with new content,
 * load the new unit. Implements the restart loop guard: if the unit crashes
 * ≥3 times within 60s after restart, revert to the last-known-good spec.
 *
 * Callers must provide the NEW OsUnitSpec (reflecting the config change or
 * artifact upgrade) and the path to the last-known-good unit file (from the
 * ownership index's os-unit entry).
 */
export async function restartOsUnit(
  newSpec: OsUnitSpec,
  platform: OsUnitPlatform,
  lastKnownGoodPath: string | undefined,
  opts: RestartOptions = {},
): Promise<RestartResult> {
  const log = opts.log ?? (() => { /* no-op */ });
  const exec = opts.exec ?? realOsExec;
  const unitDir = opts.unitDir ?? platform.defaultUnitDir();
  const signal = opts.signal;

  const unitPath = path.join(unitDir, platform.unitFileName(newSpec.label));

  // Track whether the new unit was loaded so the finally block knows
  // whether to roll back to LKG (daemon down with no replacement).
  let loaded = false;

  try {
    // Abort before any destructive work.
    if (signal?.aborted) throw new Error('Aborted');

    // 1. Unload current unit first ([inv:unload-then-reap]).
    const wasLoaded = platform.isLoaded(newSpec.label, exec);
    if (wasLoaded) {
      const ur = platform.unload(unitPath, newSpec.label, exec);
      log(`os-unit ${newSpec.label}: unloaded (code ${ur.code})`);
      // Brief yield so the OS supervisor finishes teardown.
      await new Promise((r) => setTimeout(r, 500));
    }

    // Abort after unload — daemon is down but not yet replaced.
    if (signal?.aborted) throw new Error('Aborted');

    // 2. If an OS-supervised dead process is still around, reap it.
    const token = identityToken(newSpec.entrypoint);
    if (token) {
      await reapByIdentity(token, { log: (m: string) => log(`reaper: ${m}`) });
    }

    // Abort after reap.
    if (signal?.aborted) throw new Error('Aborted');

    // 3. Render + write new unit.
    const rendered = platform.render(newSpec);
    const contentHash = readUnitMeta(rendered).contentHash ?? unitContentHash(rendered);
    writeFileAtomic(unitPath, rendered);
    log(`os-unit ${newSpec.label}: written (content-hash ${contentHash})`);

    // Abort after write.
    if (signal?.aborted) throw new Error('Aborted');

    // 4. Load new unit.
    const lr = platform.load(unitPath, newSpec.label, exec);
    if (lr.code !== 0) {
      log(`os-unit ${newSpec.label}: load FAILED (code ${lr.code})`);
      if (lastKnownGoodPath && fs.existsSync(lastKnownGoodPath)) {
        log(`os-unit ${newSpec.label}: reverting to last-known-good`);
        writeFileAtomic(unitPath, fs.readFileSync(lastKnownGoodPath, 'utf8'));
        const r2 = platform.load(unitPath, newSpec.label, exec);
        loaded = r2.code === 0;
        return {
          action: 'reverted_to_lkg',
          label: newSpec.label,
          unitPath,
          contentHash,
          loaded,
          ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
        };
      }
      return {
        action: 'failed',
        label: newSpec.label,
        unitPath,
        contentHash,
        loaded: false,
        ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
      };
    }

    loaded = true;
    log(`os-unit ${newSpec.label}: loaded`);

    // 5. Restart loop guard: monitor for 60s. If the unit crashes ≥3 times,
    //    revert to LKG.
    if (newSpec.keepAlive && lastKnownGoodPath && fs.existsSync(lastKnownGoodPath)) {
      const guard = new RestartLoopGuard(newSpec.label, platform, exec, 3, 60_000, log);
      const guardResult = await guard.monitor();
      if (guardResult === 'loop') {
        log(`os-unit ${newSpec.label}: CRASH LOOP DETECTED — reverting to LKG`);
        platform.unload(unitPath, newSpec.label, exec);
        writeFileAtomic(unitPath, fs.readFileSync(lastKnownGoodPath, 'utf8'));
        platform.load(unitPath, newSpec.label, exec);
        return {
          action: 'reverted_to_lkg',
          label: newSpec.label,
          unitPath,
          contentHash,
          loaded: true,
          reason: `restart-loop-guard: ${opts.reason ?? 'unknown'}`,
        };
      }
    }

    const result: RestartResult = {
      action: 'restarted',
      label: newSpec.label,
      unitPath,
      contentHash,
      loaded: true,
    };
    if (opts.reason !== undefined) result.reason = opts.reason;
    return result;
  } finally {
    // If the daemon was unloaded but not reloaded (interrupted/timeout/error),
    // restore the last-known-good unit so the daemon is not left dead.
    if (!loaded && lastKnownGoodPath && fs.existsSync(lastKnownGoodPath)) {
      log(`os-unit ${newSpec.label}: INTERRUPTED — reverting to last-known-good`);
      platform.unload(unitPath, newSpec.label, exec);
      writeFileAtomic(unitPath, fs.readFileSync(lastKnownGoodPath, 'utf8'));
      platform.load(unitPath, newSpec.label, exec);
    }
  }
}

/**
 * Restart loop guard: polls service liveness for `durationMs`. If the service
 * is observed down ≥`crashThreshold` times within the window, reports 'loop'.
 */
class RestartLoopGuard {
  private readonly label: string;
  private readonly platform: OsUnitPlatform;
  private readonly exec: OsExec;
  private readonly threshold: number;
  private readonly durationMs: number;
  private readonly log: (m: string) => void;
  private deaths = 0;

  constructor(
    label: string,
    platform: OsUnitPlatform,
    exec: OsExec,
    threshold: number,
    durationMs: number,
    log: (m: string) => void,
  ) {
    this.label = label;
    this.platform = platform;
    this.exec = exec;
    this.threshold = threshold;
    this.durationMs = durationMs;
    this.log = log;
  }

  /** Monitor for `durationMs`. Returns 'loop' if threshold exceeded, 'ok' otherwise. */
  async monitor(): Promise<'loop' | 'ok'> {
    const pollInterval = 500;
    const polls = Math.floor(this.durationMs / pollInterval);
    for (let i = 0; i < polls; i++) {
      await new Promise((r) => setTimeout(r, pollInterval));
      const live = this.platform.isLoaded(this.label, this.exec);
      if (!live) {
        this.deaths++;
        this.log(`restart-guard ${this.label}: down (${this.deaths}/${this.threshold})`);
        if (this.deaths >= this.threshold) return 'loop';
      }
    }
    return 'ok';
  }
}

// ─── [inv:unload-then-reap] (§8.4/§8.5) ──────────────────────────────────────────

export interface UnloadThenReapResult {
  label: string;
  /** Whether the OS unit was loaded and is now unloaded. */
  unloaded: boolean;
  /** The verified-stop reap result for survivors matching the entrypoint token. */
  reap: ReapResult;
  /** True if any survivor could not be confirmed dead (KillOutcome 'undead'). */
  undead: boolean;
}

/**
 * The canonical OS-supervised teardown order ([inv:unload-then-reap], §8.4/§8.5):
 *
 *   1. UNLOAD the OS unit FIRST (launchctl bootout / systemctl disable --now), so
 *      the supervisor will NOT immediately respawn a killed pid (resurrection loop).
 *   2. THEN verified-stop any survivor by the entrypoint IDENTITY TOKEN
 *      (reapByIdentity → killAndVerify). A clean unload may already have stopped
 *      the process; this catches a survivor that ignored the unload.
 *
 * Killing BEFORE unloading is the F3 bug; this helper makes the ordering explicit
 * and testable. `reapFn` is injectable so the ordering can be asserted in a unit
 * test without touching the real process table.
 */
export async function unloadThenReap(opts: {
  label: string;
  entrypoint: string;
  platform: OsUnitPlatform;
  unitDir?: string;
  exec?: OsExec;
  excludePids?: number[];
  graceMs?: number;
  log?: (m: string) => void;
  /** Injectable reap (default reapByIdentity) — tests assert unload-before-reap ordering. */
  reapFn?: (
    token: string,
    o: { excludePids?: number[]; graceMs?: number; log?: (m: string) => void },
  ) => Promise<ReapResult>;
}): Promise<UnloadThenReapResult> {
  const log = opts.log ?? (() => { /* no-op */ });
  const exec = opts.exec ?? realOsExec;
  const unitDir = opts.unitDir ?? opts.platform.defaultUnitDir();
  const unitPath = path.join(unitDir, opts.platform.unitFileName(opts.label));

  // STEP 1 — unload the OS unit BEFORE any kill.
  let unloaded = false;
  if (opts.platform.isLoaded(opts.label, exec)) {
    const r = opts.platform.unload(unitPath, opts.label, exec);
    unloaded = r.code === 0;
    log(`[unload-then-reap] ${opts.label}: unit ${unloaded ? 'unloaded' : `unload FAILED (code ${r.code})`}`);
  } else {
    log(`[unload-then-reap] ${opts.label}: unit not loaded`);
  }

  // STEP 2 — verified-stop the survivor by identity token (AFTER the unload).
  const token = identityToken(opts.entrypoint);
  const reapFn = opts.reapFn ?? reapByIdentity;
  const reap = await reapFn(token, {
    ...(opts.excludePids !== undefined ? { excludePids: opts.excludePids } : {}),
    ...(opts.graceMs !== undefined ? { graceMs: opts.graceMs } : {}),
    log: (m) => log(`[unload-then-reap] reap ${opts.label}: ${m}`),
  });
  const undead = reap.killed.some((k: { outcome: KillOutcome }) => k.outcome === 'undead');
  return { label: opts.label, unloaded, reap, undead };
}
