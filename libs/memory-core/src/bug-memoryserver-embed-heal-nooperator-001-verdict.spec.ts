/**
 * bug-memoryserver-embed-heal-nooperator-001-verdict.spec.ts —
 * BUG-MEMORYSERVER-EMBED-HEAL-NOOPERATOR-001, the honest pipeline-health verdict.
 *
 * RED→GREEN (BL-225): the pre-fix verdict (`computeEnrichmentHealth` in
 * memory-server's index.ts) derived `ok`/`stalled` from QUEUE FRESHNESS — the
 * age of the newest pending row. During the 2026-08-26 >24h outage the queue
 * was being re-populated faster than it drained, so rows were always <15min
 * old and the verdict read `ok`/`stalled`-cleared the WHOLE time while 127
 * enrich.pass.failed and 235 embed.error had already fired. The NEW-3 shape
 * below is the exact false-positive: fresh queue rows + a success 2h stale +
 * 10/10 failed passes. `computePipelineHealthVerdict` must read `stalled`, NOT
 * `ok`, because the honest freshness signal is `last_successful_pass_at`, never
 * queue-row age. The arms fail against the pre-fix verdict and pass now.
 */

import { describe, it, expect } from 'vitest';
import { computePipelineHealthVerdict, EMPTY_ENRICH_HEALTH_LEDGER } from './enrich-health.js';
import type { EnrichHealthLedger, ComputePipelineHealthInput } from './enrich-health.js';

const NOW = Date.parse('2026-08-26T20:00:00.000Z');
const TWO_HOURS = 2 * 60 * 60 * 1000;

function ledger(partial: Partial<EnrichHealthLedger>): EnrichHealthLedger {
  return { ...EMPTY_ENRICH_HEALTH_LEDGER, ...partial };
}

function verdict(input: ComputePipelineHealthInput): ReturnType<typeof computePipelineHealthVerdict> {
  return computePipelineHealthVerdict(input);
}

describe('BUG-MEMORYSERVER-EMBED-HEAL-NOOPERATOR-001 — computePipelineHealthVerdict is keyed off last SUCCESS, not queue freshness', () => {
  it('NEW-3 shape: fresh queue + last_successful_pass_at 2h stale + 10/10 failed passes ⇒ stalled, NOT ok', () => {
    // The exact 2026-08-26 false positive. Queue rows were all <15min old (the
    // OLD verdict read `ok` on that alone). Nothing had SUCCEEDED in 2h, and
    // every one of the last 10 passes failed.
    const v = verdict({
      nowMs: NOW,
      backlog: 12, // non-empty backlog: the pipeline has work it is not clearing
      ledger: ledger({
        last_successful_pass_at: new Date(NOW - TWO_HOURS).toISOString(),
        passes_ok: 0,
        passes_failed: 10,
        net_drained: -3,
      }),
    });

    expect(v.state).toBe('stalled');
    expect(v.state).not.toBe('ok'); // THE regression — the pre-fix verdict said ok here
    expect(v.reasons.some((r) => /last successful pass was/.test(r))).toBe(true);
  });

  it('never-succeeded (last_successful_pass_at null) + non-empty backlog ⇒ stalled, never ok', () => {
    const v = verdict({
      nowMs: NOW,
      backlog: 5,
      ledger: ledger({ last_successful_pass_at: null, passes_failed: 4 }),
    });
    expect(v.state).toBe('stalled');
    expect(v.reasons.some((r) => /no successful pass has ever been recorded/.test(r))).toBe(true);
  });

  it('fresh success + success-rate above floor + net_drained >= 0 ⇒ ok', () => {
    const v = verdict({
      nowMs: NOW,
      backlog: 8,
      ledger: ledger({
        last_successful_pass_at: new Date(NOW - 30_000).toISOString(), // 30s ago — fresh
        passes_ok: 5,
        passes_failed: 0,
        net_drained: 4,
      }),
    });
    expect(v.state).toBe('ok');
    expect(v.reasons).toEqual([]);
  });

  it('backlog 0 ⇒ idle, regardless of a stale last success or failed passes', () => {
    const v = verdict({
      nowMs: NOW,
      backlog: 0,
      ledger: ledger({
        last_successful_pass_at: new Date(NOW - TWO_HOURS).toISOString(),
        passes_ok: 0,
        passes_failed: 99,
        net_drained: -10,
      }),
    });
    expect(v.state).toBe('idle');
    expect(v.reasons).toEqual([]);
  });

  it('fresh success but success-rate below floor (>= minPasses) ⇒ regressing', () => {
    // 2 ok / 8 failed = 20% < 50% floor, with >= minPasses(3) passes run.
    const v = verdict({
      nowMs: NOW,
      backlog: 6,
      ledger: ledger({
        last_successful_pass_at: new Date(NOW - 10_000).toISOString(),
        passes_ok: 2,
        passes_failed: 8,
        net_drained: 0,
      }),
    });
    expect(v.state).toBe('regressing');
    expect(v.reasons.some((r) => /success rate/.test(r))).toBe(true);
  });

  it('fresh success but net_drained < 0 (backlog grew) ⇒ regressing', () => {
    const v = verdict({
      nowMs: NOW,
      backlog: 9,
      ledger: ledger({
        last_successful_pass_at: new Date(NOW - 10_000).toISOString(),
        passes_ok: 6,
        passes_failed: 0,
        backlog_before: 4,
        backlog_after: 12,
        net_drained: -8,
      }),
    });
    expect(v.state).toBe('regressing');
    expect(v.reasons.some((r) => /backlog grew by 8/.test(r))).toBe(true);
  });

  it('below minPasses with a fresh success is not prematurely regressing (floor not yet enforceable)', () => {
    // 0 ok / 1 failed — only 1 pass has run (< minPasses 3), so the floor is
    // not judged yet; the one success is fresh → ok.
    const v = verdict({
      nowMs: NOW,
      backlog: 3,
      ledger: ledger({
        last_successful_pass_at: new Date(NOW - 5_000).toISOString(),
        passes_ok: 1,
        passes_failed: 0,
        net_drained: 1,
      }),
    });
    expect(v.state).toBe('ok');
  });

  it('poisoned_rows > 0 + otherwise-healthy pipeline ⇒ regressing, NOT ok (parked rows are not healing)', () => {
    // Fresh success, success-rate above floor, net_drained >= 0 — every OTHER
    // dimension reads healthy. The pre-fix verdict said `ok` here while rows
    // were silently parked.
    const v = verdict({
      nowMs: NOW,
      backlog: 8,
      ledger: ledger({
        last_successful_pass_at: new Date(NOW - 30_000).toISOString(),
        passes_ok: 5,
        passes_failed: 0,
        net_drained: 4,
      }),
      poisonedRows: 3,
    });
    expect(v.state).toBe('regressing');
    expect(v.state).not.toBe('ok');
    expect(v.reasons.some((r) => /3 row\(s\) poisoned\/quarantined/.test(r))).toBe(true);
  });

  it('poisoned_rows > 0 + stale success ⇒ stalled (stalled dominates, but the poison is named)', () => {
    const v = verdict({
      nowMs: NOW,
      backlog: 8,
      ledger: ledger({
        last_successful_pass_at: new Date(NOW - 2 * 3600 * 1000).toISOString(),
        passes_ok: 0,
        passes_failed: 10,
        net_drained: 0,
      }),
      poisonedRows: 4,
    });
    expect(v.state).toBe('stalled');
    expect(v.reasons.some((r) => /poisoned\/quarantined/.test(r))).toBe(true);
  });

  it('poison 0 + recent success + net_drained >= 0 ⇒ ok (only a zero-poison pipeline reads ok)', () => {
    const v = verdict({
      nowMs: NOW,
      backlog: 8,
      ledger: ledger({
        last_successful_pass_at: new Date(NOW - 30_000).toISOString(),
        passes_ok: 5,
        passes_failed: 0,
        net_drained: 4,
      }),
      poisonedRows: 0,
    });
    expect(v.state).toBe('ok');
  });

  it('net_drained does not credit poison-skipped rows (they remain in backlog_after)', () => {
    // A pass that healed 2 rows but skipped 3 poisoned rows: backlog 5 → 3.
    // net_drained = 2 (the 3 poisoned rows are NOT counted as drained — they
    // stay in backlog_after because they still lack vectors).
    const l = ledger({
      last_successful_pass_at: new Date(NOW - 30_000).toISOString(),
      passes_ok: 5,
      passes_failed: 0,
      backlog_before: 5,
      backlog_after: 3,
      net_drained: 2,
      poisoned_skipped: 3,
    });
    expect(l.net_drained).toBe(2);
    // With the poison still active, the verdict is regressing — the skipped
    // rows are surfaced, not silently counted as progress.
    const v = verdict({ nowMs: NOW, backlog: 3, ledger: l, poisonedRows: 3 });
    expect(v.state).toBe('regressing');
    expect(v.reasons.some((r) => /poisoned\/quarantined/.test(r))).toBe(true);
  });
});
