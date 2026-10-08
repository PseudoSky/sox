# workspace-standards

One entry point to audit, run, and apply every workspace standard. Testing is the first standard; deployment, implementation, documentation, organization, and styling follow the same three verbs once their playbooks exist. Two concerns are shared by all standards and are separate targets: **routing** (which agent holds which role) and **gates** (which checks block which stage).

## When to use this skill

- `/workspace-standards <review|run|apply> <target>`, or any request to classify a change for testing, audit tests, write a standard into a repository, or check role routing and gates.
- A change needs its class, rigor, authorship mode, and the one playbook card that applies (`run testing`).
- Agents were added or edited and role coverage must be checked (`review routing`).

## When NOT to use this skill

- To read a policy document end to end. Roles apply a slice; the policy stays in the adopting repository.
- To write code for a mechanism (a checker, a hook, a gate runner). `apply` files a backlog item for each mechanism it cannot write.

## Targets and verbs

`registry.json` is the index. A target is a **foundation** (`routing`, `gates`) or a registered **standard** (`testing`; planned: `deployment`, `implementation`, `documentation`, `organization`, `styling`). A verb loads that target's playbook and you follow it.

| Verb | Foundation target | Standard target |
|---|---|---|
| `review` | role availability and roles-covered declarations (`routing`); completeness, liveness, reachability, teeth of every gate (`gates`) | the standard's own checks on top of the foundation reviews |
| `run` | resolve a role to the closest available agent (`routing`); run the gate set for a lifecycle step (`gates`) | classify a change and return rigor, authorship, and one playbook card |
| `apply` | write the routing table and `roles.md` (`routing`); write the gate registry and stage bindings (`gates`) | write only the standard's domain content between its managed markers |

Unless a standard declares `own: ["routing"]` or `own: ["gates"]`, `apply routing` and `apply gates` write that content and `apply <standard>` writes domain content only. `all` is valid for `review` and `apply`: foundations first, then each registered standard.

## How to run a verb

1. Resolve the playbook: `node <skill-dir>/scripts/ws.mjs <verb> <target> [--mode <name>]`. Success prints JSON with `playbook`; read that file and follow it.
2. The error is the answer when the target or verb does not resolve. Report the code; never substitute another target or verb.

| Code | Exit | Meaning |
|---|---|---|
| `E_UNKNOWN_TARGET` | 2 | target is not in the registry |
| `E_UNSUPPORTED_VERB` | 3 | the target has no playbook for that verb (also `run all`) |
| `E_UNKNOWN_VERB` | 4 | verb is not review, run, or apply |
| `E_PLANNED_TARGET` | 5 | registered but planned: no playbooks yet |
| `E_UNSUPPORTED_MODE` | 6 | the target has no such mode for that verb |
| `E_PLAYBOOK_MISSING` | 7 | registry names a file that is missing or empty |
| `E_USAGE` | 64 | wrong arguments |

3. `review all`: run `node <skill-dir>/scripts/review-all.mjs`. It reports every registered target lacking a playbook, a conformance specification, an apply template, or a declaration, and exits 1 on any finding. A planned standard is a finding; `--allow-planned` demotes findings that are only "planned", and nothing else. Then follow each active target's `review` playbook.
4. `review routing` includes `node <skill-dir>/scripts/review-routing.mjs --agents-dir <agents dir> --roles <skill-dir>/standards/testing/roles.md`: every agent without a `roles-covered` declaration is a finding.
5. `run testing --mode retention-audit` and `--mode flake-triage` select the two testing sub-playbooks.

## The testing standard

`standards/testing/`: `standard.json` (declaration: roles, work classes, gates G1-G12, a carrier per clause), `roles.md` (13 roles, obligation ids, tools, independence, hints, no-holder outcome), `conformance.spec.json` (run: `node <skill-dir>/scripts/conformance.mjs testing --strategy <policy path>`), `templates/` (the `apply` templates), `playbooks/` (run, apply, review, retention-audit, flake-triage), `cards/role/` (classifier, implementer-light, static-reviewer, auditor, triager), `cards/test-author/` (plan-bucket, author-new-behavior, author-regression, author-contract, characterize, select-checks, maintain), `formats/` (test header, audit record, escape record, removal record, testing record). Every card is at most 4096 bytes and cites policy clause ids only. Inline only the one card that applies into a brief.

## Contract for a new standard

`CONTRACT.md` lists what a standard must provide to register and the `roles-covered` declaration (`capabilities` entries `roles-covered:<ID>`). `schemas/` holds the machine-readable shapes. Adding a standard is a declaration, a portable policy, and playbooks, not another skill.

## Input contract

`{ verb: "review" | "run" | "apply", target: string }` plus, for `run`, the work item; for `apply`, the target repository root and the policy location.

## Output contract

Each playbook ends with a `## Record` section naming the artifact it leaves (a testing record on an item, audit and removal records, a findings list, or a diff summary). A verb that cannot run returns one of the named error codes above.

## Status

Built here: registry, contract, the testing standard's policy-side content, and the review scripts. Built by later tasks and marked `Status:` in the playbooks that need them: the managed-block writer, the routing command, the domain-neutral gate runner, the roster guard. Until they exist, perform those steps by hand and say so in the Record.

## Examples

- `/workspace-standards run testing` for item X: classify, derive rigor, return the `author-new-behavior` card.
- `/workspace-standards review all`: `review-all.mjs` then each active target's review playbook.
- `/workspace-standards apply deployment`: `E_PLANNED_TARGET`; do not fall back to `testing`.

## Skill id

`workspace-standards`
