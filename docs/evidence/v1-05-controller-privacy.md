Evidence-Schema: 1
Gate: controllerPrivacy
Status: PASS

# V1 Step 5 — controller/privacy hardening

`bridgeImplementationCommit`: `f3a672cffdee77f54d377d5594893e0606d20d5b`.

`evidenceCommit`: `f3a672cffdee77f54d377d5594893e0606d20d5b` (current implementation base; later evidence-only commits do not change `bridgeImplementationCommit`).

Pinned external tuple: T3 `0.0.46-nightly.20261013.3040` / `ffb4af8d5d4fcfc5e9322295ff846a6d1e7ffbf8`; CoS base `2.1.39` / `87ae9d631f82d8da2f462d910410031ad8f97ac5`; CoS `providerExtension` buildId `495e3e96504d9b865c18478f7b42915280712f84`; ACP SDK `1.9.0`; Node `24.21.0`; Windows x64.

Current-final deterministic owner is `.local-evidence/v1/20261023T054205Z-step8-deterministic-final/step8-deterministic.json`; exact live actions/project/policy provenance is covered by current-final V1-14, V1-15, V1-17, and V1-19B artifacts. Historical implementation/provider references later in this file are retained for lineage only.

Production admission readiness is fail-closed and refreshed for each new admission rather than reusing a prior successful health snapshot. The readiness boundary validates the exact pinned provider-extension build identity and all five required v1 feature versions, requires the production action routes for input, pending-input cancel, and exact-turn Stop, and the ACP runtime separately rejects actions-disabled. Bound sessions also require a fresh enforced `backgroundWork=disabled` policy attestation. Setup diagnostics derive extension identity, actions, and required routes from one health snapshot, avoiding stale cross-snapshot mixing, and exact project resolution remains explicit.

Controller/client hardening covers credential-free loopback-origin discovery, deterministic malformed endpoint/response rejection, strict mutation response validation, bounded safe-read retry/backoff, CRLF and malformed SSE handling, timed SSE rollover with exact cursor resume, and bounded reconnect behavior. Errors exposed across the ACP boundary use stable categories rather than controller tokens, authorization headers, prompt/assistant text, browser content, or raw controller configuration. Durable filesystem failures are now likewise exposed as the typed `state_io_error` category, with read/write/replace operation details retained internally rather than leaking raw syscall/path context through ACP.

Privacy/metrics coverage is metadata-only. Structured logs allowlist operation/transition/error categories and hash correlation/session identifiers. Bridge metrics retain counters and bounded monotonic timing receipts for prompt/input/turn-end/drain/terminal, controller reads/actions, SSE connects/reconnects/backoffs, queue depth, drain high-water, and RSS high-water; session identifiers are reduced to hashed keys and only the newest 32 timing receipts are retained. Tests explicitly prove hostile identifiers, prompt-like text, tokens, private paths, and unrelated browser/page fields are not serialized. Step-7 browser status summarization retains only connection/bridge presence state.

## Historical pre-live validation snapshot — superseded

Verification commands used by the prior 4cff/e515 freeze:

```text
npm ci
npm run typecheck
npm run verify
npm audit --json
git diff --check
```

Historical 4cff/e515 bridge validation: fresh `npm ci` PASS with `147` packages and `0` vulnerabilities; `npm run verify` PASS with `25/25` test files and `244/244` tests, including the built ACP stdio lane at `14/14`; fresh `npm audit --json` exited `0`; `git diff --check` passed. At that time package smoke correctly remained non-release-qualified and live setup had not yet been refreshed. Those values are retained for lineage only; the current-final f3/495e qualification is the refresh recorded at the top of this file.

No prompt text, assistant text, tool bodies/results, browser content, tokens, authorization headers, raw controller configuration, or private filesystem paths are recorded in this evidence summary or required by the metadata-only metrics/logging contract.

The historical deterministic built-stdio coverage exercised redaction-sensitive tool projection, metrics persistence, reconnect and slow-consumer paths without converting those tests into live acceptance. Current-final Step 7/8 and release qualification are recorded by the refresh at the top of this file and the Step-7/8/9 evidence summaries.
