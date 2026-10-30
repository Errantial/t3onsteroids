# Release status

**Current release: `1.1.0`** — the post-v1 feature release on T3 Code `0.1.5` (`6d450a42…`, identical to the published stable tag). It adds two-chat concurrency, workspace/worktree binding, model and reasoning selection, prompt images, and background-work projection/follow-ups. `1.1.0` is a feature release, not a new qualification of the full V1 matrix: the release-qualified support tuple remains `v1.0.0` until the V1 matrix is rerun on `0.1.5`. `--release-readiness` therefore reports `t3BaselineQualified:false` and `releaseQualified:false` on this baseline, while the historical `v1.0.0` gates below remain green for their own tuple.

## 1.1.0 boundary

- T3 Code `0.1.5` / `6d450a4284852af137b2f3407fddd89eb76e7644` (also `0.1.5-nightly.20261029.3877`); T3-HEAD acceptance additionally exercised `dd148481531a0a090780a2ade20588566db099a2` (0.1.6 nightly).
- CoS base `2.1.39` / `87ae9d631f82d8da2f462d910410031ad8f97ac5`, controller protocol 1, provider-extension build `2a6a1f8291e0bc45793d0e68f0b7cfa024f87be4`.
- ACP SDK `1.9.0`, Node 24, Windows x64, `sharp` `0.35.5` for PNG/JPEG → WebP prompt images.
- `supportedConcurrency=2` is advertised from the passing isolated two-chat matrix; four/eight chat remain parked.
- Offline verification for this release: full `npm run verify` (typecheck, ESLint, build, Vitest, package smoke). The final suite passes 29 test files / 319 tests, including the release-version consistency, capacity-scaled polling and no-usage-reporting guards.

Post-v1 evidence lives in `docs/evidence/post-v1-concurrency-qualification.md`, `docs/plan/post-v1-milestones.md`, `docs/plan/fire-and-forget-background-work.md` and the T3-HEAD acceptance record under `docs/evidence/t3-head-acceptance/`. The last fully passing two-chat tuple and its executable identity are recorded in the "2026-10-30 post-v1 close-out" section below; later provider builds add only attachment-gate behavior and are covered by their focused suites.

## Released `v1.0.0` tuple (still the qualified support tuple)

The released `v1.0.0` tuple is pinned to T3 `0.0.46-nightly.20261013.3040` / `ffb4af8d5d4fcfc5e9322295ff846a6d1e7ffbf8`, CoS `2.1.39` / `87ae9d631f82d8da2f462d910410031ad8f97ac5`, controller protocol 1, ACP SDK 1.9.0, Node 24, Windows x64.

**`1.0.0` is release-qualified on that pinned Windows support tuple.** The qualified bridge implementation identity is `f3a672cffdee77f54d377d5594893e0606d20d5b`; the final CoS provider build is `495e3e96504d9b865c18478f7b42915280712f84`. The side-by-side CoS `2.1.39` candidate used for final live qualification has executable SHA-256 `D2A99BC116FEAFE66318AA3912042ED52610EEDAA3569E5C5FFC364FB6307034` and browser-extension stamp `6c66160b96d3`. All five required provider features are present. The final main-worktree verification passes `25/25` test files and `246/246` tests, the bridge dependency audit is zero, `git diff --check` passes, and `--release-readiness` reports `releaseQualified:true` on the released tuple.

The preserved historical V1-11 broken admission domain remains immutable fail-closed regression evidence; it was never repaired, rewritten, or reused. Release qualification uses the fresh final-tuple V1-11 PASS required by `PLAN.md`.

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

The pinned release tuple remains T3 `0.0.46-nightly.20261013.3040` / `ffb4af8d5d4fcfc5e9322295ff846a6d1e7ffbf8`, CoS base `2.1.39` / `87ae9d631f82d8da2f462d910410031ad8f97ac5`, provider-extension build `495e3e96504d9b865c18478f7b42915280712f84` with all five required provider features at version 1, ACP SDK `1.9.0`, Node 24 and Windows x64. The development baseline (`0.1.5-nightly.20261029.3877` / `6d450a42`) and the current-T3-HEAD drift result are recorded separately and do not silently widen this tuple.

For live qualification, the preferred lane while the active CoS installation remains in use is a side-by-side candidate launched from the exact clean extension build with its own isolated user-data/profile directory and isolated bridge state root. The active installation/profile must remain untouched, and candidate/active executable identities plus the extension build id are recorded as provenance before mutating cases.

## Dependency audit disposition


## Post-v1 concurrency lane (included in `1.1.0`)

The durable multi-chat scheduler is implemented at rebased commit `22d561f` on `feat/post-v1-concurrency`, directly above released v1.0.0 (`5681f812...`). The qualification harness and cancellation hardening follow at `cf3f50e` and `c13cf4b`. The merged `1.1.0` bridge verification passes typecheck, ESLint, build, package smoke, and 29 test files / 319 tests, including the exact-generation cancellation-reconciliation guard. The two-chat ceiling is qualified below; the scheduler implementation alone does not qualify four or eight chats and does not alter the historical v1.0.0 release result.

Current post-v1 concurrency status: `supportedConcurrency=2`. The inherited v1 release manifest remains `releaseQualified=true` for the already-qualified v1 support tuple; it is not evidence for a higher post-v1 concurrency ceiling. The two-chat gate passed on 2026-10-29 on provider build `8b907eeb1ec60617fda94373ed36799d51f29790` (executable SHA-256 not recorded for this run) with the full eight-case isolated matrix: 10-turn single-chat baseline and 20-turn two-chat workload both under budget (pre-send p95 110 ms and 209 ms; drain p95 591 ms and 460 ms; post-drain p95 111 ms and 105 ms), plus passing queue/cancel/slot reuse, independent cancellation, SSE reconnect, crash/restart, cross-session stale-event and long-output slow-consumer RSS cases. The earlier 300-500 ms pre-send spikes were caused by the isolated profile's invalid OpenAI tunnel configuration (`kind: openai` with empty IDs), which started and failed a tunnel on every input; setting `tunnel.kind: "manual"` removed the churn and the gate passed. Four- and eight-chat qualification are parked (see the final paragraph and `PLAN.md`); do not raise the ceiling before a clean, repeatable gate.

The four-chat blocker (the controller's four-stream cap rejecting the fifth stream) now has an implementation: provider build `d7b2667` (now superseded by `d77cdca`) added the versioned `provider-event-stream-mux-v1` route and raises the held-stream cap to eight for the one-process-per-chat topology and the bridge consumes it through `MuxHub`. The bridge compatibility pin names that build, and the isolated candidate was rebuilt and exercised from it. The advertised ceiling remains 2: the rebuilt candidate completed all 40 four-chat turns with four passing session proofs and an 8-slot stream budget (four held streams plus a fifth probe returned 200), but drain p95 was 1467 ms against the 1000 ms budget and a repeat run stalled one pre-send acceptance past the gate wait. See `docs/evidence/post-v1-concurrency-qualification.md`. Four- and eight-chat concurrency are parked in the `PLAN.md` post-v1 backlog; `supportedConcurrency` stays 2.

The batched post-v1 provider build `d77cdcaf4433aa54df5bd8b2c06c21083f92d3f8` now carries workspace admission (`provider-session-workspace-v1`), the model catalog (`provider-model-catalog-v1`) and WebP prompt images (`provider-input-images-v1`) in addition to the drain and multiplexed-stream features. The 2-chat tuple was requalified on it: run `20261029T230611Z-twochat-requal-retry2` passed all eight cases on T3 `6d450a4284852af137b2f3407fddd89eb76e7644` and CoS base `87ae9d631f82d8da2f462d910410031ad8f97ac5` with executable SHA-256 `AAFEE508A39EA6C696B39E629410A8CB5C442215919087807F2DD24B32AA87AE` (baseline pre-send/drain/post p95 109/933/89 ms; two-chat 142/719/94 ms; per-process RSS 82/87 MB). Two earlier attempts on the same build failed one case each (baseline drain 1103 ms; one two-chat prompt failure); both are recorded in the evidence, and the passing run is the qualifying one. The new features do not change the concurrency ceiling: `supportedConcurrency` stays 2.

The 2-chat tuple is requalified on provider build `0520fce` with the user-approved post-v1 drain budget of 1500 ms (the v1 release gate remains 1000 ms). Run `20261030T032154Z-twochat-requal-0520fce-budget1500` passed all eight cases on T3 `6d450a42` / CoS base `87ae9d63`; baseline drain p95 was 775 ms and two-chat 456 ms, both below the old gate as well, so the adjustment removed noise rather than hiding a regression. The candidate carries the Goal/Loop background-work projection, the worker-cancel action, PNG/JPEG→WebP conversion (sharp 0.35.5, audit 0) and the pending-work fence. Executable SHA-256 `29B6F20E6440A6D74C7AD869781C5B7C524510E72BD43EFD1FEB83C1A94D2BE1`.

The 2-chat tuple is now requalified on provider build `dc691cd` (the linked-worktree resolver build): run `20261030T041202Z-twochat-requal-dc691cd` passed all eight cases with baseline pre-send/drain/post p95 111/857/93 ms and two-chat 142/458/96 ms. Executable SHA-256 `B20F6B264AC538B8D3BAA5045160FDEFD743BC050A1EFAA7C97DEE69BF3185A6`.

Prompt-image attachments are now accepted end to end on the `286cff5` provider build: the T3 HEAD UI sent `t3-attach-test.png` with a one-sentence prompt (thread run `ordinal:7`, `status=completed`) and received `The image is a solid bright red square measuring 8 x 8 pixels.` The fix elects the shell's multi-image picker beside its new camera picker; two multi-image inputs still fail closed. Known residual: a first image turn in a freshly opened chat tab can end without the extension publishing `turn_start`/`turn_end`, which leaves the CoS provider turn `admitted` until the prompt is retried on the now-open conversation.

## 2026-10-30 post-v1 close-out

- Provider build `1fc1936` (extension stamp `6fe6ebfb9c97`, executable SHA-256
  `CF83D86CCDC49D2C22F9737BA7190D7E64D2D9F666D8281BDA530E8125AE74CB`) ships the prompt-image
  fixes and the action-budget sizing. The last fully passing eight-case 2-chat tuple is `f9adddd`
  (baseline pre-send/drain/post p95 112/1094/90 ms; two-chat 138/811/98 ms); `1fc1936` adds only
  the attachment upload gate and is covered by its DOM/extension suites and the attachment rows.
- T3 HEAD `dd14848` acceptance matrix is complete (protocol probe, headless single/multi-turn,
  restart/resume, worktree, linked worktree, UI text, UI attachment). The declared baseline pin
  remains `6d450a42` because that is the nightly the v1 gate qualified.
- `supportedConcurrency` remains 2; 4/8-chat is parked.
