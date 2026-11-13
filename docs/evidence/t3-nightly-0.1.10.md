# T3 nightly baseline update (2026-11-13)

Status: **deterministic port verification complete; full typecheck/build/tests and live requalification pending.**

## Change

The pinned development baseline moved from T3 `v0.1.5-nightly.20261029.3877`
(`6d450a4284852af137b2f3407fddd89eb76e7644`, the `v0.1.5` stable commit) to the newest
published nightly, `v0.1.10-nightly.20261113.4656`
(`0517d15c41e95c9d84d8014ae14394ce97bc83f6`). This is the v1.2.2 preparation: the
newest live nightly mainstream T3 merged with the custom v1.2.1 patch features.

The release claim did not move with it. `v1ReleaseGateManifest.qualifiedT3Sha` still
records `ffb4af8d…`, and `releaseReadiness()` returns `t3BaselineQualified:false`,
`liveAcceptanceRequired:true` and `releaseQualified:false` while the two differ.
Promotion requires fresh live acceptance on the new baseline.

## Bridge changes

- `src/compatibility.ts` and `test/fixtures/compatibility.json`: `t3.version` `0.1.5` →
  `0.1.10`, `t3.sha` → `0517d15c41e95c9d84d8014ae14394ce97bc83f6`.
- `src/acp/index.ts`: `PINNED_T3_SHA` → `0517d15c41e95c9d84d8014ae14394ce97bc83f6`
  (the compatibility test asserts the two stay identical).
- `package.json` / `package-lock.json`: bridge version `1.2.1` → `1.2.2`.
- New patch-series directory `handoff/t3-patches/main-2026-11-13-0517d15c/` with all
  eight v1.2.1 patches ported to the new base.

## Patch-series port verification on `0517d15c`

In a clean T3 checkout at `v0.1.10-nightly.20261113.4656` plus the ChatGPT Browser fork
files at `c8cd959156` (the fork base `0003`/`0005` were authored against), all eight
patches in `handoff/t3-patches/main-2026-11-13-0517d15c/` applied with `git am --3way`
with **zero conflicts** (verified twice: once while porting, once from the generated
patch files on a fresh checkout). All 48 touched files (47 TS/TSX plus the extension
`background.js`) are free of conflict markers, and every TS/TSX file parses clean under
the TypeScript parser.

Port adjustments (details in `handoff/t3-patches/README.md`):

- `0001`: upstream removed the composer context-window meter (`521ac7c218`), so the
  tokens/sec badge and toggle moved to the thread details context section; the pure
  throughput/preference logic is unchanged.
- `0002`: merged with upstream's new flavor-gated per-turn usage
  (`reportsPerTurnPromptUsage` / `acpPerTurnPromptUsage`); non-declaring ACP agents
  still get `acpTurnTokenUsage` mapping from the prompt response.
- `0003`: keeps upstream's new `forceStopThread` alongside `controlBrowserTab`; the
  client `turnItem` query is upstream's restructured selector now, so only the
  `controlBrowserTab` command is added.
- `0008`: keeps upstream's new remote-Node test and desktop import alongside the
  runtime-sync migration.

## Not covered

- Full `vp` typecheck, web production build, focused web/ACP suites, and live browser
  verification were run on `6d450a42` but **not yet re-run on `0517d15c`**; that is the
  remaining deterministic work before the v1.2.2 fork build.
- No live T3 → bridge acceptance, performance lane, or CoS session was run on
  `v0.1.10-nightly.20261113.4656`. The release claim stays on the previously qualified
  tuple until that completes.
- The fork-side merge (upstream `0517d15c` into `Errantial/t3code` `release/v1.2.1`,
  producing the `release/v1.2.2` fork branch and build commit) is the follow-up that
  turns this preparation into published installers.
