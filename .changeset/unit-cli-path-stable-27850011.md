---
'@adhd/sox-host-runtime': patch
'@adhd/sox-cli': patch
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
