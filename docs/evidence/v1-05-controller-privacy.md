Evidence-Schema: 1
Gate: controllerPrivacy
Status: PASS

# V1 Step 5 — controller/privacy hardening

`bridgeImplementationCommit`: `3d2d224f784620d511f5ba51c23e57198440cb91`.

`evidenceCommit`: `3d2d224f784620d511f5ba51c23e57198440cb91` (implementation commit used as the evidence-refresh base; later evidence-only commits do not change `bridgeImplementationCommit`).

Pinned external tuple: T3 `0.0.46-nightly.20261013.3040` / `ffb4af8d5d4fcfc5e9322295ff846a6d1e7ffbf8`; CoS base `2.1.39` / `87ae9d631f82d8da2f462d910410031ad8f97ac5`; CoS `providerExtension` buildId `0e755281cae0f87084293e4a735cc27744691a64`; ACP SDK `1.9.0`; Node `24.21.0`; Windows x64.

Production admission readiness is fail-closed and refreshed for each new admission rather than reusing a prior successful health snapshot. The readiness boundary validates the exact pinned provider-extension build identity and all five required v1 feature versions, requires the production action routes for input, pending-input cancel, and exact-turn Stop, and the ACP runtime separately rejects actions-disabled. Bound sessions also require a fresh enforced `backgroundWork=disabled` policy attestation. Setup diagnostics derive extension identity, actions, and required routes from one health snapshot, avoiding stale cross-snapshot mixing, and exact project resolution remains explicit.

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

Current exact-tuple bridge validation: fresh `npm ci` PASS with `147` packages and `0` vulnerabilities; `npm run verify` PASS with `25/25` test files and `244/244` tests, including the built ACP stdio lane at `14/14`; fresh `npm audit --json` exits `0` with `0` vulnerabilities at every severity; fresh `git diff --check` PASS. Package smoke exits `0` while the manifest is deliberately invalidated, reporting implementation readiness false and `releaseQualified:false`; after the evidence/manifest promotion and rebuild, package smoke again exits `0` with Steps 1–4 readiness true while `liveAcceptanceRequired:true`, `currentHeadDriftRequired:true`, and `releaseQualified:false`. Final CoS source verification on provider build `0e755281cae0f87084293e4a735cc27744691a64` is unchanged and remains green: bulk `350` files passed / `5` skipped with `6607` tests passed / `45` skipped, serialized heavy lane `15` files / `2472` tests passed / `5` skipped, isolated renderer-state `1` file / `132` tests passed, and the explicit combined content/bridge/extension/provider-turn-drain run passes `1998/1998` across four files. Live setup diagnostics must be re-observed after the final portable candidate is safely launched on the preserved profile; no stale live `ready:true` claim is promoted here. Live Step 7/8 evidence remains invalidated for this implementation tuple.

No prompt text, assistant text, tool bodies/results, browser content, tokens, authorization headers, raw controller configuration, or private filesystem paths are recorded in this evidence summary or required by the metadata-only metrics/logging contract.

Deterministic built-stdio Step-8 coverage exercises redaction-sensitive tool projection, metrics persistence, reconnect and slow-consumer paths without converting those tests into live acceptance. Step 1 separately records the final provider-source full-verify PASS. No Step 7 or Step 8 live/browser pass is claimed. This evidence supports only the deterministic `controllerPrivacy` gate for this exact tuple; release qualification remains false.
