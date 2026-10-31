# Development, setup and operations

The bridge is Windows-first, uses Node directly, and this release is versioned as `1.1.3`. The production implementation includes the ACP stdio provider, CoS controller/provider-extension client, event translator, durable state and profile-wide admission scheduler, restart/cancellation recovery, bounded streaming, workspace/model/attachment support, background-work projection, and release diagnostics. `1.0.0` remains release-qualified on its pinned Windows tuple; `1.1.3` is a fix release on the `1.1.1` feature line for T3 `0.1.5` and does not silently widen that qualification.

## Pinned release tuple

The first v1 support tuple is:

- T3 `0.1.5-nightly.20261029.3877` / `6d450a4284852af137b2f3407fddd89eb76e7644` (development baseline; release tuple remains `ffb4af8d…`);
- CoS base `2.1.39` / `87ae9d631f82d8da2f462d910410031ad8f97ac5`;
- CoS provider-extension build `495e3e96504d9b865c18478f7b42915280712f84`;
- controller protocol 1 with `provider-project-resolve-v1`, `provider-assistant-content-v1`, `provider-session-policy-v1`, `provider-turn-drain-v1`, and `provider-turn-recovery-v1` all at version 1;
- `@agentclientprotocol/sdk@1.9.0`;
- Node 24, Windows x64.

Treat current upstream T3 HEAD as a **separate drift lane**. The V1 release drift check against `807319c276c6831b2c219640e9da5b38019a8f1d` recorded `compatible`; that result does not widen the pinned support tuple. Never loosen prompt normalization or other compatibility behavior merely to make HEAD work.

## Pinned development baseline

`src/compatibility.ts` tracks the **development baseline** and now targets T3 `0.1.5-nightly.20261029.3877` / `6d450a4284852af137b2f3407fddd89eb76e7644`. That baseline is ahead of the last live-qualified tuple. Qualification is tuple-specific: `v1ReleaseGateManifest.qualifiedT3Sha` records the T3 commit the release gates were recorded against, and `releaseReadiness()` reports `t3BaselineQualified:false` / `releaseQualified:false` whenever the two differ. Promote `qualifiedT3Sha` only together with fresh live-acceptance evidence for the new baseline.

The maintained T3 patch series lives in `handoff/t3-patches/`; the directory for this baseline is `main-2026-10-29-6d450a42` (same commit as nightly `.3877`). On the new baseline the series applies cleanly, the full `vp` typecheck passes (36/36 packages), the web production build succeeds, and the focused web/ACP test suites pass.

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

The pinned v1 release contract admits one active bridged turn per stable CoS profile/controller identity. That release uses a durable profile-wide lease, and a second simultaneous turn receives a deterministic busy result; controller port/token rotation does not create a new admission domain.

On branch feat/post-v1-concurrency, rebased commit `22d561f` implements the post-v1 durable profile-wide scheduler directly above the released v1.0.0 base (`5681f812...`): a bounded active set, FIFO waiting queue, exact queued cancellation/release, and legacy single-lease state compatibility. The isolated two-chat qualification gate passed on 2026-10-29, so the branch now advertises `supportedConcurrency: 2`; four chats remain unqualified and gated on the controller's four-stream global cap. Do not infer support for four chats from the implementation, the v1 release result, or offline tests alone.

The qualification lane's CoS profile must use `tunnel.kind: "manual"`. An `openai` tunnel with empty IDs makes the app start and fail a tunnel on every input, adding 300-500 ms pre-send spikes; the full matrix passes only after removing that churn.

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

## Concurrent turns (post-v1, unqualified)

The durable admission lease supports up to four slots per CoS profile (`MAX_LEASE_SLOTS`, matching the controller's global SSE budget), but the qualified ceiling is **one** turn. The production build admits one turn unless a qualification run opts in:

```text
T3COS_MAX_CONCURRENT_TURNS=2 T3COS_CONCURRENCY_QUALIFICATION=1
```

Asking for more than the qualified ceiling without `T3COS_CONCURRENCY_QUALIFICATION=1` fails at startup instead of being clamped. The lease also enforces one active turn per session, keeps honoring every existing slot if capacity is lowered, and fails closed if any slot file is corrupt. Slot 0 keeps the V1 file name, so existing state needs no migration.

The controller's read budget is shared by every turn, so its internal polling loops stretch their interval by the lease capacity (`scaledPollMs`). At capacity 1 the V1 intervals are unchanged; with more turns admitted, the combined wait-loop and Stop-loop read rate stays at the single-turn rate instead of exhausting the 600 reads/minute budget.

Raising `QUALIFIED_MAX_CONCURRENT_TURNS` in `src/state/concurrency.ts` is a qualification result: it needs live evidence for browser reliability, queue depth, memory, controller utilization, latency, cancellation isolation and stale-event isolation first (see the post-v1 roadmap in `PLAN.md`). Do not advertise or document concurrent chats as supported before then.
