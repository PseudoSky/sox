#!/usr/bin/env bash
# restart-cf-proxy.sh — SAFE restart of the content-first proxy on port 3333.
#
# WHY THIS SCRIPT EXISTS (read before using anything else):
#
# The naive `kill $(lsof -ti:3333)` is DANGEROUS and has killed the opencode
# service TWICE. lsof -i:3333 matches ANY process with a socket touching port
# 3333 — the LISTENER (the proxy) AND any CLIENT. opencode holds a live
# client connection to 3333 whenever a session is streaming through the
# proxy, so `lsof -ti:3333` returns BOTH PIDs, and `kill $(...)` kills BOTH.
#
# SAFE RULE: never kill by port. Kill by exact process identity — the
# proxy's own command line — so opencode (a client, never the process named
# "cf-proxy.mjs") can never be matched.

set -u

PROXY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROXY_CMD="node cf-proxy.mjs"
LOG_FILE="${CF_LOG:-/tmp/cf-proxy-restart.log}"

# ---------------------------------------------------------------------------
# 1. Find the proxy by EXACT process identity (command-line match), never by
#    port. `pgrep -f "node cf-proxy.mjs"` matches only the proxy process —
#    opencode is "opencode web", a different command line entirely.
# ---------------------------------------------------------------------------
proxy_pid="$(pgrep -f "^node cf-proxy\.mjs$" | head -1 || true)"

if [ -n "$proxy_pid" ]; then
  echo "→ Found cf-proxy: PID $proxy_pid ($(ps -o lstart -p "$proxy_pid" 2>/dev/null | tail -1))"
  # Sanity: confirm the matched process really is the proxy, not something
  # that happens to contain the string.
  if ps -o command= -p "$proxy_pid" | grep -q "cf-proxy.mjs"; then
    echo "→ Confirmed command: $(ps -o command= -p "$proxy_pid")"
    echo "→ Stopping ONLY PID $proxy_pid (opencode is a different process — untouched)"
    kill "$proxy_pid"
    # Wait for the port to actually free (poll, don't assume)
    for i in $(seq 1 10); do
      if ! lsof -nP -iTCP:3333 -sTCP:LISTEN >/dev/null 2>&1; then
        echo "→ Port 3333 released after ${i}0ms"
        break
      fi
      sleep 0.1
    done
  else
    echo "✗ Matched process is NOT cf-proxy — refusing to kill. Aborting."
    exit 1
  fi
else
  echo "→ No running cf-proxy found (clean start)"
fi

# ---------------------------------------------------------------------------
# 2. Start the proxy fresh.
# ---------------------------------------------------------------------------
echo "→ Starting cf-proxy (log: $LOG_FILE)"
cd "$PROXY_DIR"
nohup node cf-proxy.mjs > "$LOG_FILE" 2>&1 &
disown

# ---------------------------------------------------------------------------
# 3. Wait for health (poll, fail loudly if it doesn't come up)
# ---------------------------------------------------------------------------
for i in $(seq 1 20); do
  if curl -sf -m 2 http://localhost:3333/v1/health >/dev/null 2>&1; then
    echo "→ cf-proxy is UP: $(curl -s -m 2 http://localhost:3333/v1/health | head -c 80)"
    exit 0
  fi
  sleep 0.3
done

echo "✗ cf-proxy failed to become healthy within 6s. Check $LOG_FILE"
exit 1
