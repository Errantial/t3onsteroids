# Post-v1 concurrency qualification

Status: offline bridge gate passed, including cancellation-reconciliation hardening; isolated live qualification is blocked at authentication/controller readiness. No live test prompts have been sent.

## Scope and safety boundary

- Worktree: C:\Users\Emil\t3onsteroids-post-v1
- Branch: feat/post-v1-concurrency
- Scheduler implementation base: b8640281c52b932bc7f8cd3d6f5048164a7beb0a
- The pinned v1 checkout and its release evidence, manifest, and active CoS candidate are outside this qualification lane.
- The live candidate is built from an isolated clone of the CoS provider-extension source at 73e52028cb87ed2dd6fdc8c1a03a79669b8302bc. The source clone and candidate profile live under .local-evidence/post-v1-concurrency.
- CoS base compatibility is 2.1.39 / 87ae9d631f82d8da2f462d910410031ad8f97ac5; controller protocol 1; provider extension build id 73e52028cb87ed2dd6fdc8c1a03a79669b8302bc.
- The candidate uses a separate CoS user-data directory, a separate browser profile, and separate bridge state directories. No live traffic has been sent by this qualification harness yet.

## Offline bridge verification

Final command: npm run verify

Result: PASS on the updated worktree. Typecheck and ESLint passed; 25 test files and 253 tests passed; package smoke passed. The smoke readiness output reported supportedConcurrency=1 and releaseQualified=false.

Cancellation-reconciliation audit: `src/acp/index.ts` now uses one shared exact-generation predicate for every not-sent settlement acceptance path. It requires the active input/turn and provider translation to be absent, cancellation target/intent to be cleared, dispatch and lease metadata to be absent, pending mode-transition metadata to be absent, and `bindingState` not to be `create_pending`. `test/acp-durable-runtime.test.ts` covers each residual field independently and checks generation equality. `src/acp/stdio.ts` remains the transport/error-mapping boundary; no separate settlement predicate was present there.

Additional focused checks:
- The queued-cancellation race passed 10 consecutive isolated runs.
- The focused durability/process/performance selection passed 128 tests before the final full gate.
- Node syntax checks passed for post-v1-concurrency-runner.mjs and post-v1-concurrency-live.mjs.
- npm run lint passed after the qualification harness was added.
- git diff --check passed.
- Latest focused selection: `npx vitest run test/acp-durable-runtime.test.ts test/state-durable.test.ts test/state-process.test.ts test/integration/acp-stdio.test.ts --maxWorkers=1` — PASS, 123 tests across four files.

## CoS candidate source checks

- npm ci passed in the isolated source clone.
- Focused provider-extension/controller suites passed 152/152 tests across six files: control-api actions, reads, core API, SSE stream, provider turn drain, and provider build id.
- An additional full CoS npm run verify attempt was interrupted after broader process/UI-timing suites reported failures in plugins-manager, input-delivery, and Continue-flow tests under load. That run is not considered green; those failures were not all rerun in isolation.
- The exact-source unpacked package build and packaged-runtime smoke passed with npm run dist:dir:x64. The executable SHA-256 is C490DE96B0C5D6349AD5586465A5BD8D33D912B26A53FF51DEEC43E60672EF1B. The browser extension stamp is 45ee28157713; the provider-extension source build id remains 73e52028cb87ed2dd6fdc8c1a03a79669b8302bc.

## Live measurement rules

- Baseline: 10 single-chat bridge turns.
- Two-chat workload: 10 turns in each of two independent sessions, started in paired rounds.
- p95 uses nearest rank: sorted[ceil(0.95*N)-1].
- v1 budgets: pre-send p95 at most 250 ms, turn-drain p95 at most 1000 ms, post-drain p95 at most 250 ms.
- Per-process bridge RSS budget: below 256 MiB in the long-output/slow-consumer case. Aggregate bridge RSS across concurrent ACP processes is recorded separately and is not substituted for per-process RSS.
- The live matrix must verify two simultaneous active leases, independent active cancellation, queued cancellation before any CoS input is sent, slot reuse after release, crash/restart with another session active, an intentional SSE disconnect/reconnect with both sessions active, and a stale terminal event from another session that cannot settle the target turn.
- Four-chat qualification runs only after the full two-chat gate passes. The fifth-stream probe must show whether four bridged sessions leave room for other CoS activity. If it does not, implement and test a versioned multiplexed event-stream contract before advertising four.
- supportedConcurrency stays at 1 until the two-chat gate passes. releaseQualified stays false while any v1 release gate is pending.

## Live results

Candidate package identity checks: the candidate executable SHA-256 remains `C490DE96B0C5D6349AD5586465A5BD8D33D912B26A53FF51DEEC43E60672EF1B`; the isolated candidate extension and copied profile extension both have build stamp `45ee28157713`; source commit/build ID is `73e52028cb87ed2dd6fdc8c1a03a79669b8302bc`. The candidate process uses `cos-profile-live-01`, and Chrome uses `chrome-profile-live-01`; Chrome's extension settings resolve to the isolated `cos-profile-live-01\extension` path. The packaged extension identity is present in the isolated profile, but the running extension has not reported a successful pairing/build handshake to the candidate.

Setup-invalid attempt: `.local-evidence/post-v1-concurrency/live-runs/20261019T232918Z-preflight-not-ready/manifest.json`. Reproducible command (run from the post-v1 worktree): `node scripts/post-v1-concurrency-live.mjs --profile '.local-evidence\post-v1-concurrency\cos-profile-live-01' --project 'C:\Users\Emil\t3onsteroids-post-v1' --out-dir '.local-evidence\post-v1-concurrency\live-runs\20261019T232918Z-preflight-not-ready' --expected-build-id '73e52028cb87ed2dd6fdc8c1a03a79669b8302bc' --candidate-exe-sha256 'C490DE96B0C5D6349AD5586465A5BD8D33D912B26A53FF51DEEC43E60672EF1B'`. Result: `SETUP_INVALID`, preflight `isolated_candidate_or_project_unavailable`, exit code 2. No ACP peer was started and no test prompt was sent. The isolated Chrome profile is at ChatGPT's login dialog; the candidate setup UI says it is waiting for the browser extension. The candidate `control-api/endpoint.json` and `control-api/token` discovery files are absent, so controller health, pairing, actions-enabled state, and exact project resolution cannot yet be verified. A CoS in-app update notice for 2.1.42 was left uninstalled to preserve the pinned candidate artifact.

Live qualification remains pending until the user completes authentication in the isolated Chrome profile and the isolated CoS candidate is paired, has Local control API and Allow actions enabled, and reports protocol/build/features/required routes ready. After that, rerun the full eight-case two-chat matrix with a fresh evidence directory. Keep `supportedConcurrency=1` and `releaseQualified=false` until the two-chat gate passes. Four-chat qualification remains gated on that pass.
