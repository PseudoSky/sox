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
