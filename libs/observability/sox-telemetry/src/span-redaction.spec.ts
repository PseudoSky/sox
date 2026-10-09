/**
 * span-redaction.spec.ts — c536ce29 L3-AC-A: span JSONL honours the
 * `redactor` option of initTelemetry.
 *
 * Span `.start`/`.finish` lines are written by `JsonlSpanProcessor` through
 * `emitRecord` (runtime.ts), the same funnel as `log.*`; this spec pins that
 * the configured redactor therefore covers span attributes and captured args,
 * so a future change that gives spans their own write path cannot silently
 * bypass it.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { _resetTelemetryForTest, createRedactor, identityRedactor, initTelemetry, otelReady, withSpan, type Redactor } from './index.js';

const CANARY_KEY = 'sk-ant-api03-CANARYabcdefghijklmnopqrstuvwxyz0123456789';
const CANARY_NAMED = 'canary-named-secret-value-42';
const dirs: string[] = [];

async function spanLines(redactor: Redactor | undefined): Promise<string[]> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-span-redact-'));
  dirs.push(dir);
  initTelemetry({ service: 'spanred', role: 'test', logSink: 'file', logDir: dir, otel: true, ...(redactor ? { redactor } : {}) });
  await otelReady();
  await withSpan(
    'tool.call',
    { api_key: CANARY_NAMED, args: JSON.stringify({ prompt: 'hi', key: CANARY_KEY }), tool: 'search' },
    async () => 'ok',
  );
  const file = fs.readdirSync(dir).find((f) => f.includes('spanred.test-') && !f.includes('metrics-snapshot'));
  if (!file) throw new Error('no span file written');
  return fs.readFileSync(path.join(dir, file), 'utf8').split('\n').filter(Boolean);
}

afterEach(() => {
  _resetTelemetryForTest();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('c536ce29 L3-AC-A span redaction', () => {
  it('c536ce29 L3-AC-A with a redactor, canary secrets in span attributes and captured args never reach the span JSONL', async () => {
    const lines = await spanLines(createRedactor());
    expect(lines).toHaveLength(2); // .start and .finish
    const text = lines.join('\n');
    expect(text).not.toContain(CANARY_KEY);
    expect(text).not.toContain(CANARY_NAMED);
    expect(text).toContain('[REDACTED:');
    expect(text).toContain('"tool":"search"'); // non-secret attributes survive
  });

  it('c536ce29 L3-AC-A negative control: identityRedactor lets the canaries through, so the test above has teeth', async () => {
    const text = (await spanLines(identityRedactor)).join('\n');
    expect(text).toContain(CANARY_NAMED);
    expect(text).toContain(CANARY_KEY);
  });

  it('c536ce29 L3-AC-A with no redactor the span output is byte-identical to the pre-redactor golden shape', async () => {
    const lines = await spanLines(undefined);
    const normalised = lines.map((l) =>
      l
        .replace(/"ts":"[^"]+"/, '"ts":"T"')
        .replace(/"pid":\d+/, '"pid":0')
        .replace(/"span_id":"[0-9a-f]{16}"/, '"span_id":"S"')
        .replace(/"otel_trace_id":"[0-9a-f]{32}"/, '"otel_trace_id":"O"')
        .replace(/"duration_ms":\d+/, '"duration_ms":0'),
    );
    const head =
      '"level":"info","event":"tool.call.%s","service":"spanred","role":"test","release":{"version":null,"artifact_sha256":null,"git_sha":null},"trace_id":null,"pid":0,';
    const attrs = `"api_key":"${CANARY_NAMED}","args":${JSON.stringify(JSON.stringify({ prompt: 'hi', key: CANARY_KEY }))},"tool":"search","span_id":"S","parent_span_id":null,"otel_trace_id":"O"`;
    expect(normalised).toEqual([
      `{"ts":"T",${head.replace('%s', 'start')}${attrs}}`,
      `{"ts":"T",${head.replace('%s', 'finish')}${attrs},"duration_ms":0}`,
    ]);
  });
});
