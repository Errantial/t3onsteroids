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
    "kind": "project" | "worktree" | "subdirectory",
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
- `kind=worktree` means the path is inside a linked Git worktree. Derive the repository identity
  with the existing worktree helper (`git rev-parse --show-toplevel --absolute-git-dir
  --git-common-dir`), take the main repository root from the common Git directory, and require it
  to match exactly one non-ungrouped CoS project. The workspace is the supplied path, which may be
  the worktree root or a subdirectory inside it.
- `kind=subdirectory` means the path is inside a catalog project's root (or a linked worktree's
  root) but is not that root. Choose the deepest catalog project whose canonical root contains the
  path; a tie or zero matches is `workspace_unmapped`. Never scan upward for a directory marker or
  infer a project from cwd.
- `canonicalPath` is always the supplied cwd's canonical real path, so tools start where T3 started
  the thread. `sourceProjectPath` is the owning project's root and is what supplies instructions.
- A path that is a Git repository but not a linked worktree of a catalog project (bare repo,
  submodule, uncatalogued main root) fails closed. A path inside a catalog project that is not a
  Git repository resolves as `subdirectory` by ancestor containment.
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
workspace?: { path: string }   // canonical real path; present for worktree/subdirectory sessions
```

The `projectId` remains the ChatGPT Project/grouping identity and supplies the source project root.
Two reads stay explicit:

- `getSessionProject(sessionId)` keeps returning the **source project root**; it supplies
  `AGENTS.md` and the project name, so a subdirectory or worktree still gets the repository's
  instructions.
- `getSessionWorkspace(sessionId)` returns the session workspace when present (after re-resolving
  it under the current approved roots and proving it is still a directory), otherwise the project
  root. Tool defaults and the prompt's working-directory header use this.

A workspace that disappeared, moved or left the approved roots is a broken session
(`workspace_changed`), never a fallback to the project root. The prompt header should name the
workspace as the working directory and the project root as the instruction source.

### Bridge changes

- Feature gate: `provider-session-workspace-v1` and the `/v1/workspaces/resolve` route.
- First prompt: try exact project resolve; if it fails, resolve the workspace. A `worktree` or
  `subdirectory` result is created with `{ projectId, workspacePath, providerPolicy }`. A `project`
  result keeps the existing creation shape.
- Every subsequent prompt and `session/resume`: re-resolve the T3 cwd and require the same
  `projectId` and canonical workspace. Fail `workspace_changed` before any POST.
- Journal adds `workspacePath?` and `workspaceKind` so resume can prove the binding.
- New error categories: `workspace_unmapped`, `workspace_changed`, `workspace_outside_roots`,
  `workspace_project_mismatch`.

### Tests

Controller:

- worktree root and a subdirectory inside a worktree resolve to the owning project + the supplied
  path;
- a plain subdirectory of a project resolves by deepest ancestor containment;
- nested/ambiguous ancestor projects, zero match, bare repo, submodule, path outside approved roots
  and non-directory all fail closed;
- a path that looks like a project subdirectory is never promoted to the project root, and no
  upward marker scan applies;
- new-chat admission revalidates and stores the workspace atomically; a mismatched `projectId`
  fails before the outbox row;
- `getSessionWorkspace` returns the workspace for worktree/subdirectory sessions and the root for a
  normal session; `getSessionProject` still returns the source root; a removed/remapped workspace
  fails rather than falling back;
- prompt building reads the source project's `AGENTS.md` and names the workspace directory;
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

Confirmed against the pinned T3 server build:

- T3 understands two ACP v1 paths. If `session/new` (or resume) returns a legacy `models`
  catalog, it calls `session/set_model`. If the response carries config options, a `model`-category
  select takes precedence and T3 calls `session/set_config_option`; a `thought_level` category
  drives reasoning effort the same way.
- T3 applies the selection before `session/prompt`, and does not put the model in the prompt
  payload.

Controller side (implemented in `5e32b52`):

- `GET /v1/models` (`provider-model-catalog-v1`) publishes the observed ChatGPT catalog:
  `state`, `observedAt`, and `models[]` with `id`, `label`, `efforts`.
- `POST /v1/inputs` accepts `model` and `reasoningEffort` for provider chats. It resolves the model
  against a ready catalog, rejects an unknown model or an effort the model does not offer before
  the outbox, and records the resolved identity on the input. The existing browser model-selection
  path applies it; an unavailable catalog fails `model_catalog_unavailable` rather than guessing.

Bridge side (implemented in `70ce675`):

- `session/new` and resume advertise a `model` select and a `thought_level` select for the selected
  model's efforts, from a cached, read-only `/v1/models` call. A controller without the feature
  exposes no config options.
- `session/set_config_option` validates the id/value, records the choice through a durable
  `select_model` transition, and returns the refreshed options. Every prompt carries the selected
  model and effort.
- Confirmation: the extension applies the requested model/effort through
  `selectModelSettings(input.model, input.reasoningEffort)` and fails the send with
  `content_delivery_model_unconfirmed` when the picker does not confirm. A delivered input therefore
  proves the picker accepted the exact model/effort; no post-drain bridge comparison is needed for
  that claim, and the bridge does not claim a model when the send fails.

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

## Candidate workstream (not selected)

[`fleet-execution-targets.md`](./fleet-execution-targets.md) drafts multi-machine execution targets:
one thread and one provider session, with per-call target routing and bounded fan-out. It is not one
of the four selected workstreams above and does not change the current concurrency or release
tuple. It is recorded separately so the peer-link and native-shell constraints are not
rediscovered later.
