Evidence-Schema: 1
Gate: toolchainAudit
Status: PASS

# V1 Step 6 — toolchain audit and pre-live implementation freeze

`bridgeImplementationCommit`: `ef2548b817fe9318ac238e84d0ab39fd65258940`.

Pinned runtime tuple: T3 `0.0.46-nightly.20261013.3040` / `ffb4af8d5d4fcfc5e9322295ff846a6d1e7ffbf8`; CoS base `2.1.39` / `87ae9d631f82d8da2f462d910410031ad8f97ac5`; CoS `providerExtension` buildId `73e52028cb87ed2dd6fdc8c1a03a79669b8302bc` (browser-extension file stamp is tracked separately in Step-1/live-candidate provenance); ACP SDK `1.9.0`; Node `24.21.0`; Windows x64.

The runtime dependency lane remains deliberately narrow: `@agentclientprotocol/sdk` is pinned at `1.9.0` and Node requires `>=24`. Development tooling is pinned to TypeScript `5.9.3`, Vitest `5.0.5`, vite-node `6.0.0`, typescript-eslint `8.71.2`, and ESLint / @eslint/js `9.39.5`. The cross-process fixture uses the explicit vite-node dependency rather than relying on an accidental Vitest transitive path.

`package.json.version` is exactly `1.0.0`; ACP `agentInfo.version`, compatibility output, and release-readiness output derive from package metadata. The recorded implementation identity above follows the implementation-input history rule; evidence-only refreshes and release-manifest-only changes are not themselves treated as new bridge implementation inputs. The final Step-1 CoS server/providerExtension build is exactly `73e52028cb87ed2dd6fdc8c1a03a79669b8302bc`; the browser-extension file stamp is a separate identity tracked in Step-1/live-candidate provenance.

Current readiness hardening is included in this frozen implementation identity: production admission takes a fresh health snapshot, requires the exact pinned CoS extension build plus all four v1 feature versions and all three production mutation routes, rejects actions-disabled, and retains bound-session provider-policy attestation. Diagnostics check extension/actions/routes coherently from one health snapshot. These are source/test qualifications only; they do not convert deterministic readiness into live GUI acceptance.

The same freeze includes typed durable `state_io_error` handling with bounded Windows sharing retries and fail-closed ACP mapping, plus deterministic Step-8 built-stdio coverage across response-loss, SSE resume, restart/recovery, exact Stop, quarantine, rate-limit/provider-failure, and slow-consumer boundaries. Those tests strengthen the implementation freeze but are not recorded as a Step 7 or Step 8 live pass.

Freeze verification commands:

```text
npx vitest run test/cos-provider-extension.test.ts
npm run verify
npm audit --json
git diff --check
```

Current validation: bridge `npm run verify` PASS with `25/25` test files and `243/243` tests, including typecheck, lint, build, and package smoke; fresh `npm audit --json` exits `0` with `0` vulnerabilities at every severity; fresh `git diff --check` PASS; package smoke reports `bridgeVersion:1.0.0`, supported concurrency `1`, and `releaseQualified:false`. Live `--diagnose` against the isolated profile reports `ready:true` with `providerExtension` `73e52028cb87ed2dd6fdc8c1a03a79669b8302bc`, actions/routes ready, and exact project resolution OK. The exact CoS `73e52028` source validation is: targeted timed-out terminal-only regression `1/1` PASS; `test/provider-turn-drain.test.ts` + `test/projects.test.ts` + `test/control-api-reads.test.ts` `101/101` PASS; `npm run typecheck` PASS; `npm run build` PASS; `git diff --check` PASS. Full CoS `npm run verify` is explicitly **not claimed as PASS**.

Package smoke reports bridge version `1.0.0`, supported concurrency `1`, and `releaseQualified:false`. Metrics/privacy qualification remains content-safe and metadata-only, including hashed identifiers, bounded timing receipts, controller/SSE/backoff/queue/RSS counters, and explicit redaction coverage.

This evidence supports only the deterministic `toolchainAudit` gate for this exact tuple. Live Step 7/8 evidence remains invalidated for this implementation identity; source/test completion and setup diagnostics do not promote it to live/browser acceptance or release qualification.
