#!/usr/bin/env bash
# run-sdlc-experiment.sh — Launch parallel CF/RF SDLC chains and monitor them live.
#
# Usage:
#   ./run-sdlc-experiment.sh --backlog-id FEAT-002 --repo ~/dev/node/adhd
#
# What it does:
#   1. Creates isolated worktrees under ~/dev/.sdlc-experiments/arm-{cf,rf}/<id>/
#   2. Writes the backlog item body to FEATURE.md in each worktree
#   3. Launches opencode with SDLC-RF and SDLC-CF agents in parallel
#   4. Polls the proxy session logs every 10s, printing live metrics
#   5. Detects stalls (no new turn events in 60s) and warns loudly
#   6. On SIGINT/SIGTERM, kills ONLY the spawned opencode children — never the proxy
#
# Env overrides:
#   BASE_DIR        default: ~/dev/.sdlc-experiments
#   PROXY_DIR       default: <script-dir> (where proxy-ses_*.jsonl live)
#   OPencode_CMD    default: "opencode"
#   OPENCODE_FLAGS  extra flags passed to both opencode invocations
#   STALL_SECONDS   stall detection threshold (default: 60)
#   POLL_SECONDS    metrics refresh interval (default: 10)
#   TIMEOUT_MINUTES hard kill after this many minutes (default: 0 = no timeout)

set -euo pipefail

# ── Defaults ──
BACKLOG_ID=""
REPO=""
REPO_KEY="${REPO_KEY:-}"  # optional: backlog DB repo key, auto-detected if unset
BASE_DIR="${BASE_DIR:-$HOME/dev/.sdlc-experiments}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROXY_DIR="${PROXY_DIR:-$SCRIPT_DIR}"
OPencode_CMD="${OPencode_CMD:-opencode}"
OPENCODE_FLAGS="${OPENCODE_FLAGS:-}"
STALL_SECONDS="${STALL_SECONDS:-60}"
POLL_SECONDS="${POLL_SECONDS:-10}"
TIMEOUT_MINUTES="${TIMEOUT_MINUTES:-0}"

# ── Parse args ──
while [[ $# -gt 0 ]]; do
  case "$1" in
    --backlog-id) BACKLOG_ID="$2"; shift 2 ;;
    --repo)       REPO="$2"; shift 2 ;;
    --repo-key)   REPO_KEY="$2"; shift 2 ;;
    --base-dir)   BASE_DIR="$2"; shift 2 ;;
    --proxy-dir)  PROXY_DIR="$2"; shift 2 ;;
    --stall)      STALL_SECONDS="$2"; shift 2 ;;
    --poll)       POLL_SECONDS="$2"; shift 2 ;;
    --timeout)    TIMEOUT_MINUTES="$2"; shift 2 ;;
    *) echo "Unknown flag: $1"; exit 1 ;;
  esac
done

if [[ -z "$BACKLOG_ID" || -z "$REPO" ]]; then
  echo "Usage: $0 --backlog-id <id> --repo <path-to-repo> [--repo-key <key>]"
  echo "  --backlog-id   Backlog item ID (e.g. FEAT-002)"
  echo "  --repo         Path to the bare/working git repo for worktree creation"
  echo "  --repo-key     Backlog DB repo key (auto-detected via export-json if unset)"
  echo "  --base-dir     Worktree parent dir (default: ~/dev/.sdlc-experiments)"
  echo "  --proxy-dir    Directory with proxy-ses_*.jsonl logs (default: script dir)"
  echo "  --stall        Seconds before stall warning (default: 60)"
  echo "  --poll         Metrics refresh interval (default: 10)"
  echo "  --timeout      Hard kill after N minutes (0 = no timeout)"
  exit 1
fi

REPO="$(cd "$REPO" 2>/dev/null && pwd || echo "$REPO")"
mkdir -p "$BASE_DIR"

WT_RF="$BASE_DIR/arm-rf/$BACKLOG_ID"
WT_CF="$BASE_DIR/arm-cf/$BACKLOG_ID"

AGGREGATOR="$PROXY_DIR/aggregate-session.mjs"

# ── Colors for loud errors ──
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# ── Track spawned PIDs ──
declare -a SPAWNED=()
RF_PID=""
CF_PID=""
RF_SESSION=""
CF_SESSION=""
START_TIME=""

cleanup() {
  echo -e "\n${YELLOW}→ Cleaning up spawned processes only...${NC}"
  for pid in "${SPAWNED[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      echo "  killing pid $pid"
      kill "$pid" 2>/dev/null || true
    fi
  done
  # Give them a moment to die, then force
  sleep 1
  for pid in "${SPAWNED[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      echo "  force-killing pid $pid"
      kill -9 "$pid" 2>/dev/null || true
    fi
  done
  echo -e "${GREEN}✓ Cleanup complete. Proxy and other processes untouched.${NC}"
}
trap cleanup EXIT INT TERM

# ── Step 1: Create worktrees ──
echo "=== Creating worktrees ==="
for arm in rf cf; do
  WT="$BASE_DIR/arm-$arm/$BACKLOG_ID"
  BRANCH="arm-${arm}-$(date +%Y%m%d-%H%M%S)"
  if [[ -d "$WT" ]]; then
    echo "  removing existing $WT"
    rm -rf "$WT"
  fi
  echo "  creating $WT (branch: $BRANCH)"
  git -C "$REPO" worktree add "$WT" -b "$BRANCH" main 2>&1 | sed 's/^/    /'
done

# ── Step 2: Write FEATURE.md ──
echo ""
echo "=== Reading backlog item: $BACKLOG_ID ==="
# Use export-json (works across repos, no --repo key needed) and filter by humanId
FEATURE_BODY=$(backlog export-json 2>/dev/null | python3 -c "
import sys, json
items = json.load(sys.stdin)
for it in items:
    hid = it.get('humanId','')
    if hid == '$BACKLOG_ID':
        repo = it.get('repo','')
        print(f'REPO_KEY={repo}')
        print(f'TITLE={it.get(\"title\",\"\")}')
        print(f'BODY_START')
        print(it.get('body',''))
        break
" 2>/dev/null)

if [[ -z "$FEATURE_BODY" ]]; then
  echo -e "${YELLOW}  Could not fetch item via backlog. Creating placeholder FEATURE.md.${NC}"
  FEATURE_TITLE="Feature: $BACKLOG_ID"
  FEATURE_DESC="Could not fetch item from backlog DB. Please write the feature description manually."
  DETECTED_REPO_KEY=""
else
  DETECTED_REPO_KEY=$(echo "$FEATURE_BODY" | grep '^REPO_KEY=' | sed 's/^REPO_KEY=//')
  FEATURE_TITLE=$(echo "$FEATURE_BODY" | grep '^TITLE=' | sed 's/^TITLE=//')
  FEATURE_DESC=$(echo "$FEATURE_BODY" | sed -n '/^BODY_START$/,$ p' | tail -n +2)
  echo "  title: $FEATURE_TITLE"
  if [[ -n "$DETECTED_REPO_KEY" ]]; then
    echo "  repo:  $DETECTED_REPO_KEY"
  fi
fi

# Use detected repo key if none was specified
if [[ -z "$REPO_KEY" && -n "$DETECTED_REPO_KEY" ]]; then
  REPO_KEY="$DETECTED_REPO_KEY"
fi

for arm in rf cf; do
  WT="$BASE_DIR/arm-$arm/$BACKLOG_ID"
  cat > "$WT/FEATURE.md" <<FEATUREDOC
# Feature: $BACKLOG_ID

$FEATURE_BODY
FEATUREDOC
  echo "  wrote $WT/FEATURE.md"
done

# ── Step 3: Launch agents ──
echo ""
echo "=== Launching SDLC agents ==="

# RF arm
(
  cd "$WT_RF"
  echo "  [RF] launching in $WT_RF (log: $WT_RF/sdlc-rf.log)"
  $OPencode_CMD run --agent SDLC-RF "${REPO_KEY}::${BACKLOG_ID}" >"$WT_RF/sdlc-rf.log" 2>&1 &
  RF_PID=$!
  SPAWNED+=($RF_PID)
  wait $RF_PID
) &
RF_JOB=$!
SPAWNED+=($RF_JOB)

# CF arm
(
  cd "$WT_CF"
  echo "  [CF] launching in $WT_CF (log: $WT_CF/sdlc-cf.log)"
  $OPencode_CMD run --agent SDLC-CF "${REPO_KEY}::${BACKLOG_ID}" >"$WT_CF/sdlc-cf.log" 2>&1 &
  CF_PID=$!
  SPAWNED+=($CF_PID)
  wait $CF_PID
) &
CF_JOB=$!
SPAWNED+=($CF_JOB)

START_TIME=$(date +%s)
echo ""
echo "Both arms launched. Monitoring proxy logs..."
echo "  RF worktree: $WT_RF"
echo "  CF worktree: $WT_CF"
echo ""

# ── Step 4: Discover sessions ──
sleep 3  # Give opencode time to create sessions

# Find the newest session files for each arm (heuristic: most recent mtime after START_TIME)
find_session() {
  local arm="$1"
  local newest=""
  local newest_ts=0
  for f in "$PROXY_DIR"/proxy-ses_*.jsonl; do
    [[ -f "$f" ]] || continue
    local mtime
    mtime=$(stat -f %m "$f" 2>/dev/null || stat -c %Y "$f" 2>/dev/null || echo 0)
    if [[ "$mtime" -gt "$START_TIME" && "$mtime" -gt "$newest_ts" ]]; then
      # quick check: does this file have turn events?
      if grep -q '"event":"turn"' "$f" 2>/dev/null; then
        newest="$f"
        newest_ts="$mtime"
      fi
    fi
  done
  if [[ -n "$newest" ]]; then
    basename "$newest" | sed 's/^proxy-ses_//' | sed 's/\.jsonl$//'
  fi
}

# Wait a bit more for sessions to appear
sleep 2
RF_SESSION=""
CF_SESSION=""
for f in $(ls -t "$PROXY_DIR"/proxy-ses_*.jsonl 2>/dev/null | head -10); do
  sid=$(basename "$f" | sed 's/^proxy-ses_//' | sed 's/\.jsonl$//')
  [[ "$sid" == test_* ]] && continue
  mtime=$(stat -f %m "$f" 2>/dev/null || stat -c %Y "$f" 2>/dev/null || echo 0)
  if [[ "$mtime" -gt "$START_TIME" ]]; then
    if [[ -z "$RF_SESSION" ]]; then
      RF_SESSION="$sid"
      echo "  [RF] detected session: $RF_SESSION"
    elif [[ -z "$CF_SESSION" ]]; then
      CF_SESSION="$sid"
      echo "  [CF] detected session: $CF_SESSION"
      break
    fi
  fi
done

if [[ -z "$RF_SESSION" && -z "$CF_SESSION" ]]; then
  echo -e "${RED}WARNING: No proxy sessions detected. Is the proxy running on port 3333?${NC}"
  echo "  Continuing to poll, but metrics will be empty until sessions appear."
fi

# ── Step 5: Monitor loop ──
echo ""
echo "=== Live metrics (refreshing every ${POLL_SECONDS}s) ==="

last_rf_turns=0
last_cf_turns=0
last_rf_ts=0
last_cf_ts=0
iteration=0

get_turn_count() {
  local sid="$1"
  [[ -z "$sid" ]] && echo "0" && return
  local f="$PROXY_DIR/proxy-ses_${sid}.jsonl"
  [[ -f "$f" ]] || { echo "0"; return; }
  grep -c '"event":"turn"' "$f" 2>/dev/null || echo "0"
}

get_last_turn_ts() {
  local sid="$1"
  [[ -z "$sid" ]] && echo "0" && return
  local f="$PROXY_DIR/proxy-ses_${sid}.jsonl"
  [[ -f "$f" ]] || { echo "0"; return; }
  python3 -c "
import json
ts = 0
with open('$f') as fh:
    for line in fh:
        try:
            d = json.loads(line)
            if d.get('event') == 'turn':
                ts = d.get('_ts','')
        except: pass
if ts:
    from datetime import datetime
    dt = datetime.fromisoformat(ts.replace('Z','+00:00'))
    print(int(dt.timestamp()))
else:
    print(0)
" 2>/dev/null || echo "0"
}

while true; do
  iteration=$((iteration + 1))
  NOW=$(date +%s)
  RUNTIME=$((NOW - START_TIME))
  RUNTIME_FMT=$(printf "%02d:%02d" $((RUNTIME / 60)) $((RUNTIME % 60)))

  # Get current turn counts and last turn timestamps
  RF_TURNS=$(get_turn_count "$RF_SESSION")
  CF_TURNS=$(get_turn_count "$CF_SESSION")
  RF_LAST_TS=$(get_last_turn_ts "$RF_SESSION")
  CF_LAST_TS=$(get_last_turn_ts "$CF_SESSION")

  # Check if either arm has completed (processes exited)
  RF_ALIVE=false; CF_ALIVE=false
  if [[ -n "$RF_PID" ]] && kill -0 "$RF_PID" 2>/dev/null; then RF_ALIVE=true; fi
  if [[ -n "$CF_PID" ]] && kill -0 "$CF_PID" 2>/dev/null; then CF_ALIVE=true; fi
  # Also check if session file is still being written (mtime recent)
  if [[ -n "$RF_SESSION" ]]; then
    rf_mtime=$(stat -f %m "$PROXY_DIR/proxy-ses_${RF_SESSION}.jsonl" 2>/dev/null || echo 0)
    if [[ "$rf_mtime" -gt $((NOW - 15)) ]]; then RF_ALIVE=true; fi
  fi
  if [[ -n "$CF_SESSION" ]]; then
    cf_mtime=$(stat -f %m "$PROXY_DIR/proxy-ses_${CF_SESSION}.jsonl" 2>/dev/null || echo 0)
    if [[ "$cf_mtime" -gt $((NOW - 15)) ]]; then CF_ALIVE=true; fi
  fi

  echo ""
  echo -e "${CYAN}── Iteration $iteration ── [$RUNTIME_FMT elapsed] ── $(date '+%H:%M:%S') ──${NC}"

  # ── Stage headers ──
  RF_STATUS="${GREEN}● LIVE${NC}"
  CF_STATUS="${GREEN}● LIVE${NC}"
  if ! $RF_ALIVE; then RF_STATUS="${YELLOW}○ done?${NC}"; fi
  if ! $CF_ALIVE; then CF_STATUS="${YELLOW}○ done?${NC}"; fi

  # ── Stall detection ──
  if [[ "$RF_LAST_TS" -gt 0 ]]; then
    rf_stall=$((NOW - RF_LAST_TS))
    if [[ "$rf_stall" -gt "$STALL_SECONDS" ]]; then
      echo -e "${RED}⚠ STALL: RF arm — no new turns in ${rf_stall}s (last turn at $(date -r $RF_LAST_TS '+%H:%M:%S' 2>/dev/null || echo '?'))${NC}"
    fi
  fi
  if [[ "$CF_LAST_TS" -gt 0 ]]; then
    cf_stall=$((NOW - CF_LAST_TS))
    if [[ "$cf_stall" -gt "$STALL_SECONDS" ]]; then
      echo -e "${RED}⚠ STALL: CF arm — no new turns in ${cf_stall}s (last turn at $(date -r $CF_LAST_TS '+%H:%M:%S' 2>/dev/null || echo '?'))${NC}"
    fi
  fi

  # ── Per-arm summary ──
  echo -e "  RF: $RF_STATUS  session=$RF_SESSION  turns=$RF_TURNS  pid=${RF_PID:-?}"
  echo -e "  CF: $CF_STATUS  session=$CF_SESSION  turns=$CF_TURNS  pid=${CF_PID:-?}"

  # ── Run aggregator for each arm ──
  if [[ -n "$RF_SESSION" ]]; then
    echo ""
    echo "  ── RF Metrics ──"
    node "$AGGREGATOR" "$RF_SESSION" 2>/dev/null | head -20 || echo "    (aggregator not available)"
  fi
  if [[ -n "$CF_SESSION" ]]; then
    echo ""
    echo "  ── CF Metrics ──"
    node "$AGGREGATOR" "$CF_SESSION" 2>/dev/null | head -20 || echo "    (aggregator not available)"
  fi

  # ── End conditions ──
  if ! $RF_ALIVE && ! $CF_ALIVE && [[ "$RF_TURNS" -gt 5 && "$CF_TURNS" -gt 5 ]]; then
    echo ""
    echo -e "${GREEN}✓ Both arms appear complete.${NC}"
    echo ""
    echo "=== Final results ==="
    if [[ -n "$RF_SESSION" ]]; then
      echo ""
      echo "── RF Final ──"
      node "$AGGREGATOR" "$RF_SESSION" 2>/dev/null || echo "(aggregator error)"
    fi
    if [[ -n "$CF_SESSION" ]]; then
      echo ""
      echo "── CF Final ──"
      node "$AGGREGATOR" "$CF_SESSION" 2>/dev/null || echo "(aggregator error)"
    fi
    break
  fi

  # ── Hard timeout ──
  if [[ "$TIMEOUT_MINUTES" -gt 0 ]]; then
    timeout_sec=$((TIMEOUT_MINUTES * 60))
    if [[ "$RUNTIME" -gt "$timeout_sec" ]]; then
      echo -e "${RED}⏰ TIMEOUT: ${TIMEOUT_MINUTES} minutes reached. Killing spawned processes.${NC}"
      cleanup
      exit 1
    fi
  fi

  sleep "$POLL_SECONDS"
done

echo ""
echo -e "${GREEN}Experiment complete. Worktrees:${NC}"
echo "  RF: $WT_RF"
echo "  CF: $WT_CF"
echo "  Session logs:"
echo "    RF: $PROXY_DIR/proxy-ses_${RF_SESSION}.jsonl"
echo "    CF: $PROXY_DIR/proxy-ses_${CF_SESSION}.jsonl"
