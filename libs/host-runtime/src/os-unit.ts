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
  findOrphansByIdentity,
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

/**
 * launchd `ProcessType` (launchd.plist(5)). Governs CPU QoS, core affinity and
 * I/O throttling — NOT just niceness.
 *
 * - `Background`  — "work that was not directly requested by the user"; the
 *   heaviest throttle. On Apple Silicon this pins the job to efficiency cores.
 * - `Standard`    — "equivalent to no ProcessType being set"; the neutral default.
 * - `Adaptive`    — moves between Background and Interactive **based on activity
 *   over XPC connections**.
 * - `Interactive` — no resource limits, as an app; the man page says to use it
 *   only when responsiveness depends on it and the job "cannot be made Adaptive".
 */
export type OsUnitProcessType = 'Interactive' | 'Adaptive' | 'Standard' | 'Background';

const OS_UNIT_PROCESS_TYPES: readonly OsUnitProcessType[] = [
  'Interactive',
  'Adaptive',
  'Standard',
  'Background',
];

/**
 * BL-331: resolve the scheduling class for a unit.
 *
 * This was hardcoded to `Background` for EVERY unit. Measured consequence on the
 * live memory-server: scheduling priority 4 instead of 31, and an interleaved A/B
 * (`taskpolicy -b`, which reproduces the same pri 4) put real ONNX embedding at
 * ~470 ms unthrottled vs ~8400 ms throttled — an **18x** penalty on a service
 * whose entire job is answering interactive agent requests. Model load was hit
 * too (~686 ms vs ~8-12 s), confirming it is a general CPU throttle rather than
 * anything embed-specific.
 *
 * Default choice, deliberately:
 *
 * - A **periodic tick** unit (`startIntervalSec`) gets `Background`. It is
 *   literally launchd.plist(5)'s "work that was not directly requested by the
 *   user", and throttling it is the point.
 * - Everything else gets **`Standard`** — "equivalent to no ProcessType being
 *   set", i.e. the neutral scheduling class with no background penalty.
 *
 * Explicitly NOT `Adaptive`, despite it looking like the obvious middle ground:
 * launchd.plist(5) says Adaptive promotes a job out of Background **based on
 * activity over XPC connections**. sox services talk UDS and TCP and never open
 * an XPC connection, so there is no promotion signal — an Adaptive sox unit would
 * sit in the Background class and reintroduce this exact defect, silently.
 *
 * Explicitly NOT `Interactive` by default either: the man page reserves it for
 * jobs whose responsiveness genuinely cannot be expressed otherwise, and it lifts
 * resource limits entirely. A manifest may still opt into it via
 * `lifecycle.process_type` when a service earns it.
 */
export function resolveProcessType(spec: {
  processType?: OsUnitProcessType | undefined;
  startIntervalSec?: number | undefined;
}): OsUnitProcessType {
  if (spec.processType !== undefined) return spec.processType;
  return spec.startIntervalSec !== undefined && spec.startIntervalSec > 0
    ? 'Background'
    : 'Standard';
}

/** Narrow an untrusted manifest value; unknown strings are ignored, never emitted. */
function coerceProcessType(raw: unknown): OsUnitProcessType | undefined {
  return typeof raw === 'string' && (OS_UNIT_PROCESS_TYPES as readonly string[]).includes(raw)
    ? (raw as OsUnitProcessType)
    : undefined;
}

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
  /**
   * BL-156: full argument vector AFTER `nodePath`, when the unit must launch
   * something other than the bare entrypoint. Used for a `serve_mode: proxy`
   * mcp-server, where the OS unit runs the port-listening front-shim
   * (`<cli> serve <id> --port <port>`) which auto-ensures the singleton UDS
   * backend — the backend, not the shim, runs `entrypoint`, so the reaper's
   * identity token stays `entrypoint`. When absent, the unit runs
   * `[...nodeArgs, entrypoint]` (the direct-service default).
   */
  execArgs?: string[] | undefined;
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
  /**
   * Slice 4 (scheduled reconcile tick): run the unit PERIODICALLY every N seconds.
   * launchd: `StartInterval` on the same unit. systemd: rendered as a paired
   * `.timer` unit via `renderTimerUnit` (the seam mirror of `renderSocketUnit`).
   * Absent for ordinary long-lived services (no periodic relaunch).
   */
  startIntervalSec?: number | undefined;
  /**
   * BL-331: scheduling class for the unit. Declared by the manifest as
   * `lifecycle.process_type`; when absent, `resolveProcessType()` derives it
   * from the unit kind (tick ⇒ Background, everything else ⇒ Standard).
   * Never hardcode this — see `resolveProcessType` for why the old
   * unconditional `Background` cost an 18x throttle on the live service.
   */
  processType?: OsUnitProcessType | undefined;
  /** Durable stdout log path (ADR-0004 run/logs/). */
  stdoutPath: string;
  /** Durable stderr log path (ADR-0004 run/logs/). */
  stderrPath: string;
  /** Content address of the served artifact (ADR-0003), when known. */
  artifactHash?: string | undefined;
  /**
   * SA-2 / CONTRACTS §I: Socket path for on-demand (socket-activation) posture.
   * When set, the generated OS unit includes a Sockets key (launchd) or a paired
   * .socket unit (systemd) so the OS supervisor creates the listening socket and
   * passes the fd to the service on-demand.
   * Absent for always-on posture (no socket activation).
   */
  socketPath?: string | undefined;
}


/**
 * The reverse-DNS-style label for a (scope, id) unit.
 *
 * BL-263: when the data root is overridden (`SOX_ECOSYSTEM_HOME` — sandboxes,
 * probes, e2e), the label is namespaced with a hash of that root. The launchd
 * domain is GLOBAL — a sandbox redirects unit FILES but not the registration
 * namespace — so a sandboxed `service enable` using the production label
 * squats it in the real domain: launchd KeepAlive-respawned one such leaked
 * probe unit 4141 times and blocked every legitimate enable/unload of
 * `com.sox.user.memory-server` (the BL-203 ownership guard rightly refused to
 * touch it). Distinct data roots are distinct service universes; their labels
 * must never collide with production's.
 */
export function osUnitLabel(scope: string, id: string): string {
  return osUnitLabelFor(scope, id, process.env['SOX_ECOSYSTEM_HOME']);
}

/** Pure form of {@link osUnitLabel}: pass the data-root override explicitly. */
export function osUnitLabelFor(scope: string, id: string, dataRootOverride: string | undefined): string {
  const base = `com.sox.${scope}.${id}`;
  if (dataRootOverride === undefined || dataRootOverride === '') return base;
  const tag = createHash('sha256').update(dataRootOverride).digest('hex').slice(0, 8);
  return `${base}.sbx-${tag}`;
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
  /** BL-156: override the args after nodePath (see OsUnitSpec.execArgs). */
  execArgs?: string[] | undefined;
  env: Record<string, string>;
  workingDirectory: string;
  logDir: string;
  artifactHash?: string | undefined;
  /** Override the YYYY-MM-DD log date (tests). Default: today. */
  logDate?: string;
  /**
   * SA-1 / CONTRACTS §I: activation posture for the OS unit.
   * 'always-on' → RunAtLoad + KeepAlive (launchd manages respawns).
   * 'on-demand' → socket-activation (launchd starts on first connection).
   * When omitted: falls back to the manifest lifecycle block (existing behaviour).
   */
  activation_posture?: 'always-on' | 'on-demand' | undefined;
  /**
   * SA-2: Socket path for on-demand socket activation.
   * Only used when activation_posture === 'on-demand'.
   * The OS supervisor creates a listening socket at this path and passes the
   * file descriptor to the service on first connection.
   */
  socketPath?: string | undefined;
  /** Slice 4: periodic-relaunch interval in seconds (see OsUnitSpec.startIntervalSec). */
  startIntervalSec?: number | undefined;
  /**
   * BL-331: explicit scheduling class, overriding both the manifest's
   * `lifecycle.process_type` and the kind-derived default.
   */
  processType?: OsUnitProcessType | undefined;
}): OsUnitSpec {
  const label = osUnitLabel(opts.scope, opts.id);
  const logDate = opts.logDate ?? new Date().toISOString().slice(0, 10);

  // BL-331: the manifest may declare a scheduling class. Read it regardless of
  // which activation branch runs below — activation posture and scheduling class
  // are orthogonal, and an `always-on` service must still be able to say it is
  // not background work.
  let manifestLifecycle: {
    background?: boolean;
    singleton?: boolean;
    process_type?: unknown;
  } = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(opts.manifestPath, 'utf8')) as {
      lifecycle?: typeof manifestLifecycle;
    };
    manifestLifecycle = parsed.lifecycle ?? {};
  } catch {
    manifestLifecycle = {};
  }
  const processType =
    opts.processType ?? coerceProcessType(manifestLifecycle.process_type);

  // SA-1: activation_posture takes precedence.
  // When absent, fall back to manifest lifecycle (backward compat).
  let runAtLoad: boolean;
  let keepAlive: boolean;
  if (opts.activation_posture === 'always-on') {
    runAtLoad = true;
    keepAlive = true;
  } else if (opts.activation_posture === 'on-demand') {
    runAtLoad = false;
    keepAlive = false;
  } else {
    runAtLoad = manifestLifecycle.background !== false;
    keepAlive = manifestLifecycle.singleton === true;
  }

  return {
    id: opts.id,
    scope: opts.scope,
    label,
    nodePath: opts.nodePath,
    nodeArgs: opts.nodeArgs ?? ['--enable-source-maps'],
    entrypoint: opts.entrypoint,
    ...(opts.execArgs !== undefined ? { execArgs: opts.execArgs } : {}),
    env: opts.env,
    workingDirectory: opts.workingDirectory,
    runAtLoad,
    keepAlive,
    // launchd throttles respawns to ~10s; §11.3 maps the crash-loop guard to it.
    throttleIntervalSec: 10,
    stdoutPath: path.join(opts.logDir, `${opts.id}-os-${logDate}.out.log`),
    stderrPath: path.join(opts.logDir, `${opts.id}-os-${logDate}.err.log`),
    artifactHash: opts.artifactHash,
    ...(opts.activation_posture === 'on-demand' && opts.socketPath !== undefined
      ? { socketPath: opts.socketPath }
      : {}),
    ...(opts.startIntervalSec !== undefined && opts.startIntervalSec > 0
      ? { startIntervalSec: Math.floor(opts.startIntervalSec) }
      : {}),
    // BL-331: resolve eagerly so the spec carries the decision and the renderers
    // stay dumb. An unknown manifest value coerces to undefined above and falls
    // through to the kind-derived default rather than reaching the plist.
    processType: resolveProcessType({
      processType,
      startIntervalSec: opts.startIntervalSec,
    }),
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
  /**
   * SA-2: Render a socket unit for on-demand socket activation.
   * Returns undefined when the platform embeds socket config in the service unit
   * (launchd) or when no socketPath is set. For systemd, returns the .socket unit
   * content.
   */
  renderSocketUnit?(spec: OsUnitSpec): string | undefined;
  /**
   * Slice 4: Render a timer unit for a periodic (startIntervalSec) unit.
   * Returns undefined when the platform embeds the interval in the service unit
   * (launchd `StartInterval`) or when no startIntervalSec is set. For systemd,
   * returns the paired `.timer` unit content (the seam mirror of renderSocketUnit).
   */
  renderTimerUnit?(spec: OsUnitSpec): string | undefined;
  /** Load (activate) a unit. */
  load(unitPath: string, label: string, exec: OsExec): OsExecResult;
  /** Unload (deactivate) a unit. */
  unload(unitPath: string, label: string, exec: OsExec): OsExecResult;
  /** Query whether a unit is currently loaded. */
  isLoaded(label: string, exec: OsExec): boolean;
  /**
   * BL-372/§9.4a: restart the MANAGED PROCESS in place — kill+respawn it under
   * the supervisor — WITHOUT touching the unit file on disk. This is deliberately
   * NOT `unload()` + `load()`: those two rewrite/re-register the unit (and the
   * `enable` caller derives its spec from the invoking shell's env, see BL-375 —
   * `[inv:env-preserved-on-regenerate]`), so a `restart` that went through
   * enable/disable would silently drop whatever env the unit was ORIGINALLY
   * enabled with. `kickstart` never reads or writes the unit file.
   */
  kickstart(label: string, exec: OsExec): OsExecResult;
  /**
   * BL-372: the managed process's current PID, per the supervisor's own
   * bookkeeping (not a `ps` scan) — used to detect whether a `kickstart` swapped
   * the process for real ([inv:deploy-verified]). `undefined` when not running.
   */
  mainPid(label: string, exec: OsExec): number | undefined;
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
    const progArgs = [spec.nodePath, ...(spec.execArgs ?? [...spec.nodeArgs, spec.entrypoint])];
    const argLines = progArgs.map((a) => `    <string>${xmlEscape(a)}</string>`).join('\n');
    const envKeys = Object.keys(spec.env).sort(); // deterministic ⇒ stable content hash
    const envLines = envKeys
      .map((k) => `    <key>${xmlEscape(k)}</key>\n    <string>${xmlEscape(spec.env[k] ?? '')}</string>`)
      .join('\n');

    const socketLines = spec.socketPath
      ? [
          '  <key>Sockets</key>',
          '  <dict>',
          '    <key>Listener</key>',
          '    <dict>',
          '      <key>SockPathName</key>',
          `      <string>${xmlEscape(spec.socketPath)}</string>`,
          '      <key>SockPathMode</key>',
          '      <integer>0600</integer>',
          '      <key>SockProtocol</key>',
          '      <string>SOCK_STREAM</string>',
          '    </dict>',
          '  </dict>',
        ].join('\n')
      : '';

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
      // Slice 4: periodic relaunch (the doctor reconcile tick). launchd runs the
      // job every StartInterval seconds; KeepAlive stays false for a tick job.
      ...(spec.startIntervalSec !== undefined && spec.startIntervalSec > 0
        ? ['  <key>StartInterval</key>', `  <integer>${spec.startIntervalSec}</integer>`]
        : []),
      ...(socketLines ? ['', socketLines] : []),
      '  <key>StandardOutPath</key>',
      `  <string>${xmlEscape(spec.stdoutPath)}</string>`,
      '  <key>StandardErrorPath</key>',
      `  <string>${xmlEscape(spec.stderrPath)}</string>`,
      // BL-331: NOT hardcoded. `Background` throttles CPU, core affinity and I/O
      // (launchd.plist(5)); on Apple Silicon it pins the job to efficiency cores,
      // which cost the live memory-server an 18x embed slowdown. See
      // `resolveProcessType` for the default policy and why `Adaptive` is wrong here.
      '  <key>ProcessType</key>',
      `  <string>${resolveProcessType(spec)}</string>`,
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

  /** SA-2: launchd embeds sockets in the plist; no separate socket unit. */
  renderSocketUnit(_spec: OsUnitSpec): string | undefined {
    return undefined;
  }

  /** Slice 4: launchd embeds the interval (StartInterval) in the plist; no timer unit. */
  renderTimerUnit(_spec: OsUnitSpec): string | undefined {
    return undefined;
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
    // BL-203 ownership guard — MUST run before ANY bootout form. The launchd
    // namespace is GLOBAL, but our unit FILES may live in a sandboxed/scratch
    // dir (tests, alternate roots). BOTH bootout forms evict by label — the
    // "by path" form merely reads the label out of the plist at that path —
    // so an unload against a scratch copy of a real label evicts the REAL
    // registration. This is exactly how every `nx test sox` run silently
    // booted the live doctor-tick (its `--remove-tick` test uses the real
    // label with a sandbox unit path).
    const print = exec('launchctl', ['print', `${this.domain()}/${label}`]);
    if (print.code !== 0) {
      // Label not loaded at all — desired state already holds.
      return { code: 0, stdout: `[os-unit] ${label} not loaded — nothing to unload`, stderr: '' };
    }
    const pathLine = print.stdout.match(/^\s*path\s*=\s*(.+)$/m);
    const loadedPath = pathLine?.[1]?.trim();
    if (loadedPath !== undefined && loadedPath !== '' && loadedPath !== unitPath) {
      // Loaded from a foreign unit file — not ours to unload.
      return {
        code: 1,
        stdout: '',
        stderr: `[os-unit] refusing bootout of ${label}: loaded from ${loadedPath}, not ${unitPath} (BL-203 ownership guard)`,
      };
    }
    // Ours (or path unresolvable from print output — conservative: proceed so
    // real disables keep working if launchctl's print format ever shifts).
    const byPath = exec('launchctl', ['bootout', this.domain(), unitPath]);
    if (byPath.code === 0) return byPath;
    return exec('launchctl', ['bootout', `${this.domain()}/${label}`]);
  }

  isLoaded(label: string, exec: OsExec): boolean {
    const r = exec('launchctl', ['print', `${this.domain()}/${label}`]);
    return r.code === 0;
  }

  /**
   * BL-372: `launchctl kickstart -k` restarts the job's PROCESS in place
   * (SIGTERM the current instance, respawn per `RunAtLoad`/`KeepAlive`) without
   * unregistering or rewriting the plist — the unit file on disk is untouched.
   * `-k` forces the kill even if the job is not currently running/idle.
   */
  kickstart(label: string, exec: OsExec): OsExecResult {
    return exec('launchctl', ['kickstart', '-k', `${this.domain()}/${label}`]);
  }

  /** Parse `pid = NNNN` out of `launchctl print` — the supervisor's own bookkeeping. */
  mainPid(label: string, exec: OsExec): number | undefined {
    const r = exec('launchctl', ['print', `${this.domain()}/${label}`]);
    if (r.code !== 0) return undefined;
    const m = /^\s*pid\s*=\s*(\d+)\s*$/m.exec(r.stdout);
    return m?.[1] ? Number(m[1]) : undefined;
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
    const execLine = [spec.nodePath, ...(spec.execArgs ?? [...spec.nodeArgs, spec.entrypoint])]
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
      // BL-331 parity: systemd has no ProcessType, so only the de-prioritised
      // class is expressed, as `Nice`. Standard/Adaptive/Interactive emit
      // nothing — systemd's default is already the unthrottled class, and
      // emitting `Nice=0` would churn the content hash of every existing unit
      // for no behavioural change.
      ...(resolveProcessType(spec) === 'Background' ? ['Nice=10'] : []),
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

  /**
   * BL-372: `systemctl restart` kills+respawns the unit's process in place from
   * the unit file ALREADY on disk (no `daemon-reload`, no rewrite) — the systemd
   * mirror of launchd `kickstart -k`.
   */
  kickstart(label: string, exec: OsExec): OsExecResult {
    const unit = this.unitFileName(label);
    return exec('systemctl', ['--user', 'restart', unit]);
  }

  /** The unit's current MainPID per systemd's own bookkeeping. */
  mainPid(label: string, exec: OsExec): number | undefined {
    const unit = this.unitFileName(label);
    const r = exec('systemctl', ['--user', 'show', unit, '-p', 'MainPID', '--value']);
    if (r.code !== 0) return undefined;
    const n = Number(r.stdout.trim());
    return Number.isFinite(n) && n > 0 ? n : undefined;
  }

  isLoaded(label: string, exec: OsExec): boolean {
    const unit = this.unitFileName(label);
    const r = exec('systemctl', ['--user', 'is-active', unit]);
    return r.code === 0 && r.stdout.trim() === 'active';
  }

  /**
   * SA-2: Render a .socket unit for on-demand socket activation.
   * Returns undefined when no socketPath is set. The .socket unit instructs
   * systemd to create a listening socket at socketPath and pass the fd to
   * the service on first connection.
   */
  renderSocketUnit(spec: OsUnitSpec): string | undefined {
    if (!spec.socketPath) return undefined;

    const unitName = this.unitFileName(spec.label); // e.g. sox-user-tokenguard.service
    // Compute content hash from body only (no meta marker).
    const body = [
      '[Unit]',
      `Description=Socket for soxe service ${spec.id} (${spec.scope})`,
      '',
      '[Socket]',
      `ListenStream=${spec.socketPath}`,
      'SocketMode=0600',
      `Service=${unitName}`,
      '',
      '[Install]',
      'WantedBy=sockets.target',
      '',
    ].join('\n');
    const hash = unitContentHash(body);
    return [
      `# ${UNIT_META_MARKER} content-hash:${hash} artifact-hash:none generated-by:soxe-service-enable`,
      body,
    ].join('\n');
  }

  /**
   * Slice 4: Render a `.timer` unit for a periodic (startIntervalSec) job.
   * Returns undefined when no startIntervalSec is set. systemd separates the
   * schedule (`.timer`, WantedBy=timers.target) from the job (`.service`) —
   * the exact seam-mirror of renderSocketUnit. Content-addressed like every
   * generated unit ([inv:os-unit-content-addressed]).
   */
  renderTimerUnit(spec: OsUnitSpec): string | undefined {
    if (spec.startIntervalSec === undefined || spec.startIntervalSec <= 0) return undefined;
    const unitName = this.unitFileName(spec.label); // sox-<scope>-<id>.service
    const body = [
      '[Unit]',
      `Description=Timer for soxe service ${spec.id} (${spec.scope})`,
      '',
      '[Timer]',
      `OnBootSec=${spec.startIntervalSec}`,
      `OnUnitActiveSec=${spec.startIntervalSec}`,
      `Unit=${unitName}`,
      '',
      '[Install]',
      'WantedBy=timers.target',
      '',
    ].join('\n');
    const hash = unitContentHash(body);
    return [
      `# ${UNIT_META_MARKER} content-hash:${hash} artifact-hash:none generated-by:soxe-service-enable`,
      body,
    ].join('\n');
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

// ─── BL-372/§9.4a: `[inv:deploy-verified]` — kickstart + verify pid rotation ─────

/** A single matched process (the shape both `findOrphansByIdentity` and test fakes share). */
export interface RestartMatch {
  pid: number;
}

export interface RestartAndVerifyOptions {
  label: string;
  /** Identity token (the entrypoint path) to match survivors/respawns against. */
  token: string;
  platform: OsUnitPlatform;
  exec?: OsExec;
  /** How long to wait for a rotated pid to appear (ms). Default 15000. */
  waitMs?: number;
  /** Poll interval while waiting (ms). Default 300. */
  pollMs?: number;
  excludePids?: number[];
  /** Injectable: find live pids matching `token`. Defaults to `findOrphansByIdentity`. */
  findMatches?: (token: string, opts: { excludePids?: number[] }) => RestartMatch[];
  /** Injectable: reap survivors matching `token`. Defaults to `reapByIdentity`. */
  reapFn?: (
    token: string,
    o: { excludePids?: number[]; log?: (m: string) => void },
  ) => Promise<ReapResult>;
  /** Injectable clock sleep — tests pass a synchronous fake to run instantly. */
  sleepFn?: (ms: number) => Promise<void>;
  log?: (m: string) => void;
}

export interface RestartAndVerifyResult {
  label: string;
  token: string;
  kickstart: OsExecResult;
  before: number[];
  after: number[];
  reap: ReapResult;
  /** Pids that could not be confirmed dead (KillOutcome 'undead'). */
  undead: number[];
  /** True iff a pid NOT present in `before` appeared for `token` before the deadline. */
  rotated: boolean;
  /** True only when kickstart succeeded, no undead survivors, AND a pid rotated. */
  ok: boolean;
  /** Set when `ok` is false — why the deploy could not be verified. */
  reason?: string;
}

/**
 * BL-372 / `docs/spec/service-lifecycle.md` §9.4a `[inv:deploy-verified]`.
 *
 * A `kickstart` that exits 0 and a unit that reports `loaded: yes` are NOT
 * evidence a deploy happened — the front-shim service-proxy (§9.5) deliberately
 * keeps its backend alive across proxy restarts for zero-downtime, so `kickstart`
 * alone restarts the proxy while the backend survives as a `PPID 1` orphan still
 * executing the OLD bundle (observed twice, 2026-07-31).
 *
 * This function is the verified deploy: snapshot pids matching `token` → kickstart
 * (never touches the unit file — no env regeneration, BL-375) → reap any survivor
 * by identity (forces a zero-downtime backend to die so the already-kickstarted
 * proxy's live connection notices the disconnect and respawns on the new bundle) →
 * poll until a pid NOT in the pre-restart snapshot appears. `ok:false` (never a
 * thrown exception, never a bare "succeeded") is the honest outcome when nothing
 * rotates — the caller maps that to a non-zero exit code
 * (`apps/sox/src/main.ts` `cmdServiceRestart`).
 *
 * All I/O is injectable (`exec`, `findMatches`, `reapFn`, `sleepFn`) so both the
 * "survivor never rotates" (RED) and "pid rotates" (GREEN) arms are unit-testable
 * without touching the real process table or launchd/systemd.
 */
export async function restartAndVerify(opts: RestartAndVerifyOptions): Promise<RestartAndVerifyResult> {
  const exec = opts.exec ?? realOsExec;
  const findMatches = opts.findMatches ?? ((tok, o) => findOrphansByIdentity(tok, o));
  const reapFn = opts.reapFn ?? reapByIdentity;
  const sleepFn = opts.sleepFn ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const log = opts.log ?? (() => { /* no-op */ });
  const waitMs = opts.waitMs ?? 15000;
  const pollMs = opts.pollMs ?? 300;
  const excludeOpt = opts.excludePids !== undefined ? { excludePids: opts.excludePids } : {};

  const before = findMatches(opts.token, excludeOpt).map((m) => m.pid);
  log(`before: matching-pids=[${before.join(', ')}]`);

  const kickstart = opts.platform.kickstart(opts.label, exec);
  log(`kickstart: exit ${kickstart.code}`);
  if (kickstart.code !== 0) {
    return {
      label: opts.label, token: opts.token, kickstart, before, after: before,
      reap: { token: opts.token, killed: [] }, undead: [], rotated: false, ok: false,
      reason: `kickstart FAILED (code ${kickstart.code})`,
    };
  }

  const reap = await reapFn(opts.token, { ...excludeOpt, log: (m: string) => log(`reaper: ${m}`) });
  const undead = reap.killed.filter((k) => k.outcome === 'undead').map((k) => k.pid);
  if (undead.length > 0) {
    const after = findMatches(opts.token, excludeOpt).map((m) => m.pid);
    return {
      label: opts.label, token: opts.token, kickstart, before, after, reap, undead,
      rotated: false, ok: false,
      reason: `survivor(s) could not be confirmed dead (undead): [${undead.join(', ')}]`,
    };
  }

  // Poll until a pid NOT in the pre-restart snapshot appears for `token` — proof
  // the running process actually rotated, not merely that the unit is "loaded".
  const beforeSet = new Set(before);
  const deadline = Date.now() + waitMs;
  let after: number[] = [];
  let rotated = false;
  do {
    after = findMatches(opts.token, excludeOpt).map((m) => m.pid);
    if (after.some((p) => !beforeSet.has(p))) {
      rotated = true;
      break;
    }
    if (Date.now() >= deadline) break;
    await sleepFn(pollMs);
  } while (Date.now() < deadline);

  return {
    label: opts.label, token: opts.token, kickstart, before, after, reap, undead,
    rotated, ok: rotated,
    ...(rotated ? {} : {
      reason: `[inv:deploy-verified] violated: no pid rotated within ${waitMs}ms `
        + `(before=[${before.join(', ')}] after=[${after.join(', ')}])`,
    }),
  };
}

// ─── BL-185: Interval-schedule detection ─────────────────────────────────────

/**
 * Detect whether a rendered OS unit file (plist or systemd service/timer)
 * carries an interval schedule. Used by `soxe status` to render a loaded but
 * not-currently-running periodic unit as SCHEDULED rather than DEAD.
 *
 * Rules:
 *   launchd plist — contains `<key>StartInterval</key>` or
 *                   `<key>StartCalendarInterval</key>`.
 *   systemd timer  — the paired `.timer` file contains `OnUnitActiveSec=` or
 *                   `OnCalendar=`; the presence of the timer file alone is
 *                   sufficient signal (the .service file is unremarkable).
 *
 * Pure function (no file I/O): the caller reads the file and passes the
 * content string. Returns false on empty / null input (additive, never throws).
 */
export function isScheduledOsUnitContent(unitFileContent: string): boolean {
  if (!unitFileContent) return false;
  // launchd plist keys (StartInterval is the Slice 4 / SOX-generated key;
  // StartCalendarInterval is launchd's cron-style alternative — keep the
  // seam ready even though SOX does not currently emit it).
  if (unitFileContent.includes('<key>StartInterval</key>')) return true;
  if (unitFileContent.includes('<key>StartCalendarInterval</key>')) return true;
  // systemd timer directives (the .timer file, not the .service file).
  if (unitFileContent.includes('OnUnitActiveSec=')) return true;
  if (unitFileContent.includes('OnCalendar=')) return true;
  return false;
}

/**
 * Probe whether an installed unit file at `unitPath` carries an interval
 * schedule. For systemd, also checks for the paired `.timer` file (replacing
 * `.service` with `.timer` in the path).
 *
 * Returns false if the file is absent, unreadable, or carries no schedule.
 * Never throws — all errors are silenced (best-effort, additive).
 */
export function isScheduledOsUnit(unitPath: string): boolean {
  try {
    if (!fs.existsSync(unitPath)) return false;
    const content = fs.readFileSync(unitPath, 'utf8');
    if (isScheduledOsUnitContent(content)) return true;
    // Systemd seam: check the paired .timer file.
    const timerPath = unitPath.replace(/\.service$/, '.timer');
    if (timerPath !== unitPath && fs.existsSync(timerPath)) {
      const timerContent = fs.readFileSync(timerPath, 'utf8');
      if (isScheduledOsUnitContent(timerContent)) return true;
    }
  } catch { /* best-effort */ }
  return false;
}
