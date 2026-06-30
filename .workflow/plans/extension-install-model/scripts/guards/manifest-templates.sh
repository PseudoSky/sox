#!/usr/bin/env bash
# manifest-templates guard — [dod.1]: soxe init <type> <id> produces an extension
# that passes soxe validate for every active type. Sources [def:probe-harness].

set -uo pipefail
source "$(dirname "$0")/../sox-probe.sh"
probe_init

# Active types (prompt is parked by design per CLAUDE.md B1).
TYPES="agent skill mcp-server command hook bundle"

for TYPE in $TYPES; do
  ID="test-${TYPE}-init"

  # Run: soxe init <type> <id> from $FRESH — uses the real CLI.
  soxe init "$TYPE" "$ID"
  assert_exit0 "soxe init $TYPE $ID"

  # Find the created dir — types use different subdir names.
  case "$TYPE" in
    agent)      SUBDIR="agents" ;;
    skill)      SUBDIR="skills" ;;
    mcp-server) SUBDIR="mcp-servers" ;;
    command)    SUBDIR="commands" ;;
    hook)       SUBDIR="hooks" ;;
    bundle)     SUBDIR="bundles" ;;
  esac

  EXT_PATH="$FRESH/extensions/$SUBDIR/$ID"
  assert_dir "$EXT_PATH"

  # Run: soxe validate <path> — must exit 0 with no [ERROR] in stdout.
  soxe validate "$EXT_PATH"
  assert_exit0 "soxe validate $TYPE/$ID"

  # Check stdout for [ERROR] tokens (validate must be clean).
  case "$LAST_OUT" in
    *"[ERROR]"*)
      _bad "validate emitted [ERROR] for $TYPE/$ID: ${LAST_OUT:0:200}" ;;
    *)
      _ok "validate clean (no [ERROR]) for $TYPE/$ID" ;;
  esac
done

probe_done
