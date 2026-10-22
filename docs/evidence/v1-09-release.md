Evidence-Schema: 1
Gate: t3HeadDrift
Status: PENDING

# V1 Step 9 — current-T3 drift, clean-checkout release preparation

`bridgeImplementationCommit`: `69f00277698e6e1fc36914c4fa8992b5f79ebbc5`.

`evidenceCommit`: `69f00277698e6e1fc36914c4fa8992b5f79ebbc5` (current implementation commit used as the evidence-refresh base; later evidence-only commits do not change `bridgeImplementationCommit`).

Pinned release tuple remains T3 `0.0.46-nightly.20261013.3040` / `ffb4af8d5d4fcfc5e9322295ff846a6d1e7ffbf8`; CoS base `2.1.39` / `87ae9d631f82d8da2f462d910410031ad8f97ac5`; provider-extension build `76fe2e7f3236e2ae2ffd4ec4606759909257fd69`; ACP SDK `1.9.0`; Node `24.21.0`; Windows x64.

**No Step-9 drift or release-cut result is claimed.** The current-T3-HEAD drift lane has not yet been executed for implementation `69f00277698e6e1fc36914c4fa8992b5f79ebbc5`. Earlier read-only preparation observed current upstream T3 HEAD `b69703ccc240b9ecc6582be024f199d6d8dd44da`, but Step 9 must re-resolve the authoritative upstream HEAD immediately before execution and keep the pinned support tuple unchanged. The drift lane remains separate from pinned V1 qualification and must not relax prompt normalization.

## Release-preparation checklist (pending)

- [ ] Wait for Step 7 live performance and every Step 8 V1-01…V1-19 row to pass on current implementation and exact pinned external provenance.
- [x] Reconcile the running live provider to final source pin `76fe2e7f...` and neutralize/isolate the staged CoS `2.1.44` next-quit update handoff. The final candidate is live and diagnosed ready.
- [ ] Resolve the preserved V1-11 turn with authoritative terminal **and drain** proof before any qualifying restart/live case. Current final-provider evidence has matching `turn_end` seq `485` but no `turn_drained`; restart recovery quarantined the unsealed closing turn as `broken`, so this remains a hard fail-closed blocker.
- [ ] Run the current-T3-HEAD drift lane separately; record `compatible` or `incompatible` and preserve the pinned T3 support metadata unchanged.
- [ ] Verify a fresh clean checkout with `npm ci`, `npm run verify`, `npm audit --json`, and `git diff --check`.
- [ ] Verify package/ACP/compatibility/readiness versions, real `node.exe + dist/cli/index.js` launch under T3 `shell:false`, and the full provenance tuple.
- [ ] Record final dependency advisory disposition and complete canonical evidence; promote every manifest gate only after its matching evidence is committed and current.
- [ ] Create tag `v1.0.0` only after the worktree is clean and all manifest gates are PASS for the exact implementation/extension tuple.

## Release preparation gate

Evidence-Schema: 1
Gate: releasePreparation
Status: PENDING

The release candidate is still not qualified. Current deterministic bridge verification is green (`npm run verify`: 25/25 test files, 243/243 tests; bridge `npm audit --json`: zero vulnerabilities), but these checks do not substitute for the pending live performance, live acceptance, current-T3 drift, or fresh-checkout gates. `node dist/cli/index.js --release-readiness` must continue to report `releaseQualified:false` until every required gate has current passing evidence.
