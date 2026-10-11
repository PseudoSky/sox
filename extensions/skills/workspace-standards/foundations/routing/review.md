# Playbook: review routing

Checks role availability and the roles-covered declarations. T14.AC10.

## Steps
1. Declarations: `node scripts/review-routing.mjs --agents-dir <agents dir> --roles <roles.md>`. Exit 1 lists every agent with no `roles-covered` declaration (`no-roles-covered-declaration`), every id `roles.md` does not define (`unknown-obligation-id`), and every `hints` name that matches no installed agent (`unresolved-hint`).
2. Roster names: every agent named in the task-to-agent routing table resolves to an installed agent (the roster guard). Each name that resolves nowhere is a finding.
3. Availability: for every role in every registered standard, run `run routing` against the installed agents. List each role that is unbound, and lower the reported conformance level for each (a standard's level never counts an unbound role as covered).
4. Skipped standards: list each standard that declares `own: ["routing"]`; its own playbook reviews its routing.
5. Drift: the `workspace-standards:routing` block in `AGENTS.md` equals what `apply routing` would write; a hand edit inside the markers is drift. Command: `node <skill>/scripts/foundations.mjs review routing [--root <repo>]`; exit 3 names the drifted block and prints its diff.

## Output
Findings `{ id, severity, evidence }` and the unbound-role list.

## Record
The findings list with the command lines and exit statuses, written to the review output location the repository names.
