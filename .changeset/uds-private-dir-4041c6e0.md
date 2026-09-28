---
'@adhd/sox-service-proxy': minor
'@adhd/sox-embedding-provider': patch
'@adhd/sox-host-runtime': patch
'@adhd/sox-install-engine': patch
'@adhd/sox-cli': patch
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

Data-root directories are now created 0700 (`mkdirDataDir`), so they are private
even under umask 002. `soxe` and the embedding funnel repair their own run dirs
at start with the new `tightenOwnedSocketDir`: it removes group/other write
through a single O_NOFOLLOW descriptor and skips anything it cannot prove is
yours. An `E_UDS_DIR_UNSAFE` refusal now carries a `reason` (`foreign`,
`own-writable`, `fallback-mode`) with a matching remediation, and no message
suggests a recursive delete (BL-6233c1c2).
