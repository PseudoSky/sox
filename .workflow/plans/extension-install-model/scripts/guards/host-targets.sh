#!/usr/bin/env bash
# host-targets guard — [dod.3]: install places artifacts at the EXACT
# [shape:host-target] path for every (type, host, scope) combination;
# nothing is written outside $SBX ([inv:sandbox-isolation]).
# Sources [def:probe-harness].

set -uo pipefail
source "$(dirname "$0")/../sox-probe.sh"
probe_init

# --- 1. claude agent — project scope -----------------------------------------
ID="test-agent"
soxe init agent "$ID"
assert_exit0 "init agent"
soxe install "$ID" --host claude --scope project
assert_exit0 "install agent claude project"
assert_file "$SBX/.claude/agents/${ID}.md"

# --- 2. claude skill — user scope --------------------------------------------
ID="test-skill"
soxe init skill "$ID"
assert_exit0 "init skill"
soxe install "$ID" --host claude --scope user
assert_exit0 "install skill claude user"
assert_file "$SBX/.claude/skills/${ID}/SKILL.md"

# --- 3. claude command — local scope -----------------------------------------
ID="test-command"
soxe init command "$ID"
assert_exit0 "init command"
soxe install "$ID" --host claude --scope local
assert_exit0 "install command claude local"
assert_file "$SBX/.claude/commands/${ID}.md"

# --- 4. codex skill — project scope ------------------------------------------
ID="test-codex-skill"
soxe init skill "$ID"
assert_exit0 "init codex skill"
soxe install "$ID" --host codex --scope project
assert_exit0 "install skill codex project"
assert_dir "$SBX/.codex/skills/${ID}"

# --- 5. Prove nothing was written outside $SBX (probe_done checks real home) --
# probe_done's zero-real-home assertion covers this globally.

probe_done
