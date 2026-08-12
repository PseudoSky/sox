/**
 * integrity-status.ts — render an integrity pass into the status surface (BL-334).
 *
 * `integrity.ts` decides whether a store is damaged. This module decides how
 * that verdict is *reported*, and it exists as a separate, separately-tested
 * unit for one reason: **the reporting layer is where "damaged" historically
 * turns back into "healthy".**
 *
 * BL-347 is the case in point. The live store's FTS index was dead for at least
 * a day; `memory_ping` reported healthy the entire time, because nothing asked
 * and the absence of a complaint was rendered as an absence of a problem. The
 * rule this module enforces:
 *
 *   **Health is a claim that must be earned by a validated probe. Everything
 *   else — no pass, an aborted pass, a probe that could not be validated,
 *   verification switched off — is `unknown`, and `unknown` is never healthy.**
 *
 * Concretely, `healthy: true` is emitted only when a pass ran, completed,
 * found no damage, and every probe that ran demonstrably exercised its
 * artifact. There is deliberately no code path that infers health from a
 * missing report or an empty findings array.
 *
 * Note the trap this guards, which is real and lives in `integrity.ts`'s own
 * error path: an aborted pass records `{ ok: false, findings: [], damaged: [],
 * unknown: [] }`. A summariser that asked `damaged.length === 0` would call
 * that healthy. It is the most-damaged state the type can express.
 */

import type {
  IntegrityFinding,
  IntegrityProbe,
  IntegrityStatus,
  VerifyAndRepairResult,
} from './integrity.js';

// ── Reported shape ───────────────────────────────────────────────────────────

/** Top-level verdict. `repaired` is a distinct outcome from `ok`: the store is
 *  correct *now*, but it was not correct at open, and an operator must be able
 *  to tell those apart when the same damage recurs every restart. */
export type IntegrityOverall = 'ok' | 'repaired' | 'damaged' | 'unknown';

export interface ProbeStatusView {
  status: IntegrityStatus;
  /** False when no finding for this probe demonstrably exercised its artifact.
   *  A `status: 'ok'` with `validated: false` is NOT evidence of health. */
  validated: boolean;
  objects: number;
  detail: string | null;
}

export interface IntegrityStatusView {
  /** The single field an operator or a gate should branch on. */
  overall: IntegrityOverall;
  /** True ONLY when health was positively demonstrated. Never inferred. */
  healthy: boolean;
  /** Always populated when `healthy` is false — why we cannot claim health. */
  reason: string | null;
  last_run_at: string | null;
  age_seconds: number | null;
  depth: 'fast' | 'deep' | null;
  duration_ms: number | null;
  probes: Partial<Record<IntegrityProbe, ProbeStatusView>>;
  damaged: {
    probe: IntegrityProbe;
    object: string;
    detail: string;
    backlog: string;
    repairable: boolean;
  }[];
  unknown: { probe: IntegrityProbe; object: string; detail: string }[];
  repair: {
    attempted: boolean;
    ok: boolean;
    actions: { object: string; action: string; ok: boolean; duration_ms: number; error?: string }[];
    /** Verdict of the re-verification run AFTER repair. `null` when repair was
     *  not re-verified — which is itself a reason not to claim health. */
    reverified: IntegrityOverall | null;
  } | null;
}

// ── The "never ran" / "switched off" states ──────────────────────────────────

const NEVER_RAN_REASON =
  'No integrity verification has run for this store in this process. ' +
  'This is NOT a clean bill of health — the store is unverified.';

function unverified(reason: string): IntegrityStatusView {
  return {
    overall: 'unknown',
    healthy: false,
    reason,
    last_run_at: null,
    age_seconds: null,
    depth: null,
    duration_ms: null,
    probes: {},
    damaged: [],
    unknown: [],
    repair: null,
  };
}

// ── Summarisation ────────────────────────────────────────────────────────────

/** Collapse the findings for one probe into a single reported status.
 *  Precedence is deliberate: damaged > unknown > ok. The worst finding wins,
 *  and a single unvalidated probe drags the whole probe to unvalidated. */
function collapseProbe(findings: IntegrityFinding[]): ProbeStatusView {
  const damaged = findings.filter((f) => f.status === 'damaged');
  const unknown = findings.filter((f) => f.status === 'unknown');
  const status: IntegrityStatus =
    damaged.length > 0 ? 'damaged' : unknown.length > 0 ? 'unknown' : 'ok';
  const worst = damaged[0] ?? unknown[0] ?? findings[0];
  return {
    status,
    // Validated only when EVERY finding for this probe exercised its artifact.
    validated: findings.length > 0 && findings.every((f) => f.probeValidated),
    objects: findings.length,
    detail: worst?.detail ?? null,
  };
}

/**
 * Render the retained integrity result for the status surface.
 *
 * @param result  from `getLastIntegrityResult(adapter)`; `null` = never ran.
 * @param lastRunAtMs from `getLastIntegrityRunAt(dbPath)`.
 *
 * Verification is ALWAYS on (≥ `fast`, BL-373 family / ADR-0013): the
 * `SOX_STORE_VERIFY=off` "we chose not to look" state no longer exists, so
 * `null` unambiguously means "we have not looked yet" — never "we chose not
 * to". Neither is health.
 */
export function summarizeIntegrityForStatus(
  result: VerifyAndRepairResult | null,
  lastRunAtMs: number | null,
  nowMs: number = Date.now(),
): IntegrityStatusView {
  if (result === null) return unverified(NEVER_RAN_REASON);

  const { verify, repair } = result;

  // Group findings by probe.
  const byProbe = new Map<IntegrityProbe, IntegrityFinding[]>();
  for (const f of verify.findings) {
    const list = byProbe.get(f.probe);
    if (list) list.push(f);
    else byProbe.set(f.probe, [f]);
  }
  const probes: Partial<Record<IntegrityProbe, ProbeStatusView>> = {};
  for (const [probe, findings] of byProbe) probes[probe] = collapseProbe(findings);

  // THE TRAP (integrity.ts:1266-1277): an aborted pass records ok:false with
  // EMPTY findings/damaged/unknown. Asking `damaged.length === 0` would call
  // the most-damaged state healthy. Consult `ok` first, and treat an empty
  // report as evidence of nothing.
  const abortedOrEmpty = verify.findings.length === 0;
  if (verify.ok === false && abortedOrEmpty) {
    const view = unverified(
      'The integrity pass did not complete — it recorded no findings and did not ' +
        'succeed. The store is unverified, not healthy.',
    );
    view.depth = verify.depth;
    view.duration_ms = verify.durationMs;
    view.last_run_at = lastRunAtMs === null ? null : new Date(lastRunAtMs).toISOString();
    view.age_seconds =
      lastRunAtMs === null ? null : Math.max(0, Math.round((nowMs - lastRunAtMs) / 1000));
    return view;
  }

  const damaged = verify.damaged.map((f) => ({
    probe: f.probe,
    object: f.object,
    detail: f.detail,
    backlog: f.backlog,
    repairable: f.repairable,
  }));
  const unknownList = verify.unknown.map((f) => ({
    probe: f.probe,
    object: f.object,
    detail: f.detail,
  }));

  // Did repair clear the damage, and was that re-verified? A repair that was
  // not re-verified is exactly what BL-347 shipped, so it does not earn health.
  const reverified: IntegrityOverall | null =
    repair?.verified == null
      ? null
      : repair.verified.damaged.length > 0
        ? 'damaged'
        : repair.verified.unknown.length > 0
          ? 'unknown'
          : 'ok';

  const repairedClean =
    damaged.length > 0 && repair !== null && repair.ok === true && reverified === 'ok';

  // A probe that ran but could not be validated is an absence of evidence.
  const unvalidatedProbes = Object.entries(probes)
    .filter(([, v]) => v.status === 'ok' && !v.validated)
    .map(([k]) => k);

  let overall: IntegrityOverall;
  let reason: string | null;

  if (damaged.length > 0 && !repairedClean) {
    overall = 'damaged';
    const worst = damaged[0]!;
    reason =
      `${damaged.length} damaged artifact(s) detected and not repaired — ` +
      `e.g. [${worst.backlog}] ${worst.object}: ${worst.detail}`;
  } else if (repairedClean) {
    overall = 'repaired';
    reason =
      `${damaged.length} artifact(s) were damaged at open and were repaired and re-verified. ` +
      `The store is correct now, but it did not open correct.`;
  } else if (unknownList.length > 0) {
    overall = 'unknown';
    reason =
      `${unknownList.length} probe(s) could not be validated, so health is unproven — ` +
      `e.g. ${unknownList[0]!.object}: ${unknownList[0]!.detail}`;
  } else if (unvalidatedProbes.length > 0) {
    overall = 'unknown';
    reason =
      `Probe(s) reported ok without demonstrably exercising the artifact ` +
      `(${unvalidatedProbes.join(', ')}); health is unproven.`;
  } else if (verify.ok !== true) {
    overall = 'unknown';
    reason = 'The verification pass did not report success; health is unproven.';
  } else if (byProbe.size === 0) {
    overall = 'unknown';
    reason = 'The verification pass ran but exercised no probes; health is unproven.';
  } else {
    overall = 'ok';
    reason = null;
  }

  return {
    overall,
    // `repaired` counts as healthy-now; every other non-ok state does not.
    healthy: overall === 'ok' || overall === 'repaired',
    reason,
    last_run_at: lastRunAtMs === null ? null : new Date(lastRunAtMs).toISOString(),
    age_seconds:
      lastRunAtMs === null ? null : Math.max(0, Math.round((nowMs - lastRunAtMs) / 1000)),
    depth: verify.depth,
    duration_ms: verify.durationMs,
    probes,
    damaged,
    unknown: unknownList,
    repair:
      repair === null
        ? null
        : {
            attempted: true,
            ok: repair.ok,
            actions: repair.actions.map((a) => ({
              object: a.object,
              action: a.action,
              ok: a.ok,
              duration_ms: a.durationMs,
              ...(a.error === undefined ? {} : { error: a.error }),
            })),
            reverified,
          },
  };
}

/**
 * One-line operator summary — what `memory_ping`'s top level shows so the
 * verdict is legible without expanding the block.
 */
export function integrityHeadline(view: IntegrityStatusView): string {
  switch (view.overall) {
    case 'ok':
      return `store integrity ok (${view.depth ?? '?'} probes, ${view.duration_ms ?? '?'}ms)`;
    case 'repaired':
      return `store integrity REPAIRED at open — ${view.damaged.length} artifact(s) were damaged`;
    case 'damaged':
      return `store integrity DAMAGED — ${view.damaged.length} artifact(s), see integrity.damaged`;
    case 'unknown':
      return `store integrity UNKNOWN — ${view.reason ?? 'unverified'}`;
  }
}
