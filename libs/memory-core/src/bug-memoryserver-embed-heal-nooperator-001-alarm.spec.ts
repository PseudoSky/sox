/**
 * bug-memoryserver-embed-heal-nooperator-001-alarm.spec.ts —
 * BUG-MEMORYSERVER-EMBED-HEAL-NOOPERATOR-001, the tiered alarm state machine.
 *
 * RED→GREEN (BL-225): the pre-fix escalation (`checkAndEscalateEnrichStall`,
 * BL-413) CLEARED its record on every non-stalled tick. During the 2026-08-26
 * outage a fresh queue (rows <15min old) made each tick look healthy, so the
 * one durable record that said "escalated" was cleared on every tick — the
 * escalation-cleared bug. `checkAndEscalateEnrichAlarm` keys off the HONEST
 * verdict (last_successful_pass_at) and LATCHES crit while the verdict stays
 * non-ok: a merely-running tick can never silently clear it. Clears only on a
 * genuinely ok verdict or an operator ack. The crit-latch arm (c) is the exact
 * regression: it fails against the pre-fix behaviour and passes now.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  getDb,
  checkAndEscalateEnrichAlarm,
  readEnrichAlarm,
  acknowledgeEnrichAlarm,
  resumeEnrichAlarm,
  _resetEnrichAlarmStateForTest,
} from './index.js';
import type { StoreAdapter } from '@adhd/sox-store-adapter';

const cleanups: Array<() => void> = [];

function tmpDbPath(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-enrich-alarm-'));
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return path.join(d, 'store.db');
}

async function freshAdapter(): Promise<{ adapter: StoreAdapter; dbPath: string }> {
  const dbPath = tmpDbPath();
  const adapter = await getDb(dbPath);
  cleanups.push(() => adapter.close().catch(() => undefined));
  return { adapter, dbPath };
}

const STALLED = 'stalled' as const;
const OK = 'ok' as const;

function stalledInput(over: Partial<Parameters<typeof checkAndEscalateEnrichAlarm>[2]> = {}) {
  return {
    verdictState: STALLED,
    queueDepth: 5,
    embedBacklog: 10,
    poisonedRows: 0,
    lastIsolatedError: null,
    lastEmbedError: null,
    netDrained: 0,
    ...over,
  };
}

beforeEach(() => _resetEnrichAlarmStateForTest());
afterEach(() => {
  _resetEnrichAlarmStateForTest();
  for (const c of cleanups.splice(0)) c();
});

describe('BUG-MEMORYSERVER-EMBED-HEAL-NOOPERATOR-001 — checkAndEscalateEnrichAlarm tiered escalation', () => {
  it('watch → warn → crit across consecutive non-ok ticks', async () => {
    const { adapter, dbPath } = await freshAdapter();

    const t1 = await checkAndEscalateEnrichAlarm(adapter, dbPath, stalledInput());
    expect(t1!.level).toBe('watch');
    expect(t1!.consecutive_non_ok_ticks).toBe(1);

    const t2 = await checkAndEscalateEnrichAlarm(adapter, dbPath, stalledInput());
    expect(t2!.level).toBe('warn');
    expect(t2!.consecutive_non_ok_ticks).toBe(2);

    const t3 = await checkAndEscalateEnrichAlarm(adapter, dbPath, stalledInput());
    expect(t3!.level).toBe('warn');
    expect(t3!.consecutive_non_ok_ticks).toBe(3);

    // 4th non-ok tick reaches critTicks (default 4).
    const t4 = await checkAndEscalateEnrichAlarm(adapter, dbPath, stalledInput());
    expect(t4!.level).toBe('crit');
    expect(t4!.consecutive_non_ok_ticks).toBe(4);
  });

  it('crit LATCHES while the verdict stays non-ok — a merely-running tick cannot clear it', async () => {
    const { adapter, dbPath } = await freshAdapter();

    for (let i = 0; i < 4; i++) await checkAndEscalateEnrichAlarm(adapter, dbPath, stalledInput());
    const atCrit = await readEnrichAlarm(adapter);
    expect(atCrit!.level).toBe('crit');

    // MANY more non-ok ticks (the exact "the outage kept ticking" shape) —
    // the level must stay crit, never downgrade, never clear.
    for (let i = 0; i < 20; i++) {
      await checkAndEscalateEnrichAlarm(adapter, dbPath, stalledInput());
    }
    const still = await readEnrichAlarm(adapter);
    expect(still).not.toBeNull();
    expect(still!.level).toBe('crit');
    expect(still!.consecutive_non_ok_ticks).toBe(24);
  });

  it('clears only on a genuinely ok verdict (verified recovery)', async () => {
    const { adapter, dbPath } = await freshAdapter();

    for (let i = 0; i < 4; i++) await checkAndEscalateEnrichAlarm(adapter, dbPath, stalledInput());
    expect(await readEnrichAlarm(adapter)).not.toBeNull();

    const cleared = await checkAndEscalateEnrichAlarm(adapter, dbPath, {
      verdictState: OK,
      queueDepth: 0,
      embedBacklog: 0,
      poisonedRows: 0,
      lastIsolatedError: null,
      lastEmbedError: null,
      netDrained: 0,
    });
    expect(cleared).toBeNull();
    expect(await readEnrichAlarm(adapter)).toBeNull();
  });

  it('ack_alarm pauses re-escalation: subsequent non-ok ticks do not re-raise', async () => {
    const { adapter, dbPath } = await freshAdapter();

    await checkAndEscalateEnrichAlarm(adapter, dbPath, stalledInput());
    await checkAndEscalateEnrichAlarm(adapter, dbPath, stalledInput()); // warn
    const acked = await acknowledgeEnrichAlarm(adapter);
    expect(acked!.state).toBe('acknowledged');
    expect(acked!.acknowledged_at).not.toBeNull();

    // Non-ok ticks while acknowledged must NOT re-escalate (paused).
    const next = await checkAndEscalateEnrichAlarm(adapter, dbPath, stalledInput());
    expect(next!.state).toBe('acknowledged');

    // resume re-arms a fresh escalation cycle.
    await resumeEnrichAlarm(adapter);
    expect(await readEnrichAlarm(adapter)).toBeNull();
    const rearmed = await checkAndEscalateEnrichAlarm(adapter, dbPath, stalledInput());
    expect(rearmed!.level).toBe('watch');
    expect(rearmed!.consecutive_non_ok_ticks).toBe(1);
  });

  it('record survives a process restart (persisted to sox_store_meta, read back independently)', async () => {
    const { adapter, dbPath } = await freshAdapter();

    for (let i = 0; i < 4; i++) await checkAndEscalateEnrichAlarm(adapter, dbPath, stalledInput({
      lastEmbedError: 'Model not initialized',
    }));

    // Simulate a fresh process: drop the in-memory negative-drain counters and
    // read the record back from the STORE only.
    _resetEnrichAlarmStateForTest();
    const persisted = await readEnrichAlarm(adapter);
    expect(persisted).not.toBeNull();
    expect(persisted!.level).toBe('crit');
    expect(persisted!.last_embed_error).toBe('Model not initialized');
    expect(persisted!.consecutive_non_ok_ticks).toBe(4);
  });

  it('two consecutive negative-drain windows with backlog escalate straight to crit', async () => {
    const { adapter, dbPath } = await freshAdapter();

    // Negative drain = net_drained < 0 while backlog > 0.
    const neg1 = await checkAndEscalateEnrichAlarm(adapter, dbPath, stalledInput({ netDrained: -3 }));
    expect(neg1!.level).toBe('watch'); // first negative-drain window

    const neg2 = await checkAndEscalateEnrichAlarm(adapter, dbPath, stalledInput({ netDrained: -2 }));
    expect(neg2!.level).toBe('crit'); // 2 consecutive negative drains → crit early
  });

  it('never escalates a healthy (ok/idle) verdict — no false alarms', async () => {
    const { adapter, dbPath } = await freshAdapter();
    const ok = await checkAndEscalateEnrichAlarm(adapter, dbPath, {
      verdictState: OK, queueDepth: 0, embedBacklog: 0, poisonedRows: 0, lastIsolatedError: null, lastEmbedError: null, netDrained: 0,
    });
    expect(ok).toBeNull();
    expect(await readEnrichAlarm(adapter)).toBeNull();
  });

  it('a non-zero poison count escalates to warn on the FIRST non-ok tick (the systemic tell)', async () => {
    const { adapter, dbPath } = await freshAdapter();

    // poison 0: first non-ok tick stays watch (no poison accelerator).
    const watch = await checkAndEscalateEnrichAlarm(adapter, dbPath, stalledInput({ poisonedRows: 0 }));
    expect(watch!.level).toBe('watch');
    await resumeEnrichAlarm(adapter);

    // poison > 0: the SAME first non-ok tick jumps straight to warn — a
    // "Model not initialized" burst that parks rows must be visible, not silent.
    const warn = await checkAndEscalateEnrichAlarm(adapter, dbPath, stalledInput({ poisonedRows: 5 }));
    expect(warn!.level).toBe('warn');
    expect(warn!.poisoned_rows).toBe(5);
    expect((await readEnrichAlarm(adapter))!.poisoned_rows).toBe(5);
  });

  it('poison + consecutive ticks reaches crit alongside the existing tick rule', async () => {
    const { adapter, dbPath } = await freshAdapter();
    for (let i = 0; i < 4; i++) {
      await checkAndEscalateEnrichAlarm(adapter, dbPath, stalledInput({ poisonedRows: 3 }));
    }
    const rec = await readEnrichAlarm(adapter);
    expect(rec!.level).toBe('crit');
    expect(rec!.poisoned_rows).toBe(3);
  });
});
