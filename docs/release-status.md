# Release status

The codebase is pinned to T3 `0.0.46-nightly.20261013.3040` / `ffb4af8d5d4fcfc5e9322295ff846a6d1e7ffbf8`, CoS `2.1.39` / `87ae9d631f82d8da2f462d910410031ad8f97ac5`, controller protocol 1, ACP SDK 1.9.0, Node 24, Windows x64.

**Current state: version `1.0.0` is release-qualified on the pinned Windows support tuple.** The qualified bridge implementation identity is `f3a672cffdee77f54d377d5594893e0606d20d5b`; the final CoS provider build is `495e3e96504d9b865c18478f7b42915280712f84`. The side-by-side CoS `2.1.39` candidate used for final live qualification has executable SHA-256 `D2A99BC116FEAFE66318AA3912042ED52610EEDAA3569E5C5FFC364FB6307034` and browser-extension stamp `6c66160b96d3`. All five required provider features are present. The final main-worktree verification passes `25/25` test files and `246/246` tests, the bridge dependency audit is zero, `git diff --check` passes, and `--release-readiness` reports `releaseQualified:true`.

The preserved historical V1-11 broken admission domain remains immutable fail-closed regression evidence; it was never repaired, rewritten, or reused. Release qualification uses the fresh final-tuple V1-11 PASS required by `PLAN.md`.

The post-v1 concurrency work on `feat/post-v1-concurrency` is separate from that released tuple. Its scheduler implementation and qualification evidence must be evaluated against the released v1 base before any higher `supportedConcurrency` claim is made; post-v1 changes do not retroactively alter the v1.0.0 release qualification result.

## Supported launcher

T3 must launch a real executable with `shell:false`. The selected/validated **launch shape** is the installed real `node.exe` with the built `dist/cli/index.js` script as its argument. `.cmd`/`.bat` wrappers are unsupported. No standalone packager is bundled or implicitly downloaded.

That packaging form is proven and the no-argument CLI serves the stable ACP v1 stdio provider. The same real-`node.exe` + built-script shape was reverified from the Step-9 fresh checkout with `shell:false`.

The v1 deployment boundary is same-host and **same OS user/profile**. T3 must use the exact canonical CoS project root; worktrees, nested directories, remapped paths and changed reparse/junction identities fail closed rather than being mapped heuristically. V1 supports one active bridged turn per stable CoS profile/controller identity.

## Readiness diagnostics

Run:

```text
node dist/cli/index.js --diagnose --user-data-dir <CoS user data dir> --cwd <exact project root>
```

The diagnostic is read-only. It checks controller discovery, health/protocol, provider-extension feature IDs, actions-enabled state, and exact project resolution. It does not enable CoS Local control API or Allow actions.

For real prompts, pending-input cancel and exact-turn Stop, both CoS **Local control API** and **Allow actions** must be enabled by the user. T3 runtime mode does not replace CoS's own host-tool authority. Read-only diagnostics/project resolution and ACP provider-validation probes remain nonmutating.

## Qualification result

- Step 7 live performance: PASS — canonical nearest-rank p95 `187 ms` pre-send, `803 ms` native drain, `118 ms` post-drain, plus current SSE reconnect, bridge-restart and slow-consumer lanes.
- Step 8 pinned V1-01…V1-19 matrix: PASS — all `20` required rows mapped to current-final live/deterministic evidence on f3/495e.
- Step 9 current-T3 drift: PASS / `compatible` against upstream HEAD `807319c276c6831b2c219640e9da5b38019a8f1d`; the pinned support claim remains unchanged.
- Step 9 fresh checkout: PASS — `npm ci`, full verify, audit, `git diff --check`, compatibility/readiness output and real `node.exe + dist/cli/index.js` `shell:false` launch.

Live operation still requires CoS Local control API and **Allow actions** for bridged prompt/cancel/Stop routes. Read-only diagnostics/project resolution and ACP provider-validation probes remain nonmutating and do not require Allow actions. These settings are never silently enabled by this project.

V1 intentionally supports one active bridged turn per stable CoS controller identity. **2–4 concurrent chats are a desired post-v1 feature** and have their own measured qualification gates in `PLAN.md`; they do not block the first release.

The pinned release tuple remains T3 `0.0.46-nightly.20261013.3040` / `ffb4af8d5d4fcfc5e9322295ff846a6d1e7ffbf8`, CoS base `2.1.39` / `87ae9d631f82d8da2f462d910410031ad8f97ac5`, provider-extension build `495e3e96504d9b865c18478f7b42915280712f84` with all five required provider features at version 1, ACP SDK `1.9.0`, Node 24 and Windows x64. The current-T3-HEAD compatibility result is recorded separately and does not silently widen this tuple.

For live qualification, the preferred lane while the active CoS installation remains in use is a side-by-side candidate launched from the exact clean extension build with its own isolated user-data/profile directory and isolated bridge state root. The active installation/profile must remain untouched, and candidate/active executable identities plus the extension build id are recorded as provenance before mutating cases.

## Dependency audit disposition

The bridge uses Vitest `5.0.5`, vite-node `6.0.0`, typescript-eslint `8.71.2`, ESLint / @eslint/js `9.39.5`, TypeScript `5.9.3`, and runtime `@agentclientprotocol/sdk@1.9.0`. Step-6 evidence records a clean `npm ci`, `npm run verify`, `npm audit --json` with zero bridge-package vulnerabilities, and `git diff --check` for the exact `bridgeImplementationCommit` named in that evidence. If implementation inputs advance afterward, the Step-6 qualification must be refreshed rather than treated as portable by implication. This bridge audit is separate from the inherited CoS application dependency advisories recorded in Step-1 evidence.
