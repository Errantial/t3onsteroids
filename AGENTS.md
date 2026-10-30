# Repository instructions

- Keep T3 and CoS compatibility behavior behind explicit versioned contracts.
- Do not import unpublished `@t3tools/*` packages into the external bridge/provider package as a way to reach into T3 internals. Inside the T3 monorepo itself, normal workspace `@t3tools/*` imports are expected when they follow existing package boundaries.
- Keep ACP startup and `session/new` side-effect free with respect to CoS.
- Do not log prompt text, assistant text, repository contents, controller tokens, tool bodies/results, browser/page text, or raw configuration.
- Unsupported provider capabilities must fail explicitly rather than be approximated.
- Design the migration for Windows and Linux from the start. Keep platform-neutral provider/orchestration logic separate from explicit OS adapters for paths/storage, process containment/identity, secure secrets, browser artifacts/launch and prerequisite diagnostics. Windows may be the first live conformance/release gate when necessary, but Linux must not require an architectural rewrite and full cross-platform support is not claimed until Linux live qualification passes.
- When testing T3 Code, use the Chat On Steroids browser/background browser-control path instead of the T3 Code desktop app. Do not take over or foreground the desktop app for qualification/testing when browser-based background testing is available; preserve the user's ability to keep using the machine concurrently.
- For repository/file/terminal work in this project, use the **Chat On Steroids Core (FW)** connector specifically. Do not switch to Core, Beta, Desktop, or other CoS connectors unless the user explicitly asks; the FW connector has the intended workspace/root access and using another connector can produce misleading access failures or inconsistent behavior.
- When multiple implementation subagents run concurrently, give each one an isolated git branch/worktree rooted at the agreed frozen base or dependency commit. Do not let concurrent agents share one mutable worktree or merge/rebase each other's branches; the integration owner merges completed slice commits in dependency order.
- Never open pull requests, issues or discussions against the upstream `pingdotgg/t3code` repository. T3 changes ship only as a maintained patch series or fork; local T3 clones keep `origin`'s push URL disabled.
