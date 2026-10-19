Evidence-Schema: 1
Gate: controllerPrivacy
Status: PASS

# V1 Step 5 — controller/privacy hardening

`bridgeImplementationCommit`: `336c701c7fb3da967ef11c6b167da8a266becc46`.

Pinned external tuple: T3 `0.0.46-nightly.20261013.3040` / `ffb4af8d5d4fcfc5e9322295ff846a6d1e7ffbf8`; CoS base `2.1.39` / `87ae9d631f82d8da2f462d910410031ad8f97ac5`; CoS `providerExtension` buildId `73e52028cb87ed2dd6fdc8c1a03a79669b8302bc` (browser-extension file stamp separately `a35dccb10b05`); ACP SDK `1.9.0`; Node `24.21.0`; Windows x64.

Production admission readiness is fail-closed and refreshed for each new admission rather than reusing a prior successful health snapshot. The readiness boundary validates the exact pinned provider-extension build identity and all four required v1 feature versions, requires the production action routes for input, pending-input cancel, and exact-turn Stop, and the ACP runtime separately rejects actions-disabled. Bound sessions also require a fresh enforced `backgroundWork=disabled` policy attestation. Setup diagnostics derive extension identity, actions, and required routes from one health snapshot, avoiding stale cross-snapshot mixing, and exact project resolution remains explicit.

Controller/client hardening covers credential-free loopback-origin discovery, deterministic malformed endpoint/response rejection, strict mutation response validation, bounded safe-read retry/backoff, CRLF and malformed SSE handling, timed SSE rollover with exact cursor resume, and bounded reconnect behavior. Errors exposed across the ACP boundary use stable categories rather than controller tokens, authorization headers, prompt/assistant text, browser content, or raw controller configuration. Durable filesystem failures are now likewise exposed as the typed `state_io_error` category, with read/write/replace operation details retained internally rather than leaking raw syscall/path context through ACP.

Privacy/metrics coverage is metadata-only. Structured logs allowlist operation/transition/error categories and hash correlation/session identifiers. Bridge metrics retain counters and bounded monotonic timing receipts for prompt/input/turn-end/drain/terminal, controller reads/actions, SSE connects/reconnects/backoffs, queue depth, drain high-water, and RSS high-water; session identifiers are reduced to hashed keys and only the newest 32 timing receipts are retained. Tests explicitly prove hostile identifiers, prompt-like text, tokens, private paths, and unrelated browser/page fields are not serialized. Step-7 browser status summarization retains only connection/bridge presence state.

Verification commands:

```text
npm ci
npm run typecheck
npm run verify
npm audit --json
git diff --check
```

Current exact-tuple bridge validation: `npm run verify` PASS with `25/25` test files and `234/234` tests; fresh `npm audit --json` exits `0` with `0` vulnerabilities at every severity; fresh `git diff --check` PASS. Package smoke reports `bridgeVersion:1.0.0`, supported concurrency `1`, and `releaseQualified:false`. Live `--diagnose` against the isolated profile reports `ready:true` with `providerExtension` `73e52028cb87ed2dd6fdc8c1a03a79669b8302bc`, actions/routes ready, and exact project resolution OK. This diagnostic readiness is setup evidence only; Step 7 is now separately qualified by `v1-07-performance.md`; Step 8 live acceptance remains pending. Step 1 separately records the exact `73e52028` CoS focused validation and the explicit full-CoS-verify caveat.

No prompt text, assistant text, tool bodies/results, browser content, tokens, authorization headers, raw controller configuration, or private filesystem paths are recorded in this evidence summary or required by the metadata-only metrics/logging contract.

Deterministic built-stdio Step-8 coverage exercises redaction-sensitive tool projection, metrics persistence, reconnect and slow-consumer paths without converting those tests into live acceptance. The Step-1 summary separately records the repaired CoS source results and explicitly does not claim a full-CoS-verify PASS. No Step 7 or Step 8 live/browser pass is claimed. This evidence supports only the deterministic `controllerPrivacy` gate for this exact tuple; release qualification remains false.
