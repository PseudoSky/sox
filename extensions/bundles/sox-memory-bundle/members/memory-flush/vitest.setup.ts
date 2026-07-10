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

_setEmbedProviderForTest(new DeterministicTestProvider());
