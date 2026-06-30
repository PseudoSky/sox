#!/usr/bin/env bash
# sox-probe.sh — [def:probe-harness] for the extension-install-model plan.
#
# THE airtight mechanism. Every behavioral guard and every behavioral final-audit
# check sources this and runs the REAL `node $REPO/bin/sox <verb>` in:
#   (1) an isolated SOX_HOME sandbox ($SBX), and
#   (2) a fresh working directory outside the repo ($FRESH),
# then asserts the OBSERVABLE on disk / process / stderr — never a unit test,
# grep of source, or library call. [inv:sandbox-isolation].
#
# Usage:
#   source scripts/sox-probe.sh
#   probe_init                 # set REPO, make $SBX + $FRESH, snapshot real home
#   soxe install foo --host claude --scope project   # runs `node $REPO/bin/sox ... --root $SBX`
#   assert_file "$SBX/.claude/skills/foo/SKILL.md"
#   probe_done                 # assert zero real-home writes, clean up, report
#
# Exit: probe_done returns nonzero if any assert failed OR real home was touched.

set -uo pipefail

REPO="${REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)}"
PROBE_PASS=0
PROBE_FAIL=0
SBX=""
FRESH=""
_RH_CLAUDE_SNAP=""
_RH_CODEX_SNAP=""
LAST_OUT=""
LAST_ERR=""
LAST_RC=0

# --- real-home snapshot (so we can prove zero writes) -----------------------
# Snapshot only the sub-paths that soxe could WRITE to (install targets).
# Excludes paths written continuously by the host toolchain (not by sox):
#
#   projects/            — session transcripts (*.jsonl)
#   file-history/        — Claude Code file-change snapshots (written on every Read)
#   hooks/               — swarm-cost hook session logs + state.json
#   plugins/             — plugin cache (node_modules, static)
#   .DS_Store            — macOS filesystem metadata (modified by Finder/Spotlight)
#   .sox/                — soxe ledger (written by soxe but INSIDE SBX; excluded to prevent
#                          false positives from pre-existing project ledger entries)
#   daemon.log           — Claude daemon log (written by daemon process)
#   daemon.status.json   — Claude daemon status (updated by daemon)
#   daemon.lock          — Claude daemon lock file
#   daemon-auth-*        — Claude daemon auth state
#   history.jsonl        — Claude session command history (written by Claude Code)
#   mcp-needs-auth-cache.json — MCP auth cache (updated by MCP subsystem)
#   stats-cache.json     — Stats/telemetry cache (updated by Claude Code)
#   swarm-cost.log       — Swarm cost tracking log (written by hooks)
#   ide/                 — IDE integration lock files (updated by IDE plugin)
#   cache/               — Claude Code update/changelog cache
#   .last-cleanup        — Cleanup timestamp (updated by daemon)
#   .last-update-result.json — Update check result (updated by daemon)
#   .credentials.json    — Claude Code auth credentials (written by auth flow)
#   CLAUDE.md            — Claude Code project memory file (written by the agent)
#   backups/             — Claude Code config backups (written on settings changes)
#
# soxe init/validate NEVER writes to ~/.claude; soxe install writes only to:
#   ~/.claude/commands/, ~/.claude/skills/, ~/.claude/agents/, etc.
# Those directories are covered by the hash of the remaining paths below.
_snapshot_realhome() {
  _RH_CLAUDE_SNAP="$(cd && find "$HOME/.claude" -type f \
    ! -path "$HOME/.claude/projects/*" \
    ! -path "$HOME/.claude/file-history/*" \
    ! -path "$HOME/.claude/hooks/*" \
    ! -path "$HOME/.claude/plugins/*" \
    ! -path "$HOME/.claude/.sox/*" \
    ! -path "$HOME/.claude/ide/*" \
    ! -path "$HOME/.claude/cache/*" \
    ! -path "$HOME/.claude/backups/*" \
    ! -name ".DS_Store" \
    ! -name "daemon.log" \
    ! -name "daemon.status.json" \
    ! -name "daemon.lock" \
    ! -name "daemon-auth-status.json" \
    ! -name "daemon-auth-cooldown" \
    ! -name "history.jsonl" \
    ! -name "mcp-needs-auth-cache.json" \
    ! -name "stats-cache.json" \
    ! -name "swarm-cost.log" \
    ! -name ".last-cleanup" \
    ! -name ".last-update-result.json" \
    ! -name ".credentials.json" \
    ! -name "CLAUDE.md" \
    2>/dev/null | sort | xargs -I{} sh -c 'printf "%s %s\n" "$(shasum "{}" 2>/dev/null | cut -d" " -f1)" "{}"' 2>/dev/null | shasum | cut -d" " -f1)"
  _RH_CODEX_SNAP="$(cd && find "$HOME/.codex" -type f \
    ! -path "$HOME/.codex/projects/*" \
    ! -path "$HOME/.codex/file-history/*" \
    ! -path "$HOME/.codex/hooks/*" \
    ! -path "$HOME/.codex/plugins/*" \
    ! -path "$HOME/.codex/.sox/*" \
    ! -path "$HOME/.codex/ide/*" \
    ! -path "$HOME/.codex/cache/*" \
    ! -name ".DS_Store" \
    ! -name "daemon.log" \
    ! -name "daemon.status.json" \
    ! -name "daemon.lock" \
    ! -name "daemon-auth-status.json" \
    ! -name "daemon-auth-cooldown" \
    ! -name "history.jsonl" \
    ! -name "mcp-needs-auth-cache.json" \
    ! -name "stats-cache.json" \
    ! -name "swarm-cost.log" \
    ! -name ".last-cleanup" \
    ! -name ".last-update-result.json" \
    2>/dev/null | sort | xargs -I{} sh -c 'printf "%s %s\n" "$(shasum "{}" 2>/dev/null | cut -d" " -f1)" "{}"' 2>/dev/null | shasum | cut -d" " -f1)"
}

probe_init() {
  SBX="$(mktemp -d "${TMPDIR:-/tmp}/sox-sbx.XXXXXX")"
  FRESH="$(mktemp -d "${TMPDIR:-/tmp}/sox-fresh.XXXXXX")"
  export SOX_HOME="$SBX" # [inv:sandbox-isolation]: reroots ALL scopes
  PROBE_PASS=0
  PROBE_FAIL=0
  _snapshot_realhome
}

# sox <args...> — runs the REAL cli from $FRESH (a foreign cwd), rerooted to $SBX.
sox() {
  pushd "$FRESH" >/dev/null 2>&1 || return 1
  LAST_OUT="$(SOX_HOME="$SBX" node "$REPO/bin/sox" "$@" --root "$SBX" 2>/tmp/sox-probe-err.$$)"
  LAST_RC=$?
  LAST_ERR="$(cat /tmp/sox-probe-err.$$ 2>/dev/null)"
  rm -f /tmp/sox-probe-err.$$
  popd >/dev/null 2>&1
  return $LAST_RC
}

# --- assertions -------------------------------------------------------------
_ok() {
  PROBE_PASS=$((PROBE_PASS + 1))
  echo "    ok   $1"
}
_bad() {
  PROBE_FAIL=$((PROBE_FAIL + 1))
  echo "    FAIL $1"
}

assert_exit0() { [ "$LAST_RC" -eq 0 ] && _ok "exit 0: $1" || _bad "expected exit 0 (got $LAST_RC): $1 :: ${LAST_ERR:0:200}"; }
assert_nonzero() { [ "$LAST_RC" -ne 0 ] && _ok "exit!=0 (denied): $1" || _bad "expected nonzero exit: $1"; }
assert_file() { [ -f "$1" ] && _ok "file exists: $1" || _bad "missing file: $1"; }
assert_dir() { [ -d "$1" ] && _ok "dir exists: $1" || _bad "missing dir: $1"; }
assert_absent() { [ ! -e "$1" ] && _ok "absent: $1" || _bad "should NOT exist: $1"; }
assert_stdout() { case "$LAST_OUT" in *"$1"*) _ok "stdout has: $1" ;; *) _bad "stdout lacks '$1': ${LAST_OUT:0:200}" ;; esac }
assert_stderr_clean() { case "$LAST_ERR" in *"MODULE_NOT_FOUND"* | *"Cannot find module '@adhd"*) _bad "import error in stderr: ${LAST_ERR:0:200}" ;; *) _ok "no @adhd import errors: $1" ;; esac }
assert_in_file() { grep -q -- "$2" "$1" 2>/dev/null && _ok "file $1 contains $2" || _bad "file $1 missing $2"; }
# [dod.5]: prove the REAL serve() ran, not the deleted fallback
assert_serve_real_path() { case "$LAST_OUT$LAST_ERR" in *"[serve] real-path"*) _ok "real serve() path ran: $1" ;; *) _bad "serve real-path marker absent (fallback or crash): $1" ;; esac }

probe_done() {
  # [dod.11] / [inv:sandbox-isolation]: real home must be byte-identical
  # Same path exclusions as _snapshot_realhome (see above for rationale).
  local c2 x2
  c2="$(cd && find "$HOME/.claude" -type f \
    ! -path "$HOME/.claude/projects/*" \
    ! -path "$HOME/.claude/file-history/*" \
    ! -path "$HOME/.claude/hooks/*" \
    ! -path "$HOME/.claude/plugins/*" \
    ! -path "$HOME/.claude/.sox/*" \
    ! -path "$HOME/.claude/ide/*" \
    ! -path "$HOME/.claude/cache/*" \
    ! -path "$HOME/.claude/backups/*" \
    ! -name ".DS_Store" \
    ! -name "daemon.log" \
    ! -name "daemon.status.json" \
    ! -name "daemon.lock" \
    ! -name "daemon-auth-status.json" \
    ! -name "daemon-auth-cooldown" \
    ! -name "history.jsonl" \
    ! -name "mcp-needs-auth-cache.json" \
    ! -name "stats-cache.json" \
    ! -name "swarm-cost.log" \
    ! -name ".last-cleanup" \
    ! -name ".last-update-result.json" \
    ! -name ".credentials.json" \
    ! -name "CLAUDE.md" \
    2>/dev/null | sort | xargs -I{} sh -c 'printf "%s %s\n" "$(shasum "{}" 2>/dev/null | cut -d" " -f1)" "{}"' 2>/dev/null | shasum | cut -d" " -f1)"
  x2="$(cd && find "$HOME/.codex" -type f \
    ! -path "$HOME/.codex/projects/*" \
    ! -path "$HOME/.codex/file-history/*" \
    ! -path "$HOME/.codex/hooks/*" \
    ! -path "$HOME/.codex/plugins/*" \
    ! -path "$HOME/.codex/.sox/*" \
    ! -path "$HOME/.codex/ide/*" \
    ! -path "$HOME/.codex/cache/*" \
    ! -name ".DS_Store" \
    ! -name "daemon.log" \
    ! -name "daemon.status.json" \
    ! -name "daemon.lock" \
    ! -name "daemon-auth-status.json" \
    ! -name "daemon-auth-cooldown" \
    ! -name "history.jsonl" \
    ! -name "mcp-needs-auth-cache.json" \
    ! -name "stats-cache.json" \
    ! -name "swarm-cost.log" \
    ! -name ".last-cleanup" \
    ! -name ".last-update-result.json" \
    2>/dev/null | sort | xargs -I{} sh -c 'printf "%s %s\n" "$(shasum "{}" 2>/dev/null | cut -d" " -f1)" "{}"' 2>/dev/null | shasum | cut -d" " -f1)"
  [ "$c2" = "$_RH_CLAUDE_SNAP" ] && _ok "real ~/.claude untouched" || _bad "real ~/.claude WAS MODIFIED (sandbox leak)"
  [ "$x2" = "$_RH_CODEX_SNAP" ] && _ok "real ~/.codex untouched" || _bad "real ~/.codex WAS MODIFIED (sandbox leak)"
  # stop any spawned supervisor in the sandbox; leave zero orphans
  SOX_HOME="$SBX" node "$REPO/bin/sox" stop --root "$SBX" >/dev/null 2>&1 || true
  rm -rf "$SBX" "$FRESH" 2>/dev/null
  echo "  probe: $PROBE_PASS ok, $PROBE_FAIL fail"
  [ "$PROBE_FAIL" -eq 0 ]
}
