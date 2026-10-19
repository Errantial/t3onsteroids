Evidence-Schema: 1
Gate: controllerPrivacy
Status: PASS

# V1 Step 5 — controller/privacy hardening

`bridgeImplementationCommit`: `7017351e9de2947ba180b52401652d89fffa002f`.

Pinned external tuple: T3 `0.0.46-nightly.20261013.3040` / `ffb4af8d5d4fcfc5e9322295ff846a6d1e7ffbf8`; CoS base `2.1.39` / `87ae9d631f82d8da2f462d910410031ad8f97ac5`; CoS provider extension buildId `0893fbdfe35192f5784f07fc03f97d2ccc235425`; ACP SDK `1.9.0`; Node `24.21.0`; Windows x64.

Production admission readiness is fail-closed and refreshed for each new admission rather than reusing a prior successful health snapshot. The readiness boundary validates the exact pinned provider-extension build identity and all four required v1 feature versions, requires the production action routes for input, pending-input cancel, and exact-turn Stop, and the ACP runtime separately rejects actions-disabled. Bound sessions also require a fresh enforced `backgroundWork=disabled` policy attestation. Setup diagnostics derive extension identity, actions, and required routes from one health snapshot, avoiding stale cross-snapshot mixing, and exact project resolution remains explicit.

Controller/client hardening covers credential-free loopback-origin discovery, deterministic malformed endpoint/response rejection, strict mutation response validation, bounded safe-read retry/backoff, CRLF and malformed SSE handling, timed SSE rollover with exact cursor resume, and bounded reconnect behavior. Errors exposed across the ACP boundary use stable categories rather than controller tokens, authorization headers, prompt/assistant text, browser content, or raw controller configuration.

Privacy/metrics coverage is metadata-only. Structured logs allowlist operation/transition/error categories and hash correlation/session identifiers. Bridge metrics retain counters and bounded monotonic timing receipts for prompt/input/turn-end/drain/terminal, controller reads/actions, SSE connects/reconnects/backoffs, queue depth, drain high-water, and RSS high-water; session identifiers are reduced to hashed keys and only the newest 32 timing receipts are retained. Tests explicitly prove hostile identifiers, prompt-like text, tokens, private paths, and unrelated browser/page fields are not serialized. Step-7 browser status summarization retains only connection/bridge presence state.

Verification commands:

```text
npm ci
npm run typecheck
npm run verify
npm audit --json
git diff --check
```

Current clean-machine validation: `npm ci` PASS; `npm run verify` PASS with `23` files / `206` tests; `npm audit --json` reports `0` vulnerabilities at every severity; `git diff --check` PASS. Focused Step-7 smoke/eligibility checks: `5/5` PASS.

No prompt text, assistant text, tool bodies/results, browser content, tokens, authorization headers, raw controller configuration, or private filesystem paths are recorded in this evidence summary or required by the metadata-only metrics/logging contract.

The deterministic Step-7 smoke/eligibility result does not replace the remaining live/pinned-GUI acceptance evidence. This evidence supports promoting only the `controllerPrivacy` gate for this exact tuple; live acceptance and release qualification remain pending.
