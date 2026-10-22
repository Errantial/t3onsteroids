Evidence-Schema: 1
Gate: durableRecovery
Status: PASS

# V1 Step 3 — durable state, recovery and admission lease

`bridgeImplementationCommit`: `a4262c02ad5ffc828d05f12d3f6337c842ddf595`.

`evidenceCommit`: `a4262c02ad5ffc828d05f12d3f6337c842ddf595` (implementation commit used as the evidence-refresh base; later evidence-only commits do not change `bridgeImplementationCommit`).

Pinned tuple: T3 `0.0.46-nightly.20261013.3040` / `ffb4af8d5d4fcfc5e9322295ff846a6d1e7ffbf8`; CoS base `2.1.39` / `87ae9d631f82d8da2f462d910410031ad8f97ac5`; CoS `providerExtension` buildId `2d4cf84c8d665e767d5caa1a360ade8880567d61`; ACP SDK `1.9.0`; Node `24.21.0`; Windows x64.

Validated production durability covers the Windows hard-link mutation mutex and capability probe; tagged/quarantined session reads; guarded narrow transitions preserving concurrent cursor/cancel/mode state; provisional first-session binding/mode state while CoS delivery is only `pending`; exact unwind to unbound/prior mode when cancellation proves `not_sent`; exact generation/input/turn checks; stable profile-derived admission identity; one long-lived cross-process lease; stale-owner and PID-reuse handling without heartbeat-only stealing; crash-safe create/send/cancel/Stop recovery; lease retention through `turn_end`; release only after authoritative drain/final persistence proof; exact cancellation-target persistence; safe unknown/corrupt resume quarantine; and prevention of stale reconciler deletion of replacement leases.

Durable Windows journal I/O now has an explicit typed `StateIoError` with public code `state_io_error`. Lock-free journal reads and fsynced temp-file replacement retry only transient Windows `EPERM`/`EACCES`/`EBUSY` sharing failures within a bounded retry budget. Replacement retries reuse the same already-written temp file, never unlink the authoritative journal and never replay the state transition; persistent replace failure preserves the old parseable journal. Persistent/raw read, write and replace failures fail closed as typed state I/O errors instead of degrading to a generic internal error at the ACP boundary.

Deterministic Step-8 built-stdio coverage now exercises recovery through the compiled ACP child: ambiguous input response loss without duplicate POST, restarted accepted-send reconciliation without replay, persisted exact-Stop replay, broken/cwd/additional-directory/corrupt/future-state quarantine without provider mutation, and the existing cancellation/restart boundaries. This is deterministic production-path evidence only; it does not claim Step 7 or Step 8 live/browser pass.

Current-machine bridge validation from this exact implementation tuple:

```text
npm run verify                              PASS — 25/25 test files, 243/243 tests
npm audit --json                            PASS — exit 0; 0 vulnerabilities at every severity
git diff --check                            PASS
package smoke                               PASS — bridgeVersion 1.0.0; supportedConcurrency 1; releaseQualified false
```

The deterministic recovery gate is green for this exact implementation tuple. The final provider restart-unsealed recovery capability remains fail-closed unless exact persisted turn/terminal/token identity and fresh browser no-effects proof all agree; bare request attribution is no longer misclassified as an exact-turn effect, while real native effect surfaces still block recovery. Generic `broken` state remains unrecoverable and normal finalization remains the only source of `turn_drained`. The final provider source verification is green on build `2d4cf84c8d665e767d5caa1a360ade8880567d61`. This deterministic proof does not assert that the preserved V1-11 turn has recovered yet. Live Step 7/8 evidence remains invalidated for this implementation identity; overall release qualification remains false.
