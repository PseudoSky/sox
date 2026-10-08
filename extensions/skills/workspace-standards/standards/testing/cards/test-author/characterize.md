# Playbook card: characterize

Clauses: §6.4, §6.7, §9, G4, P4, P10. Obligations: TA.2, TA.3.

Serves a refactor of thinly covered or legacy code. One module per unit. Runs before the refactor begins.

## Input
The module, its public entry points, the refactor's intended scope.

## Steps
1. List the module's observable behaviors at its public interface, ranked by how much the refactor touches them (§6.4).
2. Pin the current behavior with tests at the lowest tier that observes it, default S. Assert outputs through the public interface only; no call sequences or private state (P4).
3. Include edge inputs the current code accepts or rejects, including the failures; pin what it does, not what it should do.
4. Tag `characterization`. Every such test carries an owner and a replace-by date and a tracking item; past the date it follows the skip rule (§6.4, §9, G4).
5. Run the tests green against the unchanged code; record command and exit status. They pass before the refactor and unchanged after it (§6.7).
6. Report behavior found to be wrong as a separate defect item; do not fix it here.

## Output
Characterization tests with owner, date, tracking item, and the green run on the unchanged code.

## Never
Change production code, leave a placeholder or skip (P10), or pin implementation structure instead of behavior (P4).
