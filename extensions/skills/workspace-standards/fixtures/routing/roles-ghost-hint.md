# Roles — testing standard

T14.AC7. Parsed by `scripts/lib.mjs` (`parseRoles`); the roster guard validates every name in `hints`. One `## role: <name>` section per role; each field is one line, obligations are `- <ID>: <text> [<clauses>]` lines.

Field vocabulary:

- `tools`: any of `read`, `search`, `shell`, `edit`, `backlog`.
- `distinct-from`: roles whose holder must be a different party (one party = one working session) for the same change.
- `hints`: preferred installed agents. Hints break ties only; they never override eligibility or closeness. Empty = no installed agent is preferred.
- `no-holder`: what happens when no installed agent is eligible. `deep-blocks: yes` means the change is blocked at Deep rigor.

Resolution (the routing foundation's `run` playbook): candidates are installed agents; eligible = can use every `tools` entry and breaks no `distinct-from` rule for this change; closeness = count of the role's obligation ids in the agent's `roles-covered` declaration, then fewest other roles already held in the change; hints break remaining ties. The closest eligible agent holds the role and the closeness evidence goes in the dispatch telemetry row.

## role: risk-owner
- prefix: RO
- RO.1: Accept or reject each entry of a "not testing" list [§6.1.3]
- RO.2: Accept exceptions only with owner, risk accepted, compensating control, and expiry [§10]
- RO.3: Own every review-debt entry until its expiry [§13.1]
- tools: read, backlog
- distinct-from:
- hints:
- independence: none stated; the human owner accepts exceptions.
- no-holder: unbound; review debt on the affected tests; deep-blocks: no

## role: classifier
- prefix: CL
- CL.1: Record the change class on every work item [§6.1.1]
- CL.2: Apply the escalation triggers and derive the rigor [§6.6]
- CL.3: Leave a rigor record on the item [§6.6]
- tools: read, search, backlog
- distinct-from:
- hints:
- independence: derives, never chooses, the rigor; a trigger a tool can detect is detected by the tool.
- no-holder: unbound; review debt on the affected tests; deep-blocks: no

## role: planner
- prefix: PL
- PL.1: Decide interfaces and contracts at boundaries [P7]
- PL.2: State the contract for a boundary change, both sides [§6.2]
- PL.3: Fix the interface stubs a parallel author needs [§14]
- tools: read, search
- distinct-from:
- hints:
- independence: none stated.
- no-holder: unbound; review debt on the affected tests; deep-blocks: no

## role: test-author
- prefix: TA
- TA.1: Produce the risk map [§6.1.2]
- TA.2: Choose the tier per failure mode and write the "not testing" list [§6.1.3]
- TA.3: Write tests with a header: failure mode, tier, gap statement [§6.1.8]
- TA.4: Record red evidence against the base commit [§6.5]
- TA.5: Report the tests the change makes obsolete or lowers [§8.6]
- tools: read, search, shell, edit
- distinct-from: static-reviewer, auditor
- hints:
- independence: the party that authored a test never approves it; edits only tests and test support, never production code; write scope declared up front (§14).
- no-holder: unbound; review debt on the affected tests; deep-blocks: yes

## role: implementer
- prefix: IM
- IM.1: Produce the behavior the tests describe [§14]
- IM.2: Never edit, skip, delete, or loosen a test it did not author; dispute through the auditor [§14]
- IM.3: At Light rigor, author the tests with headers [§6.6]
- tools: read, search, shell, edit
- distinct-from: auditor
- hints:
- independence: at Standard separated authorship is the default and at Deep it is required, so the implementer is then a different party from the test author.
- no-holder: unbound; the work waits for a specialist; deep-blocks: no

## role: static-reviewer
- prefix: SR
- SR.1: Judge tier and gap-statement validity [G9]
- SR.2: Judge teeth: a recorded red run on a failed assertion [§6.5]
- SR.3: Judge structure coupling [R4]
- SR.4: Check the planning record and test headers are present [G12]
- tools: read, search
- distinct-from: test-author
- hints:
- independence: reads the specification and the tests; at Deep it does not receive the implementer's reasoning (§14).
- no-holder: unbound; review debt on the affected tests; deep-blocks: yes

## role: auditor
- prefix: AU
- AU.1: Run the plan-scope tests [§7.1]
- AU.2: Apply the retention questions to each test under review [R1]
- AU.3: Judge removals and lowerings and require the parity proof [§8.3]
- AU.4: Decide test disputes once and record the outcome [§14]
- AU.5: Refuse to audit tests whose authorship record names the auditor's own session [§14]
- tools: read, search, shell, edit
- distinct-from: test-author, implementer
- hints: ghost-agent
- independence: edits and removals the auditor makes are confirmed by a different party (§8.4).
- no-holder: unbound; review debt on the affected tests; deep-blocks: yes

## role: triager
- prefix: TR
- TR.1: Find the root cause of a defect [§8.5]
- TR.2: Name the earliest tier and stage that could have caught it [§8.5]
- TR.3: Write the escape record on the defect item [§8.5]
- tools: read, search, shell
- distinct-from:
- hints:
- independence: none stated.
- no-holder: unbound; review debt on the affected tests; deep-blocks: no

## role: verifier
- prefix: VR
- VR.1: Run the repository's gate set [§10]
- VR.2: Apply the gates no class relaxes [§6.7]
- VR.3: Release only on a green gate set [§7.1]
- tools: read, shell, backlog
- distinct-from:
- hints:
- independence: none stated.
- no-holder: unbound; no release; deep-blocks: no

## role: record-keeper
- prefix: RK
- RK.1: Hold work items and their evidence [§6.6]
- RK.2: Hold the exception log [§10]
- RK.3: Hold removal records [§8.4]
- RK.4: Hold review-debt entries with owner and expiry [§13.1]
- tools: read, backlog
- distinct-from:
- hints:
- independence: none stated.
- no-holder: unbound; review debt on the affected tests; deep-blocks: no

## role: strategy-owner
- prefix: SO
- SO.1: Own the IMPLEMENTATION document [§13]
- SO.2: Report the conformance level [§13]
- SO.3: Deliver each role its slice at the moment it acts [§13.2]
- tools: read, search, shell, edit
- distinct-from:
- hints:
- independence: none stated.
- no-holder: unbound; review debt on the affected tests; deep-blocks: no

## role: mechanism-owner
- prefix: MO
- MO.1: Own hooks, pipelines, and checkers [§10]
- MO.2: Own runner configuration and budgets [§12]
- MO.3: Bind each gate to a mechanism or list it as an obligation [§13]
- tools: read, search, shell, edit
- distinct-from:
- hints:
- independence: none stated.
- no-holder: unbound; review debt on the affected tests; deep-blocks: no

## role: coordinator
- prefix: CO
- CO.1: Sequence the parties of a work unit [§14]
- CO.2: Commit and verify the stub commit [§14]
- CO.3: Join parallel work and run the gate set before merge [§13.2]
- tools: read, shell, backlog
- distinct-from:
- hints:
- independence: none stated.
- no-holder: unbound; a single worker covers the work and Deep is refused or escalated to the owner (§13.2); deep-blocks: no
