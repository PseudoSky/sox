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
  reapOrphansForExtension,
  reconcileRuntime,
  getRuntimeRecord,
  getRegistrar,
  runtimeFilePathFromLockfile,
  getRuntimeFilePath,
  getScopePaths,
} from './runtime.js';

// ─── ADR-0004: single data-root resolver ──────────────────────────────────────
export {
  DATA_SUBDIR,
  userDataRoot,
  dataRoot,
  scopeConfigPaths,
  ledgerPathFor,
  ownershipPathFor,
  storeRootFor,
  installRegistryPath,
  supervisorsPath,
  runDir,
  logDirFor,
  socketDir,
} from './data-paths.js';
export type { DataScope } from './data-paths.js';

export type {
  RuntimeEntry,
  RuntimeRecord,
  StartRuntimeOptions,
  StopRuntimeOptions,
  ReapExtensionResult,
} from './runtime.js';

// ─── BL-31: verified kill + orphan reaper ─────────────────────────────────────
export {
  pidAlive,
  killAndVerify,
  findOrphansByIdentity,
  findOrphansByServiceId,
  readProcessEnv,
  argvContainsToken,
  snapshotProcesses,
  identityToken,
  storeDirFromSource,
  reapByIdentity,
  reapBySource,
  gatherProcessSnapshot,
} from './reaper.js';
export type {
  KillOutcome,
  KillOptions,
  PsProcess,
  OrphanMatch,
  ReapResult,
  ProcessSnapshotRow,
  ProcessRowSource,
} from './reaper.js';

// ─── Lock (R3) ────────────────────────────────────────────────────────────────
export { acquireStartLock, computeSupervisorId } from './lock.js';

// ─── Cross-scope singleton (service-lifecycle spec Slice 1) ───────────────────
export {
  expandConfigValue,
  canonicalizePath,
  resolveStoreResource,
  singletonKey,
  manifestDeclaresSingleton,
  processStartTime,
  chooseSurvivor,
  healSingletonDuplicates,
  findCrossScopeSharers,
  entrypointTokenForStore,
} from './singleton.js';
export type {
  StoreResource,
  StoreResourceKind,
  SurvivorChoice,
  HealResult,
  ScopeResource,
} from './singleton.js';

// ─── Crash-loop cap (service-lifecycle spec Slice 3, [inv:crash-loop-cap]) ────
export {
  CRASH_LOOP_MAX_FAILURES,
  CRASH_LOOP_WINDOW_MS,
  CrashLoopGuard,
  crashLoopMarkerDir,
  crashLoopMarkerPath,
  readCrashLoopMarker,
  listCrashLoopMarkers,
  clearCrashLoopMarker,
} from './crash-loop.js';
export type {
  CrashLoopGuardOptions,
  CrashLoopState,
  CrashLoopMarker,
} from './crash-loop.js';

// ─── Doctor reconcile classification (service-lifecycle spec Slice 4) ─────────
export {
  realLsofExec,
  socketOwnerPids,
  classifyReconcileTargets,
} from './reconcile.js';
export type {
  LsofExec,
  LsofResult,
  ReconcileMatch,
  ReconcileSkipReason,
  ReconcilePlan,
} from './reconcile.js';

// ─── OS-supervisor control surface (service-lifecycle spec Slice 2) ──────────
export {
  detectOsSupervisor,
  osUnitLabel,
  deriveOsUnitSpec,
  findNonVolatileNode,
  resolveUnitNodePath,
  unitContentHash,
  readUnitMeta,
  realOsExec,
  LaunchdPlatform,
  SystemdPlatform,
  getOsUnitPlatform,
  enableOsUnit,
  disableOsUnit,
  restartOsUnit,
  unloadThenReap,
  // BL-185: interval-schedule detection for SCHEDULED status rendering.
  isScheduledOsUnitContent,
  isScheduledOsUnit,
} from './os-unit.js';
export type {
  OsSupervisor,
  OsUnitSpec,
  NodePathResolution,
  OsExecResult,
  OsExec,
  OsUnitPlatform,
  EnableAction,
  EnableResult,
  EnableOptions,
  DisableOptions,
  DisableResult,
  RestartOptions,
  RestartResult,
  UnloadThenReapResult,
} from './os-unit.js';

// ─── Global Supervisor Registry (R1) ─────────────────────────────────────────
export {
  getSupervisorsFilePath,
  readSupervisorsFile,
  writeSupervisorsFile,
  registerSupervisor,
  deregisterSupervisor,
  listRegisteredSupervisors,
} from './registry.js';
export type { SupervisorRegistryEntry, SupervisorsFile } from './registry.js';

// ─── Log Manager (R4) ─────────────────────────────────────────────────────────
export { LogManager, findAllLogStreamsForExt, findMostRecentLogFile } from './log-manager.js';
export type { LogManagerOptions, RunRecord, RunHistoryFile, LogStreamDescriptor } from './log-manager.js';

// ─── Stale state GC (R2) ──────────────────────────────────────────────────────
export { probeSocket, probeEntryLiveness, readGlobalRegistry } from './gc.js';

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
