# Playbook: apply routing

Writes the routing content, composed from every registered standard's declaration.

## Steps
1. Read each active standard's `standard.json` (roles, work classes) and `roles.md`. Skip a standard that declares `own: ["routing"]` and report it skipped.
2. Between `workspace-standards:routing:begin` and `:end` in `AGENTS.md`, write: the task-to-agent table (every task a registered standard defines, mapped by name to agents in the capability roster, using each role's holder from `run routing`), a line stating the table wins over the dispatcher's own default rows, the role bindings, and the capability rows that expose role resolution.
3. Write `roles.md` from the registered standards' role declarations.
4. Adding a second standard changes this block and no standard's domain block.
5. A second run produces no change. Every agent name written must resolve to an installed agent.
6. For a mechanism that does not exist (the resolution command, the roster guard), file one backlog item instead of writing code.

Command: `node <skill>/scripts/foundations.mjs apply routing [--root <repo>] [--dry-run] [--force] [--no-file]`. `--dry-run` and `--no-file` write and file nothing; exit 3 means a hand edit sits inside the block (re-run with `--force` to overwrite it).

## Output
The routing block diff, `roles.md`, filed mechanism items.

## Record
The diff summary and the list of filed items in the change description.

Status: built (595965cc T49). The writer is `scripts/foundations.mjs`; the roster guard is `tools/test-roster-guard.mjs` in the adopting repository and is filed when absent.
