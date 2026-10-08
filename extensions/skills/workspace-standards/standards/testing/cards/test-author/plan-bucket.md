# Playbook card: plan-bucket

Clauses: §6.1, §6.2, §6.6, §14, P3, P5, P9. Obligations: TA.1, TA.2.

Plans the tests for a bucket of related work items together; authoring is divided into units later (§14). At most 5 items per dispatch; split larger buckets by cohesion.

## Input
The bucket's items (class, rigor record, acceptance criteria with ids), the interface and contract notes, the routing output for each item.

## Steps
1. Per item, produce the risk map at the depth its rigor demands (§6.6): one line per criterion at Light; ranked by impact times likelihood at Standard; every boundary crossing and failure mode of the triggers at Deep (§6.1.2, P9).
2. Per item, write the "not testing" list (§6.1.3). An empty list claims everything was considered.
3. Per failure mode choose the tier by the decision tree (§6.2). One test per failure mode; default tier S.
4. Search existing tests for the same failure mode. If a lower tier already observes it, add nothing higher (P3, §6.1.5).
5. Across the bucket, report duplicate failure modes and shared fixtures so one test and one fixture serve them.
6. List tests the bucket makes obsolete or lowers (§8.6, P5).
7. Split authoring into independently verifiable units, each with its own failing-then-passing evidence. A unit that grows without bound is a defect in the breakdown (§14).

## Output
Per item: rigor record, risk map, "not testing" list, tier per failure mode, AC-to-test map. Per bucket: duplicates, shared fixtures, the unit list with write scopes declared by file or glob.

## Never
Write tests in this pass, edit production code, or approve a plan you authored (§14).
