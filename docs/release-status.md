# Release status

The codebase is pinned to T3 `0.0.46-nightly.20261013.3040` / `ffb4af8d5d4fcfc5e9322295ff846a6d1e7ffbf8`, CoS `2.1.39` / `87ae9d631f82d8da2f462d910410031ad8f97ac5`, controller protocol 1, ACP SDK 1.9.0, Node 24, Windows x64.

**Current state: pre-v1, not release-qualified.** The bridge has the Step 1–6 implementation lineage, including the production ACP stdio entrypoint, drain-aware event translator, durable/cross-process state and lease implementation, hardened controller/SSE/privacy boundary, and metadata-only metrics/logging. The migrated checkout is requalifying those source gates against one exact current implementation tuple before any Step-7 live evidence can count. The authoritative remaining sequence is in `PLAN.md` under **Remaining work to finished v1**; do not treat historical local verification from another machine as a current PASS.

## Supported launcher

T3 must launch a real executable with `shell:false`. The selected/validated **launch shape** is the installed real `node.exe` with the built `dist/cli/index.js` script as its argument. `.cmd`/`.bat` wrappers are unsupported. No standalone packager is bundled or implicitly downloaded.

That packaging form is proven and the no-argument CLI now serves the stable ACP v1 stdio provider. Do not treat the bridge as release-qualified until the provenance/live gates in `PLAN.md` are complete.

## Readiness diagnostics

Run:

```text
node dist/cli/index.js --diagnose --user-data-dir <CoS user data dir> --cwd <exact project root>
```

The diagnostic is read-only. It checks controller discovery, health/protocol, provider-extension feature IDs, actions-enabled state, and exact project resolution. It does not enable CoS Local control API or Allow actions.

## Remaining v1 gates

Before v1 can be called finished/release-qualified, the project still needs:

- live single-turn latency/browser/memory/reconnect qualification;
- the pinned live T3→ACP→CoS acceptance matrix;
- a separate current-T3-HEAD drift run and final clean-checkout release record.

The live controller matrix is unavailable while CoS Local control API is disabled. Every real bridged prompt/cancel/Stop also requires **Allow actions**, because `/v1/inputs`, pending-input cancel and exact-turn Stop are controller action routes even when the requested coding task itself is read-only/no-tool. Read-only diagnostics/project resolution and ACP provider-validation probes do not require Allow actions. Those settings are never silently enabled by this project.

Current upstream T3 HEAD drift is a separate compatibility lane and does not change the pinned release contract.

V1 intentionally supports one active bridged turn per stable CoS controller identity. **2–4 concurrent chats are a desired post-v1 feature** and have their own measured qualification gates in `PLAN.md`; they do not block the first release.

## Dependency audit disposition

The bridge uses Vitest `5.0.5`, vite-node `6.0.0`, typescript-eslint `8.71.2`, ESLint / @eslint/js `9.39.5`, TypeScript `5.9.3`, and runtime `@agentclientprotocol/sdk@1.9.0`. On this migrated machine a fresh `npm ci` and `npm audit --json` report zero vulnerabilities. Step-6 evidence is refreshed only after the final pre-live implementation identity passes the complete clean verification lane; the older `docs/evidence/v1-06-toolchain-audit.md` remains provenance, not a current-tuple PASS, until then.
