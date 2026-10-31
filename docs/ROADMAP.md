# Roadmap

Status: planning note, 2026-10-31. It records the current release scope and the next slate; it does
not change a support tuple or claim a capability before its evidence exists.

Source for v1.1.7: `docs/design/fleet-execution-targets.md` (commit `605a17f`), integrated as the
v1.1.7 slate. The v1.1.6 work is in progress and is not a prerequisite for reading this plan, but
v1.1.7 implementation starts only after v1.1.6 ships.

## v1.1.6 (current)

1. **Saved threads** — an independent `savedAt` thread state (not settling), a Saved sidebar filter
   with one-click restore, server-side persistence, and `save_thread` / `unsave_thread` /
   `list_saved_threads`.
2. **Instruction files** — global and project `AGENTS.md` / `CLAUDE.md` (and provider equivalents),
   sync groups that materialize generated copies with revision/hash drift detection, and optional
   per-thread role/context files injected into later messages.
   - **Per-environment instruction profiles (v1.1.6):** a project chooses one shared set of
     instruction files for all of its linked environments, or a per-environment selection. The
     profile is `shared` or `per-environment` (`environmentId -> fileIds`); thread optional
     files still layer on top. MCP: `get_project_instruction_profile` /
     `set_project_instruction_profile`, plus optional `environmentId` on sync targets. UI:
     project settings.
3. **MCP feature merge** — port every missing `t3code-mcp-v2` capability into the built-in T3 MCP
   with compatible names/argument shapes, full `offset`/`nextOffset` paging instead of hardcoded
   caps, and tests. Existing `t3code-mcp-v2` services stay running side by side.
4. **One network endpoint** — a single server-1 hub that routes to home, Framework, and server-1 by
   environment id, reporting unreachable machines explicitly. It is an aggregator over the existing
   peer links, not a second routing or credential system.
5. **server-1 version reporting** — fixed: the stale `runtime/service-state.json` active version
   made the v1.1.5 launcher spawn the v1.1.4 runtime; the fleet updater now updates both the unit
   and the state file.
6. **Cross-machine support** — instruction distribution and MCP routing across the three machines,
   without retiring the existing MCP services. Cross-machine **thread placement** within one
   logical project is v1.1.7, with the per-environment roots.

v1.1.6 is not released and no machine is rolled out until Emil approves.

## v1.1.7 — Fleet execution targets

**Goal:** one thread and one provider session on a home environment, with thread-scoped execution
targets. “Which machine” becomes a persisted target plus a tool argument, not a new thread, a new
provider session, or a context replay.

Contracts: `thread-fleet-v1`, `peer-exec-v1`, `fleet-tools-v1`, `provider-mcp-servers-v1`.
Model-facing tools: `t3_targets`, `t3_target_use`, `t3_shell`, `t3_shell_status`,
`t3_shell_cancel`, `t3_fs_read`, `t3_fs_write`, `t3_fs_list`, `t3_fs_stat`, `t3_git`,
`t3_fleet_run`, `t3_copy`.

### Per-environment project roots (v1.1.7)

A project may optionally map `environmentId` to a workspace root:
`Project.environmentRoots: Record<EnvironmentId, string>`. A missing mapping falls back to the
project default root, but only after the target confirms that path exists and its repository
identity matches the project; otherwise resolution fails `target_workspace_unmapped`. This is the
fleet plan’s canonical-path + repository-identity rule, not a home-path fallback.

- P1 adds the mapping, MCP `get_project_environment_roots` / `set_project_environment_root`, and
  the project settings UI.
- P2 enforces it during `ThreadFleet` target resolution and records the fail-closed evidence.

Per-environment **instruction** selections are separate: they are configuration distribution and
ship in v1.1.6 with the instruction manager.

### Cross-machine project threads (v1.1.7)

A multi-environment project is one logical project. Its threads may be created on, and run on, any
of the project’s environments; each thread is pinned to exactly one environment for its lifetime.
The pinned environment supplies the workspace root (per-environment mapping, then default) and the
instruction profile (per-environment selection, then shared set); thread optional files still
layer on top. The project view and sidebar aggregate all of its threads across environments with a
machine badge. MCP: `create_thread` accepts an optional `environmentId` (default: local or
project-default); `list_threads` / `search_threads` / `get_thread` span the project’s
environments and return `environmentId`. No cross-environment thread migration in v1.1.7; a
thread that must move is a new thread or the plan’s explicit P5 handoff.

This is the complementary half of the fleet plan: the plan keeps one thread on a home environment
and routes actions to execution targets; this keeps one thread per machine but lets one project own
threads on several machines. Both use the same `Project` / `EnvironmentId` /
repository-identity / per-environment root model. Do not add a second project or environment
registry.

P1 adds placement, aggregation, and the create/list/search/get MCP fields; P2 adds the
root/instruction-profile resolution and the fail-closed evidence (`target_workspace_unmapped`).

### Delivery and release fit

| Phase | In v1.1.7? | Scope | Exit evidence |
| --- | --- | --- | --- |
| P0 | **Yes** | `peer-exec-v1` `exec`, `fs.read`, `fs.list`; `t3_shell` and `t3_fs_read` on the caller; local and peer transports. Start by reconciling the peer-link source baseline. | Windows↔Windows and Windows↔Linux (server-1) execute and read; timeout, cancel, unreachable peer, and missing-capability cases. |
| P1 | **Yes** | `ThreadFleet` metadata/events; `t3_targets`, `t3_target_use`; active-target prompt block; target chip and switch event. | Target state survives restart; switching does not restart the provider session; no prompt or tool-body logging. |
| P2 | **Yes, with a documented fallback** | Jobs and PTY; `t3_fs_write`, `t3_git`; workspace/repository resolution; target-scoped approvals; separate `remoteExecution` grant. | Network drop mid-job reconnects by `jobId`; cancel is exact; an unmapped workspace fails closed; policy intersection is tested. If P2 cannot finish, it moves as a unit to v1.1.8 and v1.1.7 ships P0+P1. |
| P3 | No — v1.1.8 | `t3_fleet_run`, `t3_copy`, bounded concurrency, partial results, HEAD/dirty preflight. | Three-target matrix with one failure; one row per target; no all-or-nothing claim; context/output caps measured. |
| P4 | No — v1.1.9 | CoS `provider-mcp-servers-v1`, per-session connector, prompt injection, qualification. | A CoS thread calls `t3_shell` on server-1; native CoS terminal remains local; tool events carry the target; a new tuple is recorded. |
| P5 | Not scheduled | Optional explicit handoff of the provider session to a target. | Turn-boundary move with recorded context-loss behaviour; native target tools work after resume. |

P1 also lands cross-machine project thread placement and aggregation; P2 enforces its
per-environment root and instruction selection.

**v1.1.7 exit gate:** P0+P1 evidence is mandatory. P2’s evidence is required unless it is formally
moved to v1.1.8 before the release branch is cut. P3–P5 must not be claimed by the v1.1.7 notes.

### Non-goals carried forward

No thread per machine as the primary mechanism, no provider-session migration per action, no
distributed filesystem or atomic cross-machine transactions, no implicit file synchronization
between targets, no model-managed links/credentials/URLs/approvals, and no silent privilege
expansion through a peer link.

## Overlaps and decisions

### (a) One routing layer, one credential system

v1.1.6’s server-1 hub must not become a second transport beside the peer links. Build it as an
**aggregator over existing peer links**, using the peer’s authenticated `/mcp`, environment ids,
and link access. Do not add SSH command execution or a parallel token store to the hub. v1.1.6
stays read/orchestrate; the separate `remoteExecution` grant is reserved for the v1.1.7
`peer-exec-v1` surface. If the hub cannot be built on peer links yet, keep v1.1.6 routing read-only
and defer command execution rather than inventing a second route.

### (b) Source-drift caveat

The Fleet plan says the shipped `0.1.5-v1.1.5` build carries the peer-link contract while the local
checkout `0737827` does not. The maintained fork used for v1.1.5 (`d43ad80`) **does** contain
`packages/contracts/src/peerLink.ts`, so the drift is specific to that other checkout. P0 still
starts with a source-baseline check: reconcile `0737827`/the patch series with the maintained fork
that carries the contract, and add a conformance test that a peer can be linked and seen before
`peer-exec-v1` is implemented. Do not implement `peer-exec-v1` against a checkout that cannot see a
peer.

### (c) Instruction sync vs "no implicit file synchronization between targets"

The instruction manager distributes **harness configuration** (global `AGENTS.md`/`CLAUDE.md` and
explicit per-project assignments) from a revisioned hub. That is not execution-target workspace
synchronization: it is explicit, opt-in, hash-checked, and never triggered by a model tool or by a
fleet run. Keep instruction files outside target worktrees, keep the transport separate from
`peer-exec-v1`, and describe it as “instruction distribution”, not file sync, in user-facing text.
“No implicit file synchronization” remains true for target workspaces and job execution.

### (d) “Fleet” naming

`scripts/fleet-update.mjs` is the **release installer inventory** (`home`, `framework`, `server1`).
The Fleet plan’s “fleet” is the **runtime execution target set**. Keep the installer names; use
“execution targets” / “target fleet” and `t3_targets` for runtime code. Rename the v1.1.6
instruction mirror to `scripts/fleet-config-sync.mjs` (or `instructions-sync.mjs`) so “fleet”
continues to mean release operations in scripts. Do not add a runtime `fleet-*` script; use
`targets-*` or `peer-exec-*`.

### (e) Per-environment roots and instruction profiles

The two requests split at the transport boundary. Instruction profiles are **configuration** and
belong to the v1.1.6 instruction manager: the hub already carries project/file assignments, and
environment ids are stable, so `shared` vs `per-environment` is a store/UI/MCP change with no
runtime-execution dependency. Per-environment roots are **execution** metadata: they only matter
when a thread can act on another environment, so they land in v1.1.7 P1/P2 with `ThreadFleet` and
the fleet workspace resolver.

Rules:

- A project has a default root (today’s `workspaceRoot`) and an optional
  `environmentRoots[environmentId]`.
- Resolution prefers the environment mapping; if absent, it tries the project default. It accepts
  either only when the path exists on that environment and the repository identity matches;
  otherwise `target_workspace_unmapped`. This keeps Emil’s fallback without silently using the
  home path.
- Instruction profiles: `mode: shared | per-environment`; shared uses one file set for every
  linked environment, per-environment maps `environmentId -> fileIds`. Thread optional files layer
  on top in both modes. The store materializes only the assignment for the machine being served.
- MCP names stay consistent: `get_project_instruction_profile` /
  `set_project_instruction_profile` for v1.1.6; `get_project_environment_roots` /
  `set_project_environment_root` for v1.1.7. Both are optional additions and do not change
  existing tool shapes.

### (f) Project thread placement vs fleet execution targets

The v1.1.6 server-1 hub is **transport**; v1.1.7 project thread placement is **orchestration**. A
project thread is pinned to exactly one environment and runs there; it is not a thread on a home
environment with remote execution targets. Both features share environment ids, project identity,
repository identity, and the per-environment root/instruction model, so they must not grow separate
registries or credential paths. The fleet plan’s “one conversation on a home environment” remains
true for fleet threads; this request covers ordinary project threads created on another machine.

### Additional overlap: MCP tool names and routing

The v1.1.6 merge must expose the `t3code-mcp-v2` names and argument shapes (`list_threads`,
`get_message`, `wait_for_turn`, `pending_actions`, etc.) alongside the built-in `t3_*` tools.
Fleet tools are additive and capability-gated. Where a ported tool gains an `environmentId`, keep
it optional and default to the local environment so existing connectors keep working.

## References

- `docs/design/fleet-execution-targets.md` — full architecture, P0–P5, open questions.
- `docs/design/post-v1-workstreams.md` — candidate workstream context.
- `docs/releases/v1.1.6-mcp-inventory.md` — v1.1.6 MCP gap list (to be added with the v1.1.6
  branch).
