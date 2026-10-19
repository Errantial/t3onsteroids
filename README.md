# t3onsteroids

Windows-first bridge for using Chat On Steroids (CoS) as a Local ACP provider in T3 Code.

## Status

The v1 implementation is versioned as **`1.0.0`**, but it is **not release-qualified yet**. The production bridge now includes the stable ACP v1 stdio provider, CoS protocol-1/provider-extension client, drain-aware event translator, durable Windows state and cross-process admission lease, restart/recovery logic, prompt normalization, bounded streaming/backpressure, setup diagnostics, and metadata-only release instrumentation.

The release manifest records the deterministic Steps 1–6 gates, but each behavioral PASS is valid only for the `bridgeImplementationCommit` named by its evidence and must be refreshed after any implementation-input change. Steps 7–9 remain release gates: live single-turn performance, the pinned live acceptance matrix, current-T3-HEAD drift, and final release preparation. Until the full gate set is current and complete, `--release-readiness` intentionally reports `releaseQualified:false`.

See [`PLAN.md`](PLAN.md) for the authoritative gate sequence and [`docs/release-status.md`](docs/release-status.md) for the current release boundary.

## Supported v1 tuple

The first support claim is intentionally pinned:

- T3 `0.0.46-nightly.20261013.3040` / `ffb4af8d5d4fcfc5e9322295ff846a6d1e7ffbf8`;
- CoS base `2.1.39` / `87ae9d631f82d8da2f462d910410031ad8f97ac5`;
- CoS provider-extension build `0893fbdfe35192f5784f07fc03f97d2ccc235425` with all four v1 provider features;
- ACP SDK `1.9.0`;
- Node 24 on Windows x64.

Current upstream T3 HEAD is a separate drift lane. Its result can be compatible or incompatible without silently changing the pinned v1 support tuple.

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
