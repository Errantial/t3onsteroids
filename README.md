# t3onsteroids

Windows-first bridge for using Chat On Steroids (CoS) as a Local ACP provider in T3 Code.

## Status

The v1 implementation is versioned as **`1.0.0`** and is **release-qualified on the pinned Windows support tuple**. The production bridge includes the stable ACP v1 stdio provider, CoS protocol-1/provider-extension client, drain-aware event translator, durable Windows state and cross-process admission lease, restart/recovery logic, prompt normalization, bounded streaming/backpressure, setup diagnostics, and metadata-only release instrumentation.

All release-manifest gates are PASS for bridge implementation `f3a672cffdee77f54d377d5594893e0606d20d5b` and provider build `495e3e96504d9b865c18478f7b42915280712f84`. Step 7 live performance, the full pinned V1-01…V1-19 acceptance matrix, current-T3-HEAD drift, and fresh-checkout release preparation are current. `node dist/cli/index.js --release-readiness` reports `releaseQualified:true`.

See [`PLAN.md`](PLAN.md) for the authoritative gate sequence and [`docs/release-status.md`](docs/release-status.md) for the current release boundary.

## Supported v1 tuple

The first support claim is intentionally pinned:

- T3 `0.0.46-nightly.20261013.3040` / `ffb4af8d5d4fcfc5e9322295ff846a6d1e7ffbf8`;
- CoS base `2.1.39` / `87ae9d631f82d8da2f462d910410031ad8f97ac5`;
- CoS provider-extension build `495e3e96504d9b865c18478f7b42915280712f84` with all five required v1 provider features;
- ACP SDK `1.9.0`;
- Node 24 on Windows x64.

The **development baseline** (`src/compatibility.ts`) is T3 `0.1.5-nightly.20261029.3877` / `6d450a4284852af137b2f3407fddd89eb76e7644`. That is ahead of the release-qualified tuple above: `--release-readiness` reports `t3BaselineQualified:false` and `releaseQualified:false` until live acceptance is rerun on the new baseline and `v1ReleaseGateManifest.qualifiedT3Sha` is promoted with new evidence.

The separate current-upstream T3 drift lane was run against `807319c276c6831b2c219640e9da5b38019a8f1d` and recorded `compatible`. That result does not silently widen the pinned v1 support tuple.

## Setup and launch

Install and build with Node 24+:

```text
npm ci
npm run verify
```

T3 Local ACP must launch a real Node executable with `shell:false`; do not configure `npm.cmd`, `npx.cmd`, or another batch wrapper. The supported shape is:

```text
C:\Program Files\nodejs\node.exe
C:\path\to\t3onsteroids\dist\cli\index.js
```

No CLI arguments starts the production ACP stdio provider. Side-effect-free metadata/setup commands are also available:

```text
node dist/cli/index.js --compatibility
node dist/cli/index.js --release-readiness
node dist/cli/index.js --diagnose --user-data-dir <CoS user data dir> --cwd <exact project root>
```

The CoS **Local control API** must be enabled for live bridge use. **Allow actions** must also be enabled for every real bridged prompt, pending-input cancel, or exact-turn Stop because those operations use controller action routes. Diagnostics, exact project resolution, and ACP provider-validation/session-allocation probes remain read-only and do not require Allow actions.

## V1 boundaries

V1 binds only an **exact canonical CoS project root**. A worktree, subdirectory, remapped path, junction/reparse-changed path, or otherwise nonexact root fails closed instead of guessing another project. T3 and CoS must run on the same host under the **same OS user/profile**; same-host/different-user and remote-control scenarios are outside the v1 support claim.

V1 supports **one active bridged turn per stable CoS controller/profile identity**. A second concurrent turn is rejected rather than silently queued. Two-to-four concurrent chats are a post-v1 qualification target.

Bridge-created provider sessions require CoS `backgroundWork=disabled`, so workers/Goal/Loop/continuation work cannot outlive a provider turn. A delivered turn does not settle from `turn_end` alone: the bridge waits for the exact `turn_drained` high-water, persists all events through it, validates the authoritative final assistant event, and rechecks the provider-session policy before ACP terminal success.

## Recovery and reconnect

The bridge persists only compact metadata needed for binding, cursor/generation, cancellation, mode, recovery, and admission ownership; it does not persist prompts, assistant text, tool bodies/results, browser text, or controller credentials. On controller/CoS restart it rediscovers the endpoint/token, keeps the same stable admission domain, and reconciles the exact saved input/turn before any retry or lease release.

If a healthy bound ACP child restarts, resume reattaches to the same durable CoS session. Unknown, corrupt, cwd-mismatched, additional-directory, project-remapped, or otherwise unsafe resume state is quarantined/fails visibly safe rather than creating a replacement chat. Do not delete the bridge state directory to “fix” a live recovery problem unless the session has been explicitly reconciled and the consequences are understood.

For setup, operational recovery, side-by-side qualification, and troubleshooting steps, see [`docs/development.md`](docs/development.md).
