# Development, setup and operations

The v1 bridge is Windows-first, uses Node directly, and is versioned as `1.0.0`. The production implementation includes the ACP stdio provider, CoS controller/provider-extension client, event translator, durable state and profile-wide admission lease, restart/cancellation recovery, bounded streaming, and release diagnostics. V1 release qualification is complete on the pinned Windows tuple; this document describes that qualified operating model.

## Pinned release tuple

The first v1 support tuple is:

- T3 `0.0.46-nightly.20261013.3040` / `ffb4af8d5d4fcfc5e9322295ff846a6d1e7ffbf8`;
- CoS base `2.1.39` / `87ae9d631f82d8da2f462d910410031ad8f97ac5`;
- CoS provider-extension build `495e3e96504d9b865c18478f7b42915280712f84`;
- controller protocol 1 with `provider-project-resolve-v1`, `provider-assistant-content-v1`, `provider-session-policy-v1`, `provider-turn-drain-v1`, and `provider-turn-recovery-v1` all at version 1;
- `@agentclientprotocol/sdk@1.9.0`;
- Node 24, Windows x64.

Treat current upstream T3 HEAD as a **separate drift lane**. The V1 release drift check against `807319c276c6831b2c219640e9da5b38019a8f1d` recorded `compatible`; that result does not widen the pinned support tuple. Future drift runs must still avoid editing pinned compatibility metadata or loosening prompt normalization merely to make HEAD work.

## Install and verify

Use a clean checkout for release evidence:

```text
npm ci
npm run verify
npm audit --json
git diff --check
node scripts/implementation-commit.mjs
```

`npm run verify` runs typecheck, lint, tests/build, and the release-readiness package smoke. The current release process additionally relies on the canonical evidence files and `src/release-manifest.ts`; a green local verify is necessary but not sufficient for release qualification.

## T3 Local ACP configuration

T3 spawns Local ACP providers with `shell:false`. Configure a real Node executable plus the built script; do not point T3 at `npm.cmd`, `npx.cmd`, PowerShell wrappers, or another `.cmd`/`.bat` launcher.

Example Windows shape:

```text
executable: C:\Program Files\nodejs\node.exe
argument:   C:\path\to\t3onsteroids\dist\cli\index.js
```

No CLI arguments starts the production stable ACP v1 stdio provider. `initialize` and bridge-local `session/new` allocation remain free of CoS mutation so T3 validation probes do not create chats.

Useful side-effect-free commands:

```text
node dist/cli/index.js --compatibility
node dist/cli/index.js --release-readiness
node dist/cli/index.js --diagnose --user-data-dir <CoS user data dir> --cwd <exact project root>
```

`--diagnose` is read-only. It checks controller discovery, protocol/app identity, exact provider-extension build/features, action-route availability, and exact project resolution. It never enables CoS settings for the user.

## Required CoS settings

For live bridge use, CoS **Local control API** must be enabled by the user. Every real bridged prompt uses `POST /v1/inputs`; pending-input cancellation and exact-turn Stop are action routes too. Therefore **Allow actions must be enabled** for prompts, cancel, and Stop even when the requested model task itself is read-only or no-tool.

Read-only diagnostics/project resolution and ACP provider-validation/session-allocation probes do not require Allow actions. Host-tool authority is separate: T3 runtime mode does not widen or narrow CoS permissions. CoS remains the final authority for Core/Desktop/browser/plugin actions.

## Exact project-root rule

V1 accepts only the exact canonical root of one usable CoS project. The bridge re-resolves and revalidates that identity before subsequent prompts. It does not silently map a T3 worktree, nested subdirectory, alternate checkout, remapped path, changed junction/reparse target, or ambiguous path to a parent CoS project.

If the exact root cannot be proven, expect `project_unmapped` or a broken/recovery-required session with **no send**. Configure T3 to open the exact CoS project root for the pinned lane rather than working around this check.

ACP `ResourceLink` support follows the same boundary: only local `file:` URIs that canonicalize inside the exact bound project root are accepted. The bridge does not pre-read the linked file into its own durable state.

## Same-user and concurrency boundaries

V1 is same-host, **same OS user/profile** only. The bridge discovers the current user's CoS controller token from that user's CoS profile; a different-user service or remote-client authority model has not been release-qualified.

V1 admits **one active bridged turn per stable CoS profile/controller identity**, coordinated across ACP processes by a durable profile-wide lease. A second simultaneous turn receives a deterministic busy result instead of being queued invisibly. Controller port/token rotation does not create a new admission domain. Two-to-four concurrent chats are post-v1 work and must not be advertised yet.

## Terminal semantics and background work

Bridge-created provider sessions require the immutable CoS policy `backgroundWork=disabled`. Workers, Goal/Loop, and equivalent continuations must therefore be refused for that provider session.

For a delivered turn, CoS `turn_end` is outcome evidence but is not terminal proof. The bridge remains open until the exact matching `turn_drained` marker is consumed, every event through its `highWaterSeq` has been projected/persisted, the authoritative `finalAssistantSeq` has been validated/fetched when present, and the session freshly attests the required background-work policy. The admission lease is not released earlier.

## State, restart and recovery

Production state defaults under `%LOCALAPPDATA%\t3onsteroids\state`; `T3ONSTEROIDS_STATE_DIR` is available for an explicit test/deployment override. For qualification runs, use an isolated state root and never delete unrelated user state.

Durable state is metadata-only: session binding, generation/cursor, interaction-mode transition, cancellation target, terminal/recovery status, quarantine hashes, and admission ownership. It must not contain prompt/assistant text, tool bodies/results, browser text, or bearer tokens.

Recovery behavior is fail-closed:

- a healthy bound ACP process restart resumes the same CoS session;
- controller/CoS restart or token/port rotation triggers rediscovery and exact turn/input reconciliation before retry/release;
- an ambiguous send is reconciled from authoritative input/session evidence and is never blindly reposted;
- a saved cancellation target is retried/reconciled only against that exact input/turn;
- unknown post-crash resume ids, corrupt/future state, cwd mismatch, nonempty additional directories, project remap, or policy loss are quarantined/broken rather than reconstructed as a new chat;
- Windows durable-state sharing failures use bounded retry and surface as typed `state_io_error` if they remain unresolved.

If a session is recovery-required, first preserve the state/evidence and determine whether the exact old input/turn drained or proved `not_sent`. Do not “recover” by deleting state and resending, because that can duplicate an operation that CoS already accepted.

## Reconnect troubleshooting

For controller/CoS reconnect problems:

1. Verify CoS is running under the same OS user/profile as T3 and the bridge.
2. Verify Local control API is enabled; for prompt/cancel/Stop also verify Allow actions is enabled.
3. Run the read-only diagnostic against the exact project root and the intended CoS user-data directory.
4. Confirm health reports protocol 1, the exact pinned provider-extension build id, and all five feature versions at 1, including `provider-turn-recovery-v1`.
5. Keep the existing bridge state intact while the bridge rediscovers the controller endpoint/token and reconciles the saved input/turn.
6. If a lease remains held, resolve the saved turn to authoritative `not_sent` or drained terminal proof before attempting a new prompt.

For SSE reconnects, the bridge resumes from the persisted cursor and deduplicates recorded events. Repeated manual restarts should not be used as a substitute for resolving a persistent controller/extension mismatch.

## Side-by-side qualification lane

Release qualification prefers a **side-by-side CoS candidate** while the user's active CoS remains in use. Build the exact clean provider-extension commit and launch that candidate with a dedicated, isolated CoS user-data/profile directory. Do not point it at the active profile, copy files into the installed application directory, or patch `app.asar` in place.

For that lane, record the candidate executable/version/SHA-256, extension build id/features, isolated profile identity hash, bridge implementation commit, state-root identity hash, and the active installed CoS executable identity so evidence can prove the active instance was not replaced. Run `--diagnose` against the candidate profile/exact project root before any mutating case.

An installed-candidate lane is also defined in `PLAN.md`, but it is a separate explicitly authorized environment transition with rollback provenance; it is not required merely to develop or verify the bridge source.

## Release qualification boundary

The deterministic implementation/source gates are not sufficient by themselves for a release claim. For `v1.0.0`, Steps 7–9 have now completed the live single-turn performance lane, the pinned V1-01…V1-19 matrix, current-T3-HEAD drift, fresh-checkout/package verification, final evidence/readiness, and the release tag.

The final qualified implementation is bridge `f3a672cffdee77f54d377d5594893e0606d20d5b` with CoS provider build `495e3e96504d9b865c18478f7b42915280712f84`. The historical V1-11 broken admission domain remains preserved and fail-closed rather than repaired or reused; the final release qualification is based on a fresh equivalent V1-11 PASS on the final tuple. `docs/release-status.md` and `docs/evidence/v1-07-performance.md` through `v1-09-release.md` are the authoritative current qualification summaries.
