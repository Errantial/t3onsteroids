Evidence-Schema: 1
Gate: liveAcceptance
Status: PENDING

# V1 Step 8 — pinned live acceptance matrix

`bridgeImplementationCommit`: `ef2548b817fe9318ac238e84d0ab39fd65258940`.

`evidenceCommit`: `ef2548b817fe9318ac238e84d0ab39fd65258940` (current implementation commit used as the evidence-refresh base; prior live artifacts retain their own evidence commit).

Pinned release tuple: T3 `0.0.46-nightly.20261013.3040` / `ffb4af8d5d4fcfc5e9322295ff846a6d1e7ffbf8`; CoS base `2.1.39` / `87ae9d631f82d8da2f462d910410031ad8f97ac5`; provider-extension build `73e52028cb87ed2dd6fdc8c1a03a79669b8302bc`; ACP SDK `1.9.0`; Node `24.21.0`; Windows x64.

**Current gate status is pending.** The previous browser-live/deterministic run is preserved under `.local-evidence/v1/20261019T234030Z/` and was recorded against bridge implementation `336c701c7fb3da967ef11c6b167da8a266becc46` and evidence commit `0a39af1313bd0a275b37a4ab83bb0a8efcade741`. Those results are historical and cannot satisfy the current matrix after implementation changes at `9f6a70c589ac1ac4831ebde4f3f6d45bc493e3be` and `ef2548b817fe9318ac238e84d0ab39fd65258940`. Do not overwrite or delete the old artifacts.

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

The pinned candidate profile was read-only diagnosed as CoS `2.1.39.0`, candidate executable SHA-256 `c490de96b0c5d6349ad5586465a5bd8d33d912b26a53ff51deec43e60672ef1b`, protocol 1, provider-extension build `73e52028cb87ed2dd6fdc8c1a03a79669b8302bc`, all four required features, actions enabled, and exact project root resolved. The candidate currently advertises that CoS `2.1.42` is downloaded and ready to install on the next quit; do not quit/restart this candidate during qualification.

The live profile's `extension/build-stamp.txt` reports `45ee28157713`, while the older Step-1 source evidence records browser-extension stamp `a35dccb10b05`. The provider-extension `buildId` matches, but this file-stamp discrepancy must be reconciled against the exact candidate artifact before claiming pinned live provenance.

The old V1-11 durable state has `cancelIntent=requested`, a saved active input/turn, and no authoritative drain proof. The controller reports the provider turn as active, but the exact-turn Stop endpoint returned HTTP 409 (`turn_not_running` at the candidate route boundary). Do not clear the state, restart the candidate, send another prompt, or reuse this admission domain until an approved recovery proves the exact turn terminal/drained and safely resolves the lease. The exact selected T3 thread ↔ bridge-session mapping must also be proven; the browser currently displays the long V1-11 response while `STEP7-COS-BROWSER-01` is a separate thread.

## Current implementation validation and gate boundary

```text
npm run verify                              PASS — 25/25 test files, 243/243 tests
targeted CoS client regressions             PASS — 27/27 tests
git diff --check                            PASS
package smoke                               PASS — releaseQualified false
```

These deterministic results validate implementation `ef2548b817fe9318ac238e84d0ab39fd65258940`; they do not promote historical browser-live outcomes. Resume Step 7 only after the exact-turn/state, candidate-update, provenance-stamp and T3 thread/session gates are safely resolved. Step 8 requires every V1-01…V1-19 row to pass in the exact execution mode/owner specified by `PLAN.md`. Overall `releaseQualified` remains false.
