/**
 * proxy-backend-front-shim.ts — BL a49ca837 (redeploy severs sessions).
 *
 * Extracted seam for the `shimIsUnit` gate that `restartProxyBackend`
 * (apps/sox/src/main.ts) applies before verified-stopping a proxy backend.
 * `main.ts` exports nothing and defines every collaborator
 * (`unloadOwnedOsUnitsBeforeReap`, `mcpServerIsProxyMode`, etc.) as file-local
 * functions, so this predicate + gate is pulled into its own module purely to
 * make it independently unit-testable (mirrors the `grace-ms.ts` extraction,
 * commit d9af44de).
 *
 * `shimIsUnit` answers a REALITY question — "what does the on-disk os-unit
 * actually execute right now?" — not a config question. It is derived by
 * reading the unit file's rendered argv (`extractUnitArgv` +
 * `isFrontShimArgv`, `@adhd/sox-host-runtime`) and checking whether it runs
 * `soxe serve <id> --port <port>` (the front-shim, ensure-backend.ts's
 * detached backend is a separate process this restart never touches) versus
 * the bare backend entrypoint (BL-156's `cmdOsUnit` execArgs fallback path —
 * empty `cliPath`, or the unit enabled before a port was configured — the
 * unit itself IS the backend, and launchd/systemd KeepAlive supervises it).
 *
 * This is deliberately a DIFFERENT question from the `cmdOsUnit` execArgs
 * branch's predicate (main.ts, the `cmdOsUnit` execArgs branch): that one
 * decides, at unit-render time, what argv to WRITE from current config +
 * `cliPath` availability. This one decides, at restart time, what argv is
 * ALREADY on disk. The two must not be merged into "one predicate" — they
 * answer different questions at different times — but they must never
 * disagree about what "front-shim" means, which is why both live on the same
 * `serve <id> --port` token shape (`isFrontShimArgv`).
 *
 * Fail-safe direction: no unit on disk, an unreadable unit file, or
 * unparseable argv is NOT positive evidence of front-shim status — treat it
 * as NOT the shim so `unload()` (and the caller's matching re-enable step,
 * `restartProxyBackend`'s re-enable gate in main.ts) still run
 * ([inv:unload-then-reap] needs positive evidence to skip, never the
 * absence of it).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { extractUnitArgv, isFrontShimArgv, type OsUnitPlatform } from '@adhd/sox-host-runtime';

export interface UnloadUnlessFrontShimOpts {
  /** The extension id whose os-unit is being evaluated. */
  extId: string;
  /** The os-unit platform (launchd/systemd) — supplies unit dir + file naming + argv format. */
  platform: OsUnitPlatform;
  /** The unit's label (`osUnitLabel(scope, extId)`), used to derive the unit file name. */
  label: string;
  /** Best-effort unload of the owned os-unit; invoked whenever the unit is NOT the front-shim. */
  unload: () => void;
  /** Injectable for tests; defaults to `fs.readFileSync`. A throw (missing file, etc.) is fail-safe: NOT the front-shim. */
  readUnitText?: (unitPath: string) => string;
  log?: (m: string) => void;
}

export interface UnloadUnlessFrontShimResult {
  /** True iff the on-disk os-unit's argv is `... serve <extId> --port ...` (the front-shim). */
  shimIsUnit: boolean;
  /** The unit path this was evaluated against (diagnostic / test assertion aid). */
  unitPath: string;
}

/**
 * Compute `shimIsUnit` from the on-disk unit's REAL argv and call `unload()`
 * unless the unit is the front-shim. Returns `shimIsUnit` so the caller can
 * also gate the matching re-enable step (`restartProxyBackend`'s re-enable
 * gate, main.ts) on the same value — never re-derive it independently
 * (commit 36520052 called out duplication as the hazard that regressed
 * BL a49ca837; see this module's docblock for why the execArgs-render-time
 * predicate is a legitimately separate question rather than a duplicate).
 */
export function unloadOsUnitUnlessFrontShim(
  opts: UnloadUnlessFrontShimOpts,
): UnloadUnlessFrontShimResult {
  const log = opts.log ?? (() => { /* no-op */ });
  const readUnitText = opts.readUnitText ?? ((p: string) => fs.readFileSync(p, 'utf8'));
  const unitPath = path.join(opts.platform.defaultUnitDir(), opts.platform.unitFileName(opts.label));

  let shimIsUnit = false;
  try {
    const text = readUnitText(unitPath);
    const argv = extractUnitArgv(text, opts.platform.kind);
    shimIsUnit = isFrontShimArgv(argv, opts.extId);
  } catch (e) {
    log(
      `unit read failed for ${unitPath} (${(e as Error).message}) — ` +
        'treating as NOT the front-shim (fail-safe: unload still runs)',
    );
    shimIsUnit = false;
  }

  if (!shimIsUnit) {
    opts.unload();
  } else {
    log(
      `skip unload: on-disk os-unit argv runs 'serve ${opts.extId} --port ...' (the front-shim), ` +
        'does not supervise the detached backend',
    );
  }

  return { shimIsUnit, unitPath };
}
