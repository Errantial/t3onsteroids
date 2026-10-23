Evidence-Schema: 1
Gate: eventTranslator
Status: PASS

# V1 Step 2 — event translator and terminal semantics

`bridgeImplementationCommit`: `f3a672cffdee77f54d377d5594893e0606d20d5b`.

`evidenceCommit`: `f3a672cffdee77f54d377d5594893e0606d20d5b` (current implementation base; later evidence-only commits do not change `bridgeImplementationCommit`).

Pinned tuple: T3 `0.0.46-nightly.20261013.3040` / `ffb4af8d5d4fcfc5e9322295ff846a6d1e7ffbf8`; CoS base `2.1.39` / `87ae9d631f82d8da2f462d910410031ad8f97ac5`; CoS `providerExtension` buildId `495e3e96504d9b865c18478f7b42915280712f84`; ACP SDK `1.9.0`; Node `24.21.0`; Windows x64.

Current-final deterministic owner: `.local-evidence/v1/20261023T054205Z-step8-deterministic-final/step8-deterministic.json` — PASS, 2/2 files and 50/50 tests. Historical implementation/provider references later in this file are retained for lineage only.

Validated production translator behavior includes monotonic cursor/dedupe handling; no assistant prose before authoritative drain; exact `finalAssistantSeq` selection with bounded ranged full-content delivery and resumable chunk acknowledgement; UTF-16-safe range advancement; tool/page projection without raw bodies; late old-turn activity before terminal; handoff continuity; stale-generation and malformed/post-drain fail-closed handling; cancellation-through-drain; and fresh background-policy attestation before terminal acceptance. The controller driver completes the same lifecycle through the typed production controller surface and resumes safely across delivery/persistence interruption points.

The frozen implementation also has deterministic built-stdio Step-8 coverage that drives the real compiled ACP child through response-loss reconciliation, exact SSE cursor resume, cancellation/Stop boundaries, terminal provider failure, large final-assistant reconstruction, and a deliberately slow ACP consumer. These tests exercise translator/terminal semantics through the shipped stdio path; they are deterministic qualification only and are not a claim that Step 7 or Step 8 browser/live acceptance has passed.

## Historical pre-live validation snapshot — superseded

The following was captured on the prior 4cff/e515 freeze and is retained only as lineage evidence:

```text
npm run verify                              PASS — 25/25 test files, 244/244 tests
npm audit --json                            PASS — exit 0; 0 vulnerabilities at every severity
git diff --check                            PASS
package smoke                               PASS — bridgeVersion 1.0.0; supportedConcurrency 1; releaseQualified false
```

At that historical snapshot, this evidence supported only the deterministic `eventTranslator` gate and release qualification was still pending. The current-final f3/495e qualification is the refresh recorded at the top of this file.
