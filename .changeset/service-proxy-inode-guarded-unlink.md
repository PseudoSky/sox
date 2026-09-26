---
'@adhd/sox-service-proxy': patch
---

`serveBackend`'s close no longer deletes a successor's socket (448f9d93).

The close callback runs only once every client connection has closed, which
is well after `server.close()` stopped accepting and libuv removed the path.
A successor listener (for example the next embedding host a consumer spawns)
can bind the same path inside that window, and the callback then unlinked the
successor's freshly bound socket by path. The listener now records the
`(dev, ino)` of the socket it bound and unlinks at close only when the path
still names that exact object. Unexpected errors on the listen/close paths are
reported through `onDiagnostic` instead of being swallowed. The inherited-fd
path is unchanged.
