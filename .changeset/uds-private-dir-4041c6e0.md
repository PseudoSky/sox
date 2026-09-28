---
'@adhd/sox-service-proxy': minor
'@adhd/sox-embedding-provider': patch
---

Backend Unix sockets are only bound or dialed inside a verified-private directory
(BL-4041c6e0). The tier-3 socket path for an over-long socket directory is now
`/tmp/sox-<uid>/p-<16hex>.sock` — fixed and TMPDIR-independent, so every peer
derives the same path — instead of `$TMPDIR/sox-uds/…` or `/tmp/s-<hex>.sock`.
`serveBackend` creates the directory 0700 and refuses (`E_UDS_DIR_UNSAFE`, no
bind) when it is a symlink, not a directory, owned by another uid, group/other
writable, or — for the `/tmp/sox-<uid>` root — not exactly 0700. `dialBackend`,
`probeSocketLive`, `handshakeBackend` and `ensureBackend` refuse to connect into
such a directory; the refusal is non-retryable (no re-dial, `ensureBackend`
returns `errorCode: 'E_UDS_DIR_UNSAFE'`, the embedding funnel raises a
`PermanentEmbeddingError`). New exports: `udsFallbackRoot`,
`ensurePrivateSocketDir`, `assertPrivateSocketDir`, `isUdsDirUnsafeError`.
