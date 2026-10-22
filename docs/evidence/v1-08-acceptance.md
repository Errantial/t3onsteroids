Evidence-Schema: 1
Gate: liveAcceptance
Status: PENDING

# V1 Step 8 — pinned live acceptance matrix

`bridgeImplementationCommit`: `69f00277698e6e1fc36914c4fa8992b5f79ebbc5`.

`evidenceCommit`: `69f00277698e6e1fc36914c4fa8992b5f79ebbc5` (current implementation commit used as the evidence-refresh base; prior live artifacts retain their own evidence commit).

Target pinned release tuple: T3 `0.0.46-nightly.20261013.3040` / `ffb4af8d5d4fcfc5e9322295ff846a6d1e7ffbf8`; CoS base `2.1.39` / `87ae9d631f82d8da2f462d910410031ad8f97ac5`; provider-extension build `76fe2e7f3236e2ae2ffd4ec4606759909257fd69`; ACP SDK `1.9.0`; Node `24.21.0`; Windows x64.

**Current gate status is pending.** The previous browser-live/deterministic run is preserved under `.local-evidence/v1/20261019T234030Z/` and was recorded against bridge implementation `336c701c7fb3da967ef11c6b167da8a266becc46` and evidence commit `0a39af1313bd0a275b37a4ab83bb0a8efcade741`. Those results are historical and cannot satisfy the current matrix after later implementation changes through `69f00277698e6e1fc36914c4fa8992b5f79ebbc5` and the provider update to `76fe2e7f3236e2ae2ffd4ec4606759909257fd69`. Do not overwrite or delete the old artifacts.

## Preserved prior outcomes (historical only)

- **V1-02, V1-03, V1-04: PASS** in the old browser-live run. Simple turn, same-session multi-turn, and exact long assistant content all had matching terminal/drain and policy evidence. Rerun on the current implementation before promoting.
- **V1-05: FAIL**. The request did not create the safe fixture because the tool reported its approved root `/sunrise` was unavailable. The fixture remained absent; the failure was explicitly recorded as `tool_workspace_root_unavailable`, not accepted as a successful edit. Retest with a valid exact-root fixture after live preflight is safe.
- **V1-06, V1-07, V1-09, V1-10, V1-12, V1-16, V1-18, V1-19A: deterministic component PASS** in the old integration run. These are not full matrix PASSes where the plan additionally requires live smoke (notably V1-09 SSE reconnect, V1-10 healthy bridge restart, V1-12 healthy pinned-T3 resume, and V1-18 the Step-7 live slow-consumer case).
- **V1-08: PASS** in the old browser-live run. Exact active-turn Stop produced a matching stopped `turn_end`, `turn_drained`, policy attestation and ACP cancelled terminal. It remains historical until rerun on the current implementation.
- **V1-11: FAIL**. CoS process restart rotated endpoint/token while the same profile/session/input identity was retained, but the provider turn stayed active without `turn_end`/`turn_drained`; cancellation remained requested, lease release was not proven, and no second prompt was sent. A subsequent read-only controller check still found the exact provider turn `active`; a fresh exact Stop attempt returned HTTP 409 and no terminal proof appeared. This is unresolved, not a pass.
- **V1-13, V1-14, V1-15: PENDING**. No current qualifying artifacts establish compact/resume/handoff, disabled-action negative/positive pair, or project-remap/unavailable cases.
- **V1-17: partial only**. CoS source tests passed the worker/Goal/Loop/continuation refusal component, but the full row still lacks live policy re-attestation across restart, compaction and handoff.
- **V1-19B: source-suite component PASS only**. The preserved artifact recorded the installed candidate hash as not matching the recorded hash, so candidate provenance must be re-established before this can count for the full split-ownership row.
- **V1-01: historical setup/provider-validation artifacts exist**, but this current evidence file does not promote the row; rerun or formally reconcile its exact no-input/no-chat/no-probe-state assertions on the current tuple.

## Current live preflight blockers

The running pinned candidate profile was last read-only diagnosed as CoS `2.1.39.0`, candidate executable SHA-256 `c490de96b0c5d6349ad5586465a5bd8d33d912b26a53ff51deec43e60672ef1b`, protocol 1, provider-extension build `73e52028cb87ed2dd6fdc8c1a03a79669b8302bc`, all four required features, actions enabled, and exact project root resolved. That installed provider build is now older than the final source pin `76fe2e7f3236e2ae2ffd4ec4606759909257fd69` and must be safely reconciled before new live qualification can count. CoS `2.1.44` is currently staged to install on ordinary quit; do not quit/restart this candidate until that update handoff is neutralized or isolated.

The browser-extension stamp discrepancy is resolved as provenance, not as a current live-provider match: `45ee28157713` is the source/recomputed/packaged/materialized stamp for the currently installed `73e52028` candidate, while historical `a35dccb10b05` belongs to the older `4d8ea6ac` artifact. The stamp itself is no longer a blocker. The remaining live provenance blocker is that the running provider build is still `73e52028`, not final source pin `76fe2e7f`.

The old V1-11 durable state has `cancelIntent=requested`, a saved active input/turn, and no authoritative drain proof. The currently installed `73e52028` candidate returned HTTP 409 (`turn_not_running`) for exact-turn Stop after restart. Final source lineage now contains the scoped exact-provider-turn restart Stop repair, but that source result is not a substitute for installing/reconciling the live candidate and obtaining authoritative matching `turn_end` / `turn_drained`. Do not clear or rewrite the state, send another prompt, or reuse this admission domain until the integrated recovery proves the exact turn terminal/drained and safely resolves the lease. The selected `T3 and CoS Compatibility` thread is read-only proven to map to ACP session `e2c42c71-0c7f-44cc-b1ed-1c0606ad6a74`; `STEP7-COS-BROWSER-01` remains a separate thread.

## Fresh read-only V1-11 reconciliation — 2026-10-20

Artifact: `.local-evidence/v1/20261020T025835Z-readonly-v1-11/readonly-reconciliation.json` (captured `2026-10-20T02:58:36Z`). This is a new read-only observation, not a replacement for the historical V1-11 FAIL artifact and not a new acceptance attempt.

- Current candidate is still PID `38104`, CoS `2.1.39.0`, executable SHA-256 `c490de96b0c5d6349ad5586465a5bd8d33d912b26a53ff51deec43e60672ef1b`; protocol 1, actions enabled, all four required provider-extension features available, provider build ID `73e52028cb87ed2dd6fdc8c1a03a79669b8302bc`, and exact project root resolves. No credential value was emitted.
- The exact controller read reports session `e2c42c71-0c7f-44cc-b1ed-1c0606ad6a74`, active input `a4c30169-b041-4b34-b1bb-c5c920f2fb58`, turn `g-1q2mv3n11cqq8m-0-1`, state `active`, input delivery `sent`, `drainedSeq=null`, and `finalAssistantSeq=null`. Policy remains `backgroundWork=disabled`, enforced. Querying events from durable cursor `477` returned only event `477` (`assistant_message` for the same turn); no later sequence or matching `turn_end`/`turn_drained` exists in the current response. The durable `cancelIntent` remains `requested`, and the matching admission-lease file is present.
- The T3 database row for thread `3f8607fc-a5ac-4fe1-b872-956bbfd38d46` (`T3 and CoS Compatibility`) records provider `t3onsteroids` and `nativeThreadRef.nativeId=e2c42c71-0c7f-44cc-b1ed-1c0606ad6a74`. Its sixth provider turn references `e2c42c71-0c7f-44cc-b1ed-1c0606ad6a74:turn:6` and is projected as `interrupted`. That T3 projection is not CoS terminal/drain proof.
- The installed candidate source explains the historical 409 guard: it required process-local live activity authority to match the persisted exact turn before accepting Stop, so a restarted process could retain durable active provider state while refusing Stop. Final source build `76fe2e7f3236e2ae2ffd4ec4606759909257fd69` includes the scoped restart recovery repair and its regression coverage; live recovery still requires that final provider code to be the code actually serving the session.
- The installed profile stamp `45ee28157713` matches the packaged `73e52028` candidate; historical `a35dccb10b05` belongs to the separate `4d8ea6ac` artifact. The stamp discrepancy is therefore resolved. CoS `2.1.44` is the current staged next-quit update hazard.
- No prompt, Stop action, restart, state clearing, or admission-domain reuse was performed in that read-only reconciliation. **NO-GO remains for Step 7 and Step 8** until the staged-update hazard and live-provider identity are safely reconciled and integrated recovery produces authoritative matching terminal/drain proof for the preserved V1-11 turn.

## Current implementation validation and gate boundary

```text
npm run verify                              PASS — 25/25 test files, 243/243 tests
targeted CoS client regressions             PASS — 27/27 tests
git diff --check                            PASS
package smoke                               PASS — releaseQualified false
```

These deterministic results validate implementation `69f00277698e6e1fc36914c4fa8992b5f79ebbc5` and final provider source build `76fe2e7f3236e2ae2ffd4ec4606759909257fd69`; they do not promote historical browser-live outcomes. Main `npm run verify` is PASS — 25/25 files, 243/243 tests; main `npm audit --json` exits 0 with zero vulnerabilities; `git diff --check` passes; final provider `npm run verify` also exits 0. The exact T3 thread/session mapping and browser stamp provenance are proven, but the preserved exact-turn state, staged `2.1.44` update hazard, and live provider-build mismatch remain unresolved. Resume Step 7 only after those blockers are safely resolved. Step 8 requires every V1-01…V1-19 row to pass in the exact execution mode/owner specified by `PLAN.md`. Overall `releaseQualified` remains false.

## Integrated V1-11 recovery attempt — 2026-10-22 UTC

Artifact: `.local-evidence/v1/20261022T011830Z-v1-11-recovery/recovery.json`.

- The staged CoS `2.1.44` installer was reversibly quarantined outside the profile's `updates` directory while the pinned CoS `2.1.39.0` process remained running as PID `38104`. Candidate executable SHA-256 remained `c490de96b0c5d6349ad5586465a5bd8d33d912b26a53ff51deec43e60672ef1b`; browser-extension stamp remained `45ee28157713`; quarantined installer SHA-256 remained `2EEB4616A07F5BAE501E89250D7C57FB1775FD77729DE2B802D3CC59342F3E00`.
- Attempt 01 was `SETUP_INVALID`: a temporary one-shot reconciliation launcher used the wrong relative import path and exited before any controller action or durable-state mutation. The failure is preserved rather than erased.
- Attempt 02 invoked the production runtime's persisted-cancellation reconciliation path directly against the preserved session, so it could replay only the saved exact Stop target and could not post a new provider input. The live controller returned HTTP `409`; the bridge surfaced `request_failed`; durable `cancelIntent` remained `requested`; the exact turn remained `g-1q2mv3n11cqq8m-0-1`.
- A post-attempt read found no events after the existing cursor, no matching `turn_end`, and no matching `turn_drained`. The provider turn remains `active`; `drainedSeq` and `finalAssistantSeq` remain null. The 409 is therefore preserved as a FAIL and is **not** treated as terminal or drain proof.
- The reason is now identity-concrete: the running candidate still serves provider build `73e52028cb87ed2dd6fdc8c1a03a79669b8302bc`, while the final qualified source pin is `76fe2e7f3236e2ae2ffd4ec4606759909257fd69`, which contains the scoped exact-Stop-after-restart fix. Replaying the preserved same-profile turn through that fix requires the final provider code to be the code actually serving this profile/session.

Under the current instruction for V1-11 to restart only the bridge if required, there is no safe remaining mutation that can install the final CoS main-process provider code into the already-running `2.1.39` process. Hot-patching the running app, copying provider state into an isolated side-by-side profile, clearing/re-writing the preserved session, or accepting silence/409 would violate the qualification contract. V1-11 and therefore Steps 7–8 remain blocked until the owner authorizes a normal same-profile final-candidate CoS replacement/restart (with the quarantined updater still prevented from taking over), or changes the requirement for how the preserved V1-11 attempt may be reconciled.

## Final-provider V1-11 reconciliation — 2026-10-22 UTC

Artifact: `.local-evidence/v1/20261022T023206Z-v1-11-final-provider-blocked/`.

- The authorized same-profile final portable candidate is live on PID `47268`, CoS `2.1.39.0`, executable SHA-256 `37D37FAE28FF467F85DC701EB851EF6B583649A2B294163D53AE030294C379CB`, with provider build `76fe2e7f3236e2ae2ffd4ec4606759909257fd69`. Read-only `--diagnose` is `ready:true`: controller discovery/health, actions, all required action routes, all four provider-extension features, and exact canonical project root `C:\Users\Emil\t3onsteroids` are current. The staged `updates\2.1.44` directory is absent; prior downloads remain quarantined outside `updates`.
- Newer provider history, discovered after the final candidate replacement, contains an authoritative `turn_end` for the preserved exact turn `g-1q2mv3n11cqq8m-0-1` at seq `485`, outcome `completed`, recovered from the final assistant message after the ChatGPT page reloaded. This is stronger than the historical HTTP `409` attempt but is still not enough for V1-11 acceptance.
- There is still **no matching `turn_drained`** for that exact turn. The provider sidecar now records the same turn as `state=broken`, `closingOutcome=completed`, `terminalSeq=485`, with a drain token but no `drainedSeq` or `finalAssistantSeq`. The durable bridge state remains at cursor `477` with `cancelIntent=requested`, generation `6`, the exact active input/turn, and its admission lease still present.
- Final provider source deliberately quarantines an unsealed closing turn as `broken` after restart when no durable `turn_drained` marker advanced the checkpoint. Its drain probe/commit path accepts only `closing` or `drained`; a `broken` turn is not eligible for a later drain commit. This is fail-closed behavior, not an invitation to rewrite the provider sidecar or synthesize a marker.
- The absence of recorded tool calls for this turn is not a substitute for drain proof. Provider effect admission happens before the tool handler and before the durable tool-call row is written, while running process-completion custody is process-memory-only. A restart can therefore lose knowledge of an admitted effect in the gap before its durable recorder row exists. `toolCalls:0`, the completed `turn_end`, and post-restart silence cannot prove that gap empty; this is the exact uncertainty the `broken` quarantine preserves.
- Therefore V1-11 is **BLOCKED/FAIL for release qualification on the final provider identity**: authoritative terminal proof exists, authoritative drain proof does not, and the remaining admission lease/cancel state cannot be safely finalized by a supported production transition. No new Stop, prompt, state clearing, state rewrite, or fabricated terminal/drain was performed during this reconciliation.
- Step 7 and Step 8 promotion remain blocked under the qualification contract. `releaseQualified` remains false. Historical FAIL and SETUP_INVALID artifacts are preserved unchanged.
