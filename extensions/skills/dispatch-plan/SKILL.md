# dispatch-plan — plans are backlog structure

The dispatcher's playbook for plans, which live in the backlog — used when the user asks for a plan, or when a plan-item already covers the area. A plan is crafted into the backlog — product prioritizes, architect returns the structured items with their part_of / blocks edges, the dispatcher has backlog-operator file and link them, and it executes from the ready view. The dispatcher never designs the plan structure and never touches the graph. Load when a plan is named or discovered; otherwise stay in dispatch-direct.

The user owns the choice to plan. This playbook exists so that when they make
it, the plan is crafted properly — as dependency-correct backlog structure — and
so that when they do not, the existence of a plan is *mentioned*, not *imposed*.

A plan is not a document the dispatcher reads. It is an `issue` row in the
backlog: its work items attach by a `part_of` edge, and their order is expressed
as `blocks` dependencies. Execution is driven by the **ready view** — the items
whose blockers are resolved.

## Entry conditions (any one)

- The user says "plan", "make a plan", "use the plan", "execute the plan", or names a plan.
- The backlog already holds a plan that plausibly covers the current direction — in which case the dispatcher says **one line**: "plan `<uid>` covers this; N items ready. Say the word to work it; otherwise I'll continue on the task list." — and continues on the task list unless told otherwise.

## Confirmation gate

Crafting a plan dispatches two agents (`product`, then `architect`) and files
items. Do it only when the user asks for a plan. On discovery alone: highlight in one line, then
wait.

## Steps

1. **Read the existing structure.** Ask `backlog-operator` for the plan item, its `part_of`
   children, their `blocks` edges, and the **ready view**. Report any live claim (by whom, how old);
   never override it.
2. **Craft — only when the user wants a plan and none exists.** The dispatcher does not design the
   plan. Dispatch `product` to set what matters and in what order; then dispatch
   `architect` with the prioritized direction, asking for **returned structured items** —
   each item's title/body plus its membership (`part_of`) and dependency (`blocks`) edges. The
   architect *returns* the structure; it does not touch the backlog.
3. **Land the structure.** Hand the architect's returned items to `backlog-operator`: `file` each
   item, `relate … part_of` to attach it to the plan, and `relate … blocks` for each dependency
   edge. The dispatcher never writes the graph directly (rule 15). Done-state: the ready view
   returns the first dispatchable items.
4. **Execute from the ready view.** Dispatch the ready items through the normal `dispatch-contract`
   brief and review gate; `resolve` each on completion, which unblocks its dependents; re-read the
   ready view. Repeat until nothing is ready and the plan is complete or blocked.
5. **Track.** One Task entry per item; every claim/transition goes through `backlog-operator`. The
   plan's dependency structure is landed from the architect's output — never edited by you.

## Hard rules

- Never design the plan structure yourself; take `architect`'s returned items. Never touch
  the backlog directly — `backlog-operator` files and links.
- Never dispatch a dependency-blocked item; work the ready view.
- Never enter this playbook on discovery alone — highlight, then wait.
- Never take over a live claim.
