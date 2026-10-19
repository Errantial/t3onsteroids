Evidence-Schema: 1
Gate: durableRecovery
Status: PASS

# V1 Step 3 — durable state, recovery and admission lease

`bridgeImplementationCommit`: `7017351e9de2947ba180b52401652d89fffa002f`. Evidence HEAD at draft: `7017351e9de2947ba180b52401652d89fffa002f`; `evidenceCommit` is intentionally pending because this summary is not yet committed.

Pinned tuple: T3 `0.0.46-nightly.20261013.3040` / `ffb4af8d5d4fcfc5e9322295ff846a6d1e7ffbf8`; CoS base `2.1.39` / `87ae9d631f82d8da2f462d910410031ad8f97ac5`; CoS provider extension `0893fbdfe35192f5784f07fc03f97d2ccc235425`; ACP SDK `1.9.0`; Node `24.21.0`; Windows x64.

Validated production durability covers the Windows hard-link mutation mutex and capability probe; tagged/quarantined session reads; guarded narrow transitions preserving concurrent cursor/cancel/mode state; exact generation/input/turn checks; stable profile-derived admission identity; one long-lived cross-process lease; stale-owner and PID-reuse handling without heartbeat-only stealing; crash-safe create/send/cancel/Stop recovery; lease retention through `turn_end`; release only after authoritative drain/final persistence proof; exact cancellation-target persistence; safe unknown/corrupt resume quarantine; and prevention of stale reconciler deletion of replacement leases.

Current-machine validation from this qualification run:

```text
npm ci                                      PASS
npm run verify                              PASS — 23 files / 206 tests
test/state-process.test.ts                  PASS — 20 tests
test/state-durable.test.ts                  PASS — 31 tests
test/acp-durable-runtime.test.ts             PASS — 33 tests
test/phase5-recovery.test.ts                PASS — 8 tests
test/translate-events.test.ts               PASS — 19 tests
test/translate-driver.test.ts               PASS — 6 tests
test/integration/acp-stdio.test.ts           PASS — 6 tests
test/phase7-release.test.ts                 PASS — 8 tests
test/release-manifest.test.ts               PASS — 3 tests
Step-7 focused repository harness checks     PASS — 5/5
```

The deterministic recovery gate is green for this exact implementation tuple. Browser-live Step 7 and the browser-live portions of Step 8 remain pending; this evidence supports promoting only the `durableRecovery` gate and does not claim live or overall release qualification.
