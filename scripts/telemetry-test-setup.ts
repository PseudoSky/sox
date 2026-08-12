/**
 * Telemetry composition root for EVERY vitest worker (BL-404 universal-coverage).
 *
 * `initTelemetry` is PER-PROCESS state (the module-level `_state` in
 * `@adhd/sox-telemetry`'s runtime.ts), so it must run in `setupFiles`
 * (per-worker, before every test file), never `globalSetup` (which runs once in
 * the main process and does not compose a worker). Without this hook, every
 * emitter in a test worker hits the unlabelled fallback state —
 * `logSink:'none'` — and the one-shot
 * `[sox-telemetry] WARNING: emitting with no initTelemetry() call` tripwire
 * fires while every record is silently dropped.
 *
 * A durable file sink means test telemetry is captured, never dropped, and
 * `role: 'test'` keeps the OTel SDK off by default (`otelDefaultFor` in
 * runtime.ts) — the SDK costs a measured 91.5 ms + 23.6 MB per worker, which
 * is the wrong price in a vitest fork pool.
 *
 * logDir is resolved EXPLICITLY:
 *   - sandboxed runs (`SOX_TEST_ECOSYSTEM_HOME`, set by the root config's
 *     BL-179 `scripts/test-env-setup.ts` globalSetup) write under the per-run
 *     scratch home — never the real user data root;
 *   - everything else writes to `~/.adhd/sox-ecosystem/sox-tests/logs`
 *     (via `os.homedir()`), the same durable, reviewable `~/.adhd` convention
 *     the backlog CLI composition root follows (`~/.adhd/sox-ecosystem/backlog/logs`)
 *     and memory-server's live JSONL follows (`~/.adhd/sox-ecosystem/memory-server/logs`).
 *
 * A bare OS-tmpdir scratch base is NEVER used: test telemetry is durable and
 * reviewable on disk, separated from live-service logs by the role-qualified
 * `sox-tests.test` component so it can never collide with or prune them (§5.8
 * pruning anchor).
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { initTelemetry } from '@adhd/sox-telemetry';

const logDir = process.env.SOX_TEST_ECOSYSTEM_HOME
  ? join(process.env.SOX_TEST_ECOSYSTEM_HOME, 'telemetry')
  : join(homedir(), '.adhd', 'sox-ecosystem', 'sox-tests', 'logs');

initTelemetry({ service: 'sox-tests', role: 'test', logSink: 'file', logDir });
