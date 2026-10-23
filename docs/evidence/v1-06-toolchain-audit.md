Evidence-Schema: 1
Gate: toolchainAudit
Status: PASS

# V1 Step 6 — toolchain audit and pre-live implementation freeze

`bridgeImplementationCommit`: `f3a672cffdee77f54d377d5594893e0606d20d5b`.

`evidenceCommit`: `f3a672cffdee77f54d377d5594893e0606d20d5b` (current implementation base; later evidence-only commits do not change `bridgeImplementationCommit`).

Pinned runtime tuple: T3 `0.0.46-nightly.20261013.3040` / `ffb4af8d5d4fcfc5e9322295ff846a6d1e7ffbf8`; CoS base `2.1.39` / `87ae9d631f82d8da2f462d910410031ad8f97ac5`; CoS `providerExtension` buildId `495e3e96504d9b865c18478f7b42915280712f84`; ACP SDK `1.9.0`; Node `24.21.0`; Windows x64.

The strict-reset deterministic refresh is `.local-evidence/v1/20261023T054205Z-step8-deterministic-final/step8-deterministic.json` — PASS, 2/2 files and 50/50 tests. Final release checks are rerun after evidence/manifest closure; historical implementation/provider references later in this file are retained for lineage only.

The runtime dependency lane remains deliberately narrow: `@agentclientprotocol/sdk` is pinned at `1.9.0` and Node requires `>=24`. Development tooling is pinned to TypeScript `5.9.3`, Vitest `5.0.5`, vite-node `6.0.0`, typescript-eslint `8.71.2`, and ESLint / @eslint/js `9.39.5`. The cross-process fixture uses the explicit vite-node dependency rather than relying on an accidental Vitest transitive path.

`package.json.version` is exactly `1.0.0`; ACP `agentInfo.version`, compatibility output, and release-readiness output derive from package metadata. The recorded implementation identity above follows the implementation-input history rule; evidence-only refreshes and release-manifest-only changes are not themselves treated as new bridge implementation inputs. The final Step-1 CoS server/providerExtension build is exactly `e5157983c6b5cbc7a9a1fc77c0822d452ab52d2f`; browser-extension/package file identity is separate and will be refreshed during the downstream portable-package/live-provenance step.

Current readiness hardening is included in this frozen implementation identity: production admission takes a fresh health snapshot, requires the exact pinned CoS extension build plus all five v1 feature versions and all three production mutation routes, rejects actions-disabled, and retains bound-session provider-policy attestation. Diagnostics check extension/actions/routes coherently from one health snapshot. These are source/test qualifications only; they do not convert deterministic readiness into live GUI acceptance.

The same freeze includes typed durable `state_io_error` handling with bounded Windows sharing retries and fail-closed ACP mapping, plus deterministic Step-8 built-stdio coverage across response-loss, SSE resume, restart/recovery, exact Stop, quarantine, rate-limit/provider-failure, and slow-consumer boundaries. The current regression also proves that a persisted restart cancellation whose exact provider turn is already drained consumes authoritative historical stream/terminal state and settles the lease before retrying Stop; the old-order negative control reached `turn_not_running`, while the fixed case passes without synthetic events or any widening of generic `broken` recovery. Those tests strengthen the implementation freeze but are not recorded as a Step 7 or Step 8 live pass.

## Historical pre-live validation snapshot — superseded

Freeze verification commands used by the prior 4cff/e515 state:

```text
npm ci
npx vitest run test/cos-provider-extension.test.ts
npm run verify
npm audit --json
git diff --check
```

Historical validation from the prior `4cffd484601ae3dabfc2bce066f47cac3fbf8f9a` implementation freeze: fresh `npm ci`, verify, bridge audit and `git diff --check` were green while live gates remained pending. The e515 provider source verification and its inherited advisory disposition are retained as lineage only. The current-final implementation/provider tuple and final verification are the f3/495e refresh recorded at the top of this file plus Step-7/8/9 evidence.

At that historical snapshot package smoke reported bridge version `1.0.0`, supported concurrency `1`, and `releaseQualified:false`. Final package smoke now reports `releaseQualified:true`; metrics/privacy qualification remains content-safe and metadata-only, including hashed identifiers, bounded timing receipts, controller/SSE/backoff/queue/RSS counters, and explicit redaction coverage.

The historical section above supported only the deterministic toolchain gate at that time. Current-final live acceptance and release qualification are recorded separately by the Step-7, Step-8 and Step-9 evidence summaries.
