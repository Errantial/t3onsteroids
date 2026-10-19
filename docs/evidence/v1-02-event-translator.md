Evidence-Schema: 1
Gate: eventTranslator
Status: PASS

# V1 Step 2 — event translator and terminal semantics

`bridgeImplementationCommit`: `7017351e9de2947ba180b52401652d89fffa002f`. Evidence HEAD at draft: `7017351e9de2947ba180b52401652d89fffa002f`; `evidenceCommit` is intentionally pending because this summary is not yet committed.

Pinned tuple: T3 `0.0.46-nightly.20261013.3040` / `ffb4af8d5d4fcfc5e9322295ff846a6d1e7ffbf8`; CoS base `2.1.39` / `87ae9d631f82d8da2f462d910410031ad8f97ac5`; CoS provider extension `0893fbdfe35192f5784f07fc03f97d2ccc235425`; ACP SDK `1.9.0`; Node `24.21.0`; Windows x64.

Validated production translator behavior includes monotonic cursor/dedupe handling; no assistant prose before authoritative drain; exact `finalAssistantSeq` selection with bounded ranged full-content delivery and resumable chunk acknowledgement; UTF-16-safe range advancement; tool/page projection without raw bodies; late old-turn activity before terminal; handoff continuity; stale-generation and malformed/post-drain fail-closed handling; cancellation-through-drain; and fresh background-policy attestation before terminal acceptance. The controller driver completes the same lifecycle through the typed production controller surface and resumes safely across delivery/persistence interruption points.

Current-machine validation from this qualification run:

```text
npm ci                                      PASS
npm run verify                              PASS — 23 files / 206 tests
test/translate-events.test.ts               PASS — 19 tests
test/translate-driver.test.ts               PASS — 6 tests
test/cos-provider-extension.test.ts         PASS — 11 tests
test/acp-phase3.test.ts                     PASS — 12 tests
test/phase6-performance.test.ts             PASS — 9 tests
test/phase7-release.test.ts                 PASS — 8 tests
test/release-manifest.test.ts               PASS — 3 tests
Step-7 focused repository harness checks     PASS — 5/5
```

The Step-7 focused result above is deterministic repository/harness validation only; browser-live Step 7 and the browser-live portions of Step 8 remain pending. This evidence supports promoting only the `eventTranslator` gate for this exact tuple; it does not claim live acceptance or overall release qualification.
