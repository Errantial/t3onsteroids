# T3 nightly baseline update (2026-10-29)

Status: **deterministic verification complete; live requalification pending.**

## Change

The pinned development baseline moved from T3 `0.0.46-nightly.20261013.3040`
(`ffb4af8d5d4fcfc5e9322295ff846a6d1e7ffbf8`) to the newest published nightly,
`v0.1.5-nightly.20261029.3877` (`6d450a4284852af137b2f3407fddd89eb76e7644`, the same
commit as the `v0.1.5` tag).

The release claim did not move with it. `v1ReleaseGateManifest.qualifiedT3Sha` still
records `ffb4af8d…`, and `releaseReadiness()` now returns `t3BaselineQualified:false`,
`liveAcceptanceRequired:true` and `releaseQualified:false` while the two differ. Promotion
requires fresh live acceptance on the new baseline.

## Bridge verification

`npm run verify` on the updated tree: typecheck, ESLint, full Vitest suite and the
release-readiness package smoke pass. New assertions cover:

- `PINNED_T3_SHA` equals `compatibility.t3.sha`;
- the compatibility fixture matches `src/compatibility.ts`;
- release qualification requires `qualifiedT3Sha === compatibility.t3.sha` in addition
  to every gate being `pass`.

## Patch-series verification on `6d450a42`

In a clean T3 checkout at `v0.1.5-nightly.20261029.3877`, both patches in
`handoff/t3-patches/main-2026-10-29-6d450a42/` applied with `git am --3way` without
conflicts, dependencies installed from the lockfile, then:

- `pnpm typecheck` (full `vp` workspace typecheck): 36/36 packages successful, 0 errors;
- `pnpm --filter @t3tools/web exec vitest run src/lib/tokenThroughput.test.ts src/components/chat/threadTokenRatePreference.test.ts`: 7/7 pass;
- `pnpm --filter @t3tools/provider-acp test -- src/server/turnTokenUsage.test.ts`: 5/5 pass;
- `pnpm --filter t3 test -- src/orchestration-v2/Adapters/AcpAdapterV2.test.ts`: 72/72 pass, including the ACP prompt-usage mapping added by patch `0002`;
- `pnpm --filter @t3tools/web build`: production build succeeds.

## Not covered

No live T3 → bridge acceptance, performance lane, or CoS session was run on
`0.1.5-nightly.20261029.3877`. Deterministic checks cannot establish ACP handshake,
prompt-shape, or UI behavior against the real server; that is the remaining
requalification work, and the release claim stays on the previous tuple until it
completes.
