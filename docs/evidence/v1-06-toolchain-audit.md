Evidence-Schema: 1
Gate: toolchainAudit
Status: PASS

# V1 Step 6 — toolchain audit and pre-live implementation freeze

`bridgeImplementationCommit`: `23d385d0d62dc7fefbbf5dc702f70115af644453`.

Pinned runtime tuple: T3 `0.0.46-nightly.20261013.3040` / `ffb4af8d5d4fcfc5e9322295ff846a6d1e7ffbf8`; CoS base `2.1.39` / `87ae9d631f82d8da2f462d910410031ad8f97ac5`; CoS provider extension buildId `0893fbdfe35192f5784f07fc03f97d2ccc235425`; ACP SDK `1.9.0`; Node `24.21.0`; Windows x64.

The runtime dependency lane remains deliberately narrow: `@agentclientprotocol/sdk` is pinned at `1.9.0` and Node requires `>=24`. Development tooling is pinned to TypeScript `5.9.3`, Vitest `5.0.5`, vite-node `6.0.0`, typescript-eslint `8.71.2`, and ESLint / @eslint/js `9.39.5`. The cross-process fixture uses the explicit vite-node dependency rather than relying on an accidental Vitest transitive path.

`package.json.version` is exactly `1.0.0`, with lockfile consistency proven by a clean `npm ci`. ACP `agentInfo.version`, compatibility output, and release-readiness output derive from package metadata. The recorded implementation identity above follows the implementation-input history rule; evidence-only refreshes and release-manifest-only changes are not themselves treated as new bridge implementation inputs.

Current readiness hardening is included in this frozen implementation identity: production admission takes a fresh health snapshot, requires the exact pinned CoS extension build plus all four v1 feature versions and all three production mutation routes, rejects actions-disabled, and retains bound-session provider-policy attestation. Diagnostics check extension/actions/routes coherently from one health snapshot. These are source/test qualifications only; they do not convert deterministic readiness into live GUI acceptance.

Freeze verification commands:

```text
npm ci
npm run verify
npm audit --json
git diff --check
```

Current validation: clean `npm ci` PASS; `npm run verify` PASS with `23` files / `208` tests, including typecheck, lint, build-backed tests, and package smoke; `npm audit --json` reports `0` vulnerabilities at every severity; `git diff --check` PASS. Focused Step-7 smoke/eligibility checks: `5/5` PASS.

Package smoke reports bridge version `1.0.0`. Metrics/privacy qualification remains content-safe and metadata-only, including hashed identifiers, bounded timing receipts, controller/SSE/backoff/queue/RSS counters, and explicit redaction coverage. The focused Step-7 result is deterministic smoke/eligibility evidence, not the pinned-T3 GUI fallback/live acceptance proof.

This evidence supports promoting only the `toolchainAudit` gate for this exact tuple. It does not claim release qualification from source/test completion alone; performance, live acceptance, current-head drift and release preparation remain pending.
