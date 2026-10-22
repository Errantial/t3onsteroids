Evidence-Schema: 1
Gate: toolchainAudit
Status: PASS

# V1 Step 6 — toolchain audit and pre-live implementation freeze

`bridgeImplementationCommit`: `4cffd484601ae3dabfc2bce066f47cac3fbf8f9a`.

`evidenceCommit`: `4cffd484601ae3dabfc2bce066f47cac3fbf8f9a` (implementation commit used as the evidence-refresh base; later evidence-only commits do not change `bridgeImplementationCommit`).

Pinned runtime tuple: T3 `0.0.46-nightly.20261013.3040` / `ffb4af8d5d4fcfc5e9322295ff846a6d1e7ffbf8`; CoS base `2.1.39` / `87ae9d631f82d8da2f462d910410031ad8f97ac5`; CoS `providerExtension` buildId `e5157983c6b5cbc7a9a1fc77c0822d452ab52d2f`; ACP SDK `1.9.0`; Node `24.21.0`; Windows x64.

The runtime dependency lane remains deliberately narrow: `@agentclientprotocol/sdk` is pinned at `1.9.0` and Node requires `>=24`. Development tooling is pinned to TypeScript `5.9.3`, Vitest `5.0.5`, vite-node `6.0.0`, typescript-eslint `8.71.2`, and ESLint / @eslint/js `9.39.5`. The cross-process fixture uses the explicit vite-node dependency rather than relying on an accidental Vitest transitive path.

`package.json.version` is exactly `1.0.0`; ACP `agentInfo.version`, compatibility output, and release-readiness output derive from package metadata. The recorded implementation identity above follows the implementation-input history rule; evidence-only refreshes and release-manifest-only changes are not themselves treated as new bridge implementation inputs. The final Step-1 CoS server/providerExtension build is exactly `e5157983c6b5cbc7a9a1fc77c0822d452ab52d2f`; browser-extension/package file identity is separate and will be refreshed during the downstream portable-package/live-provenance step.

Current readiness hardening is included in this frozen implementation identity: production admission takes a fresh health snapshot, requires the exact pinned CoS extension build plus all five v1 feature versions and all three production mutation routes, rejects actions-disabled, and retains bound-session provider-policy attestation. Diagnostics check extension/actions/routes coherently from one health snapshot. These are source/test qualifications only; they do not convert deterministic readiness into live GUI acceptance.

The same freeze includes typed durable `state_io_error` handling with bounded Windows sharing retries and fail-closed ACP mapping, plus deterministic Step-8 built-stdio coverage across response-loss, SSE resume, restart/recovery, exact Stop, quarantine, rate-limit/provider-failure, and slow-consumer boundaries. The current regression also proves that a persisted restart cancellation whose exact provider turn is already drained consumes authoritative historical stream/terminal state and settles the lease before retrying Stop; the old-order negative control reached `turn_not_running`, while the fixed case passes without synthetic events or any widening of generic `broken` recovery. Those tests strengthen the implementation freeze but are not recorded as a Step 7 or Step 8 live pass.

Freeze verification commands:

```text
npm ci
npx vitest run test/cos-provider-extension.test.ts
npm run verify
npm audit --json
git diff --check
```

Current validation from final implementation commit `4cffd484601ae3dabfc2bce066f47cac3fbf8f9a`: fresh `npm ci` PASS with `147` packages and `0` vulnerabilities; bridge `npm run verify` PASS with `25/25` test files and `244/244` tests, including typecheck, lint, build, package smoke, and the built ACP stdio lane at `14/14`; fresh `npm audit --json` exits `0` with `0` vulnerabilities at every severity; `git diff --check` PASS; `node scripts/implementation-commit.mjs` returns the exact same implementation commit. During the deliberate manifest-invalidated state, package smoke exits `0` and truthfully reports implementation readiness false and `releaseQualified:false`; after the evidence/manifest promotion and rebuild, package smoke exits `0` with `productionAcpEntrypoint:true`, `cosProviderExtensionReady:true`, `eventTranslatorReady:true`, and `durableRecoveryReady:true`, while Steps 7–9 keep `liveAcceptanceRequired:true`, `currentHeadDriftRequired:true`, and `releaseQualified:false`. Final CoS source verification on `e5157983c6b5cbc7a9a1fc77c0822d452ab52d2f` exits `0`: bulk `350` files passed / `5` skipped with `6608` tests passed / `45` skipped; serialized heavy lane `15` files / `2472` tests passed / `5` skipped; isolated renderer-state `1` file / `132` tests passed; focused `provider-turn-drain.test.ts` `13/13`; standalone typecheck and `git diff --check` PASS. The provider dependency audit is preserved at `12` advisories (`4` moderate, `8` high, `0` critical); untouched `2d4cf84c` currently reports the same `12` on its unchanged lockfile, so the count is documented advisory-database drift rather than a dependency regression in `e5157983`. No audit fix is included in this freeze.

Package smoke reports bridge version `1.0.0`, supported concurrency `1`, and `releaseQualified:false`. Metrics/privacy qualification remains content-safe and metadata-only, including hashed identifiers, bounded timing receipts, controller/SSE/backoff/queue/RSS counters, and explicit redaction coverage.

This evidence supports only the deterministic `toolchainAudit` gate for this exact tuple. Live Step 7/8 evidence remains invalidated for this implementation identity; source/test completion and setup diagnostics do not promote it to live/browser acceptance or release qualification.
