Evidence-Schema: 1
Gate: toolchainAudit
Status: PASS

# V1 Step 6 — toolchain audit and pre-live implementation freeze

`bridgeImplementationCommit`: `b4fb45d5b1ae6683d2b42e71589e207ff2f662dd`.

`evidenceCommit`: `b4fb45d5b1ae6683d2b42e71589e207ff2f662dd` (implementation commit used as the evidence-refresh base; later evidence-only commits do not change `bridgeImplementationCommit`).

Pinned runtime tuple: T3 `0.0.46-nightly.20261013.3040` / `ffb4af8d5d4fcfc5e9322295ff846a6d1e7ffbf8`; CoS base `2.1.39` / `87ae9d631f82d8da2f462d910410031ad8f97ac5`; CoS `providerExtension` buildId `4a32b82499af82948580235b3d1c66f2e84ad762` (browser-extension stamp `ecc2a76d317a` is tracked separately in Step-1/live-candidate provenance); ACP SDK `1.9.0`; Node `24.21.0`; Windows x64.

The runtime dependency lane remains deliberately narrow: `@agentclientprotocol/sdk` is pinned at `1.9.0` and Node requires `>=24`. Development tooling is pinned to TypeScript `5.9.3`, Vitest `5.0.5`, vite-node `6.0.0`, typescript-eslint `8.71.2`, and ESLint / @eslint/js `9.39.5`. The cross-process fixture uses the explicit vite-node dependency rather than relying on an accidental Vitest transitive path.

`package.json.version` is exactly `1.0.0`; ACP `agentInfo.version`, compatibility output, and release-readiness output derive from package metadata. The recorded implementation identity above follows the implementation-input history rule; evidence-only refreshes and release-manifest-only changes are not themselves treated as new bridge implementation inputs. The final Step-1 CoS server/providerExtension build is exactly `4a32b82499af82948580235b3d1c66f2e84ad762`; the browser-extension file stamp is a separate identity tracked in Step-1/live-candidate provenance.

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

Current validation from the clean detached final implementation commit `b4fb45d5b1ae6683d2b42e71589e207ff2f662dd`: `npm ci` PASS; bridge `npm run verify` PASS with `25/25` test files and `243/243` tests, including typecheck, lint, build, and package smoke; fresh `npm audit --json` exits `0` with `0` vulnerabilities at every severity; `git diff --check` PASS; `node scripts/implementation-commit.mjs` returns the exact same implementation commit; clean-worktree package smoke reports the four Steps 1–4 readiness fields true and `releaseQualified:false`. Final CoS source verification on `4a32b82499af82948580235b3d1c66f2e84ad762` exits `0`: bulk `354` files / `6639` tests passed with `46` skipped tests; serialized heavy lane `11` files / `2436` tests passed with `4` skipped tests; isolated renderer-state `1` file / `132` tests passed. The provider verification retains exact-turn/Stop/deadline/drain assertions; the post-`61d111f6` commits are test-isolation/verification-runner changes, not acceptance weakening.

Package smoke reports bridge version `1.0.0`, supported concurrency `1`, and `releaseQualified:false`. Metrics/privacy qualification remains content-safe and metadata-only, including hashed identifiers, bounded timing receipts, controller/SSE/backoff/queue/RSS counters, and explicit redaction coverage.

This evidence supports only the deterministic `toolchainAudit` gate for this exact tuple. Live Step 7/8 evidence remains invalidated for this implementation identity; source/test completion and setup diagnostics do not promote it to live/browser acceptance or release qualification.
