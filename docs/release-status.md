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


## Post-v1 concurrency lane (separate from the pinned v1 release tuple)

The durable multi-chat scheduler is implemented at rebased commit `22d561f` on `feat/post-v1-concurrency`, directly above released v1.0.0 (`5681f812...`). The qualification harness and cancellation hardening follow at `cf3f50e` and `c13cf4b`. The rebased post-v1 offline bridge verification passes the focused concurrency/recovery selection at 128/128 tests and full `npm run verify` at 25 files / 266 tests, including the exact-generation cancellation-reconciliation guard. This does **not** qualify higher live concurrency or alter the pinned v1 contract.

Current post-v1 concurrency status: `supportedConcurrency=2`. The inherited v1 release manifest remains `releaseQualified=true` for the already-qualified v1 support tuple; it is not evidence for a higher post-v1 concurrency ceiling. The two-chat gate passed on 2026-10-29 on provider build `8b907eeb1ec60617fda94373ed36799d51f29790` (executable SHA-256 not recorded for this run) with the full eight-case isolated matrix: 10-turn single-chat baseline and 20-turn two-chat workload both under budget (pre-send p95 110 ms and 209 ms; drain p95 591 ms and 460 ms; post-drain p95 111 ms and 105 ms), plus passing queue/cancel/slot reuse, independent cancellation, SSE reconnect, crash/restart, cross-session stale-event and long-output slow-consumer RSS cases. The earlier 300-500 ms pre-send spikes were caused by the isolated profile's invalid OpenAI tunnel configuration (`kind: openai` with empty IDs), which started and failed a tunnel on every input; setting `tunnel.kind: "manual"` removed the churn and the gate passed. Four-chat qualification is next and must prove the controller's four-stream cap leaves room for other CoS activity; do not raise the ceiling to four before that evidence exists.

The four-chat blocker (the controller's four-stream cap rejecting the fifth stream) now has an implementation: provider build `d7b266711c408c8183b1bddbd927ab85d533843b` adds the versioned `provider-event-stream-mux-v1` route and raises the held-stream cap to eight for the one-process-per-chat topology and the bridge consumes it through `MuxHub`. The bridge compatibility pin now names that build, so the isolated candidate must be rebuilt and relaunched from it before the four-chat matrix can run. The advertised ceiling remains 2 until that matrix passes with a 200 fifth-stream probe.
