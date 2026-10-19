Evidence-Schema: 1
Gate: acpStdio
Status: PASS

# V1 Step 4 — production ACP stdio provider

`bridgeImplementationCommit`: `3cb315830850305fc7c772b497d70c1c8249a1cc`.

Pinned tuple: T3 `0.0.46-nightly.20261013.3040` / `ffb4af8d5d4fcfc5e9322295ff846a6d1e7ffbf8`; CoS base `2.1.39` / `87ae9d631f82d8da2f462d910410031ad8f97ac5`; CoS `providerExtension` buildId `73e52028cb87ed2dd6fdc8c1a03a79669b8302bc` (browser-extension file stamp separately `a35dccb10b05`); ACP SDK `1.9.0`; Node `24.21.0`; Windows x64.

The shipped built `node.exe + dist/cli/index.js` lane is covered through the real stdio ACP path against the deterministic protocol-1+extension controller boundary. Validation covers stable ACP v1 negotiation, side-effect-free initialize/session allocation and provider validation, lazy exact-session creation, prompt/update/terminal flow held open through authoritative `turn_drained`, late activity ordering, exact active-turn Stop, pending-cancel race conversion, first-input `pending` remaining provisional until exact `sent`/turn proof, cancellation settlement only after authoritative non-delivery/drain proof, healthy durable restart/resume without replacement input, and unknown/corrupt resume quarantine without CoS mutation.

The final freeze adds deterministic Step-8 built-stdio scenarios for input-response loss reconciliation without duplicate POST, exact SSE cursor resume after deliberate disconnect, restarted accepted-send and exact-Stop boundaries, quarantine/no-provider-mutation cases, controller rate limiting without action retry spin, blocking provider failure without false success, and bounded/complete output under a deliberately slow ACP consumer. Durable state I/O failures also cross the production ACP error boundary as typed `state_io_error` rather than `internal_error`; the public mapping exposes only the stable error code, not raw filesystem failure details.

Current-machine bridge validation from this exact implementation tuple:

```text
npm run verify                              PASS — 25/25 test files, 233/233 tests
npm audit --json                            PASS — exit 0; 0 vulnerabilities at every severity
git diff --check                            PASS
package smoke                               PASS — bridgeVersion 1.0.0; supportedConcurrency 1; releaseQualified false
```

This Step-4 result and the Step-8 scenarios above are deterministic production-path evidence against the repaired `providerExtension` build, not browser/live acceptance. The Step-1 summary explicitly does not claim a full-CoS-verify PASS. No Step 7 or Step 8 live pass is claimed, and overall `releaseQualified` remains false.
