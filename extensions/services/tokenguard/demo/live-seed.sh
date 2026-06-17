#!/usr/bin/env bash
# live-seed.sh — prove CLI seed reflected by running proxy without restart.
#
# Steps:
#   1. Start tokenguard proxy (bundle/index.js) — NO seeds for the test real.
#   2. Send traffic containing the test real identifier → passes through unseeded
#      (proxy has no mapping, so the real is not tokenized at this stage).
#   3. Run the CLI to seed that real → appends to token-mapping.json.
#   4. Wait ≤500ms for the proxy to reload via fs.watch debounce.
#   5. Send the SAME traffic again → real must now be replaced on the wire.
#   6. Assert the second upstream payload does NOT contain the real identifier.
#   7. Print LIVE SEED REFLECTED (or LIVE SEED MISSED).
#
# [tg-cli.5] [def:live-map] [inv:wire-guarantee]

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
EXT_DIR="$REPO_ROOT/extensions/services/tokenguard"
BUNDLE="$EXT_DIR/bundle/index.js"

# ── Ports ─────────────────────────────────────────────────────────────────────
MOCK_PORT=19199
BASE_PROXY_PORT=19180

STORE_DIR="$(mktemp -d)"
MAP_PATH="$STORE_DIR/token-mapping.json"

cleanup() {
  if [[ -n "${TOKENGUARD_PID:-}" ]]; then
    kill "$TOKENGUARD_PID" 2>/dev/null || true
    wait "$TOKENGUARD_PID" 2>/dev/null || true
  fi
  if [[ -n "${MOCK1_PID:-}" ]]; then
    kill "$MOCK1_PID" 2>/dev/null || true
    wait "$MOCK1_PID" 2>/dev/null || true
  fi
  if [[ -n "${MOCK2_PID:-}" ]]; then
    kill "$MOCK2_PID" 2>/dev/null || true
    wait "$MOCK2_PID" 2>/dev/null || true
  fi
  rm -rf "$STORE_DIR"
}
trap cleanup EXIT

# Use a plain custom identifier that won't be auto-detected by the FQDN/IP
# detectors — so it only appears in the upstream body after an explicit CLI seed.
REAL_ID="alice-operator-12345"

# ── 1. Start mock upstream (multi-request capable) ────────────────────────────
# We need the mock to accept two requests. Use a simple node server that stays up.
MOCK1_OUT="$STORE_DIR/mock1"
MOCK2_OUT="$STORE_DIR/mock2"
mkdir -p "$MOCK1_OUT" "$MOCK2_OUT"

# Write a persistent mock upstream (unlike single-shot mock-upstream.mjs)
PERSISTENT_MOCK="$STORE_DIR/persistent-mock.mjs"
cat > "$PERSISTENT_MOCK" <<'NODEEOF'
import http from 'node:http';
import fs from 'node:fs';

const PORT = parseInt(process.argv[2] ?? '19199', 10);
const OUT1 = process.argv[3] ?? '/tmp/mock1';
const OUT2 = process.argv[4] ?? '/tmp/mock2';

let requestCount = 0;

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    requestCount++;
    const body = Buffer.concat(chunks).toString('utf8');
    const outDir = requestCount === 1 ? OUT1 : OUT2;
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(outDir + '/received-body.json', body, 'utf8');

    // Echo first message content back as SSE
    let echoText = 'mock-reply';
    try {
      const parsed = JSON.parse(body);
      const msgs = parsed.messages;
      if (Array.isArray(msgs) && msgs.length > 0) {
        const first = msgs[0];
        if (first && typeof first.content === 'string') {
          echoText = first.content.slice(0, 80);
        }
      }
    } catch {}

    const mid = Math.max(1, Math.floor(echoText.length / 2));
    const part1 = echoText.slice(0, mid);
    const part2 = echoText.slice(mid);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
    });

    const events = [
      { type: 'message_start', message: { id: 'mock', type: 'message', role: 'assistant', content: [], model: 'mock', stop_reason: null } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: part1 } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: part2 } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
      { type: 'message_stop' },
    ];
    for (const ev of events) {
      res.write('event: ' + ev.type + '\ndata: ' + JSON.stringify(ev) + '\n\n');
    }
    res.end();
  });
});

server.listen(PORT, '127.0.0.1', () => {
  process.stderr.write('persistent-mock: listening on ' + PORT + '\n');
});
NODEEOF

node "$PERSISTENT_MOCK" "$MOCK_PORT" "$MOCK1_OUT" "$MOCK2_OUT" &
MOCK1_PID=$!

# Wait for mock upstream
for i in $(seq 1 50); do
  if nc -z 127.0.0.1 "$MOCK_PORT" 2>/dev/null; then break; fi
  sleep 0.1
done

# ── 2. Start tokenguard proxy — NO seeds for the test real ───────────────────
export SOX_CONFIG_PORT="$BASE_PROXY_PORT"
export SOX_CONFIG_UPSTREAM="http://127.0.0.1:${MOCK_PORT}"
export SOX_CONFIG_CAPTURE="full"
export SOX_CONFIG_PROVIDER="anthropic"
export SOX_CONFIG_MAP_PATH="$MAP_PATH"
export SOX_CONFIG_CAPTURE_DIR="$STORE_DIR"
export SOX_CONFIG_SEEDS="[]"
export SOX_CONFIG_NEVER="[]"
export SOX_CONFIG_DETECT_PHONE="false"
export SOX_CONFIG_DETECT_IPV6="false"

node "$BUNDLE" &
TOKENGUARD_PID=$!

# Wait for port.txt
PROXY_PORT=""
for i in $(seq 1 100); do
  if [[ -f "$STORE_DIR/port.txt" ]]; then
    PROXY_PORT="$(cat "$STORE_DIR/port.txt")"
    break
  fi
  sleep 0.1
done

if [[ -z "$PROXY_PORT" ]]; then
  echo "ERROR: tokenguard did not write port.txt within 10s" >&2
  exit 1
fi

# Health check
for i in $(seq 1 20); do
  if curl -sf "http://127.0.0.1:${PROXY_PORT}/_tokenguard/health" >/dev/null 2>&1; then break; fi
  sleep 0.1
done

# ── 3. First request — real passes through unseeded ──────────────────────────
REQUEST_BODY=$(cat <<REQEOF
{
  "model": "claude-3-5-sonnet-20241022",
  "max_tokens": 100,
  "stream": true,
  "system": "You help with ${REAL_ID}.",
  "messages": [{"role": "user", "content": "Tell me about ${REAL_ID}."}]
}
REQEOF
)

curl -s -X POST \
  "http://127.0.0.1:${PROXY_PORT}/v1/messages" \
  -H "Content-Type: application/json" \
  -H "x-api-key: demo-key" \
  -H "anthropic-version: 2023-06-01" \
  -d "$REQUEST_BODY" \
  -o "$STORE_DIR/response1.txt"

UPSTREAM1="$(cat "$MOCK1_OUT/received-body.json" 2>/dev/null || echo '')"

# Before seeding, real should appear in the upstream body (not yet tokenized)
if echo "$UPSTREAM1" | grep -qF "$REAL_ID"; then
  echo "Pre-seed: real identifier passed through (expected — not yet in map)"
else
  echo "Pre-seed: real identifier not found in upstream body (unexpected)" >&2
fi

# ── 4. CLI seed — append the real identifier to the live map ─────────────────
# Use direct node invocation of the CLI dist (SOX_EXEC_CLI=1 ensures service
# mode is not triggered in index.ts).
SEED_OUTPUT=$(SOX_CONFIG_MAP_PATH="$MAP_PATH" node "$BUNDLE" seed "$REAL_ID" label 2>&1)
echo "CLI seed output: $SEED_OUTPUT"

# Verify the map file now contains the new entry
if ! grep -qF "$REAL_ID" "$MAP_PATH" 2>/dev/null; then
  echo "ERROR: $REAL_ID not found in token-mapping.json after seed" >&2
  echo "LIVE SEED MISSED"
  exit 1
fi

ALLOCATED_TOKEN=$(node -e "
const f = require('fs');
const d = JSON.parse(f.readFileSync('$MAP_PATH','utf8'));
const e = d.entries.find(x => x.real === '$REAL_ID');
console.log(e ? e.token : '');
" 2>/dev/null || echo '')

echo "Allocated token: $ALLOCATED_TOKEN"

# ── 5. Wait for proxy to reload (fs.watch + ~100ms debounce) ─────────────────
# The watch fires within ~100ms of the atomic rename. We wait up to 600ms.
for i in $(seq 1 6); do
  sleep 0.1
done

# ── 6. Second request — same traffic, real should now be tokenized ────────────
curl -s -X POST \
  "http://127.0.0.1:${PROXY_PORT}/v1/messages" \
  -H "Content-Type: application/json" \
  -H "x-api-key: demo-key" \
  -H "anthropic-version: 2023-06-01" \
  -d "$REQUEST_BODY" \
  -o "$STORE_DIR/response2.txt"

UPSTREAM2="$(cat "$MOCK2_OUT/received-body.json" 2>/dev/null || echo '')"

echo "Second upstream body excerpt: $(echo "$UPSTREAM2" | head -3)"

# ── 7. Assert — real must NOT appear in second upstream body ─────────────────
if echo "$UPSTREAM2" | grep -qF "$REAL_ID"; then
  echo "LIVE SEED MISSED: real identifier '$REAL_ID' still visible in second upstream body" >&2
  echo "LIVE SEED MISSED"
  exit 1
fi

if [[ -n "$ALLOCATED_TOKEN" ]] && echo "$UPSTREAM2" | grep -qF "$ALLOCATED_TOKEN"; then
  echo "Token '$ALLOCATED_TOKEN' confirmed in second upstream body"
fi

echo "LIVE SEED REFLECTED"
