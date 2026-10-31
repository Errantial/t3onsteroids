# Fleet execution targets

Status: proposed architecture, 2026-10-31. No implementation or qualification claim.
Scope: one T3 thread acting on multiple machines without a thread or provider session per machine.
Baseline: T3 `0.1.5` / `6d450a4284852af137b2f3407fddd89eb76e7644`; bridge `1.1.5`;
CoS `2.1.39` / `87ae9d631f82d8da2f462d910410031ad8f97ac5`, controller protocol 1.

This is a post-v1 workstream. It does not change the v1 support tuple or the M1-M7 ledger. “Fleet”
here means a set of runtime execution targets. It is not the release fleet in
`scripts/fleet-update.mjs`; that script is an operational installer inventory (`home`,
`framework`, `server1`) and is the first test bed, not a runtime target registry.

## 1. Decision

Keep **one conversation and one provider session on a home environment**. Make “which machine” a
first-class **execution target** attached to the thread:

- `home` is the durable anchor where the provider session lives.
- `targets` are machines the thread may act on, sourced from the user’s linked environments.
- `activeTarget` is the default target for host actions, changeable per call.

Switching machines is thread state plus a tool argument. It is not a new thread, a new provider
session, or a context replay. Whole-fleet work is a bounded fan-out call, not N threads.

## 2. Why this shape

| Alternative | Failure |
| --- | --- |
| Thread per machine (today via `delegate_task` with `target.environmentId`) | N contexts, duplicated instructions, coarse handoff, latency. Good for isolated chunks; poor for tight cross-machine loops. |
| Migrate the provider session per turn | Provider state is machine-local: processes, caches, credentials, approvals, checkpoints. Resuming elsewhere means replaying history and losing that state. |
| Mount remote filesystems | Latency, Windows support, file watchers, atomicity; remote binaries and services still do not run locally. |
| Let the agent SSH directly | Bypasses peer access, runtime policy, approvals, and audit; duplicates credentials; no portable Windows path. |

The missing layer is not another model session. It is an execution route that the existing thread
can call.

## 3. Evidence

Verified on 2026-10-31 against the shipped T3 build
`0.1.5-v1.1.5.20261031.d43ad80f4724.connect1`, the local T3 fork checkout `0737827`, and this
repository at `origin/main` `3d482bd`.

| Claim | Evidence |
| --- | --- |
| A T3 thread is scoped to one environment. | `ScopedThreadRef` is `{ environmentId, threadId }` (`packages/contracts/src/environment.ts`). Terminal sessions are thread-scoped and local (`apps/server/src/terminal/Manager.ts`). |
| Linked environments already exist as authenticated peer MCP links. | Packaged `PeerLink` contract: this environment “signed in to the peer’s `/mcp` as an outside agent, with a pairing code from the peer”; the peer enforces the access chosen at linking and revokes it from its own Connections. |
| Links carry reachability and access, not just an address. | Live `t3_environment_links` returned `reachable` / `unreachable` and `access` for two linked environments. |
| Orchestrator tools can already act on another environment. | `t3_thread_launch`, `t3_project_read`, `t3_schedule_task`, and related tools accept `environmentId`; the live schemas expose it. |
| T3’s ACP provider channel can carry MCP servers. | `mcpServers: mcpContext.servers` and `acpMcpServers: mcpContext.acpServers` in `packages/provider-acp/src/server/adapter.ts`; the same block advertises `fs` and `terminal` client capabilities. |
| The bridge currently ignores those MCP servers. | `test/acp-phase3.test.ts` — “accepts but does not forward T3-injected MCP metadata”; `newSession` and `resumeSession` reject `additionalDirectories` but neither forwards nor rejects `mcpServers` (`src/acp/index.ts`). |
| CoS executes its own tools; the bridge is a transport, not an executor. | The bridge owns ACP lifecycle and controller transport; its v1 boundary is same-host/same-user (`README.md`). There is no bridge path that runs a CoS tool. |
| T3 already has a runtime-mode and approval model a target executor can reuse. | Threads and orchestrator calls expose `runtimeMode` as `approval-required`, `auto-accept-edits`, `auto`, or `full-access`; the target must enforce its own mode rather than inheriting the caller’s. |
| The repository already has a three-machine inventory. | `scripts/fleet-update.mjs`: `home`, `framework`, `server1`; Windows-local, Windows-SSH, and Linux-SSH install paths. |

Source drift: the packaged `0.1.5-v1.1.5` build contains the peer-link contract and environment
tools, but neither local T3 checkout (`source/repos/t3code` at `0737827`) does. P0 must either start
from the source that carries them or land the peer-link contract in the maintained patch series
first. Do not implement `peer-exec-v1` against a checkout that cannot see a peer.

The practical constraint follows: **T3 can route its own tools, but it cannot redirect a provider’s
native shell.** Claude’s `Bash`, Codex’s shell, OpenCode’s shell, and CoS’s terminal all execute on
the home host unless the agent itself moves. The design must be explicit about that boundary.

## 4. Model

```ts
type ExecutionTarget = {
  targetId: string;                 // stable, user-visible label
  environmentId: EnvironmentId;     // linked peer identity
  label: string;
  platform: "windows" | "linux" | "darwin";
  workspace: {
    root: string;                   // canonical path on that machine
    repositoryKey?: string;         // canonical git remote identity
    branch?: string;                // advisory, revalidated per job
  };
  access: "read-only" | "approval-required" | "auto" | "full-access";
  transport: "peer" | "local";
};

type ThreadFleet = {
  homeEnvironmentId: EnvironmentId;
  targets: ExecutionTarget[];
  activeTargetId: string | null;
};
```

Persist `ThreadFleet` with thread metadata, not with the provider session. Emit
`thread.target.added`, `thread.target.removed`, and `thread.target.activated`. Restore the active
target on resume exactly as it was. Targets are added and removed by the **user** through the
existing environment-link card; the model may request a link but never creates one.

The home environment may also be listed as a target. Local calls use the local transport; remote
calls use the peer transport. Keep one result shape for both.

Versioned contracts:

| Contract | Owner | Purpose |
| --- | --- | --- |
| `thread-fleet-v1` | T3 orchestration | Thread target metadata, active target, events, restart restore. |
| `peer-exec-v1` | T3 peer server | Target-local `exec`, job, fs, and git primitives. |
| `fleet-tools-v1` | T3 MCP | Model-facing `t3_targets` / `t3_shell` / `t3_fs_*` schemas and result shape. |
| `provider-mcp-servers-v1` | Bridge + CoS | Per-session, thread-scoped MCP connector for CoS-backed threads. |

Each is independently capability-gated. A missing contract is an explicit refusal, not a
best-effort fallback.

## 5. Transport

Reuse the existing peer link; do not build a second credential system.

Add a narrow, capability-versioned **`peer-exec-v1`** surface to the peer’s `/mcp`:

```text
peer_exec({ command, cwd, env?, timeoutMs?, tty? }) -> { jobId } | { exitCode, ... }
peer_exec_status({ jobId }) -> { state, exitCode?, ... }
peer_exec_cancel({ jobId }) -> { cancelled }
peer_fs_read({ path, offset?, limit? })
peer_fs_write({ path, content })
peer_fs_list({ path })
peer_git({ args, cwd })
```

`peer-exec-v1` executes **only on the peer that serves it**. It accepts no `environmentId` and no
peer URL, so it cannot chain or recurse. The calling environment owns target resolution.

The model-facing tools live on the calling environment and add target awareness:

| Tool | Behavior |
| --- | --- |
| `t3_targets` | Compact list: id, label, platform, workspace, access, reachability. |
| `t3_target_use` | Set the thread’s active target; durable; emits an event. |
| `t3_shell` | Run a command or open a PTY on `target` (default: active). |
| `t3_shell_status` / `t3_shell_cancel` | Inspect or stop an exact job. |
| `t3_fs_read` / `t3_fs_write` / `t3_fs_list` / `t3_fs_stat` | File operations on `target`. |
| `t3_git` | Git operations on `target`. |
| `t3_fleet_run` | Bounded fan-out over an explicit target list or `all`. |
| `t3_copy` | Explicit file transfer between targets, routed through the caller. |

Rules:

- One shell tool with a `target` parameter. Never one tool per machine.
- Every result echoes `{ targetId, environmentId, workspace, cwd }`.
- The active target is a default, not a hidden mode. A call that omits `target` records the
  resolved target it used.
- Long-running work returns a `jobId`; one-shot `exec` is not enough for dev servers, test suites,
  or builds.
- No interactive password prompts in v1. A PTY is for process output and signals, not credential
  entry. Fail closed rather than hang a turn.

## 6. Routing, workspaces, and jobs

**Workspace resolution.** Do not assume the same path on every machine. Resolve a target workspace
by canonical path plus repository identity (the same discipline as
`provider-session-workspace-v1`). If the path is missing or the repository identity differs, fail
`target_workspace_unmapped`; never fall back to the home path.

**Worktrees.** A thread’s worktree is local to its home environment. Do not silently create matching
worktrees on every target. Default target operations to the target’s existing checkout. Creating a
worktree on a target is an explicit setup step with its own command.

**Jobs.** `t3_shell` returns either a completed result or a job handle. Jobs support status, log
cursors, and exact cancellation. Default lifecycle: kill on turn end unless `detach: true` is
explicitly set and persisted. A detached job is visible in the thread’s job list and in the target
panel.

**Fan-out.** `t3_fleet_run` expands `all` only to targets that are reachable and have a resolved
workspace. Proposed defaults: concurrency 4, per-target timeout, partial results, `stopOnError`
false. Return one row per target with exit code, duration, output tail, and artifact handle. Never
claim atomicity or all-or-nothing completion across machines.

**Context budget.** `t3_targets` returns a compact list, not a tool schema per target. Shell results
return an output tail plus an artifact handle for full output. Fan-out returns one row per target,
not concatenated logs. This keeps fleet work from consuming the thread’s context in proportion to
the number of machines.

## 7. Policy, approvals, and failure

- The **target’s** runtime mode and approval policy are authoritative. The caller’s mode is a
  ceiling; the effective permission is the intersection. A caller cannot escalate a target.
- Add a **separate `remoteExecution` grant** to a peer link, distinct from “may orchestrate
  threads”. A link that can launch threads should not silently gain raw shell.
- v1 approvals: if a command exceeds the link’s remote-execution access, fail with
  `remote_approval_required` and tell the user to approve on the target. Do not approximate a
  cross-machine approval prompt. A later contract can carry a reverse approval request keyed by
  `origin { environmentId, threadId, itemId }`.
- Audit metadata only: thread, target, workspace, command hash, decision, exit code. No command
  bodies, output bodies, or repository contents.
- Treat remote output as untrusted data. It can never change the target list, active target, or
  approval state.
- Target unreachable is a tool error, not a turn failure. The thread continues.
- Network loss mid-command is **not** command failure. The job may still be running; reconnect by
  `jobId`. Never auto-rerun a destructive command.
- Home restart: reconcile persisted job IDs after resume. Target restart: jobs are lost; report the
  exact loss. Version skew: missing `peer-exec-v1` is `target_capability_missing`; the target stays
  visible but not executable.

## 8. UI

- Composer chip: `on: <target>` with a picker; `/target <name>` as the keyboard path.
- Tool cards and approval cards carry a target badge; detail shows target, workspace, and cwd.
- Terminal panel gets per-target tabs; file tree and diff follow the active target.
- Fleet panel: reachability, last job, git HEAD, access, expiry.
- Switching appends a short transcript event (“Switched to server-1”); it does not fork or rewind.

## 9. Provider integration

**Native providers (Claude, Codex, OpenCode).** Native shell and file tools stay local to the home
environment. Add a compact prompt block naming the home, the targets, and the active target, and
state the rule: native tools are home-only; `t3_shell` / `t3_fs_*` are target-aware. Where the
provider supports tool allowlists, a fleet-only thread can disable the native shell. Do not pretend
native `Bash` is remote.

**CoS-backed threads.** CoS executes its own terminal and filesystem tools, so T3 cannot reroute
them. The workable path is to give CoS’s model the fleet tools:

1. Add `provider-mcp-servers-v1` to the bridge. `session/new` and resume forward a thread-scoped T3
   MCP descriptor to CoS.
2. CoS mounts it as a per-session connector, with a token scoped to the thread, the allowed target
   set, and a short TTL.
3. Inject the fleet block into the bridge’s normalized prompt. The bridge currently does not
   forward T3-injected MCP metadata (`test/acp-phase3.test.ts`), so this is a real contract change,
   not a passthrough toggle.
4. Keep CoS’s native tool authority intact. The connector is additive.

If CoS cannot mount per-session connectors, the honest fallbacks are a `t3 fleet` CLI invoked
through CoS’s existing shell (works, but weak quoting, streaming, and approvals) or a CoS-side
remote-executor contract. Do not claim native fleet support before one of those exists.

**Handoff is not the fleet mechanism.** Moving the provider session to another machine at a turn
boundary is a separate “move thread” command: stop, replay normalized history, resume there, and
accept the loss of native processes and caches. It is useful when native tools must run on the
target; it is not how per-action switching should work.

## 10. Scaling

- **2–10 machines:** peer links plus a T3 server on each machine. This matches the current
  `home` / `framework` / `server1` setup.
- **10+ machines:** one fleet gateway in front of lightweight executor daemons. The gateway holds
  the registry and authenticated transports; the model still sees logical `targetId`s and the same
  `peer-exec-v1` contract. Do not require a full T3 server, provider runtime, and data store on
  every build box.

Build the contract and the two-machine vertical slice first. The gateway is an implementation of
the same contract, not a phase-one requirement.

## 11. Delivery

| Phase | Scope | Exit evidence |
| --- | --- | --- |
| P0 | `peer-exec-v1` with `exec`, `fs.read`, `fs.list`; `t3_shell` and `t3_fs_read` on the caller; local + peer transport. | Windows↔Windows and Windows↔Linux (server-1) execute and read; timeout, cancel, unreachable peer, and missing-capability cases. |
| P1 | `ThreadFleet` metadata and events; `t3_targets` / `t3_target_use`; active-target prompt block; UI chip and switch event. | Target state survives restart; switching does not restart the provider session; no prompt/tool-body logging. |
| P2 | Jobs and PTY; `t3_fs_write`, `t3_git`; workspace/repository resolution; target-scoped approvals. | Network drop mid-job reconnects by `jobId`; cancel is exact; unmapped workspace fails closed; policy intersection tested. |
| P3 | `t3_fleet_run`, `t3_copy`, bounded concurrency, partial results, HEAD/dirty preflight. | Three-target matrix with one failure; per-target rows; no all-or-nothing claim; context/output caps measured. |
| P4 | CoS `provider-mcp-servers-v1`, per-session connector, prompt injection, qualification. | A CoS thread calls `t3_shell` on server-1; native CoS terminal remains local; tool events carry the target; new tuple recorded. |
| P5 | Optional explicit handoff to a target. | Turn-boundary move with recorded context-loss behavior; native target tools work after resume. |

P0–P3 are T3-side patch-series work; the bridge is unchanged until P4. P4 needs a provider
extension build and a new qualification tuple. P5 is independent and should not block P0–P4.

## 12. Non-goals

- A thread per machine as the primary mechanism.
- Migrating the provider session per action.
- A distributed filesystem or atomic cross-machine transactions.
- Implicit file synchronization between targets.
- Model-managed links, credentials, target URLs, or approvals.
- Silent privilege expansion through a peer link.
- Widening the v1 support tuple without its own evidence.

## 13. Open questions

1. Does `ThreadFleet` belong in thread metadata or in a separate target service keyed by thread?
2. What is the reverse-approval contract, and which providers can surface it without a T3-specific
   tool?
3. How should non-git target workspaces be identified: explicit path only, or a repository marker?
4. Is the peer `/mcp` transport sufficient for high-frequency shell calls, or does `peer-exec-v1`
   need a streaming RPC beside it?
5. Can CoS mount a per-session MCP connector without exposing it to unrelated chats?
6. Do fleet threads disable native shell by default, or keep it local and rely on prompt policy?
7. At what machine count does the gateway/executor-daemon model replace peer links?

## References

- `src/compatibility.ts` — pinned T3/CoS tuple and provider features.
- `src/acp/index.ts` — ACP session lifecycle; `additionalDirectories` rejection; no MCP forwarding.
- `test/acp-phase3.test.ts` — “accepts but does not forward T3-injected MCP metadata”.
- `packages/contracts/src/environment.ts` (T3) — `ScopedThreadRef`, environment capabilities.
- `packages/provider-acp/src/server/adapter.ts` (T3) — `mcpServers` / `acpMcpServers`, `fs` and
  `terminal` client capabilities.
- `apps/server/src/terminal/Manager.ts` (T3) — thread-scoped, host-local terminals.
- `packages/contracts/src/orchestrationV2.ts` (T3) — thread/run `runtimeMode`; target policy input.
- `scripts/fleet-update.mjs` — existing `home` / `framework` / `server1` release inventory.
- `docs/design/post-v1-workstreams.md`, `docs/plan/post-v1-milestones.md` — post-v1 context.
