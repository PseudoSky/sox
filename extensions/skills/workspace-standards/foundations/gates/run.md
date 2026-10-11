# Playbook: run gates

Runs the gate set for a lifecycle step and returns one report.

## Input
The lifecycle step (stage A to H), the change class and rigor, the changed paths, the repository's gate command table (gate id, command, stage, mechanism class).

## Steps
1. Select the gates bound to the stage that have something to check for this class, rigor, and changed paths. No class relaxes G1, G2, G4, G10, G12, or the release stage (§6.7 of the testing policy); a class only decides whether a gate has anything to check.
2. Run each selected gate's command. A cache hit counts for G1 but is not execution evidence for G2 or G5.
3. Write one structured report: gate id, command, exit status, outcome, evidence path. The overall status is the worst gate's.
4. Release nothing: running the gates never merges, tags, or publishes.
5. A gate with no mechanism is listed as an obligation, not yet a gate, and never reported as passing.

## Output
The structured report and the worst exit status.

## Record
The report file (JSON) and the command line with its exit status.

Status: built. Run `node <skill>/engine/cli.mjs run --step <A-H> --class <class> --rigor <rigor> --changed <path> --root <repo>`; the engine's command table is the repository's `gates.table.json`.
