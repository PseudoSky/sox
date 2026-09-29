# @adhd/sox-host-runtime

## 0.6.2

### Patch Changes

- fdd0566: Backend Unix sockets are only bound or dialed inside a verified-private directory
  (BL-4041c6e0). The tier-3 socket path for an over-long socket directory is now
  `/tmp/sox-<uid>/p-<16hex>.sock` — fixed and TMPDIR-independent, so every peer
  derives the same path — instead of `$TMPDIR/sox-uds/…` or `/tmp/s-<hex>.sock`.
  `serveBackend` creates the directory 0700 and refuses (`E_UDS_DIR_UNSAFE`, no
  bind) when it is a symlink, not a directory, owned by another uid, group/other
  writable, or — for the `/tmp/sox-<uid>` root — not exactly 0700. `dialBackend`,
  `probeSocketLive`, `handshakeBackend` and `ensureBackend` refuse to connect into
  such a directory; the refusal is non-retryable (no re-dial, `ensureBackend`
  returns `errorCode: 'E_UDS_DIR_UNSAFE'`, the embedding funnel raises a
  `PermanentEmbeddingError`). New exports: `udsFallbackRoot`,
  `ensurePrivateSocketDir`, `assertPrivateSocketDir`, `isUdsDirUnsafeError`.

  Data-root directories are now created 0700 (`mkdirDataDir`), so they are private
  even under umask 002. `soxe` and the embedding funnel repair their own run dirs
  at start with the new `tightenOwnedSocketDir`: it removes group/other write
  through a single O_NOFOLLOW descriptor and skips anything it cannot prove is
  yours. An `E_UDS_DIR_UNSAFE` refusal now carries a `reason` (`foreign`,
  `own-writable`, `fallback-mode`) with a matching remediation, and no message
  suggests a recursive delete (BL-6233c1c2).

## 0.6.1

### Patch Changes

- a742f23: A user-scope OS unit no longer bakes a git checkout's `soxe` into its argv. The
  front-shim (`soxe serve <id> --port <port>`) and doctor-tick units used
  `realpath(process.argv[1])` — the CLI that ran `service enable` — so prod's
  launchd unit ran the dev checkout's `bin/soxe` and every branch switch or build
  there changed production. New `resolveUnitCliPath` (host-runtime) resolves an
  explicit `--cli-path`, else the invoking soxe when it is not in a checkout, else
  a released `@adhd/sox-cli` install, else the checkout CLI marked volatile;
  `service enable|update` and `doctor --install-tick` refuse a volatile CLI at
  user scope unless `--allow-checkout-cli`. Also exports `isGitCheckoutPath` and
  `installedCliCandidates`. (27850011)

  A path only counts as a git checkout if the nearest `.git` is found BEFORE the
  walk crosses a `node_modules` segment — a released CLI installed under
  Homebrew's (`/opt/homebrew/.git`) or nvm's (`~/.nvm/.git`) own repo was
  previously misclassified as a checkout, so a correctly installed
  `@adhd/sox-cli` failed the user-scope gate with no way to pass it (the
  suggested `npm i -g @adhd/sox-cli` remedy could never succeed). The released-CLI
  candidate is now resolved via `npm root -g` run through the pinned node's own
  npm, falling back to the old `<prefix>/lib/node_modules` heuristic only when
  that call fails (it previously resolved to the Homebrew Cellar path, which
  Homebrew never populates, and to `~/.adhd/sox-ecosystem/cli`, which nothing
  ever populates — both dropped). `--cli-path` is now validated: a non-absolute
  or nonexistent value throws instead of silently baking in a broken path. This
  is a **behavior change** for `@adhd/sox-cli`: a user-scope `service
enable|update` / `doctor --install-tick` that previously silently accepted (or
  wrongly refused) a CLI path now resolves and gates it correctly, hence `minor`.

## 0.6.0

### Minor Changes

- 14265f0: `service restart` now targets the backend the OS unit is actually running
  (dc6261c1), and `restartAndVerify` can skip the kickstart.

  - New exports `extractUnitArgv(unitText, kind)` and
    `isFrontShimArgv(argv, extId)` read the argv of the unit file on disk, so a
    caller can tell a front-shim unit from a direct-backend unit without
    re-deriving it from config.
  - `restartAndVerify` options gain `kickstart?: boolean` (default `true`) and
    `mainPid?: number`. With `kickstart: false`, only the backend is restarted,
    and the reaper reaps the live backend scoped by pid. A rotation whose
    entrypoint path is stale is rejected.

  **Minor, not patch:** `RestartAndVerifyResult.kickstart` is now optional. It is
  absent, and `kickstartSkipped: true` is set, when `kickstart: false` skipped
  it. Code that reads `result.kickstart` unconditionally has to handle the
  absent case.

## 0.5.0

### Minor Changes

- 884e3e7: Public API surface changed since the last publish.

  Each of these packages has `dist/*.d.ts` differing from the version currently on
  npm, with no changeset recording it — the drift the `check-changeset-surface` gate
  exists to catch. This changeset records it and ships the accumulated surface.

  The READMEs shipped alongside are rewritten and verified: every documented symbol
  is checked against that package's own built declarations, and every example is one
  that was executed against the built artifact.

  `@adhd/sox-memory-core` also corrects three source comments that asserted ADR-0007's
  single-writer architecture as current fact. ADR-0012 supersedes it — the default
  Turso backend runs `multiprocess-wal`, where multiple processes hold concurrent
  write connections to one store file, serialized through a `-tshm` coordinator, with
  no opt-out. Because those comments are emitted into the shipped `.d.ts`, the false
  claim was visible in consumers' editor tooltips.

### Patch Changes

- Updated dependencies [884e3e7]
  - @adhd/sox-listen-guard@0.1.1

## 0.4.1

### Patch Changes

- Additive surface: shutdown grace-margin discipline, `soxe service update`, and reload-after-unload verification.

  - New `shutdown.ts` module exporting `SOX_SHUTDOWN_SAFETY_MARGIN_MS`, `resolveShutdownSafetyNetMs`,
    and `resolveStopTimeoutMsFromEnv` (BL-592/BUG-018 grace-margin shutdown).
  - New `updateOsUnit` (+ `UpdateOsUnitOptions`/`UpdateOsUnitResult`) for `soxe service update` — a
    verified restart that proves artifact adoption (BL-593).
  - New `reloadAndVerifyOsUnit` (+ `ReloadAndVerifyOsUnitOptions`/`ReloadAndVerifyOsUnitResult`) so a
    rolling-restart unload that leaves an OS unit dead now fails loudly instead of silently reporting
    success (BUG-023).
  - `--dry-run` render made truly render-only — it was writing live unit files (fix).

  All additions are additive exports; no existing exported signature was removed or changed.

## 0.4.0

### Minor Changes

- OS units now stamp `SOX_SERVICE_ID` into their environment (BL-584).

  The in-process supervisor already did this, so the same extension saw a **different environment** depending on which supervisor started it, and an OS-unit service had no supervisor-authoritative way to know it was running as a service. That is what made `tokenguard` infer its mode from the absence of `SOX_CONFIG_PORT` and exit 0 immediately under launchd while reporting `loaded: yes`.

  It also closes a reaper gap: `findOrphansByServiceId` matches `SOX_SERVICE_ID` in process env and treats that path as cross-build safe, falling back to argv-token matching otherwise. OS-unit services previously only ever matched via the fallback.

  Also: log files are pruned on date rollover rather than only on the size cap (BL-579), every manifest/CLI path join is contained against traversal, and incoming wire buffers are bounded with port/IPv6-authority validation.

## 0.3.0

### Minor Changes

- 32275f7: Additive: crash-loop guard, env-policy scrubbing, OS-unit control surface, and reconcile helpers.

  Four wholly new modules, each re-exported from `index.d.ts`:

  - `crash-loop.d.ts` — `CrashLoopGuard`, `CRASH_LOOP_MAX_FAILURES`, `CRASH_LOOP_WINDOW_MS`, marker
    read/write helpers.
  - `env-policy.d.ts` — `scrubEnv`, `scrubEnvReported`, `isDeniedEnvKey`, `formatDeniedEnvWarning`,
    `ENV_BASE_ALLOW`, `ENV_ALLOW_PREFIXES`, `ENV_DENY_PREFIXES`, type `ScrubbedEnv`.
  - `os-unit.d.ts` — `detectOsSupervisor`, `deriveOsUnitSpec`, `enableOsUnit`, `disableOsUnit`,
    `restartOsUnit`, `unloadThenReap`, `restartAndVerify`, plus ~10 associated types.
  - `reconcile.d.ts` — `classifyReconcileTargets`, `sweepProxyBackendLocks`, `quickReconcile`, plus
    associated types.

  Additive extensions to existing modules: `reaper.d.ts` gains `readProcessEnv`,
  `findOrphansByServiceId`, `gatherProcessSnapshot` and types `ProcessRowSource`,
  `ProcessSnapshotRow`. `log-manager.d.ts` gains `findAllLogStreamsForExt`, `findMostRecentLogFile`
  and type `LogStreamDescriptor`. `supervisor.d.ts`'s `SupervisorOptions` gains an optional
  `crashLoop?: {...}` block and `ProcessSupervisor` gains a public `isCrashLooped(): boolean` method —
  both additive, nothing removed or narrowed. `index.d.ts`'s re-export list only ever grows (every
  diffed line appends a new named export or widens an existing `export {...}` clause). Remaining hunks
  are `sox`→`soxe` comment rebrand or a doc example string change (`"memory-daemon"` →
  `"tokenguard"` in a `@param` example — text only). No removed or narrowed export anywhere in this
  package's diff — minor.

## 0.2.0

### Minor Changes

- 05430d9: Publishing & distribution refactor — the system is now publishable, consumable, and reusable purely
  from `npm install`, and new bundles install the same way (BL-42/BL-43/BL-65/BL-34/BL-33/BL-38).

  - **All 12 `@adhd/sox-*` libs publish public** (`private:false` + `publishConfig.access:public`,
    `engines.node>=20`, `files:["dist"]`) so third parties can `npm i` and import the engine SDK (G3).
    API stability tiers documented in `docs/publishing/api-stability.md` (ADR-0005 / Q2).
  - **CLI is a self-contained esbuild bundle** with an in-package `bin` (`@adhd/sox-cli` →
    `soxe`), in-package `dist`/`files`/`engines`/`publishConfig`, and a bundled registry copy, so
    `npm i -g @adhd/sox-cli` works on a fresh machine with no checkout (G1; fixes BL-34).
  - **Extensions are self-contained bundles (Model A)** carrying zero `@adhd/sox-*` runtime deps;
    `memory-server`/`memory-cli`/`memory-flush`/`memory-daemon` migrated off bare `tsc` to esbuild
    (closes BL-38). Native addons (`better-sqlite3`, `sqlite-vec`) are declared as real runtime
    `dependencies` and installed via a new `npm-package:` install mode (tarball + `npm install`),
    the only path that can deliver transitive native deps to a fresh machine (G2).
  - **Registry portability:** `build-index` emits portable `npm-package:` locators under the
    `SOX_REGISTRY_PUBLISH` signal (was a dormant CDN branch); `check-registry-sync` mirrors it
    (BL-33). The content checksum remains the sole extension identity/integrity authority — the npm
    version only selects which bytes to fetch (ADR-0003 intact; ADR-0005 ratifies the coexistence).
  - **Born-publishable golden path:** `soxe init` scaffolds publish + fresh-machine-install-ready
    packages; a `check-publishable` gate forbids the `workspace:*`/`@adhd`-runtime-dep 404 class.
