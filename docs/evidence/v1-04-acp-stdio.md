Evidence-Schema: 1
Gate: acpStdio
Status: PASS

# V1 Step 4 — production ACP stdio provider

`bridgeImplementationCommit`: `23d385d0d62dc7fefbbf5dc702f70115af644453`. Evidence HEAD at draft: `23d385d0d62dc7fefbbf5dc702f70115af644453`; `evidenceCommit` is intentionally pending because this summary is not yet committed.

Pinned tuple: T3 `0.0.46-nightly.20261013.3040` / `ffb4af8d5d4fcfc5e9322295ff846a6d1e7ffbf8`; CoS base `2.1.39` / `87ae9d631f82d8da2f462d910410031ad8f97ac5`; CoS provider extension `0893fbdfe35192f5784f07fc03f97d2ccc235425`; ACP SDK `1.9.0`; Node `24.21.0`; Windows x64.

The shipped built `node.exe + dist/cli/index.js` lane is covered through the real stdio ACP path against the deterministic protocol-1+extension controller boundary. Validation covers stable ACP v1 negotiation, side-effect-free initialize/session allocation and provider validation, lazy exact-session creation, prompt/update/terminal flow held open through `turn_drained`, late activity ordering, exact active-turn Stop, pending-cancel race conversion, first-input `pending` remaining provisional until exact `sent`/turn proof, cancellation settlement to `cancelled` only after authoritative `not_sent`, healthy durable restart/resume without replacement input, and unknown-resume quarantine without CoS mutation. The formerly intermittent pending-input cancellation case was also stress-repeated six consecutive times after the journal/binding fix with zero failures. Phase-3 contract tests additionally cover truthful capability advertisement, T3 wrapper normalization, ResourceLink restrictions and the 64,000-character boundary.

Current-machine validation from this qualification run:

```text
npm ci                                      PASS
npm run verify                              PASS — 23 files / 208 tests
test/integration/acp-stdio.test.ts           PASS — 6 tests
test/acp-phase3.test.ts                     PASS — 12 tests
test/acp-durable-runtime.test.ts             PASS — 33 tests
test/cos-provider-extension.test.ts         PASS — 11 tests
test/translate-events.test.ts               PASS — 19 tests
test/translate-driver.test.ts               PASS — 6 tests
test/phase5-recovery.test.ts                PASS — 8 tests
test/phase6-performance.test.ts             PASS — 9 tests
test/phase7-release.test.ts                 PASS — 8 tests
test/release-manifest.test.ts               PASS — 3 tests
Step-7 focused repository harness checks     PASS — 5/5
```

This Step-4 result is deterministic production-path evidence, not browser-live acceptance. Browser-live Step 7 and the browser-live portions of Step 8 remain pending. This evidence supports promoting only the `acpStdio` gate and does not claim overall release qualification.
