/**
 * apps/sox/src/tighten-run-dirs.ts -- CLI-init repair of sox's own run dirs
 * (BL-4041c6e0, BL-6233c1c2).
 *
 * The socket-dir trust check (`@adhd/sox-service-proxy` `assertPrivateSocketDir`)
 * refuses a group/other-writable socket directory. Older soxe builds, and any
 * `mkdir` under umask 002 (Linux user-private-group hosts), left `run/` and
 * `run/supervisors/` at 0775 -- so every proxy-mode bind and dial would be
 * refused. Once per invocation, before verb dispatch, this drops that write bit
 * from the two dirs, but only when they are provably ours (see
 * `tightenOwnedSocketDir`). New dirs are already created 0700 (`mkdirDataDir`).
 */

import { runDir, socketDir } from '@adhd/sox-host-runtime';
import { log } from '@adhd/sox-telemetry';

type TightenFn = typeof import('@adhd/sox-service-proxy').tightenOwnedSocketDir;

/** `@adhd/sox-service-proxy` is lazy-loaded across the CLI (module-boundary rule). */
function loadTighten(): TightenFn {
  return (require('@adhd/sox-service-proxy') as typeof import('@adhd/sox-service-proxy')).tightenOwnedSocketDir;
}

/** Per-directory outcome, for tests and diagnostics. */
export type TightenRunDirsResult = Array<{ dir: string; outcome: string }>;

/**
 * Tighten `runDir()` then `socketDir()`. `tighten` is injectable for tests; by
 * default it is loaded lazily from `@adhd/sox-service-proxy`. Never throws: a failure is logged and
 * the verb proceeds -- the trust check will then report the precise problem at
 * the point of use.
 */
export function tightenSoxRunDirs(tighten?: TightenFn): TightenRunDirsResult {
  const results: TightenRunDirsResult = [];
  let fn: TightenFn;
  try {
    fn = tighten ?? loadTighten();
  } catch (err) {
    log.warn('sox.run_dir_tighten_unavailable', { error: String(err) });
    return results;
  }
  for (const dir of [runDir(), socketDir()]) {
    try {
      const outcome = fn(dir, {
        onTightened: (e) =>
          log.info('sox.run_dir_tightened', {
            dir: e.dir,
            old_mode: `0${e.oldMode.toString(8)}`,
            new_mode: `0${e.newMode.toString(8)}`,
          }),
      });
      results.push({ dir, outcome });
    } catch (err) {
      log.warn('sox.run_dir_tighten_failed', { dir, error: String(err) });
      results.push({ dir, outcome: 'error' });
    }
  }
  return results;
}
