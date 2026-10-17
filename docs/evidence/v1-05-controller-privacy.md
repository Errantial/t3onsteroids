Evidence-Schema: 1
Gate: controllerPrivacy
Status: PASS

# V1 Step 5 — controller/privacy hardening

Bridge evidence HEAD at execution: `e751b4e74f9a16f485c1cb6d157929de782f0357` plus the uncommitted implementation changes represented by this evidence summary. Stable `bridgeImplementationCommit` is intentionally not claimed until the Step-6 implementation freeze commit exists.

Pinned external tuple: T3 `0.0.46-nightly.20261013.3040` / `ffb4af8d5d4fcfc5e9322295ff846a6d1e7ffbf8`; CoS base `2.1.39` / `87ae9d631f82d8da2f462d910410031ad8f97ac5`; ACP SDK `1.9.0`; Node `24.14.0`; Windows x64.

Validated controller/client behavior includes deterministic malformed endpoint/response handling, credential-free loopback-origin discovery, strict mutation response validation, CRLF and malformed SSE handling, bounded exponential reconnect/backoff with jitter, timed stream rollover with exact cursor resume, secret-safe public errors/causes, metadata-only structured logging, hostile-identifier/partial-secret redaction tests, and production bridge metrics wiring for prompt/input/turn/drain/terminal/controller/SSE/backoff/RSS counters.

Verification commands:

```text
npm run typecheck
npx vitest run test/cos-client.test.ts test/phase6-performance.test.ts test/logging-redaction.test.ts
npm run verify
git diff --check
```

Focused Step-5 result: `3` files / `22` tests PASS. Full pre-Step-6 result: `16` files / `150` tests PASS; typecheck, lint, build, package smoke and diff-check PASS.

No prompt text, assistant text, tool bodies/results, browser content, tokens, authorization headers, raw controller configuration, or private filesystem paths are recorded in this evidence summary.

Unresolved release blockers: live single-turn performance, pinned live acceptance, current-head drift and final release preparation remain pending. No live CoS installation/replacement was performed.
