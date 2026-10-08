# Card: classifier

Clauses: §6.1.1, §6.6, §6.7. Obligations: CL.1, CL.2, CL.3.

## Input
The work item (text, acceptance criteria) and the paths it will change.

## Steps
1. Pick exactly one class: new behavior, defect fix, refactor, configuration, dependency, boundary or contract change, no-code, test maintenance (§6.1.1). A change that spans classes is split into items, one class each. No class recorded means new behavior at Standard.
2. Read the class default rigor from §6.7: none, light, standard, deep.
3. Test every escalation trigger of §6.6 against the change: process, network or ownership boundary (Standard); shipped entry point (Standard); persistence or concurrent writers (Deep); security-relevant input or secrets (Deep); published interface (Deep); data migration (Deep); effect cannot be undone (Deep). A trigger a tool can detect is read from the tool, not asserted.
4. Rigor = the higher of the class default and every triggered level. It is derived, never chosen. Lowering it below the derived level is a deviation that needs an exception-log entry (§10).
5. Write the rigor record onto the item: class, derived rigor, and for each trigger whether it was hit (§6.6). Use the testing-record format.

## Output
The testing record (class, rigor, triggers) on the item. No-code work records rigor none and produces no tests.

## Never
Choose the rigor, skip a trigger because the change looks small, or write tests.
