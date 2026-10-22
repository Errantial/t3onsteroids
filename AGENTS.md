# Repository instructions

- Keep T3 and CoS compatibility behavior behind explicit versioned contracts.
- Do not import unpublished `@t3tools/*` packages into production code.
- Keep ACP startup and `session/new` side-effect free with respect to CoS.
- Do not log prompt text, assistant text, repository contents, controller tokens, tool bodies/results, browser/page text, or raw configuration.
- Unsupported provider capabilities must fail explicitly rather than be approximated.
- Windows is the first conformance platform; keep path/process abstractions portable where practical.
- When testing T3 Code, use the Chat On Steroids browser/background browser-control path instead of the T3 Code desktop app. Do not take over or foreground the desktop app for qualification/testing when browser-based background testing is available; preserve the user's ability to keep using the machine concurrently.

