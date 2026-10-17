# Release status

The codebase is pinned to T3 `0.0.46-nightly.20261013.3040` / `ffb4af8d5d4fcfc5e9322295ff846a6d1e7ffbf8`, CoS `2.1.39` / `87ae9d631f82d8da2f462d910410031ad8f97ac5`, controller protocol 1, ACP SDK 1.9.0, Node 24, Windows x64.

**Current state: pre-v1, not release-qualified.** The repository contains the bridge-side controller contract/runtime helpers, recovery guards, performance helpers, diagnostics and tests, but it does not yet contain a production ACP stdio agent entrypoint, the actual CoS provider-extension server implementation, the Phase-4 event translator, or durable/cross-process state and lease implementations. The authoritative remaining sequence is in `PLAN.md` under **Remaining work to finished v1**.

## Supported launcher

T3 must launch a real executable with `shell:false`. The selected/validated **launch shape** is the installed real `node.exe` with the built `dist/cli/index.js` script as its argument. `.cmd`/`.bat` wrappers are unsupported. No standalone packager is bundled or implicitly downloaded.

That packaging form is proven, but the current CLI is still setup/release tooling rather than the final ACP stdio provider. Do not configure it as the production provider until the production ACP entrypoint gate in `PLAN.md` is complete.

## Readiness diagnostics

Run:

```text
node dist/cli/index.js --diagnose --user-data-dir <CoS user data dir> --cwd <exact project root>
```

The diagnostic is read-only. It checks controller discovery, health/protocol, provider-extension feature IDs, actions-enabled state, and exact project resolution. It does not enable CoS Local control API or Allow actions.

## Remaining v1 gates

Before v1 can be called finished/release-qualified, the project still needs:

- the real CoS provider-extension build and tests;
- a production ACP stdio entrypoint/harness;
- the event translator and terminal-state machine;
- durable crash-safe state plus a real cross-process admission lease;
- remaining controller/SSE/privacy hardening;
- development-toolchain advisory disposition;
- live single-turn latency/browser/memory/reconnect qualification;
- the pinned live T3→ACP→CoS acceptance matrix;
- a separate current-T3-HEAD drift run and final clean-checkout release record.

The live controller matrix is unavailable while CoS Local control API is disabled; mutating cases also require Allow actions. Those settings are never silently enabled by this project.

Current upstream T3 HEAD drift is a separate compatibility lane and does not change the pinned release contract.

V1 intentionally supports one active bridged turn per stable CoS controller identity. **2–4 concurrent chats are a desired post-v1 feature** and have their own measured qualification gates in `PLAN.md`; they do not block the first release.

## Dependency audit disposition

`npm audit` currently reports 12 advisories in the pinned development toolchain (1 moderate, 9 high, 2 critical). The affected direct packages are development-only `vitest@3.2.4` and `typescript-eslint@8.46.1`; runtime production dependency remains `@agentclientprotocol/sdk@1.9.0`. No automatic audit fix is applied because release compatibility is intentionally pinned. Before a production release, upgrade the dev-only toolchain in a separate compatibility change, rerun the full suite, and record the resulting audit state.
