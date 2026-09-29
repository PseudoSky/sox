/**
 * funnel-client-map-error-uds-unsafe.bl-32ece600.spec.ts
 *
 * BL-32ece600 — `FunneledFastembedClient`'s private `mapError()` classifies a
 * JSON-RPC -32001 error carrying `{ code: 'E_UDS_DIR_UNSAFE' }` data as a
 * {@link PermanentEmbeddingError} (BL-4041c6e0: an unsafe socket directory is
 * an operator problem, never a retry — it must NOT be classified as the
 * transient `HostGoneError` that every other -32001 gets). This mapping had
 * no dedicated test; a regression here (e.g. loosening the `data.code` check,
 * or reordering the -32001 branches) would silently turn a "fix your socket
 * dir permissions" condition back into an infinite retry loop.
 *
 * `mapError` is TS-`private` (soft privacy only, no `#` field) — called
 * directly via a typed cast, matching how this codebase already tests other
 * classification-only private methods without spinning up a real backend.
 */
import { describe, expect, it } from 'vitest';
import { FunneledFastembedClient } from './funnelClient.js';
import { PermanentEmbeddingError, TransientEmbeddingError } from './errors.js';

interface RpcErrorLike {
  code: number;
  message: string;
  data?: unknown;
}

function mapError(client: FunneledFastembedClient, error: RpcErrorLike): Error {
  return (client as unknown as { mapError(e: RpcErrorLike): Error }).mapError(error);
}

describe('FunneledFastembedClient.mapError — BL-32ece600 E_UDS_DIR_UNSAFE mapping', () => {
  it('-32001 with data.code === "E_UDS_DIR_UNSAFE" maps to PermanentEmbeddingError', () => {
    const client = new FunneledFastembedClient();
    const err = mapError(client, {
      code: -32001,
      message: 'socket dir is group/other-writable',
      data: { code: 'E_UDS_DIR_UNSAFE' },
    });
    expect(err).toBeInstanceOf(PermanentEmbeddingError);
    expect(err.message).toContain('socket dir is group/other-writable');
  });

  it('regression guard: a bare -32001 (no E_UDS_DIR_UNSAFE data) stays TRANSIENT, not permanent', () => {
    // The E_UDS_DIR_UNSAFE check must be checked BEFORE the generic -32001
    // fallback — every other host-gone condition (host crashed, socket
    // stale) must still retry.
    const client = new FunneledFastembedClient();
    const err = mapError(client, { code: -32001, message: 'connection refused' });
    expect(err).toBeInstanceOf(TransientEmbeddingError);
    expect(err).not.toBeInstanceOf(PermanentEmbeddingError);
  });

  it('regression guard: -32001 with unrelated data.code stays TRANSIENT', () => {
    const client = new FunneledFastembedClient();
    const err = mapError(client, { code: -32001, message: 'x', data: { code: 'SOME_OTHER_CODE' } });
    expect(err).toBeInstanceOf(TransientEmbeddingError);
    expect(err).not.toBeInstanceOf(PermanentEmbeddingError);
  });

  it('regression guard: non-object data.code (e.g. a string) stays TRANSIENT', () => {
    const client = new FunneledFastembedClient();
    const err = mapError(client, { code: -32001, message: 'x', data: 'E_UDS_DIR_UNSAFE' });
    expect(err).toBeInstanceOf(TransientEmbeddingError);
    expect(err).not.toBeInstanceOf(PermanentEmbeddingError);
  });
});
