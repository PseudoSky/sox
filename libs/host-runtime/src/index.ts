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

// ─── Shutdown grace-margin discipline (BL-592, §8.1a) ─────────────────────────
export {
  SOX_SHUTDOWN_SAFETY_MARGIN_MS,
  resolveShutdownSafetyNetMs,
  resolveStopTimeoutMsFromEnv,
} from './shutdown.js';

// ─── Env scrub policy (BL-344 — the ONE definition; formerly five copies) ─────
export {
  scrubEnv,
  scrubEnvReported,
  isDeniedEnvKey,
  formatDeniedEnvWarning,
  ENV_BASE_ALLOW,
  ENV_ALLOW_PREFIXES,
  ENV_DENY_PREFIXES,
} from './env-policy.js';
export type { ScrubbedEnv } from './env-policy.js';

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
  // BL-201: proxy-backend spawn-lock debris sweep
  LOCK_DEBRIS_TTL_MS,
  realPidAlive,
  realLockSweepFs,
  sweepProxyBackendLocks,
  // BL-176: fast-path GC + split-brain heal for `list`/`status` (phases 0/3)
  quickReconcile,
} from './reconcile.js';
export type {
  LsofExec,
  LsofResult,
  ReconcileMatch,
  ReconcileSkipReason,
  ReconcilePlan,
  // BL-201
  LockSweepFs,
  LockSweepEntry,
  LockSweepResult,
  PidAliveCheck,
  // BL-176
  QuickReconcileHealedEntry,
  QuickReconcileResult,
} from './reconcile.js';

// ─── OS-supervisor control surface (service-lifecycle spec Slice 2) ──────────
export {
  detectOsSupervisor,
  osUnitLabel,
  osUnitLabelFor,
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
  // BL-375: [inv:env-preserved-on-regenerate] guard internals, exported for
  // external test/tooling consistency with every other os-unit.ts symbol.
  extractUnitEnv,
  droppedShellEnvKeys,
  disableOsUnit,
  restartOsUnit,
  unloadThenReap,
  // BL-372/§9.4a: `[inv:deploy-verified]` — kickstart + verify pid rotation.
  restartAndVerify,
  // BL-593/§9.4b: `soxe service update` — enable + verified rotation check.
  updateOsUnit,
  // BUG-023: reload-then-verify a unit unloaded out from under a caller.
  reloadAndVerifyOsUnit,
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
  RestartMatch,
  RestartAndVerifyOptions,
  RestartAndVerifyResult,
  UpdateOsUnitOptions,
  UpdateOsUnitResult,
  ReloadAndVerifyOsUnitOptions,
  ReloadAndVerifyOsUnitResult,
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
