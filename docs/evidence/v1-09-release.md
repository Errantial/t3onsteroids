Evidence-Schema: 1
Gate: t3HeadDrift
Status: PASS
Outcome: compatible

# V1 Step 9 — current-T3 drift, clean-checkout release preparation

`bridgeImplementationCommit`: `f3a672cffdee77f54d377d5594893e0606d20d5b`.

Pinned release tuple: T3 `0.0.46-nightly.20261013.3040` / `ffb4af8d5d4fcfc5e9322295ff846a6d1e7ffbf8`; CoS `2.1.39` / `87ae9d631f82d8da2f462d910410031ad8f97ac5`; provider build `495e3e96504d9b865c18478f7b42915280712f84`; candidate SHA-256 `D2A99BC116FEAFE66318AA3912042ED52610EEDAA3569E5C5FFC364FB6307034`; browser-extension stamp `6c66160b96d3`; ACP SDK `1.9.0`; Node `24.21.0`; Windows x64.

## Current-T3-HEAD drift

The authoritative upstream `pingdotgg/t3code` `main` HEAD was re-resolved immediately before the drift check as `807319c276c6831b2c219640e9da5b38019a8f1d`. The pinned support tuple remains unchanged. Machine-readable evidence is `.local-evidence/v1/step9-t3-head-current.json`.

The drift result is **compatible**. The current upstream source preserves the exact orchestration envelope/runtime-info split, pull-request-linking runtime block, ACP initialize/session-prompt lifecycle, and `shell:false` ACP spawn boundary expected by the bridge. The focused bridge normalization regression passed `2/2` selected tests (`10` skipped) without loosening prompt matching or changing pinned compatibility metadata.

## Release-preparation verification

Fresh-checkout evidence: `.local-evidence/v1/20261023T081532Z-step9-fresh-checkout/qualification.json`.

- Fresh checkout commit: `6b8237e346a5068a5b9f6946bacb6bb0ad81d3fa` (Step-8 evidence promotion; implementation identity remains `f3a672c...`).
- `npm ci`: PASS, `147` packages added, `0` vulnerabilities.
- `npm run verify`: PASS, `25/25` test files and `246/246` tests; includes typecheck, lint, build, test, package smoke, release-manifest guard, implementation-commit guard and release-version consistency.
- `npm audit --json`: PASS, `0` vulnerabilities at every severity.
- `git diff --check`: PASS; fresh checkout worktree clean.
- `node scripts/implementation-commit.mjs`: exact `f3a672cffdee77f54d377d5594893e0606d20d5b`.
- Real launcher proof: `C:\Program Files\nodejs\node.exe` + fresh-checkout `dist\cli\index.js`, `spawnShell:false`, exit status `0`; no `.cmd`, `npm` or PowerShell wrapper.
- Compatibility output is exactly the pinned tuple above. Pre-Step-9-promotion readiness correctly reported `liveAcceptanceRequired:false`, `currentHeadDriftRequired:true`, `releaseQualified:false`; the final manifest promotion is performed only after this evidence block is complete.
- Bridge dependency audit remains zero. CoS application advisory disposition remains the separately documented Step-1 residual and is not altered by this bridge release.
- The quarantined CoS updater was not run; active/default CoS remained untouched during side-by-side qualification.

## Release preparation gate

Evidence-Schema: 1
Gate: releasePreparation
Status: PASS

Step 7 and Step 8 are current PASS on the final f3/495e tuple, current-T3 drift is recorded as compatible, and the fresh clean-checkout release preparation above is green. This evidence satisfies the two Step-9 gate blocks; the release manifest may now promote `t3HeadDrift` and `releasePreparation` to PASS, after which final readiness must be rerun and the repository must be clean before tagging `v1.0.0`.
