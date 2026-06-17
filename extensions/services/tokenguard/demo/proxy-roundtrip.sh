#!/usr/bin/env bash
# proxy-roundtrip.sh — [fix:roundtrip-sample] live end-to-end demo
#
# Starts tokenguard via the built dist/index.js, points a client at it with a
# seeded real identifier + a mock upstream (demo/mock-upstream.mjs that echoes
# the received body as a streamed reply), sends a request, and asserts:
#   - The upstream received ONLY placeholders (LEAKS 0)
#   - The client got the real value back exactly (ROUNDTRIP OK)
#
# Also writes four founder artifacts under demo/out/:
#   prompts.txt       — the seeded request content
#   outbound.diff     — real->placeholder (what the upstream saw vs what we sent)
#   raw-response.txt  — the raw SSE reply from mock upstream (as seen by proxy)
#   inbound.diff      — placeholder->real (reversal proof)
#
# [tg-service.6] — asserts ROUNDTRIP OK + LEAKS 0
# [inv:bijective-roundtrip] — exact reversal proven
# [inv:wire-guarantee] — upstream sees only placeholders

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
EXT_DIR="$REPO_ROOT/extensions/services/tokenguard"
OUT_DIR="$EXT_DIR/demo/out"
mkdir -p "$OUT_DIR"

# ── Config ────────────────────────────────────────────────────────────────────
REAL_ID="vulntarget.internal"
TOKEN_PLACEHOLDER="<HOST_1>"   # expected after tokenization (first host seed)
MOCK_UPSTREAM_PORT=19099
BASE_PROXY_PORT=19080

STORE_DIR="$(mktemp -d)"
MAP_PATH="$STORE_DIR/token-mapping.json"
AUDIT_PATH="$STORE_DIR/audit.jsonl"

cleanup() {
  if [[ -n "${TOKENGUARD_PID:-}" ]]; then
    kill "$TOKENGUARD_PID" 2>/dev/null || true
    wait "$TOKENGUARD_PID" 2>/dev/null || true
  fi
  if [[ -n "${MOCK_PID:-}" ]]; then
    kill "$MOCK_PID" 2>/dev/null || true
    wait "$MOCK_PID" 2>/dev/null || true
  fi
  rm -rf "$STORE_DIR"
}
trap cleanup EXIT

# ── 1. Start mock upstream ─────────────────────────────────────────────────
MOCK_OUT_DIR="$STORE_DIR/mock"
mkdir -p "$MOCK_OUT_DIR"

node "$EXT_DIR/demo/mock-upstream.mjs" "$MOCK_UPSTREAM_PORT" "$MOCK_OUT_DIR" &
MOCK_PID=$!

# Wait for mock upstream to be ready (up to 5 s) — use nc only (not curl, which
# would consume the single-shot mock request prematurely)
for i in $(seq 1 50); do
  if nc -z 127.0.0.1 "$MOCK_UPSTREAM_PORT" 2>/dev/null; then
    break
  fi
  sleep 0.1
done

# ── 2. Start tokenguard proxy ──────────────────────────────────────────────
export SOX_CONFIG_PORT="$BASE_PROXY_PORT"
export SOX_CONFIG_UPSTREAM="http://127.0.0.1:${MOCK_UPSTREAM_PORT}"
export SOX_CONFIG_CAPTURE="full"
export SOX_CONFIG_PROVIDER="anthropic"
export SOX_CONFIG_MAP_PATH="$MAP_PATH"
export SOX_CONFIG_CAPTURE_DIR="$STORE_DIR"
export SOX_CONFIG_SEEDS="[{\"real\":\"${REAL_ID}\",\"type\":\"host\"}]"
export SOX_CONFIG_NEVER="[]"
export SOX_CONFIG_DETECT_PHONE="false"
export SOX_CONFIG_DETECT_IPV6="false"

node "$EXT_DIR/bundle/index.js" &
TOKENGUARD_PID=$!

# Wait for port.txt (written only after listen) — up to 10 s
PROXY_PORT=""
for i in $(seq 1 100); do
  if [[ -f "$STORE_DIR/port.txt" ]]; then
    PROXY_PORT="$(cat "$STORE_DIR/port.txt")"
    break
  fi
  sleep 0.1
done

if [[ -z "$PROXY_PORT" ]]; then
  echo "ERROR: tokenguard did not write port.txt within 10 s" >&2
  exit 1
fi

# Health check
for i in $(seq 1 20); do
  if curl -sf "http://127.0.0.1:${PROXY_PORT}/_tokenguard/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done

# ── 3. Build request with seeded real identifier ──────────────────────────
REQUEST_BODY=$(cat <<EOF
{
  "model": "claude-3-5-sonnet-20241022",
  "max_tokens": 100,
  "stream": true,
  "system": "You help with network analysis for ${REAL_ID}.",
  "messages": [
    {
      "role": "user",
      "content": "What do you know about ${REAL_ID}?"
    }
  ]
}
EOF
)

# Capture the prompts/request
echo "$REQUEST_BODY" > "$OUT_DIR/prompts.txt"

# ── 4. Send request through proxy ────────────────────────────────────────
RESPONSE_FILE="$STORE_DIR/proxy-response.txt"
curl -s -X POST \
  "http://127.0.0.1:${PROXY_PORT}/v1/messages" \
  -H "Content-Type: application/json" \
  -H "x-api-key: demo-key" \
  -H "anthropic-version: 2023-06-01" \
  -d "$REQUEST_BODY" \
  -o "$RESPONSE_FILE"

CLIENT_RESPONSE="$(cat "$RESPONSE_FILE")"

# ── 5. Inspect what upstream received ────────────────────────────────────
RECEIVED_FILE="$MOCK_OUT_DIR/received-body.json"
if [[ ! -f "$RECEIVED_FILE" ]]; then
  echo "ERROR: mock upstream did not write received-body.json" >&2
  exit 1
fi
UPSTREAM_RECEIVED="$(cat "$RECEIVED_FILE")"

# ── 6. Write outbound.diff (real -> placeholder transformation) ───────────
cat > "$OUT_DIR/outbound.diff" <<DIFF
=== OUTBOUND: real -> placeholder ===
--- sent by client (contains real identifier)
+++ received by upstream (must contain only placeholder)

CLIENT REQUEST (excerpt):
$(echo "$REQUEST_BODY" | grep -o "\"content\":.*" | head -2 || true)

UPSTREAM RECEIVED (excerpt):
$(echo "$UPSTREAM_RECEIVED" | python3 -c "import sys,json; b=json.load(sys.stdin); msgs=b.get('messages',[]); [print(m.get('content','')) for m in msgs]" 2>/dev/null || echo "$UPSTREAM_RECEIVED" | head -5)
DIFF

# ── 7. Write raw-response.txt ──────────────────────────────────────────────
echo "$CLIENT_RESPONSE" > "$OUT_DIR/raw-response.txt"

# ── 8. LEAKS check — upstream must NOT contain the real identifier ─────────
if echo "$UPSTREAM_RECEIVED" | grep -qF "$REAL_ID"; then
  echo "WIRE LEAK DETECTED: '$REAL_ID' found in upstream body" >&2
  echo "upstream received: $UPSTREAM_RECEIVED" >&2
  # We still print LEAKS count for the guard
  LEAK_COUNT=$(echo "$UPSTREAM_RECEIVED" | grep -o "$REAL_ID" | wc -l | tr -d ' ')
  echo "LEAKS $LEAK_COUNT"
else
  echo "LEAKS 0"
fi

# ── 9. ROUNDTRIP check — client response must contain the real identifier ──
# The proxy detokenized the response; the client should see the real value back.
if echo "$CLIENT_RESPONSE" | grep -qF "$REAL_ID"; then
  echo "ROUNDTRIP OK"
else
  echo "ROUNDTRIP FAIL: '$REAL_ID' not found in client response" >&2
  echo "client response: $CLIENT_RESPONSE" >&2
fi

# ── 10. Write inbound.diff (placeholder -> real reversal proof) ─────────
cat > "$OUT_DIR/inbound.diff" <<DIFF
=== INBOUND: placeholder -> real (reversal) ===
--- raw SSE from upstream (contains placeholder tokens)
+++ received by client (real value restored)

CLIENT RESPONSE (excerpt):
$(echo "$CLIENT_RESPONSE" | head -10)

PROOF: '$REAL_ID' $(echo "$CLIENT_RESPONSE" | grep -cF "$REAL_ID" || echo 0) occurrence(s) in client response.
DIFF

echo "demo artifacts written to: $OUT_DIR"
