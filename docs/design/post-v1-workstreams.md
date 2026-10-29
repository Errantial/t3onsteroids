# Post-v1 workstreams

Status: design note for the four workstreams selected on 2026-10-29. Concurrency is parked at
`supportedConcurrency=2` (see `PLAN.md` and `docs/evidence/post-v1-concurrency-qualification.md`).
Nothing in this note changes a release or capability claim until its own evidence exists.

## Order

1. **Workspace / worktree binding** — the largest daily-use gap. T3 commonly runs a thread in a
   worktree; today the bridge accepts only an exact CoS project root and fails closed otherwise.
2. **Model and reasoning selection** — a prompt-surface identity problem, but it needs controller
   attestation before T3 may claim the choice took effect.
3. **Attachments and slash commands** — bridge prompt-surface work; image/attachment support needs a
   CoS input contract, slash commands can stay a bridge-local allowlist.
4. **Native background work** — the riskiest: it reopens the lifecycle problem the v1
   `backgroundWork=disabled` policy deliberately closed and needs pending-work, cancellation and
   late-completion semantics.

Provider-side changes cost a new extension build id. Per the invalidation graph in `PLAN.md`, that
resets the 2-chat qualification tuple. Batch every provider-side change (workspace, and any model or
attachment contract that needs CoS) into one extension build, then requalify 2 chats once. Items 2-4
must not each force their own requalification.

## 1. Workspace / worktree binding

### Problem

`POST /v1/inputs` accepts `projectId` only. A new chat's workspace is derived from the project
catalog entry, and `getSessionProject()` returns the project root. The bridge's
`resolveProject(cwd)` requires an exact canonical project root; a T3 worktree or subdirectory
returns `project_unmapped`. Adding every worktree as a CoS project is not acceptable: worktrees are
ephemeral, and CoS already has a validated worktree identity model for workers.

### Contract: `provider-session-workspace-v1`

New read route, authenticated and side-effect free:

```text
POST /v1/workspaces/resolve
{ "path": "<absolute T3 cwd>" }
→ {
    "kind": "project" | "worktree",
    "projectId": "<CoS project that supplies grouping/instructions>",
    "projectName": "...",
    "canonicalPath": "<canonical real path of the supplied cwd>",
    "sourceProjectPath": "<canonical root of the project, or the supplied path for kind=project>"
  }
```

Rules:

- The supplied path is resolved through CoS's existing approved-root/canonical-path owner
  (`resolvePath`) and must be an existing directory. It is not re-implemented in the bridge.
- `kind=project` means the path is exactly one catalog project root. Existing v1 behavior.
- `kind=worktree` means the path is a linked Git worktree. Derive the repository identity with the
  existing worktree helper (`git rev-parse --show-toplevel --absolute-git-dir --git-common-dir`),
  take the main repository root from the common Git directory, and require it to match exactly one
  non-ungrouped CoS project. Zero or multiple matches is `workspace_unmapped`, never a guess.
- A plain subdirectory that is not a worktree root is **not** accepted in v1. It has no unambiguous
  project root for instructions and no worktree identity to revalidate. This can be relaxed later
  with an explicit "workspace is a subdirectory of project X" contract.
- Bare repositories, submodules, worktrees whose common directory is not a normal `.git`, and
  paths whose repository identity changes under reparse points fail closed.
- No project catalog, ChatGPT project id, Git remote URL or configuration is exposed.

New-chat admission adds one optional field to `POST /v1/inputs`:

```text
workspacePath?: string   // only with a new chat, providerPolicy.backgroundWork=disabled,
                         // and projectId; revalidated by the controller before admission
```

The controller re-runs the resolver at admission, requires the resolved `projectId` to equal the
supplied `projectId`, and persists the canonical workspace path on the session atomically with
creation. An existing session never changes its workspace.

### Session model

`SessionSummary` gains an immutable, optional workspace:

```text
workspace?: { path: string }   // canonical real path; present only for kind=worktree sessions
```

`getSessionProject(sessionId)` returns the session workspace when present, after re-resolving it
under the current approved roots and proving it is still a directory; otherwise it keeps the
project-root behavior. A workspace that disappeared, moved or left the approved roots is a broken
session (`workspace_changed`), never a fallback to the project root.

The `projectId` remains the ChatGPT Project/grouping identity and supplies the project name.
Instructions, the default tool working directory and prompt headers come from the session
workspace, so a worktree's own `AGENTS.md` and files win. The prompt header should say "working
directory" rather than "selected project directory" when a workspace override is present.

### Bridge changes

- Feature gate: `provider-session-workspace-v1` and the `/v1/workspaces/resolve` route.
- First prompt: try exact project resolve; if it fails, resolve the workspace. A `worktree` result
  is created with `{ projectId, workspacePath, providerPolicy }`. A `project` result keeps the
  existing creation shape.
- Every subsequent prompt and `session/resume`: re-resolve the T3 cwd and require the same
  `projectId` and canonical workspace. Fail `workspace_changed` before any POST.
- Journal adds `workspacePath?` and `workspaceKind` so resume can prove the binding.
- New error categories: `workspace_unmapped`, `workspace_changed`, `workspace_outside_roots`,
  `workspace_project_mismatch`.

### Tests

Controller:

- worktree of a catalog project resolves to that project + the worktree path;
- worktree of an uncatalogued repository, ambiguous main-root match, plain subdirectory, bare repo,
  path outside approved roots, and non-directory all fail closed;
- new-chat admission revalidates and stores the workspace atomically; a mismatched `projectId`
  fails before the outbox row;
- `getSessionProject` returns the workspace for a worktree session and still the root for a normal
  session; a removed/remapped workspace fails rather than falling back;
- prompt building reads the worktree's `AGENTS.md` and names the worktree directory;
- an existing session cannot be given a new workspace.

Bridge:

- exact-root behavior is unchanged when the feature is absent;
- worktree creation sends `projectId` + `workspacePath`; resume with a different cwd or a different
  workspace fails before send;
- no workspace path appears in logs or persisted prompt text.

### Qualification impact

New provider build id, so the 2-chat matrix must be rerun on the final extension build before the
tuple is requalified. Worktree support is not a concurrency claim and does not change
`supportedConcurrency`.

## 2. Model and reasoning selection

Open contract question: ACP 1.9 offers session modes, not a generic model selector. Before widening
the bridge, confirm exactly how pinned T3 communicates a per-thread model/reasoning choice to a
Local ACP provider, and whether it expects an ACP capability or a provider-specific extension. The
controller must attest the exact model/effort on the accepted input; a T3 selection that cannot be
proven must fail `unsupported_model` rather than silently using the CoS default. Do not advertise a
model picker until the attestation exists.

## 3. Attachments and slash commands

- `ResourceLink` already covers in-root local files. Images/captured windows need a CoS input
  attachment contract with the same root and size limits; otherwise keep rejecting them.
- Slash commands stay a bridge-local allowlist. An unmapped command fails `unsupported_command`;
  do not forward arbitrary slash text to ChatGPT.

## 4. Native background work

Reopens the lifecycle boundary closed by `backgroundWork=disabled`. Needs: a durable pending-work
record per provider turn, causal cancellation, isolation between provider turns, and a rule for
late completions after ACP terminal. Without those, a turn cannot settle and the bridge must keep
refusing worker/Goal/Loop creation.

## Execution note

Each slice starts from a clean worktree, changes only its own contract and tests, and records the
new provider build id. Provider changes are batched before the single 2-chat requalification.
