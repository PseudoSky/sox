---
"@adhd/sox-host-registry": minor
---

opencode renderer emits `model:` from the per-host render override (`render.opencode.model`, a host model id such as `deepseek/deepseek-v4-flash`). Previously the opencode header never carried a model, so every rendered agent inherited the parent session's model at `task()` time — running the dispatcher on a pro model silently promoted all flash-tier subagents. The IR's logical tier (`sonnet`) is still never emitted for opencode, since opencode cannot resolve it.
