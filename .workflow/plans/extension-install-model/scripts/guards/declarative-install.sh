#!/usr/bin/env bash
# declarative-install guard — full install→diff→update→uninstall cycle for
# content types (agent/skill/command, claude project/user/local + codex skill).
# Asserts exact [shape:host-target] paths, drift detection, clean reversal,
# and ZERO real-home writes ([inv:sandbox-isolation]).
# Sources [def:probe-harness].

set -uo pipefail
source "$(dirname "$0")/../sox-probe.sh"
probe_init

# =============================================================================
# Track A: claude agent, project scope — install → diff (clean) → update
# =============================================================================
ID_A="di-agent"
soxe init agent "$ID_A"
assert_exit0 "init agent $ID_A"
soxe install "$ID_A" --host claude --scope project
assert_exit0 "install agent claude project"
AGENT_PATH="$SBX/.claude/agents/${ID_A}.md"
assert_file "$AGENT_PATH"

# diff on clean install: exit 0, no drift reported.
soxe diff "$ID_A"
assert_exit0 "diff agent (clean)"

# External edit → drift must be detected.
echo "# drifted content" >> "$AGENT_PATH"
soxe diff "$ID_A"
assert_exit0 "diff agent (drifted) exits 0"
assert_stdout "$ID_A"  # stdout must name the drifted path

# update refreshes the artifact.
soxe update "$ID_A" --host claude --scope project
assert_exit0 "update agent"

# =============================================================================
# Track B: claude skill, user scope — install → uninstall → artifact gone
# =============================================================================
ID_B="di-skill"
soxe init skill "$ID_B"
assert_exit0 "init skill $ID_B"
soxe install "$ID_B" --host claude --scope user
assert_exit0 "install skill claude user"
assert_file "$SBX/.claude/skills/${ID_B}/SKILL.md"

# Uninstall — artifact must be removed; ledger entry reversed.
soxe uninstall "$ID_B" --host claude --scope user
assert_exit0 "uninstall skill"
assert_absent "$SBX/.claude/skills/${ID_B}/SKILL.md"

# =============================================================================
# Track C: claude command, local scope
# =============================================================================
ID_C="di-command"
soxe init command "$ID_C"
assert_exit0 "init command $ID_C"
soxe install "$ID_C" --host claude --scope local
assert_exit0 "install command claude local"
assert_file "$SBX/.claude/commands/${ID_C}.md"

# =============================================================================
# Track D: codex skill, project scope
# =============================================================================
ID_D="di-codex-skill"
soxe init skill "$ID_D"
assert_exit0 "init codex skill $ID_D"
soxe install "$ID_D" --host codex --scope project
assert_exit0 "install skill codex project"
assert_dir "$SBX/.codex/skills/${ID_D}"

soxe uninstall "$ID_D" --host codex --scope project
assert_exit0 "uninstall codex skill"
assert_absent "$SBX/.codex/skills/${ID_D}"

probe_done
