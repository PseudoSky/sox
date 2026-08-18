/**
 * vitest.setup.ts — Global test setup for memory-flush (BL-161).
 *
 * Mirrors libs/memory-core/vitest.setup.ts: installs the deterministic
 * feature-hash embedding provider as the default for ALL memory-flush tests
 * via _setEmbedProviderForTest(). memory-flush's index.spec.ts drives
 * fireSessionEnd() -> auto-export -> memory-core's export pipeline, which
 * embeds episode content. Without this, that path falls through to the real
 * fastembed/ONNX backend, making the suite:
 *   - Slow    (model download / ONNX warmup on every run)
 *   - Flaky   (concurrent ONNX workers contending for CPU/RAM — BL-161)
 *
 * Installing the test provider here makes the entire suite fast and
 * deterministic without any change to memory-flush's src/ (which is owned
 * by another agent) or to memory-core's src/ (ditto) — this only calls the
 * already-exported test hook from the built @adhd/sox-memory-core dist that
 * vitest.config.ts aliases to.
 */

import { _setEmbedProviderForTest } from '@adhd/sox-memory-core';
import { DeterministicTestProvider } from '@adhd/sox-memory-core';
import { initTelemetry } from '@adhd/sox-telemetry';

_setEmbedProviderForTest(new DeterministicTestProvider());

// BL-568: per-WORKER telemetry composition root, mirroring memory-server's and
// memory-core's own vitest.setup.ts (and the root scripts/telemetry-test-setup.ts).
// Without this, `currentRuntimeState().service` stays `'unlabeled'` for the
// FIRST spec file's import of src/index.ts, which fires this project's own
// module-level `initTelemetry()` guard (BL-568's composition-root fix) with
// `service:'memory-flush'` during a normal test run — not wrong, exactly, but
// it means the suite exercises production init timing/ordering instead of the
// deterministic 'test'-role state every other project's suite runs under, and
// masks the specific regression bl568-telemetry-composition-root.spec.ts needs
// to force: that guard only fires when nothing has claimed telemetry yet.
// Calling `initTelemetry` here FIRST — before any spec file's first import of
// `src/index.ts` — puts every ordinary spec run under `role:'test'` like the
// rest of the repo, and lets the regression spec explicitly
// `_resetTelemetryForTest()` back to the unlabeled state to exercise the real
// guard path deliberately.
initTelemetry({ service: 'sox-tests', role: 'test', logSink: 'file' });
