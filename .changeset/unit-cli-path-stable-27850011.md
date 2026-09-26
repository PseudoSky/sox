---
'@adhd/sox-host-runtime': patch
'@adhd/sox-cli': minor
---

A user-scope OS unit no longer bakes a git checkout's `soxe` into its argv. The
front-shim (`soxe serve <id> --port <port>`) and doctor-tick units used
`realpath(process.argv[1])` — the CLI that ran `service enable` — so prod's
launchd unit ran the dev checkout's `bin/soxe` and every branch switch or build
there changed production. New `resolveUnitCliPath` (host-runtime) resolves an
explicit `--cli-path`, else the invoking soxe when it is not in a checkout, else
a released `@adhd/sox-cli` install, else the checkout CLI marked volatile;
`service enable|update` and `doctor --install-tick` refuse a volatile CLI at
user scope unless `--allow-checkout-cli`. Also exports `isGitCheckoutPath` and
`installedCliCandidates`. (27850011)

A path only counts as a git checkout if the nearest `.git` is found BEFORE the
walk crosses a `node_modules` segment — a released CLI installed under
Homebrew's (`/opt/homebrew/.git`) or nvm's (`~/.nvm/.git`) own repo was
previously misclassified as a checkout, so a correctly installed
`@adhd/sox-cli` failed the user-scope gate with no way to pass it (the
suggested `npm i -g @adhd/sox-cli` remedy could never succeed). The released-CLI
candidate is now resolved via `npm root -g` run through the pinned node's own
npm, falling back to the old `<prefix>/lib/node_modules` heuristic only when
that call fails (it previously resolved to the Homebrew Cellar path, which
Homebrew never populates, and to `~/.adhd/sox-ecosystem/cli`, which nothing
ever populates — both dropped). `--cli-path` is now validated: a non-absolute
or nonexistent value throws instead of silently baking in a broken path. This
is a **behavior change** for `@adhd/sox-cli`: a user-scope `service
enable|update` / `doctor --install-tick` that previously silently accepted (or
wrongly refused) a CLI path now resolves and gates it correctly, hence `minor`.
