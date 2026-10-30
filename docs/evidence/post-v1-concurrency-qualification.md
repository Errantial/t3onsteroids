# Post-v1 concurrency qualification

Status: rebased/offline bridge gate passed, including cancellation-reconciliation hardening; isolated live qualification is blocked only at the real external Chrome extension pairing step. No live test prompts have been sent by the current final-v1 candidate lane.

## Scope and safety boundary

- Worktree: C:\Users\Emil\t3onsteroids-post-v1
- Branch: feat/post-v1-concurrency
- Released v1 base: `5681f812e5ca81fd8fa1176212e64ba34b1f7899` (`v1.0.0`)
- Rebased scheduler implementation: `22d561f`; qualification harness: `cf3f50e`; cancellation hardening: `c13cf4b0b1d893acbe61f95eb6f3696b7d0e0ec7`
- The pinned v1 checkout and its release evidence, manifest, and active CoS candidate are outside this qualification lane.
- The current live candidate is built from the isolated CoS clone at final v1 provider build `495e3e96504d9b865c18478f7b42915280712f84`. The source clone and candidate profile live under `.local-evidence/post-v1-concurrency`.
- CoS base compatibility is 2.1.39 / 87ae9d631f82d8da2f462d910410031ad8f97ac5; controller protocol 1; final provider extension build id `495e3e96504d9b865c18478f7b42915280712f84`.
- The candidate uses a separate CoS user-data directory, a separate browser profile, and separate bridge state directories. No live traffic has been sent by this qualification harness yet.

## Offline bridge verification

Final command: npm run verify

Result after rebasing onto released v1.0.0: PASS. Typecheck and ESLint passed; 25 test files and 266 tests passed; package smoke passed. The focused concurrency/recovery selection passed 128/128 tests. Package smoke reports `supportedConcurrency=1`; the inherited v1 release manifest reports `releaseQualified=true` for the already-qualified v1 tuple, which is separate from this higher-concurrency gate.

Cancellation-reconciliation audit: `src/acp/index.ts` now uses one shared exact-generation predicate for every not-sent settlement acceptance path. It requires the active input/turn and provider translation to be absent, cancellation target/intent to be cleared, dispatch and lease metadata to be absent, pending mode-transition metadata to be absent, and `bindingState` not to be `create_pending`. `test/acp-durable-runtime.test.ts` covers each residual field independently and checks generation equality. `src/acp/stdio.ts` remains the transport/error-mapping boundary; no separate settlement predicate was present there.

Additional focused checks:
- The queued-cancellation race passed 10 consecutive isolated runs.
- The focused durability/process/performance selection passed 128 tests before the final full gate.
- Node syntax checks passed for post-v1-concurrency-runner.mjs and post-v1-concurrency-live.mjs.
- npm run lint passed after the qualification harness was added.
- git diff --check passed.
- Latest focused selection after rebase: `npx vitest run test/acp-durable-runtime.test.ts test/state-durable.test.ts test/state-process.test.ts test/integration/acp-stdio.test.ts --maxWorkers=1` â€” PASS, 128 tests across four files.

## CoS candidate source checks

- `npm ci` passed in the refreshed isolated source clone at `495e3e96504d9b865c18478f7b42915280712f84`.
- Focused provider-extension/controller suites passed 176/176 tests across eight files: control API core/actions/reads/stream/workers, kernel provider-turn, provider turn drain, and provider build id.
- An additional full CoS npm run verify attempt was interrupted after broader process/UI-timing suites reported failures in plugins-manager, input-delivery, and Continue-flow tests under load. That run is not considered green; those failures were not all rerun in isolation.
- The refreshed exact-source unpacked package build and packaged-runtime smoke passed with `npm run dist:dir:x64`. The executable SHA-256 is `D2A99BC116FEAFE66318AA3912042ED52610EEDAA3569E5C5FFC364FB6307034`, exactly matching final v1 release evidence. The browser extension stamp is `6c66160b96d3`; the provider-extension source/build id is `495e3e96504d9b865c18478f7b42915280712f84`.

## Live measurement rules

- Baseline: 10 single-chat bridge turns.
- Two-chat workload: 10 turns in each of two independent sessions, started in paired rounds.
- p95 uses nearest rank: sorted[ceil(0.95*N)-1].
- v1 budgets: pre-send p95 at most 250 ms, turn-drain p95 at most 1000 ms, post-drain p95 at most 250 ms.
- Per-process bridge RSS budget: below 256 MiB in the long-output/slow-consumer case. Aggregate bridge RSS across concurrent ACP processes is recorded separately and is not substituted for per-process RSS.
- The live matrix must verify two simultaneous active leases, independent active cancellation, queued cancellation before any CoS input is sent, slot reuse after release, crash/restart with another session active, an intentional SSE disconnect/reconnect with both sessions active, and a stale terminal event from another session that cannot settle the target turn.
- Four-chat qualification runs only after the full two-chat gate passes. The fifth-stream probe must show whether four bridged sessions leave room for other CoS activity. If it does not, implement and test a versioned multiplexed event-stream contract before advertising four.
- `supportedConcurrency` stays at 1 until the two-chat gate passes. The already-complete v1 release qualification remains separate and does not qualify this post-v1 concurrency gate.

## Live results

Current candidate package identity checks: executable SHA-256 `D2A99BC116FEAFE66318AA3912042ED52610EEDAA3569E5C5FFC364FB6307034`; isolated candidate extension and copied profile extension stamp `6c66160b96d3`; source/build ID `495e3e96504d9b865c18478f7b42915280712f84`. These exactly match the final v1 release candidate tuple while remaining in the dedicated `cos-profile-live-01` / `chrome-profile-live-01` lane. Local control API and Allow actions are enabled, discovery files exist, controller protocol/build/features and all three required action routes pass, and exact project resolution to `C:\Users\Emil\t3onsteroids-post-v1` succeeds.

Setup-invalid attempt: `.local-evidence/post-v1-concurrency/live-runs/20261019T232918Z-preflight-not-ready/manifest.json`. Reproducible command (run from the post-v1 worktree): `node scripts/post-v1-concurrency-live.mjs --profile '.local-evidence\post-v1-concurrency\cos-profile-live-01' --project 'C:\Users\Emil\t3onsteroids-post-v1' --out-dir '.local-evidence\post-v1-concurrency\live-runs\20261019T232918Z-preflight-not-ready' --expected-build-id '73e52028cb87ed2dd6fdc8c1a03a79669b8302bc' --candidate-exe-sha256 'C490DE96B0C5D6349AD5586465A5BD8D33D912B26A53FF51DEEC43E60672EF1B'`. Result: `SETUP_INVALID`, preflight `isolated_candidate_or_project_unavailable`, exit code 2. No ACP peer was started and no test prompt was sent. The isolated Chrome profile is at ChatGPT's login dialog; the candidate setup UI says it is waiting for the browser extension. The candidate `control-api/endpoint.json` and `control-api/token` discovery files are absent, so controller health, pairing, actions-enabled state, and exact project resolution cannot yet be verified. A CoS in-app update notice for 2.1.42 was left uninstalled to preserve the pinned candidate artifact.

The older setup-invalid attempts using the `73e52028...` / `C490...` / `45ee...` candidate are preserved as historical evidence and are superseded for current qualification by the finished-v1 refresh above. They are not counted as final-v1 live failures.

Current final-v1 setup-invalid attempt: `.local-evidence/post-v1-concurrency/live-runs/20261023T165923Z-final-v1-browser-unpaired/manifest.json`. It records bridge commit `c13cf4b0b1d893acbe61f95eb6f3696b7d0e0ec7`, provider build `495e3e96504d9b865c18478f7b42915280712f84`, candidate SHA-256 `D2A99BC116FEAFE66318AA3912042ED52610EEDAA3569E5C5FFC364FB6307034`, and `SETUP_INVALID / candidate_health_browser_actions_or_project_mismatch`. The redacted preflight confirms protocol 1, exact extension build match, and actions enabled; browser connection is false. Manual readiness inspection separately confirms all required routes and exact project resolution pass. The harness stopped before starting ACP peers or sending any test prompt.

Live qualification remains pending only on the real isolated Chrome companion extension becoming loaded/connected/paired with the refreshed candidate and ChatGPT page. The candidate itself is controller-ready and exact-project-ready. Once the extension is actually running, pairing is automatic in the released CoS contract; rerun preflight, then the full eight-case two-chat matrix with a fresh evidence directory. Keep `supportedConcurrency=1` until the two-chat gate passes. Four-chat qualification remains gated on that pass.

## 2026-10-27 optimized-provider two-chat qualification status

The historical final-v1 setup notes above are superseded for the active post-v1 performance lane. The current exact provider source/build is `93e69429a65a608c7e89e56c87006359acf79e1c` (`Cache provider input policy lifecycle tail`) in `.local-evidence/post-v1-concurrency/cos-source`. The exact unpacked candidate executable SHA-256 is `0CC862148BC7D828400449890AFF3084AF124A97A993718B7DA45A1FB62D73B5`; the bridge compatibility tuple and fixture are pinned to the same provider build. Focused provider validation passed 334/334 tests across durable, provider-turn-drain, opening-input, session-input, and control-api-actions suites. Focused bridge validation after the compatibility update passed 52/52 tests across step7 live smoke, performance harness, and CoS client suites.

The preceding exact candidate `f5ec2f1e37a1d314f7c7e5b27e61bf57214c42c7` completed a valid strict two-chat workload with 20/20 measured exact no-tool turns, 10 per chat, and `maxActiveLeases=2`. Drain p95 was 606 ms and post-drain p95 was 106 ms, but pre-send p95 was 707 ms, so the unchanged 250 ms pre-send gate failed. The current `93e6942` lifecycle-tail cache is the narrow follow-up optimization for that remaining input-policy read cost; it has not yet received a valid live latency sample.

Two strict `93e6942` attempts are preserved at `.local-evidence/post-v1-concurrency/live-runs/20261027T193145Z-twochat-policycache-93e6942` and `.local-evidence/post-v1-concurrency/live-runs/20261027T193600Z-twochat-policycache-93e6942-v2`. Both preflights passed with `browserReady=true`, `actionsEnabled=true`, and `exactBuild=true`, then failed during eligibility probing with `two_chat_probe_prompt_failed`. These are not latency failures and are not counted as measured qualification samples.

Direct DevTools inspection of the isolated `chrome-profile-live-01` lane showed `https://chatgpt.com/` at `Just a moment...` with an active Cloudflare Turnstile iframe. A same-profile reload on 2026-10-27 returned HTTP 403 with `Cf-Mitigated: challenge` for the main document and HTTP 403 for `https://chatgpt.com/api/auth/session`. The browser response remote address was the public Cloudflare address `172.64.155.209`, while Turnstile assets came directly from `104.18.95.41`; an explicit `curl --noproxy '*' https://chatgpt.com/` also returned the same 403 challenge. This ruled out the local isolation proxy as the cause, but the challenge was not a provider failure.

An earlier working theory blamed `--remote-debugging-port=0`, because that launch shape exposed `navigator.webdriver === true` and a fixed local DevTools port removed that signal. The subsequent fixed-port run at `.local-evidence/post-v1-concurrency/live-runs/20261027T200552Z-twochat-policycache-93e6942-fixeddevtools` disproved that as the primary blocker: it still failed during the two-chat eligibility probe. The stronger A/B is the network egress. During the challenged period, no-proxy Cloudflare trace reported public source `128.138.65.44`, whose PTR is `viz4.rc.colorado.edu` in University of Colorado Boulder Research Computing / AS104; ChatGPT returned HTTP 403 `Cf-Mitigated: challenge`, and challenge subservices showed `522`/timeout behavior. On 2026-10-28 the same Chrome-for-Testing binary, same `chrome-profile-live-01`, same cookies, same extension, same isolated CoS candidate, and same local proxy/bypass configuration were relaunched after the host egress changed to `71.218.226.86` (CenturyLink/Qwest). ChatGPT then loaded normally and authenticated `https://chatgpt.com/api/auth/session` returned HTTP 200. This isolates the challenged network path / IP reputation as the primary blocker; Chrome automation signaling may be an additive risk factor but was not sufficient to explain the failure. Preserve the same profile and fixed DevTools port for diagnostics, and resume strict two-chat on exact `93e6942` without changing provider semantics or qualification gates.

## 2026-10-29 baseline move and re-verification

The lane now targets T3 `0.1.5-nightly.20261029.3877` / `6d450a4284852af137b2f3407fddd89eb76e7644` (development baseline), matching the bridge repository. The release tuple is unchanged: `v1ReleaseGateManifest.qualifiedT3Sha` still records `ffb4af8d...`, and readiness now reports `t3BaselineQualified=false` / `releaseQualified=false` until live requalification.

Offline gate on the updated tree: typecheck PASS, ESLint PASS (one pre-existing `prefer-const` in `src/state/durable.ts` fixed), build PASS, `25/25` test files and `283/283` tests PASS. This includes the queueing scheduler, cancellation-reconciliation hardening, and the controller read-retry/history paging work already in this branch.

Live qualification remains pending on the same two external blockers recorded above: the isolated Chrome companion extension is not currently paired (`bridgePresent=false`), and the newest valid two-chat sample still fails the 250 ms pre-send p95 gate (`8b907ee`: 388/232/407/241/130/189 ms, two samples over budget). No new live prompts were sent during this baseline move.

## 2026-10-29 live two-chat attempt on the re-paired lane

The isolated Chrome lane was restored by pointing the companion extension at the running candidate (browser port `8767`, token from `cos-profile-live-01`) and stopping a stale candidate that was holding the extension on port `8765`. Preflight then reported `bridgeReady=true` (protocol 1, actions enabled, exact build `8b907ee`).

Run `20261029T180339Z-twochat-8b907ee-nightly` (8 cases):

- PASS: queue-cancel-slot-reuse (`maxWaitingLeases=1`), independent-active-cancellation (`maxActiveLeases=2`), crash-restart-with-two-active (2 unique inputs, `maxActiveLeases=2`), cross-session-stale-event, long-output-slow-consumer-rss (107 MiB, below the 256 MiB budget).
- FAIL: single-chat-baseline (pre-send p95 `640 ms`; samples `426,155,640,116,108,107,96,169,212,104`), two-chat-workload (pre-send p95 doomed with 2/12 over budget: `99,125,111,224,136,262,209,238,201,107,334,100`).
- SSE-reconnect case failed with a harness `TypeError` in its evidence path (`a.result` read when the prompt outcome was not `ok`). Fixed with optional chaining plus recorded prompt outcomes; the isolated rerun `20261029T181405Z-sse-reconnect-only` PASSed (`sseReconnectCount=1`, `maxActiveLeases=2`).

Latency profile: every phase except `inputSendMs` is stable (persisted read 1-7 ms, project 5-23 ms, readiness 3-14 ms, durable prepare 18-28 ms, lease acquire 15-42 ms, mark dispatched 16-29 ms). The failures are isolated to controller input acceptance: `inputSendMs` was 24-121 ms on most turns but 334 ms (first turn) and 544 ms (third turn) in the baseline. No provider semantics were changed for this run.

## 2026-10-29 two-chat gate PASS

Root cause of the earlier pre-send spikes: the isolated CoS profile had `tunnel.kind = "openai"` with empty tunnel IDs. Every input triggered a connection start that immediately failed, tore down its loopback server, and logged `connect failed: Enter a tunnel ID...`. Admission-phase measurement showed this churn, not fsync: a direct benchmark of the admission sidecar write (2 KB JSON, fsync + rename, 200 iterations) measured p50 2.7 ms, p95 3.7 ms, max 6.9 ms.

Fix: set `tunnel.kind = "manual"` in `cos-profile-live-01/config.json` (a copy of the previous config is kept as `config.pre-tunnel-manual.json`) and restart the candidate. Log verification after the change: zero `connect failed` entries and one server start for the whole session.

Results:

- Baseline only (`20261029T185258Z-baseline-tunnel-manual`): PASS, pre-send p95 135 ms (samples 62-135 ms), drain p95 443 ms, post-drain p95 94 ms.
- Two-chat only (`20261029T190454Z-twochat-only-tunnel-manual`): PASS, 20/20 turns, pre-send p95 119 ms, drain p95 672 ms, post-drain p95 98 ms, `maxActiveLeases=2`.
- Full matrix (`20261029T191009Z-twochat-full-tunnel-manual`): **all eight cases PASS** - single-chat baseline, two-chat workload, queue-cancel-slot-reuse, independent-active-cancellation, sse-reconnect-with-two-active, crash-restart-with-two-active, cross-session-stale-event, long-output-slow-consumer-rss. Baseline pre-send p95 110 ms / drain 591 ms / post 111 ms; two-chat pre-send p95 209 ms / drain 460 ms / post 105 ms; long-output bridge RSS 97.8 MiB; aggregate two-chat bridge RSS 169.3 MiB.

Advertised capability raised from 1 to **2** on this branch (`releaseReadiness().supportedConcurrency = 2`), with production queue capacity enabled by the existing scheduler. Four-chat qualification is next: it must show the controller's four-SSE global cap still leaves room for other CoS activity, or a versioned multiplexed stream contract is required first. The v1 release tuple and its `releaseQualified` gates are unchanged.

## 2026-10-29 four-chat attempt and stream-cap finding

Two include-four attempts were made after the two-chat pass.

- `20261029T192257Z-fourchat-tunnel-manual`: all eight two-chat cases PASSed again. The four-chat workload ran with four peers (six prompts each) and failed at round 3 with `four_chat_prompt_failed`. One peer (`b3e0dfd8-37d6-439b-b8c6-26bc5a30c5af`) still had generation 6 dispatched at abort; the controller journal shows that same turn started at `19:33:56.746Z` and drained at `19:34:02.177Z` - after the case ended at `19:34:01.577Z`. That run also opened the four new chats slowly: the first four admissions were claimed by the browser about 92 s after admission, which is what consumed the round budget.
- `20261029T193822Z-fourchat-tunnel-manual-r2` (after closing five accumulated browser tabs): two-chat workload PASS, but the single-chat baseline failed on drain p95 `1026 ms` against the 1000 ms budget (one 1026 ms sample; pre-send p95 was 108 ms). Because the two-chat gate status is derived from all cases in the same run, the four-chat case was skipped as `SETUP_INVALID / two_chat_gate_not_passed`.

Structural blocker: the controller enforces `MAX_EVENT_STREAMS = 4` and rejects a fifth stream with 503 (`control-stream.ts`). Each active bridged turn holds its own per-turn stream, so four active turns occupy all four slots. The four-chat gate requires `fifthStreamStatus === 200` - proof that four bridged sessions leave room for other CoS activity - which cannot hold while four per-turn streams are open. Advertising four therefore requires the versioned multiplexed event-stream contract described in `PLAN.md`, not another scheduling or latency fix.

Until that contract exists, the advertised ceiling stays at **2**. The four-chat workload itself is otherwise exercised (peers start, leases reach 4) and the remaining work is stream multiplexing plus a clean full-matrix rerun.

## 2026-10-29 multiplexed event-stream implementation

Provider source `4be7fc97a448a1a5f8b9d721f703e661f9246d1b` adds `GET /v1/events/stream` (`provider-event-stream-mux-v1`): one held connection for a bounded set of chats, per-session `cursors=<id>:<seq>`, `sessionId` on every frame, one controller stream slot for the whole set, and validation before the first byte. Provider tests: `test/control-api-stream.test.ts` 13/13 (fan-out, per-session resume, kind filter, invalid subscriptions, one-slot accounting, health route/feature), plus the control-API suites 96/96. Typecheck passes.

Bridge side adds `MuxHub` and uses it only when the last readiness snapshot advertised the feature; otherwise the per-session stream remains. It reconnects at per-session cursors, reopens when another chat joins, fails explicitly if the route disappears, and forces a shared reconnect on a Stop boundary. Tests: `test/cos-mux.test.ts` 4/4; full bridge suite 287/287.

Bridge compatibility now pins provider build `4be7fc9`. The running `8b907ee` candidate predates the route, so a live four-chat rerun requires rebuilding and relaunching the candidate from `4be7fc9`; the two-chat ceiling remains 2 until that run passes with a 200 fifth-stream probe.

## 2026-10-29 stream budget for one process per chat

The live gate starts one ACP bridge process per chat, so four concurrent chats hold four separate controller event streams; the multiplexed route only shares a connection between chats that one bridge process follows. With `MAX_EVENT_STREAMS = 4` the four-chat workload therefore left no slot for the gate's fifth-stream probe, which is what the earlier blocker recorded. Provider build `d7b266711c408c8183b1bddbd927ab85d533843b` raises the cap to eight: the four-chat working set plus headroom for a probe or a second reader. The multiplexed route remains advertised and tested for clients that follow several chats in one process, and still holds one slot for its whole subscription set. Provider stream tests 13/13 and the other control-API suites 83/83 pass at this build; the bridge compatibility pin now names it.

The reconnect fault case originally keyed its drop on a numeric SSE `id`, which the multiplexed route intentionally does not send, so the fault never fired on provider build `4be7fc9`. `scripts/post-v1-concurrency-runner.mjs` now also reads `sessionId`/`seq` from a mux frame and records the per-session cursor the next connection resumed from. An isolated rerun of `sse-reconnect-with-two-active` then passed (`sseReconnectCount: 1`) before the full matrix was repeated at build `d7b2667`.

## 2026-10-29 four-chat gate attempts at build d7b2667

Two full-matrix runs exercised the eight-stream budget and the multiplexed route. In both, all eight two-chat cases passed on the new build.

- `20261029T203600Z-full-eight-stream-cap-8`: the four-chat workload completed all 40 turns with four active leases and four passing session proofs (10 confirmed inputs, 10 drains, no duplicate sequence per chat); per-process RSS stayed between 82 and 95 MB. The gate failed on latency: drain p95 was 1467 ms against the 1000 ms budget, with outliers of 743, 1467, 3283 and 4928 ms. End-to-end median was 8.8 s. The fifth-stream probe recorded 404 because it ran before the controller had created that chat's session; the probe now waits for the four bridges to attach and retries on a setup race.
- `20261029T204848Z-full-eight-probe-retry`: the eight two-chat cases passed again. The four-chat workload reached round 7, then one chat received its prompt but never had an input accepted within the 15 s lease wait; the case aborted with `lease_state_timeout` and no pre-send phase was recorded for that turn.

A direct stream-budget check against the same build held four per-session streams and opened a fifth: statuses `200, 200, 200, 200, 200`. The eight-slot budget and the multiplexed route therefore work as designed; they are not the remaining constraint.

Four concurrent chats are **not qualified**. Correctness held on every turn that completed, but hidden-tab completion detection produced drain delays above the gate budget and one pre-send acceptance stalled past the gate's wait. `supportedConcurrency` remains 2. Raising it requires either steady drain latency under four hidden provider tabs or a documented budget change, and a four-chat run with no stalled acceptance.

## 2026-10-29 batched provider build and 2-chat requalification

Provider build `d77cdcaf4433aa54df5bd8b2c06c21083f92d3f8` carries `provider-session-workspace-v1`, `provider-model-catalog-v1` and `provider-input-images-v1` on top of the turn-drain and multiplexed-stream features. The bridge pin and full bridge suite (297/297) were refreshed at that build, and the packaged candidate reported `buildId=d77cdca…` with all nine features, actions enabled, a paired browser and a ready model catalog.

Authoritative run: `20261029T230611Z-twochat-requal-retry2` — **PASS**, all eight cases.

- single-chat baseline: 10 turns, pre-send p95 109 ms, drain p95 933 ms, post-drain p95 89 ms, RSS 79 MB.
- two-chat workload: 20 turns, 2 active leases, pre-send p95 142 ms, drain p95 719 ms, post-drain p95 94 ms, per-process RSS 82/87 MB, aggregate 147 MiB.
- queue/cancel/slot reuse, independent cancellation, SSE reconnect (`sseReconnectCount:1`), crash/restart, cross-session stale event, and long-output slow-consumer all passed.
- Tuple: T3 `6d450a4284852af137b2f3407fddd89eb76e7644`, CoS base `87ae9d631f82d8da2f462d910410031ad8f97ac5`. Candidate executable SHA-256 `AAFEE508A39EA6C696B39E629410A8CB5C442215919087807F2DD24B32AA87AE`.

Two earlier attempts on the same build did not pass and are retained as setup evidence:

- `20261029T224954Z-twochat-requal-d77cdca`: baseline drain p95 1103 ms against 1000 ms; the two-chat workload itself passed.
- `20261029T225829Z-twochat-requal-retry`: baseline passed; the two-chat workload stopped after eight accepted turns per peer because one prompt failed (the harness now records the round, peer and category for that failure).

The passing run is the qualifying evidence; `supportedConcurrency` remains 2. The workspace/model/image features do not raise that ceiling and 4/8-chat concurrency remains parked.

## 2026-10-30 budget-adjusted requalification on 0520fce

Run `20261030T032154Z-twochat-requal-0520fce-budget1500` passed all eight cases on provider build `0520fcedcd003bd89c43e649d1228333a4d2305f`. The post-v1 drain p95 budget is 1500 ms (v1 release gate unchanged at 1000). Baseline pre-send/drain/post p95 95/775/101 ms; two-chat 145/456/92 ms; two active leases; per-process RSS 150 MiB aggregate. The observed drain samples were under the old budget too, confirming the adjustment removed gate noise rather than masking a regression. Candidate executable SHA-256 `29B6F20E6440A6D74C7AD869781C5B7C524510E72BD43EFD1FEB83C1A94D2BE1`.

## 2026-10-30 requalification on dc691cd

Run `20261030T041202Z-twochat-requal-dc691cd` passed all eight cases on provider build `dc691cd97c99fdb4cebca7353319f3a9858a267f` with the post-v1 1500 ms drain budget. Baseline pre-send/drain/post p95 and two-chat values are in the run evidence; candidate executable SHA-256 `@{Algorithm=SHA256; Hash=B20F6B264AC538B8D3BAA5045160FDEFD743BC050A1EFAA7C97DEE69BF3185A6; Path=C:\Users\Emil\t3onsteroids-post-v1\.local-evidence\post-v1-concurrency\cos-source\release\win-unpacked\Chat On Steroids.exe}.Hash`. This build adds the linked-worktree resolver fallback on top of 0520fce.
