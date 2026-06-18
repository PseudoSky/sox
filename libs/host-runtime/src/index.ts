/**
 * libs/host-runtime/src/index.ts
 *
 * Re-homes the host loader/supervisor/registrar/event-bus from the pre-nx runtime
 * into a pure nx lib. No @nx/devkit imports.
 *
 * [def:session-fixes] carried forward:
 *   - fireIsolated on the event bus (DEFECT-1 fix)
 *   - enable-reactivation (supervisor restart logic)
 *   - stop-via-supervisor (SIGTERM path in stop)
 */

// ─── Hook loader ──────────────────────────────────────────────────────────────
export type { HookContext, HookManifest, HookHandler, RegisteredHook } from './hook-loader.js';
export { compareHooks, HookLoader } from './hook-loader.js';

// ─── Event bus ────────────────────────────────────────────────────────────────
export {
  LIFECYCLE_EVENTS,
  isLifecycleEvent,
  HostEventBus,
  createEventBus,
} from './event-bus.js';
export type {
  LifecycleEvent,
  BusHandlerResult,
  BusEmitResult,
  LifecycleHandler,
} from './event-bus.js';

// ─── Supervisor ───────────────────────────────────────────────────────────────
export { expandTilde, ProcessSupervisor } from './supervisor.js';
export type {
  LifecycleHealth,
  LifecycleBlock,
  PermissionsBlock,
  SupervisorOptions,
  SupervisedProcess,
} from './supervisor.js';

// ─── Policy ───────────────────────────────────────────────────────────────────
export { compilePolicy, compilePolicyFromEnv } from './policy.js';
export type { Policy } from './policy.js';

// ─── Audit log (inproc-policy SOFT enforcement) ───────────────────────────────
export { auditAccess, getAuditLog, clearAuditLog, makeInprocHandle } from './audit-log.js';
export type { AuditEntry, AuditDecision, ExtensionType, AccessDomain, InprocPolicyHandle } from './audit-log.js';

// ─── Loader ───────────────────────────────────────────────────────────────────
export { loadFromLockfile, resolveExtensionDir } from './loader.js';
export type {
  ActivatedHandle,
  LoaderResult,
  LoaderOptions,
} from './loader.js';

// ─── Registrar ────────────────────────────────────────────────────────────────
export { McpClient, McpRegistrar } from './registrar.js';
export type {
  McpToolDescriptor,
  McpServerInfo,
  McpRegistration,
  McpCallResult,
} from './registrar.js';

// ─── Runtime ──────────────────────────────────────────────────────────────────
export {
  startRuntime,
  stopRuntime,
  stopExtension,
  reconcileRuntime,
  getRuntimeRecord,
  getRegistrar,
  runtimeFilePathFromLockfile,
  getRuntimeFilePath,
  getScopePaths,
} from './runtime.js';
export type {
  RuntimeEntry,
  RuntimeRecord,
  StartRuntimeOptions,
  StopRuntimeOptions,
} from './runtime.js';

// ─── Lock (R3) ────────────────────────────────────────────────────────────────
export { acquireStartLock, computeSupervisorId } from './lock.js';

// ─── Log Manager (R4) ─────────────────────────────────────────────────────────
export { LogManager } from './log-manager.js';
export type { LogManagerOptions, RunRecord, RunHistoryFile } from './log-manager.js';

// ─── Adapters ─────────────────────────────────────────────────────────────────
export { activateMcp } from './adapters/mcp.js';
export type { McpAdapterOptions, McpAdapterHandle } from './adapters/mcp.js';

export { activateHook } from './adapters/hook.js';
export type { HookAdapterOptions, HookAdapterHandle } from './adapters/hook.js';

export { activateAgent, activateSkill } from './adapters/agent.js';
export type {
  AgentAdapterOptions,
  AgentAdapterHandle,
  SkillAdapterOptions,
  SkillAdapterHandle,
} from './adapters/agent.js';

export { CommandRegistry, activateCommand } from './adapters/command.js';
export type {
  CommandInput,
  CommandOutput,
  CommandHandler,
  CommandRegistration,
  CommandAdapterOptions,
  CommandAdapterHandle,
} from './adapters/command.js';
