# Changelog

## Unreleased

- **`resolveRole` follows the closest-available-agent rule (595965cc T47 AC1, MAP 1E.4).** An agent is eligible when it has the role's tools and breaks no independence constraint; obligation coverage no longer gates eligibility, so a zero-coverage agent with the tools is eligible at closeness 0 and is chosen only when no covered agent is. Ranking is closeness, then fewest other roles already held in the change, then `roles.md` hints, then name. A new optional third argument `{ session, held }` applies `distinct-from` inside the function (the authoring session is excluded from a role whose `distinct-from` names a role it holds; a fresh dispatch of the same agent stays eligible) and supplies the held-role counts. The result gains `held`. Calls without the argument keep the static routing-table behavior. Descriptions are never scored. Version is left to the Changesets release flow.

## 0.1.0

- Initial release (item 9024e9ac, T14). Registry (routing and gates foundations, testing standard, five planned standards), standard contract and `roles-covered` schema, the `testing` standard (13 roles with obligation ids, five role cards, seven Test-author playbook cards, run/apply/review/retention-audit/flake-triage playbooks, five record formats, `apply` templates, conformance specification), foundation playbooks, and the scripts `ws.mjs`, `review-all.mjs`, `review-routing.mjs`, `conformance.mjs`. Recorded reuse decision for the gate runner and managed-block writer. `review-routing.mjs` also reports `roles.md` hints that match no installed agent and names a misplaced `agent["roles-covered"]` list.
