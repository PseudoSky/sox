#!/usr/bin/env bash
# bundle-pipeline guard — [dod.5] mechanism: esbuild bundle is self-contained;
# runs from /tmp with no monorepo siblings; real serve() path emits the marker.
# Sources [def:probe-harness] and asserts [inv:bundle-selfcontained].

set -uo pipefail
source "$(dirname "$0")/../sox-probe.sh"
probe_init

# --- 1. Build the fixture mcp-server bundle via the documented tool ----------
# Proves tools/bundle-extension.cjs exists and produces a bundle artifact.
BUNDLE_OUT="$SBX/bundle-out"
mkdir -p "$BUNDLE_OUT"

pushd "$REPO" >/dev/null
node tools/bundle-extension.cjs \
  --entry extensions/mcp-servers/memory-server/src/index.ts \
  --outdir "$BUNDLE_OUT" \
  --external better-sqlite3 \
  2>/tmp/bundle-build-err.$$
BUILD_RC=$?
BUILD_ERR="$(cat /tmp/bundle-build-err.$$ 2>/dev/null)"
rm -f /tmp/bundle-build-err.$$
popd >/dev/null

if [ $BUILD_RC -eq 0 ] && [ -f "$BUNDLE_OUT/index.js" ]; then
  _ok "bundle artifact produced: $BUNDLE_OUT/index.js"
else
  _bad "bundle build failed (rc=$BUILD_RC): ${BUILD_ERR:0:200}"
fi

# --- 2. Run the bundle's entrypoint from /tmp (no monorepo on $PATH) ---------
# Proves [inv:bundle-selfcontained]: no Cannot find module '@adhd in stderr.
TMP_RUN="$(mktemp -d "${TMPDIR:-/tmp}/sox-bundle-run.XXXXXX")"
SERVE_OUT="$TMP_RUN/serve.out"
SERVE_ERR="$TMP_RUN/serve.err"

# The bundle uses --external better-sqlite3 (a native .node binary; can't be inlined).
# Symlink it from the repo's node_modules into the run dir so the bundle can load it
# while all @adhd/sox-* packages remain unavailable (proving they are bundled, not resolved).
if [ -d "$REPO/node_modules/better-sqlite3" ]; then
  mkdir -p "$TMP_RUN/node_modules"
  ln -sf "$REPO/node_modules/better-sqlite3" "$TMP_RUN/node_modules/better-sqlite3"
fi

# Spawn the bundle for 3 s in a totally isolated cwd (not the repo).
(cd "$TMP_RUN" &&
  timeout 3 node "$BUNDLE_OUT/index.js" \
    >"$SERVE_OUT" 2>"$SERVE_ERR") || true

BUNDLE_STDERR="$(cat "$SERVE_ERR" 2>/dev/null)"
BUNDLE_STDOUT="$(cat "$SERVE_OUT" 2>/dev/null)"

case "$BUNDLE_STDERR$BUNDLE_STDOUT" in
*"Cannot find module '@adhd"* | *"MODULE_NOT_FOUND"*)
  _bad "@adhd import error running bundle from /tmp: ${BUNDLE_STDERR:0:200}"
  ;;
*)
  _ok "no @adhd import errors: bundle runs from /tmp ([inv:bundle-selfcontained])"
  ;;
esac

# --- 3. Assert [shape:serve-marker] present in combined output ----------------
# proves the REAL serve() path ran (not a deleted hand-rolled fallback).
LAST_OUT="$BUNDLE_STDOUT"
LAST_ERR="$BUNDLE_STDERR"
assert_serve_real_path "memory-server bundle from /tmp"

rm -rf "$TMP_RUN"

probe_done
