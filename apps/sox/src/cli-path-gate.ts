/**
 * (27850011) The CLI-path counterpart of the volatile-node ack
 * (docs/spec/service-lifecycle.md §9.2).
 *
 * A USER-scope OS unit must not run `soxe` out of a git checkout unless the
 * operator explicitly asked for it (`--cli-path=<checkout>` resolves as
 * `source: 'flag'`, never volatile; or `--allow-checkout-cli`). Prod's
 * memory-server launchd unit ran `<dev checkout>/bin/soxe serve memory-server
 * --port 3099`, so any branch switch or build in that checkout changed
 * production. Project/local scopes (dev loops, the smoke harness under
 * dist/smoke) keep the invoking CLI with a warning.
 */
import type { UnitCliResolution } from '@adhd/sox-host-runtime';

/** Returns false when the caller must refuse (and exit non-zero). */
export function gateVolatileCli(
  cliRes: UnitCliResolution | null,
  scope: string,
  flags: Record<string, string>,
  verbLabel: string,
  write: (m: string) => void = (m) => {
    process.stderr.write(m);
  },
): boolean {
  if (cliRes === null || !cliRes.volatile) return true;
  write(`${verbLabel}: WARNING — ${cliRes.volatileReason ?? 'CLI path is inside a git checkout'}\n`);
  if (scope !== 'user' || flags['allow-checkout-cli'] !== undefined) return true;
  write(
    `  Refusing to bake a git-checkout soxe into a user-scope unit. Re-run with ` +
      `--cli-path=<released soxe> or --allow-checkout-cli to proceed anyway.\n`,
  );
  return false;
}
