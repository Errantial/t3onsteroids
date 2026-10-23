Evidence-Schema: 1
Gate: durableRecovery
Status: PASS

# V1 Step 3 — durable state, recovery and admission lease

`bridgeImplementationCommit`: `f3a672cffdee77f54d377d5594893e0606d20d5b`.

`evidenceCommit`: `f3a672cffdee77f54d377d5594893e0606d20d5b` (current implementation base; later evidence-only commits do not change `bridgeImplementationCommit`).

Pinned tuple: T3 `0.0.46-nightly.20261013.3040` / `ffb4af8d5d4fcfc5e9322295ff846a6d1e7ffbf8`; CoS base `2.1.39` / `87ae9d631f82d8da2f462d910410031ad8f97ac5`; CoS `providerExtension` buildId `495e3e96504d9b865c18478f7b42915280712f84`; ACP SDK `1.9.0`; Node `24.21.0`; Windows x64.

Current-final deterministic owner: `.local-evidence/v1/20261023T054205Z-step8-deterministic-final/step8-deterministic.json` — PASS, including f3-specific missing-dispatched-input reconciliation, restart, cancellation, and quarantine boundaries. Historical implementation/provider references later in this file are retained for lineage only.

Validated production durability covers the Windows hard-link mutation mutex and capability probe; tagged/quarantined session reads; guarded narrow transitions preserving concurrent cursor/cancel/mode state; provisional first-session binding/mode state while CoS delivery is only `pending`; exact unwind to unbound/prior mode when cancellation proves `not_sent`; exact generation/input/turn checks; stable profile-derived admission identity; one long-lived cross-process lease; stale-owner and PID-reuse handling without heartbeat-only stealing; crash-safe create/send/cancel/Stop recovery; lease retention through `turn_end`; release only after authoritative drain/final persistence proof; exact cancellation-target persistence; safe unknown/corrupt resume quarantine; and prevention of stale reconciler deletion of replacement leases.

Durable Windows journal I/O now has an explicit typed `StateIoError` with public code `state_io_error`. Lock-free journal reads and fsynced temp-file replacement retry only transient Windows `EPERM`/`EACCES`/`EBUSY` sharing failures within a bounded retry budget. Replacement retries reuse the same already-written temp file, never unlink the authoritative journal and never replay the state transition; persistent replace failure preserves the old parseable journal. Persistent/raw read, write and replace failures fail closed as typed state I/O errors instead of degrading to a generic internal error at the ACP boundary.

Deterministic Step-8 built-stdio coverage now exercises recovery through the compiled ACP child: ambiguous input response loss without duplicate POST, restarted accepted-send reconciliation without replay, persisted exact-Stop replay, broken/cwd/additional-directory/corrupt/future-state quarantine without provider mutation, and the existing cancellation/restart boundaries. The current implementation also covers persisted cancellation after restart when the exact provider turn is already authoritatively drained: recovery consumes the authoritative historical provider stream/terminal and settles the lease before deciding whether a Stop action is still required. The preserved negative control demonstrated the old ordering by reaching `turn_not_running`; the fixed deterministic regression now passes without synthesizing provider events or widening generic `broken` recovery. This is deterministic production-path evidence only; it does not claim Step 7 or Step 8 live/browser pass.

## Historical pre-live validation snapshot — superseded

The following was captured on the prior 4cff/e515 freeze and is retained only as lineage evidence:

```text
npm run verify                              PASS — 25/25 test files, 244/244 tests
npm audit --json                            PASS — exit 0; 0 vulnerabilities at every severity
git diff --check                            PASS
package smoke                               PASS — bridgeVersion 1.0.0; supportedConcurrency 1; releaseQualified false
```

At that historical snapshot, the e515 recovery source retained the fail-closed restart-unsealed behavior described above and live qualification was still pending. The current-final f3/495e deterministic and live qualification is the refresh recorded at the top of this file; the preserved historical V1-11 admission domain remains immutable fail-closed evidence.
