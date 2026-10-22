Evidence-Schema: 1
Gate: eventTranslator
Status: PASS

# V1 Step 2 — event translator and terminal semantics

`bridgeImplementationCommit`: `4cffd484601ae3dabfc2bce066f47cac3fbf8f9a`.

`evidenceCommit`: `4cffd484601ae3dabfc2bce066f47cac3fbf8f9a` (implementation commit used as the evidence-refresh base; later evidence-only commits do not change `bridgeImplementationCommit`).

Pinned tuple: T3 `0.0.46-nightly.20261013.3040` / `ffb4af8d5d4fcfc5e9322295ff846a6d1e7ffbf8`; CoS base `2.1.39` / `87ae9d631f82d8da2f462d910410031ad8f97ac5`; CoS `providerExtension` buildId `e5157983c6b5cbc7a9a1fc77c0822d452ab52d2f`; ACP SDK `1.9.0`; Node `24.21.0`; Windows x64. Browser-extension/package identity is tracked separately and must be refreshed after the final provider is packaged.

Validated production translator behavior includes monotonic cursor/dedupe handling; no assistant prose before authoritative drain; exact `finalAssistantSeq` selection with bounded ranged full-content delivery and resumable chunk acknowledgement; UTF-16-safe range advancement; tool/page projection without raw bodies; late old-turn activity before terminal; handoff continuity; stale-generation and malformed/post-drain fail-closed handling; cancellation-through-drain; and fresh background-policy attestation before terminal acceptance. The controller driver completes the same lifecycle through the typed production controller surface and resumes safely across delivery/persistence interruption points.

The frozen implementation also has deterministic built-stdio Step-8 coverage that drives the real compiled ACP child through response-loss reconciliation, exact SSE cursor resume, cancellation/Stop boundaries, terminal provider failure, large final-assistant reconstruction, and a deliberately slow ACP consumer. These tests exercise translator/terminal semantics through the shipped stdio path; they are deterministic qualification only and are not a claim that Step 7 or Step 8 browser/live acceptance has passed.

Current-machine bridge validation from this exact implementation tuple:

```text
npm run verify                              PASS — 25/25 test files, 244/244 tests
npm audit --json                            PASS — exit 0; 0 vulnerabilities at every severity
git diff --check                            PASS
package smoke                               PASS — bridgeVersion 1.0.0; supportedConcurrency 1; releaseQualified false
```

This evidence supports only the deterministic `eventTranslator` gate for this exact implementation tuple. Step 1 records the final CoS source build separately; its final `npm run verify` is green on provider build `e5157983c6b5cbc7a9a1fc77c0822d452ab52d2f`. Live Step 7/8 evidence remains invalidated for this implementation identity; this deterministic suite does not promote it. `releaseQualified` remains false.
