Evidence-Schema: 1
Gate: t3HeadDrift
Status: PENDING

# V1 Step 9 — current-T3 drift, clean-checkout release preparation

`bridgeImplementationCommit`: `4cffd484601ae3dabfc2bce066f47cac3fbf8f9a`.

`evidenceCommit`: `7a8c3ad679aa5d667f9307cf09e6086da53cc43e` (evidence-refresh base before the current evidence-only promotion; later evidence-only commits do not change `bridgeImplementationCommit`).

Pinned release tuple remains T3 `0.0.46-nightly.20261013.3040`; CoS base `2.1.39` / `87ae9d631f82d8da2f462d910410031ad8f97ac5`; packaged candidate SHA-256 `ABC8A63C9A7FD0CB92DD1101EF8E87AB5BC194166DA845AB57EB32B6E8C01EA8`; browser-extension stamp `bafcb47f1143`; provider-extension build `e5157983c6b5cbc7a9a1fc77c0822d452ab52d2f`; ACP SDK `1.9.0`; Node `24.21.0`; Windows x64.

**No Step-9 drift or release-cut result is claimed.** The current-T3-HEAD drift lane has not yet been executed for implementation `69f00277698e6e1fc36914c4fa8992b5f79ebbc5`. Earlier read-only preparation observed current upstream T3 HEAD `b69703ccc240b9ecc6582be024f199d6d8dd44da`, but Step 9 must re-resolve the authoritative upstream HEAD immediately before execution and keep the pinned support tuple unchanged. The drift lane remains separate from pinned V1 qualification and must not relax prompt normalization.

## Release-preparation checklist (pending)

- [ ] Step 7 live performance is PASS on the final tuple; wait for every Step 8 V1-01…V1-19 row to pass before release preparation can complete.
- [x] Reconcile the running live provider to final source pin `e5157983...` and neutralize/isolate the staged CoS `2.1.44` next-quit update handoff. The final side-by-side candidate is live and diagnosed ready.
- [x] Preserve the pre-fix V1-11 admission domain as immutable FAIL evidence and waive it as a release prerequisite. Do not repair/reclassify its generic `broken` state. Fresh V1-11 final-tuple evidence now passes on a new admission domain.
- [ ] Run the current-T3-HEAD drift lane separately; record `compatible` or `incompatible` and preserve the pinned T3 support metadata unchanged.
- [ ] Verify a fresh clean checkout with `npm ci`, `npm run verify`, `npm audit --json`, and `git diff --check`.
- [ ] Verify package/ACP/compatibility/readiness versions, real `node.exe + dist/cli/index.js` launch under T3 `shell:false`, and the full provenance tuple.
- [ ] Record final dependency advisory disposition and complete canonical evidence; promote every manifest gate only after its matching evidence is committed and current.
- [ ] Create tag `v1.0.0` only after the worktree is clean and all manifest gates are PASS for the exact implementation/extension tuple.

## Release preparation gate

Evidence-Schema: 1
Gate: releasePreparation
Status: PENDING

The release candidate is still not qualified. Step 7 is current PASS; Step 8 live acceptance and Step 9 current-T3 drift/fresh-checkout/release preparation remain pending. `node dist/cli/index.js --release-readiness` must continue to report `releaseQualified:false` until every required gate has current passing evidence.
