Evidence-Schema: 1
Gate: toolchainAudit
Status: PASS

# V1 Step 6 — toolchain audit and pre-live implementation freeze

`bridgeImplementationCommit`: `6f68fcddcba8ace4119ec28948516c3aa98454e6`.

`evidenceCommit`: `6f68fcddcba8ace4119ec28948516c3aa98454e6` (implementation commit used as the evidence-refresh base; later evidence-only commits do not change `bridgeImplementationCommit`).

Pinned runtime tuple: T3 `0.0.46-nightly.20261013.3040` / `ffb4af8d5d4fcfc5e9322295ff846a6d1e7ffbf8`; CoS base `2.1.39` / `87ae9d631f82d8da2f462d910410031ad8f97ac5`; CoS `providerExtension` buildId `0e755281cae0f87084293e4a735cc27744691a64`; ACP SDK `1.9.0`; Node `24.21.0`; Windows x64.

The runtime dependency lane remains deliberately narrow: `@agentclientprotocol/sdk` is pinned at `1.9.0` and Node requires `>=24`. Development tooling is pinned to TypeScript `5.9.3`, Vitest `5.0.5`, vite-node `6.0.0`, typescript-eslint `8.71.2`, and ESLint / @eslint/js `9.39.5`. The cross-process fixture uses the explicit vite-node dependency rather than relying on an accidental Vitest transitive path.

`package.json.version` is exactly `1.0.0`; ACP `agentInfo.version`, compatibility output, and release-readiness output derive from package metadata. The recorded implementation identity above follows the implementation-input history rule; evidence-only refreshes and release-manifest-only changes are not themselves treated as new bridge implementation inputs. The final Step-1 CoS server/providerExtension build is exactly `0e755281cae0f87084293e4a735cc27744691a64`; browser-extension/package file identity is separate and will be refreshed during the downstream portable-package/live-provenance step.

Current readiness hardening is included in this frozen implementation identity: production admission takes a fresh health snapshot, requires the exact pinned CoS extension build plus all five v1 feature versions and all three production mutation routes, rejects actions-disabled, and retains bound-session provider-policy attestation. Diagnostics check extension/actions/routes coherently from one health snapshot. These are source/test qualifications only; they do not convert deterministic readiness into live GUI acceptance.

The same freeze includes typed durable `state_io_error` handling with bounded Windows sharing retries and fail-closed ACP mapping, plus deterministic Step-8 built-stdio coverage across response-loss, SSE resume, restart/recovery, exact Stop, quarantine, rate-limit/provider-failure, and slow-consumer boundaries. Those tests strengthen the implementation freeze but are not recorded as a Step 7 or Step 8 live pass.

Freeze verification commands:

```text
npm ci
npx vitest run test/cos-provider-extension.test.ts
npm run verify
npm audit --json
git diff --check
```

Current validation from final implementation commit `6f68fcddcba8ace4119ec28948516c3aa98454e6`: fresh `npm ci` PASS with `147` packages and `0` vulnerabilities; bridge `npm run verify` PASS with `25/25` test files and `243/243` tests, including typecheck, lint, build, and package smoke; fresh `npm audit --json` exits `0` with `0` vulnerabilities at every severity; `git diff --check` PASS; `node scripts/implementation-commit.mjs` returns the exact same implementation commit. During the deliberate manifest-invalidated state, package smoke exits `0` and truthfully reports implementation readiness false and `releaseQualified:false`; after the evidence/manifest promotion and rebuild, package smoke exits `0` with `productionAcpEntrypoint:true`, `cosProviderExtensionReady:true`, `eventTranslatorReady:true`, and `durableRecoveryReady:true`, while Steps 7–9 keep `liveAcceptanceRequired:true`, `currentHeadDriftRequired:true`, and `releaseQualified:false`. Final CoS source verification on `0e755281cae0f87084293e4a735cc27744691a64` exits `0`: bulk `350` files passed / `5` skipped with `6607` tests passed / `45` skipped; serialized heavy lane `15` files / `2472` tests passed / `5` skipped; isolated renderer-state `1` file / `132` tests passed; standalone typecheck and `git diff --check` PASS. An explicit combined content/bridge/extension/provider-turn-drain run passes `1998/1998` across four files. The provider dependency audit is preserved at `20` advisories (`12` moderate, `8` high, `0` critical); untouched `2d4cf84c` now reports the same result on its unchanged lockfile/Electron `44.3.0`, so the extra moderate advisory is documented advisory-database drift rather than a new dependency regression. No audit fix is included in this freeze.

Package smoke reports bridge version `1.0.0`, supported concurrency `1`, and `releaseQualified:false`. Metrics/privacy qualification remains content-safe and metadata-only, including hashed identifiers, bounded timing receipts, controller/SSE/backoff/queue/RSS counters, and explicit redaction coverage.

This evidence supports only the deterministic `toolchainAudit` gate for this exact tuple. Live Step 7/8 evidence remains invalidated for this implementation identity; source/test completion and setup diagnostics do not promote it to live/browser acceptance or release qualification.
