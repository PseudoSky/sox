/**
 * apps/sox/src/upgrade-summary.ts
 *
 * BL-ad811031: `cmdUpgrade`'s per-consumer summary previously tallied only
 * `current`, `upgraded` (changed), and `failed` — silently dropping `ahead`
 * and `no-registry` outcomes from both the printed count and the "fully
 * current" gate. A run whose only outcomes were `ahead`/`no-registry` (zero
 * current, zero changed, zero failed) printed "system fully current — zero
 * changes" while leaving those pins entirely unjudged.
 *
 * Pulled out of `main.ts` (which runs `void main()` at import time) so this
 * pure formatting logic can be unit-tested directly, matching the
 * `grace-ms.ts` convention for side-effect-free CLI helpers.
 */

export interface UpgradeConsumerOutcome {
  state:
    | 'current'
    | 'ahead'
    | 'no-registry'
    | 'upgraded'
    | 'restarted'
    | 'restart-mismatch'
    | 'restarted-unsupervised'
    | 'backend-restarted'
    | 'backend-restart-mismatch'
    | 'backend-restarted-unsupervised'
    | 'reconnect-needed'
    | 'not-installed'
    | 'unresolvable'
    | 'failed';
}

export interface UpgradeSummary {
  tally: string;
  fullyCurrent: boolean;
}

/** Format the `soxe upgrade` per-consumer tally and decide the "fully current" gate. */
export function formatUpgradeSummary(
  outcomes: UpgradeConsumerOutcome[],
  changed: number,
  failed: number,
): UpgradeSummary {
  const currentCount = outcomes.filter((o) => o.state === 'current').length;
  const aheadCount = outcomes.filter((o) => o.state === 'ahead').length;
  const noRegistryCount = outcomes.filter((o) => o.state === 'no-registry').length;
  const tally = `${currentCount} current, ${changed} upgraded, ${aheadCount} ahead, ${noRegistryCount} no-registry, ${failed} failed.`;
  const fullyCurrent = changed === 0 && failed === 0 && aheadCount === 0 && noRegistryCount === 0;
  return { tally, fullyCurrent };
}
