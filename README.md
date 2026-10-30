# t3onsteroids

Windows-first bridge for using Chat On Steroids (CoS) as a Local ACP provider in T3 Code.

## Status

**`1.1.1`** is the latest feature release. It targets **T3 Code `0.1.5`** (`6d450a4284852af137b2f3407fddd89eb76e7644`, also published as nightly `0.1.5-nightly.20261029.3877`) and adds the post-v1 capability set on top of the release-qualified `1.0.0` bridge:

- two simultaneously active bridged turns per stable CoS controller/profile, with a durable FIFO queue and exact cancellation/release;
- workspace and T3 worktree binding through the versioned `provider-session-workspace-v1` contract;
- model and reasoning-effort selection from T3 through `provider-model-catalog-v1`;
- prompt images (PNG/JPEG converted to WebP, bounded by the controller contract) and other attachment hardening;
- native CoS background-work projection with a pending-work fence and report-after-drain follow-ups;
- the same durable recovery, drain-aware termination, bounded streaming, diagnostics and privacy guarantees as v1;
- a maintained T3 patch series for optional per-thread tokens/sec and ACP per-turn token usage, ported to T3 `0.1.5`.

The complete pinned v1 support tuple from `1.0.0` (T3 `0.0.46-nightly.20261013.3040` / `ffb4af8d…`, CoS `2.1.39` / `87ae9d63…`, provider build `495e3e96…`) remains the **release-qualified** tuple recorded in `src/release-manifest.ts`. Qualification is tuple-specific: on the `0.1.5` development/release baseline, `--release-readiness` reports `t3BaselineQualified:false` and `releaseQualified:false` until the full V1 matrix is rerun on that exact tuple. Post-v1 evidence (two-chat matrix, T3-HEAD acceptance, attachment and recovery lanes) is recorded in `docs/release-status.md` and `docs/evidence/`.

See [`PLAN.md`](PLAN.md) for the gate sequence and [`docs/release-status.md`](docs/release-status.md) for the current release boundary.

## Windows installer and T3 Connect

`v1.1.1` also publishes the **T3 Code 0.1.5 Windows x64 installer** built from the ChatGPT Browser fork with the t3onsteroids patch series applied:

```text
T3-Code-0.1.5-v1.1.1.20261030.c8cd959156.connect1-x64.exe
```

That installer includes the optional per-thread tokens/sec and ACP per-turn token usage patches, the managed ChatGPT Browser provider, and **T3 Connect enabled with the production public relay/Clerk configuration** baked into the build. `t3 connect status --json` works against the packaged server without runtime environment variables.

The installer is the T3 Code application; the t3onsteroids bridge remains the Local ACP provider distributed in the source and patch assets of this release. The installer does not auto-register the bridge.

## Supported tuple for `1.1.1`

- T3 Code `0.1.5` / `6d450a4284852af137b2f3407fddd89eb76e7644`
  (also published as `0.1.5-nightly.20261029.3877`; T3-HEAD acceptance additionally exercised `dd14848…`);
- CoS `2.1.39` / `87ae9d631f82d8da2f462d910410031ad8f97ac5`, controller protocol 1;
- CoS provider-extension build `2a6a1f8…` with the v1 feature set plus workspace, model-catalog, prompt-image, multiplexed-stream and background-work contracts; the exact build and feature versions are in `src/compatibility.ts`;
- ACP SDK `1.9.0`;
- Node 24 on Windows x64 (`sharp` is used for PNG/JPEG → WebP prompt images).

The maintained T3 patch series lives in `handoff/t3-patches/` and is verified against both the pinned `ffb4af8d` release tuple and the `0.1.5` baseline. It is never sent upstream; do not open PRs, issues or discussions against `pingdotgg/t3code`.

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

## Boundaries

V1 binds only an **exact canonical CoS project root**. A worktree, subdirectory, remapped path, junction/reparse-changed path, or otherwise nonexact root fails closed instead of guessing another project. `1.1.1` adds explicit workspace binding when the controller advertises `provider-session-workspace-v1`: exact project roots, linked Git worktrees and plain project subdirectories resolve to their owning project, and the resolved workspace is revalidated on every prompt. T3 and CoS must run on the same host under the **same OS user/profile**; same-host/different-user and remote-control scenarios are outside the supported claim.

`1.1.1` supports **two active bridged turns per stable CoS controller/profile identity**. A third turn queues durably behind the active set (bounded queue) instead of being silently admitted; cancellation and release are exact per session. Four- and eight-chat concurrency remain parked behind their own measured gates.

Bridge-created provider sessions require CoS `backgroundWork=disabled` for the v1 lane; `1.1.1` adds the versioned report-after-drain policy where the controller advertises it. A delivered turn does not settle from `turn_end` alone: the bridge waits for the exact `turn_drained` high-water, persists all events through it, validates the authoritative final assistant event, and rechecks the provider-session policy before ACP terminal success. Pending native work is projected and fenced before settlement.

## Recovery and reconnect

The bridge persists only compact metadata needed for binding, cursor/generation, cancellation, mode, recovery, admission ownership and bounded follow-up state; it does not persist prompts, assistant text, tool bodies/results, browser text, or controller credentials. On controller/CoS restart it rediscovers the endpoint/token, keeps the same stable admission domain, and reconciles the exact saved input/turn before any retry or lease release.

If a healthy bound ACP child restarts, resume reattaches to the same durable CoS session. Unknown, corrupt, cwd-mismatched, additional-directory, project-remapped, or otherwise unsafe resume state is quarantined/fails visibly safe rather than creating a replacement chat. Do not delete the bridge state directory to “fix” a live recovery problem unless the session has been explicitly reconciled and the consequences are understood.

For setup, operational recovery, side-by-side qualification, and troubleshooting steps, see [`docs/development.md`](docs/development.md). For the provider usage/tokens-sec contract and its current CoS scope decision, see [`docs/usage-contract.md`](docs/usage-contract.md).
