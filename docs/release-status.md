# Release status

The codebase is pinned to T3 `0.0.46-nightly.20261013.3040` / `ffb4af8d5d4fcfc5e9322295ff846a6d1e7ffbf8`, CoS `2.1.39` / `87ae9d631f82d8da2f462d910410031ad8f97ac5`, controller protocol 1, ACP SDK 1.9.0, Node 24, Windows x64.

**Current state: version `1.0.0`, but not release-qualified.** The bridge has the production ACP stdio entrypoint, drain-aware event translator, durable/cross-process state and lease implementation, restart/cancellation recovery, hardened controller/SSE/privacy boundary, and metadata-only metrics/logging. Deterministic Steps 1–6 are recorded PASS for bridge implementation `ef2548b817fe9318ac238e84d0ab39fd65258940`; `npm run verify` passes with 25/25 files and 243/243 tests. The previous Step-7 live performance PASS was recorded against an earlier implementation and is invalidated pending requalification. Step 8 remains incomplete: the prior V1-05 safe edit failed because the tool's approved root was unavailable, and V1-11 restart/cancellation remains unresolved with no authoritative drain. The side-by-side candidate also has a pending 2.1.42 update and a live profile-stamp/provenance discrepancy; no further live prompts or restarts are safe until those gates are resolved. The current-T3-HEAD drift/release cut (Step 9) also remains pending, so `releaseQualified` remains false.

## Supported launcher

T3 must launch a real executable with `shell:false`. The selected/validated **launch shape** is the installed real `node.exe` with the built `dist/cli/index.js` script as its argument. `.cmd`/`.bat` wrappers are unsupported. No standalone packager is bundled or implicitly downloaded.

That packaging form is proven and the no-argument CLI now serves the stable ACP v1 stdio provider. Do not treat the bridge as release-qualified until the provenance/live gates in `PLAN.md` are complete.

The v1 deployment boundary is same-host and **same OS user/profile**. T3 must use the exact canonical CoS project root; worktrees, nested directories, remapped paths and changed reparse/junction identities fail closed rather than being mapped heuristically. V1 supports one active bridged turn per stable CoS profile/controller identity.

## Readiness diagnostics

Run:

```text
node dist/cli/index.js --diagnose --user-data-dir <CoS user data dir> --cwd <exact project root>
```

The diagnostic is read-only. It checks controller discovery, health/protocol, provider-extension feature IDs, actions-enabled state, and exact project resolution. It does not enable CoS Local control API or Allow actions.

For real prompts, pending-input cancel and exact-turn Stop, both CoS **Local control API** and **Allow actions** must be enabled by the user. T3 runtime mode does not replace CoS's own host-tool authority. Read-only diagnostics/project resolution and ACP provider-validation probes remain nonmutating.

## Remaining v1 gates

Before v1 can be called finished/release-qualified, the project still needs:

- the pinned live T3→ACP→CoS acceptance matrix;
- a separate current-T3-HEAD drift run and final clean-checkout release record.

The live controller matrix is unavailable while CoS Local control API is disabled. Every real bridged prompt/cancel/Stop also requires **Allow actions**, because `/v1/inputs`, pending-input cancel and exact-turn Stop are controller action routes even when the requested coding task itself is read-only/no-tool. Read-only diagnostics/project resolution and ACP provider-validation probes do not require Allow actions. Those settings are never silently enabled by this project.

Current upstream T3 HEAD drift is a separate compatibility lane and does not change the pinned release contract.

V1 intentionally supports one active bridged turn per stable CoS controller identity. **2–4 concurrent chats are a desired post-v1 feature** and have their own measured qualification gates in `PLAN.md`; they do not block the first release.

The pinned release tuple remains T3 `ffb4af8d5d4fcfc5e9322295ff846a6d1e7ffbf8`, CoS base `87ae9d631f82d8da2f462d910410031ad8f97ac5`, provider-extension build `73e52028cb87ed2dd6fdc8c1a03a79669b8302bc`, ACP SDK `1.9.0`, Node 24 and Windows x64. A current-T3-HEAD result is recorded separately as compatible or incompatible; it does not silently widen this tuple.

For live qualification, the preferred lane while the active CoS installation remains in use is a side-by-side candidate launched from the exact clean extension build with its own isolated user-data/profile directory and isolated bridge state root. The active installation/profile must remain untouched, and candidate/active executable identities plus the extension build id are recorded as provenance before mutating cases.

## Dependency audit disposition

The bridge uses Vitest `5.0.5`, vite-node `6.0.0`, typescript-eslint `8.71.2`, ESLint / @eslint/js `9.39.5`, TypeScript `5.9.3`, and runtime `@agentclientprotocol/sdk@1.9.0`. Step-6 evidence records a clean `npm ci`, `npm run verify`, `npm audit --json` with zero bridge-package vulnerabilities, and `git diff --check` for the exact `bridgeImplementationCommit` named in that evidence. If implementation inputs advance afterward, the Step-6 qualification must be refreshed rather than treated as portable by implication. This bridge audit is separate from the inherited CoS application dependency advisories recorded in Step-1 evidence.
