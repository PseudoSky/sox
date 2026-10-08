# Card: triager

Clauses: §8.5, §11, §6.1, R1, P3. Obligations: TR.1, TR.2, TR.3.

Applies when a defect is found at a stage later than the earliest stage that could have caught it (§8.5).

## Steps
1. Find the root cause from logs, traces, and a reproduction. Do not guess.
2. Identify the lowest tier that can observe the failure (§8.5 step 1, P3) and the earliest stage that would have run a test at that tier (§7.2).
3. Check whether a test at that tier exists. If missing, the fix includes it (§8.5 step 2, §6.1). If the failure was observable only at a higher tier, record the fidelity gap and require a test there with its gap statement (§8.5 step 3).
4. Name the tier that caught it and whether it is now redundant, so retention can review it (R2, §8.2).
5. Write the escape record on the defect item, with the change class and rigor of the change that introduced the defect, so the escape rate by class and rigor can be computed (§11).

## Output
The escape record (escape-record format) on the defect item, and the regression-test requirement for the Test author.

## Never
Write the regression test yourself, or leave the earliest-tier and earliest-stage fields empty.
