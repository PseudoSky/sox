<!-- workspace-standards:testing:begin -->
## Testing
- Every change carries a testing record: class, derived rigor, triggers, not-testing list (`docs/standards/testing.md`).
- Default test tier is S; a higher tier needs a gap statement: "cannot be observed at tier T-1 because ...".
- Every new test has a header: failure mode, tier, item and criterion cited, red run.
- The author of a test never approves it; an implementer never edits a test it did not author.
- Task routing and role holders: the routing block and `roles.md`. Gates: the gates block.
- Obtain a change's class, rigor, and playbook: `/workspace-standards run testing`.
<!-- workspace-standards:testing:end -->
