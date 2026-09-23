#!/usr/bin/env bash
# scripts/acceptance/clean-room-smoke.sh — the canonical "is it publishable?" gate (SCOPE §9).
#
# Proves G1–G2 against a LOCAL registry (verdaccio) with NO repo checkout in the
# consumer environment and an isolated HOME/data root (never touches the live
# ~/.memory or ~/.adhd — BL-65 safety). This is the OFFLINE stand-in for the
# fresh-machine container gate; the real public-npm publish is owner-gated.
#
# Flow:
#   1. start verdaccio (proxies public npm via uplink for native deps)
#   2. pnpm -r publish → all @adhd packages to verdaccio (workspace:* rewritten)
#   3. SOX_REGISTRY_PUBLISH=npm build-index → portable npm-package: sources
#   4. rebuild CLI (embeds the portable registry), publish CLI to verdaccio
#   5. CONSUMER (clean cwd, isolated HOME, registry=verdaccio):
#        npm i -g @adhd/sox-cli         → soxe --version, soxe search   (G1)
#        soxe install sox-memory-bundle  → members from npm, native deps (G2)
#        memory_ping                     → {ok:true, artifact:sha256...} (G2)
#
# Usage:  bash scripts/acceptance/clean-room-smoke.sh
# Requires: pnpm, npx (verdaccio fetched on demand), network for the npm uplink.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="$(mktemp -d)"
VPORT=4873
VREG="http://localhost:${VPORT}/"
VHOME="$WORK/verdaccio"
GLOBAL="$WORK/global"
CONSUMER="$WORK/consumer"
export HOME="$WORK/home"; mkdir -p "$HOME"
export SOX_ECOSYSTEM_HOME="$WORK/sox-home"; mkdir -p "$SOX_ECOSYSTEM_HOME"
mkdir -p "$VHOME" "$GLOBAL" "$CONSUMER" "$HOME/.memory"

# Step 3 below regenerates the REAL `$REPO/registry/index.json` in place. That file
# is not a build artifact — it carries checksums deliberately pinned to published
# npm bytes, and `build-index` recomputes them from LOCAL disk bytes, so an
# un-restored run silently replaces a curated supply-chain record with whatever
# the working tree happens to hash to. Snapshot it now and restore unconditionally,
# including on the `set -e` bail-out and Ctrl-C paths.
REGISTRY_INDEX="$REPO/registry/index.json"
REGISTRY_BACKUP="$WORK/registry-index.json.orig"
[ -f "$REGISTRY_INDEX" ] && cp -p "$REGISTRY_INDEX" "$REGISTRY_BACKUP"

cleanup() {
  [ -n "${VPID:-}" ] && kill "$VPID" 2>/dev/null || true
  if [ -f "$REGISTRY_BACKUP" ]; then
    if cmp -s "$REGISTRY_BACKUP" "$REGISTRY_INDEX"; then
      echo "[smoke] registry/index.json unchanged"
    else
      cp -p "$REGISTRY_BACKUP" "$REGISTRY_INDEX"
      echo "[smoke] registry/index.json RESTORED to its pre-smoke contents"
    fi
  fi
  echo "[smoke] workdir: $WORK (left for inspection)"
}
trap cleanup EXIT INT TERM

# ── 1. verdaccio config: anonymous publish + public uplink ────────────────────
cat > "$VHOME/config.yaml" <<EOF
storage: $VHOME/storage
uplinks:
  npmjs:
    url: https://registry.npmjs.org/
packages:
  '@adhd/*':
    access: \$all
    publish: \$all
    unpublish: \$all
  '**':
    access: \$all
    publish: \$all
    proxy: npmjs
log: { type: stdout, format: pretty, level: warn }
EOF

echo "[smoke] starting verdaccio…"
npx --yes verdaccio@6 --config "$VHOME/config.yaml" --listen "$VPORT" >"$WORK/verdaccio.log" 2>&1 &
VPID=$!
for i in $(seq 1 60); do
  curl -fsS "$VREG" >/dev/null 2>&1 && break
  sleep 0.5
done
echo "//localhost:${VPORT}/:_authToken=smoke-token" > "$HOME/.npmrc"

# ── 2. publish all @adhd packages to verdaccio (workspace:* rewritten) ────────
echo "[smoke] building everything…"
( cd "$REPO" && npx nx run-many -t build >/dev/null 2>&1 )
# ── 3. portable registry (npm-package: sources) BEFORE publishing, so the CLI
#       embeds it and is published once (no 409 republish). ───────────────────
echo "[smoke] regenerating registry with publication signal…"
( cd "$REPO" && SOX_REGISTRY_PUBLISH=npm npx tsx scripts/build-index.ts >/dev/null 2>&1 )
FILE_COUNT=$(grep -c 'file://' "$REPO/registry/index.json" || true)
echo "[smoke] registry file:// count = $FILE_COUNT (expect 0)"
echo "[smoke] rebuilding CLI so it embeds the portable registry…"
( cd "$REPO" && npx nx build sox --skip-nx-cache >/dev/null 2>&1 )

# ── 4. publish all @adhd packages → verdaccio (per-package, sequential) ────────
echo "[smoke] publishing @adhd packages → verdaccio (per-package, sequential)…"
# Sequential per-package publish: `pnpm -r publish` runs in PARALLEL and races
# verdaccio's metadata writes (observed: some packages silently 404 after a
# parallel run); `--workspace-concurrency` is not accepted by `pnpm publish`.
# A loop is reliable and isolates per-package failures. `pnpm publish` (not npm)
# is required so `workspace:*` deps are rewritten to real versions on publish.
PUBLISHED=0
while IFS= read -r pj; do
  dir="$(dirname "$pj")"
  name="$(node -e "try{const p=require('$pj');if(p.private===true||!String(p.name||'').startsWith('@adhd/sox-')){process.exit(3)}process.stdout.write(p.name)}catch{process.exit(3)}")" || continue
  if ( cd "$dir" && pnpm publish --registry "$VREG" --no-git-checks --tag latest >/dev/null 2>>"$WORK/publish.err" ); then
    PUBLISHED=$((PUBLISHED+1))
  else
    echo "[smoke]   publish FAILED: $name ($dir)"
  fi
done < <(find "$REPO/libs" "$REPO/apps" "$REPO/extensions" -name package.json -not -path '*/node_modules/*' -not -path '*/dist/*' | sort)
echo "[smoke] published $PUBLISHED @adhd packages to verdaccio"

# ── 5. CONSUMER: clean room, no checkout ──────────────────────────────────────
export NPM_CONFIG_REGISTRY="$VREG"
echo "[smoke] G1: npm i -g @adhd/sox-cli (no checkout)…"
npm install -g --prefix "$GLOBAL" @adhd/sox-cli --registry "$VREG" >/dev/null 2>&1
SOXE="$GLOBAL/bin/soxe"
cd "$CONSUMER"
echo -n "[smoke] soxe --version → "; "$SOXE" --version
echo "[smoke] soxe search memory →"; "$SOXE" search memory 2>&1 | head -4

echo "[smoke] G2: soxe install sox-memory-bundle --scope user…"
"$SOXE" install sox-memory-bundle --scope user 2>&1 | tail -12

echo "[smoke] G2: memory_ping (soxe serve, direct stdio) →"
# Direct-stdio (--no-proxy) is the deterministic harness proof: the installed
# bundle IS the stdio server and answers synchronously. (The proxy default works
# with a persistent MCP client; a one-shot pipe closes stdin before the detached
# backend finishes spawning — a harness artifact, not a distribution defect.)
PING_OUT="$(printf '%s\n%s\n' \
 '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}' \
 '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"memory_ping","arguments":{}}}' \
 | timeout 30 "$SOXE" serve memory-server --scope user --no-proxy 2>"$WORK/ping.err" | tail -3)"
echo "$PING_OUT"

# The ping result is JSON-RPC content text, so its inner JSON is backslash-escaped
# (\"ok\":true). Strip backslashes before asserting so the regex matches the payload.
PING_UNESC="$(printf '%s' "$PING_OUT" | tr -d '\\')"
echo "[smoke] ── ASSERTIONS ──"
FAIL=0
grep -q '"ok":true' <<<"$PING_UNESC" && echo "  [PASS] memory_ping ok:true (G2 runtime)" || { echo "  [FAIL] memory_ping"; FAIL=1; }
grep -q 'artifact":"sha256:' <<<"$PING_UNESC" && echo "  [PASS] content address present (ADR-0003/0005)" || { echo "  [FAIL] no content address"; FAIL=1; }
[ "$FILE_COUNT" = "0" ] && echo "  [PASS] registry has 0 file:// sources (G2 portability)" || { echo "  [FAIL] $FILE_COUNT file:// sources"; FAIL=1; }
grep -q '/Users/' <<<"$PING_OUT" && { echo "  [FAIL] /Users path leaked into output"; FAIL=1; } || echo "  [PASS] no /Users path in resolved output"
"$SOXE" --version | grep -q '^[0-9]' && echo "  [PASS] soxe --version (G1)" || { echo "  [FAIL] soxe --version"; FAIL=1; }
[ "$FAIL" = "0" ] && echo "[smoke] DONE — ALL GATES GREEN (G1+G2)" || { echo "[smoke] DONE — FAILURES ABOVE"; exit 1; }
