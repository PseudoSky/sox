/**
 * vitest.setup.ts — Global test setup for memory-core.
 *
 * Installs the deterministic feature-hash embedding provider as the default
 * for ALL memory-core tests via _setEmbedProviderForTest(). This bypasses the
 * real fastembed/ONNX backend in every test file, making the entire suite:
 *   - Fast  (no model download / ONNX warmup)
 *   - Deterministic (same text → same vector, every run)
 *   - Flake-free (no concurrent ONNX workers contending for CPU/RAM)
 *
 * Tests that genuinely need the real bge-base-en-v1.5 model (embed.spec.ts)
 * opt out explicitly by calling:
 *   _setEmbedProviderForTest(null);
 *   process.env['SOX_EMBED_BACKEND'] = 'real';
 * at the start of their test and restoring afterward.
 *
 * The test provider survives _resetEmbedSingleton() calls (those clear the
 * cached fastembed instance but deliberately leave _testProvider intact).
 */

import { _setEmbedProviderForTest } from './src/embed.js';
import { DeterministicTestProvider } from './src/embed-test-provider.js';

_setEmbedProviderForTest(new DeterministicTestProvider());

/**
 * BL-404 universal-coverage: per-worker telemetry composition root. memory-core
 * emits stage records (stages.ts declareStages) and log.* records from src on
 * every test that exercises them; without initTelemetry every one of those was
 * silently dropped behind the logSink:'none' fallback (the one-shot stderr
 * warning was the only tell). `logDir` is deliberately omitted so the runtime
 * default lands records under the ecosystem home —
 * `~/.adhd/sox-ecosystem/sox-tests/logs` (honoring the `SOX_ECOSYSTEM_HOME`
 * override when a sandbox sets it) — matching the memory-server durable-JSONL
 * pattern; never a bare tmpdir. Role 'test' keeps the OTel SDK off in every
 * worker (otelDefaultFor in @adhd/sox-telemetry).
 */
import { initTelemetry } from '@adhd/sox-telemetry';

initTelemetry({ service: 'sox-tests', role: 'test', logSink: 'file' });
