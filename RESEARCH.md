# T3 Code ↔ Chat On Steroids Compatibility Research

Status: historical research/conformance record. Its conclusions were incorporated into `PLAN.md`, which is now the authoritative implementation/release roadmap. A live T3 Local ACP spike succeeded and the exact CoS `v2.1.39` stock controller suite passed 136/136 targeted tests. Some early-baseline statements below intentionally describe the repository before implementation began and are not current repository-status claims.

## Goal

Define the unknowns that must be answered before a comprehensive implementation plan can be written for making T3 Code compatible with Chat On Steroids (CoS). This document separates established facts from design decisions still requiring a product choice.

## Established baseline

- At the start of this research, `/t3onsteroids` was empty and not yet a Git repository. It is now an implemented worktree; see `PLAN.md` and `docs/release-status.md` for current status.
- At the start of this research there was no project-local `AGENTS.md`; the repository now has one.
- This machine has multiple T3 Code builds present. A stable `v0.0.42` runtime exists at `C:\Users\emilg\.t3\runtime\versions\0.0.42\t3.exe`. The `t3` command on PATH reports `v0.0.46-nightly.20261010.2948`, but the **running T3 desktop/server** is newer: `v0.0.46-nightly.20261013.3040`, source tag/SHA `ffb4af8d5d4fcfc5e9322295ff846a6d1e7ffbf8`. Provider conformance must follow the server actually spawning the ACP process, not the older CLI.
- The active T3 nightly is from the Orchestration V2 train. Upstream moved nightly builds to V2 in early October 2026; current provider contracts, replay guidance, capability handling, checkpoints, background-work semantics, and command receipts should therefore be treated as V2 contracts. `v0.0.42` must not be assumed to be the correct first conformance target without an explicit legacy-compatibility decision.
- The T3 CLI describes itself as a server with HTTP/WebSocket transport, project management, local auth, pairing/session bearer support, desktop/web modes, a configurable data directory, and provider sessions rooted at a working directory.
- Public T3 source describes a Node WebSocket server wrapping multiple coding-agent providers. Current nightly/upstream routes provider behavior through Orchestration V2 and `ProviderAdapterV2`; the older unified `ProviderService`/`ProviderRuntimeEvent` facade belongs to the legacy `v0.0.42` lane.
- Chat On Steroids already exposes structured Core/Desktop tool surfaces for filesystem, terminal, browser/desktop control, plans, workers, session lifecycle, and scoped permissions.
- The installed Chat On Steroids desktop app reports version `2.1.39`. Current upstream source documents four relevant integration surfaces: tokenized MCP connectors (Core/Desktop/Plugins), a separately authenticated browser bridge, recorded session/event state, and an **opt-in local control API** intended for trusted local callers.
- The exact installed CoS `v2.1.39` source confirms the local control API is already much closer to a provider controller than the first research pass found. With **Allow actions** enabled it can start a **new chat** or send to an existing chat through an idempotent outbox, expose delivery proof, stop the **exact active turn** by `turnId`, and stream recorded session events over resumable SSE (`Last-Event-ID`/`seq`). Its health response carries protocol/app version and the routes/actions this build supports.
- T3's internal `@t3tools/contracts`, `@t3tools/provider-core`, and `@t3tools/provider-testing` packages are not published on npm. A standalone project cannot assume it can consume those packages as ordinary external dependencies.
- The official `@agentclientprotocol/sdk` TypeScript package is public. Stable ACP v1 is supported normally; ACP v2 is explicitly experimental/draft and may change incompatibly. Current T3 V2 prefers ACP v2 when available but negotiates ACP v1; legacy `v0.0.42` initializes ACP v1.

## Questions that must be answered before implementation planning

### 1. Product scope and compatibility target

1. What does “T3 code compatibility with Chat On Steroids” mean from a user-visible perspective?
   - A new T3 provider that runs CoS sessions?
   - A bridge letting T3 clients control an existing CoS session?
   - A CoS-side adapter that understands T3 provider/session protocol?
   - Bidirectional interoperability?
2. Which T3 versions must be supported initially? The authoritative local target is the running Orchestration V2 desktop/server (`0.0.46-nightly.20261013.3040`, `ffb4af8…`); the older PATH CLI is a separate tooling lane. Is legacy `v0.0.42` compatibility actually required, or should the first contract target be this exact V2 server plus a later stable lane?
3. Which CoS host/runtime versions are in scope, and is compatibility expected across ChatGPT, Claude, Codex, or only the current CoS host?
4. Is the project intended to remain a standalone adapter/service, become a fork/patch of T3, become a CoS plugin, or combine these?
5. What is explicitly out of scope for the first usable release?

### 2. Provider and session model

6. What is the exact T3 provider adapter contract for session start, send turn, interrupt, stop, user-input requests, approvals, feedback, compaction, checkpoints, and event streaming?
7. Which of those operations have exact CoS equivalents today?
8. How should a T3 `thread`, `provider session`, and `turn` map to CoS chat/session/request identities?
9. Does one T3 thread bind to one persistent CoS chat, or can attempts/retries create new CoS sessions?
10. How are reconnects handled without duplicating an in-flight turn or losing an approval/input request?
11. What state must survive process restart on each side?

### 3. Message and event translation

12. What canonical event types does T3 require from providers, including text deltas, reasoning/status, tool calls/results, plans, file changes, approvals, errors, and completion?
13. Which CoS events are directly observable, and which require synthesis from tool responses or lifecycle state?
14. How should partial/streamed assistant text be forwarded and deduplicated?
15. How are tool invocations represented in T3, especially calls that are composed through CoS `exec`?
16. How should nested workers/subagents appear in T3: as tool events, child sessions, activities, or hidden implementation detail?
17. How should progress/commentary messages map into the T3 timeline?
18. How should user steering during an active turn map across both systems?

### 4. Tools and capability exposure

19. Should T3 see CoS as one opaque provider, or should individual CoS tools/capabilities be surfaced to T3?
20. If tool metadata is surfaced, what schema translates CoS tool names, descriptions, JSON arguments, and result content into T3's provider contracts?
21. How are binary/image/file outputs represented?
22. How are large/truncated tool results represented so T3 can distinguish truncation from provider failure?
23. How do CoS-specific tools such as `update_plan`, `agents`, `session_finish`, browser/desktop control, and plugin connectors appear in T3?
24. Does the first release need Desktop/browser control compatibility, or only Core filesystem/terminal operations?

### 5. Permissions, authorization, and identity

25. Which system is authoritative for permission decisions?
26. How are CoS approved roots and per-operation guards represented to T3?
27. Can a T3 user grant a permission that CoS has not granted, or must the bridge always fail closed to CoS authority?
28. How are destructive/irreversible actions distinguished from ordinary reversible tool calls?
29. How are request/session identities propagated for auditability and replay protection?
30. What authentication is required between T3 and the bridge: loopback trust, bearer token, T3 pairing/session token, an additional bridge secret, or a combination?
31. What secrets must never be logged or persisted?

### 6. Cancellation, concurrency, and lifecycle

32. What does T3 `interruptTurn` mean when CoS has a currently running shell process, worker, browser action, or long tool call?
33. Can CoS cancel all underlying work reliably, or are some operations only cancellable between calls?
34. How are late tool results handled after a T3 cancellation?
35. How many concurrent T3 turns/sessions should the bridge allow?
36. Can one CoS session safely service multiple T3 threads concurrently?
37. What backpressure behavior is needed for streaming events and slow T3 clients?
38. What are the timeout semantics for session start, tool calls, idle sessions, and reconnects?

### 7. Filesystem and workspace semantics

39. How should a T3 project path map to CoS approved roots/workspaces?
40. Can the bridge operate on arbitrary T3 project paths, or only paths already approved in CoS?
41. How should Windows/native paths and T3 cross-platform project paths be normalized?
42. How are worktrees, symlinks/junctions, and path traversal treated?
43. Which side owns repository initialization, worktree creation, and Git actions?
44. Are CoS project associations persistent or per-session?

### 8. Plans, workers, approvals, and interactive requests

45. Does T3 have native UI concepts that can faithfully render CoS plans and worker status?
46. How should worker spawn/message/status/finish map into T3 activities?
47. How should an approval or clarification requested by CoS be represented so T3 can collect and route the answer back to the exact pending request?
48. How are multiple simultaneous pending inputs disambiguated?
49. Does a T3 turn remain “running” while waiting for user approval/input?

### 9. Error model and recovery

50. What T3 error categories exist for provider unavailable, invalid request, startup failure, interrupted turn, tool failure, auth failure, and transport failure?
51. How should CoS-specific failures such as stale session IDs, output-limit errors, permission blocks, and unavailable roots map into those categories?
52. Which errors are retryable, and who owns retry policy?
53. How is idempotency guaranteed for retried T3 RPCs or reconnect replay?
54. What diagnostic detail is safe to expose to users versus logs?

### 10. Transport and deployment

55. Should the compatibility component run inside the T3 server process, beside it as a local service, or inside CoS?
56. Which protocol is best at the boundary: direct T3 provider adapter calls, WebSocket RPC, stdio/ACP/MCP-style transport, or another local IPC layer?
57. Does the bridge need to support remote T3 clients through Tailscale/headless mode?
58. If remote access is supported, which CoS operations must be disabled or additionally confirmed?
59. How are bridge and T3 versions negotiated?
60. How is availability/health reported to T3?

### 11. Packaging and developer setup

61. What implementation language/runtime best fits both ecosystems and the intended distribution model?
62. Does this project need Node/Bun/TypeScript to reuse T3 contracts directly?
63. Can the bridge import T3 packages/contracts, or must it avoid depending on unstable internal packages?
64. How will Windows be supported first, and which macOS/Linux behavior must be designed from day one?
65. What minimum local dependencies are acceptable for users?
66. How will installation discover T3 and CoS endpoints/configuration?

### 12. Testing and compatibility gates

67. What is the smallest conformance suite that proves a T3 client can drive a CoS-backed provider correctly?
68. Which behaviors require real CoS integration tests versus protocol fakes?
69. Which T3 provider contract tests can be reused directly from upstream?
70. What golden fixtures are needed for streaming, tool calls, cancellation, approvals, reconnect, retry, and restart recovery?
71. What version matrix must CI cover?
72. What failure injection is required: dropped WS, duplicate requests, delayed tool results, provider restart, permission denial, output truncation?
73. What are the release acceptance criteria for “compatible”?

### 13. Observability, privacy, and data retention

74. What events/metrics are needed to debug protocol mismatches without logging user code, prompts, secrets, or tool payloads?
75. Which identifiers can be logged safely?
76. Does the bridge persist transcripts/events, or rely on T3/CoS persistence?
77. What retention and deletion semantics apply to bridge-owned state?
78. How are crash reports scrubbed?

### 14. Upstream strategy and maintenance

79. Is upstream contribution to T3 desired, or should this stay external?
80. Which T3 contracts are stable enough to depend on, and which need a compatibility shim/version adapter?
81. How will upstream T3 releases be detected and tested for breaking changes?
82. Does CoS expose a stable plugin/connector SDK suitable for this, or must the first implementation use the currently exposed host tool contract?
83. What semver/versioning policy should this project adopt?
84. Who owns backward compatibility when either side changes?

### 15. Follow-up questions exposed by the review

85. Can the existing CoS **local control API protocol 1** be adopted directly as the supported bridge boundary? It is sufficient for a conformance spike and supplies durable create/send/stop/SSE/idempotency semantics, but it is **not sufficient for production transcript fidelity**: projected messages are capped at 4,000 characters and tool arguments/results at 2,000 characters. A production-quality integration therefore needs a narrow full-fidelity controller extension or content/chunk retrieval route unless T3 explicitly accepts lossy provider history.
86. How should a T3 provider session bind to CoS's existing new-chat primitive? One T3 provider thread should map one-to-one to one CoS prime session/chat. `POST /v1/inputs` without `sessionId` creates a new CoS session under the caller-supplied input UUID, making deterministic binding possible. The remaining gap is workspace resolution: T3 supplies exact `cwd` to ACP, while protocol 1 accepts only a CoS `projectId`. Production should add a narrow authenticated **exact canonical path → projectId** resolver. V1 supports only an exact CoS project-root cwd; arbitrary T3 worktrees/subdirectories require a later durable CoS session-workspace primitive.
87. Is CoS `POST /v1/sessions/{id}/stop` sufficient for T3 interrupt semantics? It targets the exact `activeTurnId`, refuses a late stop that would hit a newer turn, and `turn_end` is the proof of completion. The spike must verify bounded behavior for Stop-before-acceptance, Stop-during-tool work, transport loss, and a stop that returns while underlying tool side effects are still settling.
88. Is CoS's **existing SSE event stream** sufficient for the ACP event source? Transport-wise, yes: it resumes by `Last-Event-ID`, replays recorded events, and has explicit termination reasons. Semantically, protocol 1 is adequate for turn/message/error/final tool summaries but is lossy for long content and does not expose every intermediate tool/approval phase. V1 should therefore advertise only the lifecycle it can prove and use the controller extension for full content before claiming production transcript parity.
89. How are ChatGPT model, reasoning effort, account/workspace, and selected conversation verified for the **exact accepted input** rather than read later from mutable session state?
90. What should happen when the companion/browser is disconnected, ChatGPT displays a native modal/rate-limit warning, or model discovery is unavailable? CoS `/v1/status`, live session state and `chat_error` events expose part of this truth; the bridge still needs a deterministic error/terminal mapping that distinguishes provider restriction, temporary browser recovery, transport loss and an already-accepted turn.
91. Is browser-driven ChatGPT automation an acceptable supported dependency for this project? CoS explicitly documents that the companion automates ChatGPT's browser UI and that this is not a public ChatGPT automation API, so supportability and provider-policy risk must be treated as a product constraint.
92. Which CoS release line is the compatibility target? The installed binary is `2.1.39`, and the exact public tag is `v2.1.39` / git commit `87ae9d631f82d8da2f462d910410031ad8f97ac5`, with control API protocol `1`. Use that exact tag for the first conformance lane; treat later `main` separately.
93. If ACP is the T3-facing boundary, does v1 cover the minimum release or are v2-only features required? Because ACP v2 is a draft, the bridge should either support v1 plus capability-gated v2 or pin an exact experimental SDK/protocol version.
94. If a native T3 provider becomes necessary, where does it live? The T3 provider/core/contracts packages are workspace-internal rather than npm dependencies, so a native adapter implies an upstream T3 contribution/fork/worktree or an explicitly maintained source-level patch.
95. How is the **effective capability set** represented for v1? The bridge advertises only protocol/lifecycle capabilities it implements and does **not** translate T3 runtime modes into CoS host-tool permissions. CoS's live configuration remains authoritative for Core/Desktop/browser/plugin power. The one additional v1 enforcement is a CoS-owned provider-session policy that disables background workers/Goal/Loop/continuations so terminal semantics stay bounded.
96. Are CoS shell children actually OS-confined to approved roots? Approved-root checks constrain CoS filesystem tool admission, but command execution normally runs with the logged-in user's OS privileges; file-tool scope and shell authority must not be conflated.
97. How are background workers/Goal/Loop/continuations represented when work outlives the root provider turn? V1 avoids that unsupported lifecycle entirely: bridge-created CoS sessions carry an enforced `backgroundWork=disabled` provider policy, and the bridge settles success only after prime `turn_end` plus verification that the policy is still in force. Native background/subagent continuation semantics are deferred until the bridge can project and cancel them causally.
98. Which side owns usage/context/cost truth? T3 can render provider usage and context state; CoS derives some state from ChatGPT/browser observations. The bridge needs a source-of-truth rule and an `unknown` state when observations are unavailable.
99. How are T3 MCP tools injected into a CoS-backed session, if at all? T3 expects provider integrations to make thread-scoped T3 tools available where supported, while CoS already publishes its own MCP tool surfaces to ChatGPT. Avoid recursive/duplicate MCP routing and permission ambiguity.
100. What is the bridge's threat model for a malicious local process, malicious webpage, untrusted repository content, stale/replayed protocol frame, remote T3 user, or overbroad external plugin?
101. Which exact **T3 Orchestration V2 capabilities** will the bridge advertise? Current V2 distinguishes multiple provider threads per session, model/runtime switching, handoff, interrupt, active steering, interrupt-restart steering, queued messages, MCP/dynamic callbacks, approval classes, structured questions, subagents, checkpoint scopes, and other provider behaviors. Unsupported capabilities must remain false rather than be approximated.
102. What session topology will CoS support: exactly one provider thread per session, multiple T3 threads mapped into one CoS session, or one CoS conversation per T3 provider thread? This determines isolation, event fanout, restart policy, and background-work ownership.
103. How should **persisted entity events** be separated from **ephemeral stream deltas**? Current T3 V2 uses provider/session/thread/turn/node/message/item/request/plan updates plus a terminal turn event, while newer HEAD also includes non-persisted command-output deltas. The bridge must not make correctness depend on an ephemeral chunk.
104. What exact terminal state/disposition maps from CoS to T3 `turn.terminal`, including whether the provider thread/session is reusable or broken after cancellation, transport loss, or a partial side effect?
105. Which history/resume semantics are required? T3 may resume provider-native history or inject portable history; CoS must define whether replayed T3 history is authoritative, additive, or disallowed for an already-bound ChatGPT conversation.
106. Which rollback/fork/checkpoint behaviors are in scope? T3 V2 supports provider/checkpoint transitions beyond simple resume; the bridge must explicitly decline capabilities it cannot implement safely.
107. What full identifier set is needed for diagnostics and stale-result rejection? Current V2 may involve T3 thread, provider session, provider thread, provider turn, run, run attempt, node, message, runtime request, and turn-item IDs in addition to CoS chat/session/input/request/generation/worker identities.
108. How will installed-nightly compatibility be separated from current-upstream compatibility? The installed nightly and current HEAD already differ in provider behaviors such as ephemeral command-output deltas and background task/subagent stop semantics, so the project needs SHA-pinned lanes rather than a generic “V2” target.
109. What exact controller extension carries **full provider content**? Protocol 1 caps projected messages at 4,000 characters and tool args/results at 2,000. V1 needs only full-length **assistant message** text after the controller's existing credential-redaction transform. Keep raw tool args/results behind the existing capped/sanitized projection; do not broaden that sensitive surface merely for parity.
110. How does the bridge map T3's exact `cwd` to a CoS project? CoS already owns a validated project catalog and path identity rules, while protocol 1 accepts only `projectId`. Prefer a narrow authenticated `resolve this exact canonical path -> projectId` controller route rather than exporting the whole catalog or maintaining a duplicate bridge mapping. Because CoS's durable prime workspace derives from `projectId`, v1 supports exact CoS project-root cwd only; arbitrary T3 worktrees/subdirectories require a later explicit CoS session-workspace primitive.
111. When is the actual CoS chat created? Live T3 provider validation invokes `session/new` for disposable probes, so ACP `session/new` must allocate only bridge-local state. Defer `POST /v1/inputs` without `sessionId` until the first real `session/prompt`; otherwise adding/checking a provider opens stray browser chats.
112. What restart contract does the ACP agent advertise? T3 will eagerly activate a persisted native session with `session/load` or `session/resume` when advertised. Support `session/resume` first. Generate the ACP session id as a lowercase UUID and reuse that same UUID as the first CoS input/session id, eliminating an unnecessary opaque id map; add `session/load` only if replaying full prior history is both useful and correct.
113. What capability profile is enforceable without changing CoS? Protocol 1 has no per-session capability override and controller status does not prove the entire live tool-permission set. V1 therefore makes no claim that T3 permission modes govern CoS tools. It is same-user/local-control only under the user's current CoS permissions; remote T3 control waits for a real CoS per-provider/session policy mechanism.
114. What is the safe initial concurrency? CoS protocol 1 permits at most four SSE streams globally, heavy journal reads at most two concurrently, actions are serialized with at most four pending, and action rate is 30/minute. V1 admits one active T3→CoS turn per stable same-user CoS profile/controller identity and rejects a concurrent second turn before any CoS POST with retryable `input_busy`; because T3 can spawn multiple ACP processes, this requires a same-user cross-process admission lease with crash reconciliation. Ephemeral endpoint/port/PID/token rotation does not create a new admission domain.
115. How should SSE connections scale? One stream per active CoS chat is simple but hits the four-stream global cap quickly. V1 should stream only active turns, close streams promptly at terminal events, and use paged reads/cursors for idle resume. A future controller extension can add multiplexing only if measurements justify it.
116. Is model/reasoning selection required for v1? Protocol-1 external sends set both to `null`, meaning CoS/browser defaults win. Do not surface a T3 model selector until the controller can bind the selected model/reasoning choice to the exact admitted input and prove it at delivery time.
117. Are T3-native approvals/questions in v1? The controller projection records tool outcomes but does not currently provide a pre-effect external approval bridge. Treat approvals/questions as unsupported T3 provider capabilities until CoS exposes a causally bound request/response route; rely on CoS's own approval UI in the meantime.
118. How is Compact & Resume represented? A CoS session can migrate to a replacement ChatGPT conversation while preserving its recorded session identity. The bridge should bind to the CoS **session id**, follow `handoff`/live job state, and never bind permanently to a mutable ChatGPT `conversationId`.
119. Which T3 executable is allowed to mutate test state? The running server is newer than the PATH CLI and the older CLI reported migration divergence. Use the running UI/server or an exact-matching CLI in automated fixtures; version-check before any state mutation.
120. How is the ACP command packaged on Windows? T3 spawns Local ACP with `shell:false` and rejects `.cmd`/`.bat` wrappers. Development should configure the real `node.exe` plus a script argument; release packaging should provide a real executable/launcher and keep startup side-effect free because T3 may spawn it for validation probes.
121. How is cancellation intent recovered across a bridge crash? Persist the cancellation intent and exact pending input/active CoS turn id **before** calling controller cancel/Stop. On restart reconcile only that saved identity; never redirect a stale cancel to a newer turn or forget a user Stop because the ACP process died mid-request.
122. What workspace does ACP resume authorize? `session/resume` carries `cwd`, `additionalDirectories` and MCP metadata. V1 requires canonical resume cwd to equal the persisted project root and rejects nonempty `additionalDirectories`; otherwise resume could silently widen or move workspace authority.
123. Is first-prompt project validation enough? No. Re-resolve the exact canonical cwd before every prompt and require the same CoS project/root identity. Root removal, junction/reparse replacement or project-catalog remapping must fail before send rather than redirect a bound session.
124. How is the one-turn concurrency ceiling enforced across T3 processes? Distinct T3 provider sessions can spawn distinct Local ACP processes, so v1 needs a same-user cross-process lease keyed to a **stable CoS profile/controller identity** (for example the canonical user-data/control-api directory), not to ephemeral host:port/PID/token values. A dead PID or CoS restart does not release it by itself because the CoS turn may still be running; stale-owner recovery first reconciles the saved session/input/turn and cancellation intent.
125. Does T3 send the raw user prompt to Local ACP? **No.** Live capture on the running server and exact `ffb4af8…` source show that first/mode-change prompts can be wrapped in `<t3_code_instructions>` with collaborative-browser/orchestration guidance whenever T3 MCP is present, and a separate `runtime_info` / PR-linking text block is appended on every prompt. Same-mode subsequent prompts are raw apart from that runtime block; leading slash commands bypass the wrapper. Because v1 does not forward T3 MCP into CoS, the bridge needs a fail-closed SHA-pinned prompt normalizer (or a future upstream T3 suppression option) rather than forwarding these blocks verbatim.
126. What input/content types can CoS protocol 1 accept? `POST /v1/inputs` is text-only and rejects `images`/`attachments` fields; text is capped at 64,000 JavaScript string characters. ACP baseline nevertheless requires agents to support `Text` and `ResourceLink` prompt blocks, while image/audio/embedded-resource variants are capability-gated. V1 should therefore support `ResourceLink` only for safe local `file:` URIs that canonicalize inside the exact bound project root and translate them into an escaped validated-path reference in the CoS text. It advertises no image/audio/embedded-resource capability, rejects T3 attachment/captured-window augmentation and unsupported slash commands, and rejects the final normalized text over 64,000 **before** journaling/send rather than truncating.
127. How is T3 interaction mode preserved across an ACP child restart? T3's ACP adapter emits the default/plan wrapper only on first prompt or a mode transition and keeps that transition state on the T3 side. A restarted bridge can therefore receive a raw same-mode prompt. Persist the bridge's normalized `default|plan` state with the bound session, restore it on resume, and apply bridge-owned read-only Plan guidance on every prompt while durable state is `plan`; do not rely on seeing another T3 transition wrapper after restart.

## Research findings so far

### T3 Code architecture

T3 has two materially different provider architecture generations relevant to this machine. Legacy `v0.0.42` uses the older `ProviderService`/`ProviderAdapter` facade and a `ProviderRuntimeEvent` stream. Both the older PATH CLI build (`v0.0.46-nightly.20261010.2948`, `4f63275…`) and the **running** desktop/server (`v0.0.46-nightly.20261013.3040`, `ffb4af8…`) use **Orchestration V2** and `ProviderAdapterV2`: the adapter exposes capabilities/selection transition/session opening, and the returned session runtime owns provider-thread creation/resume, turn start/steer/interrupt, runtime-request responses, snapshots, rollback/fork and related lifecycle work.

The exact source identities matter. The reviewed `v0.0.42` tag is `719a76ca1dbf5490f1aa33ffb9966301e02be9a9`; the older PATH CLI build corresponds to `4f63275ac7885281d245022e65f1e9e8816b1382`; the running desktop/server corresponds to `ffb4af8d5d4fcfc5e9322295ff846a6d1e7ffbf8`; and the upstream HEAD reviewed during this research was `67bca6c224b3caf61dc7824f6487d754bcad8f8c` on October 16, 2026. Architecture claims and fixtures must therefore always identify the exact server build they exercised.

V2's event vocabulary is also different from legacy `ProviderRuntimeEvent`. Current adapter output is organized around entity updates such as provider session/thread/turn, node, subagent, message, turn item, runtime request, and plan updates plus an explicit terminal turn event. Current HEAD also adds an ephemeral `command_output.delta` path whose final output still belongs in persisted turn-item state. A new integration must target these V2 semantics and must not design its durable state around the legacy event names.

The T3 CLI confirms the server can run in desktop or web mode, bind a configurable HTTP/WebSocket endpoint, use a configurable data directory, auto-bootstrap projects from a working directory, and expose pairing/bearer-session auth for headless deployments.

### Chat On Steroids integration surface

The active CoS Core contract provides structured filesystem reads/patches, shell execution and continuation, task plans, worker agents, session lifecycle, and JavaScript composition of tool calls. The host also enforces approved roots and live per-operation guards. CoS Desktop adds browser and native Windows control with explicit tab/page/window identities and an observe-before-act model.

This means an adapter should treat CoS as a stateful execution host with permissions and session identity, rather than as a stateless shell wrapper. Cancellation, output truncation, worker lifecycle, approvals, and permission failures need first-class protocol mappings.

### Two distinct interoperability directions already exist

T3 exposes an OAuth-protected HTTP MCP endpoint for outside agents, including ChatGPT-style clients, to inspect and optionally control T3 projects/threads. Separately, T3 supports adding new providers through ACP when the agent implements ACP, or through a native provider adapter when ACP is not available. These are different products:

- **CoS controls T3**: likely an MCP/client integration problem with comparatively little T3-side code.
- **T3 runs CoS as a coding provider**: a provider integration problem requiring lifecycle/event/cancellation/tool semantics to map cleanly.
- **Bidirectional compatibility**: both paths plus shared identity/auth/state rules.

The final plan locks the first direction to **T3 runs CoS as a coding provider**. CoS→T3 through T3's outside-agent MCP surface remains an independent later capability.

## Likely architectural direction (revised)

The strongest architecture is a **standalone local ACP agent command in this project that talks to CoS's authenticated local control API**, with a deliberately small CoS controller extension for production fidelity. The existing protocol-1 API remains the control/idempotency base; it should not be replaced by a second session owner.

The reasons are concrete:

- T3 already supports arbitrary **Local ACP command** providers and keeps the provider behind its generic adapter/capability boundary.
- The official TypeScript ACP SDK is a public dependency, while T3's `@t3tools/contracts`, `@t3tools/provider-core`, and `@t3tools/provider-testing` packages are workspace-internal and are not available from npm.
- Exact CoS `v2.1.39` already exposes the core control primitives: start a new chat, send idempotently, inspect delivery proof, stream recorded events over SSE, read live turn identity/status, stop the exact active turn, and discover health/protocol/action capabilities.
- Those routes reuse CoS's authoritative session/outbox/Stop owners, so the bridge gets existing ambiguous-delivery and stale-turn protections instead of recreating them. The final validation proved three production gaps that justify a narrow controller extension: protocol-1 event text is deliberately capped, the controller cannot map a T3 cwd to the corresponding CoS project id, and root `turn_end` alone is not a safe terminal boundary while CoS workers/Goal/Loop can outlive the prime answer. V1 therefore also needs an enforceable provider-session `backgroundWork=disabled` policy/attestation.

ACP v1 should be treated as the stable protocol floor. ACP v2 can be capability-gated behind an exact SDK/protocol pin because the official SDK labels v2 experimental and incompatible changes are still possible. If the **existing CoS protocol-1 controller + ACP** pair cannot represent a required behavior honestly, first determine whether a narrow CoS controller addition solves it; only then consider a native T3 provider package inside an upstream/forked T3 source tree.

## Answered questions and planning implications

The research phase established several answers strongly enough that the implementation plan should treat them as constraints rather than open speculation.

### Compatibility direction is a product choice with two different technical paths

T3 already has an outside-agent integration surface: an OAuth-protected HTTP MCP endpoint at `/mcp`. Public T3 documentation explicitly positions this for outside agents, including ChatGPT-style clients. That path can expose T3 projects/threads/providers/models and, subject to granted authority, create or message threads and stop work. If the intended goal is **CoS controlling T3**, the project should begin by validating and packaging that MCP integration rather than inventing a new T3 provider protocol.

Making **T3 run CoS as a provider** is materially different. T3's provider architecture expects a provider process or adapter that can start/resume sessions, accept turns, emit normalized runtime events, answer interactive requests, stop/interrupt work, and survive reconnection/restart semantics. T3's own provider guidance says ACP should be preferred for agents that can implement it, with a native provider adapter used when ACP cannot faithfully represent the provider.

Therefore the implementation plan cannot collapse both directions into one feature. It must select CoS→T3, T3→CoS, or an explicitly phased bidirectional scope.

### T3 version targeting must be deliberate

The machine contains an older `v0.0.42` runtime and a PATH CLI reporting `v0.0.46-nightly.20261010.2948`, but the running desktop/server that actually launches providers is `v0.0.46-nightly.20261013.3040` / `ffb4af8d5d4fcfc5e9322295ff846a6d1e7ffbf8`. Current upstream has moved beyond that again. These are separate compatibility targets.

Early development should pin the **running server** SHA `ffb4af8…`. The older `20261010.2948` CLI produced a migration-divergence warning when used against the newer desktop data store, so development scripts must not assume an older CLI is safe for state mutation. `v0.0.42` remains an optional legacy lane.

### Current T3 is organized around an Orchestration V2 provider boundary

The installed nightly/current architecture uses `ProviderAdapterV2` plus an orchestration layer that persists normalized entity events, projections, command receipts and effect/outbox state. Provider-specific session runtimes translate native provider behavior into that model. The older `ProviderService`/`ProviderRuntimeEvent` facade is relevant only to a separate legacy `v0.0.42` compatibility lane.

This still strongly favors integrating at the provider boundary rather than altering T3's client/WebSocket protocol. The UI and remote clients should continue receiving ordinary T3 V2 state regardless of whether the backing provider is Codex, Claude, ACP, or CoS. For an external project, Local ACP is the cleanest boundary because it lets T3's existing ACP adapter perform the V2 translation.

### ACP is the first interoperability protocol to evaluate for T3→CoS

T3's documented rule is to use the generic ACP integration for ACP-capable agents, preferring ACP v2 with v1 fallback, before implementing a native provider adapter. A native `ProviderAdapterV2` is warranted only when ACP cannot represent required behavior. T3's own adding-a-provider guide explicitly requires capabilities to be truthful, provider-native option IDs to survive unchanged, replay fixtures for supported scenarios, and provider-specific behavior to stay at the adapter boundary.

The follow-up research found a much stronger CoS seam than the first pass recorded, and the exact installed release closed three previously assumed gaps. CoS `v2.1.39` has an **opt-in local control API protocol 1** with a per-launch bearer token, Host and Origin checks, bounded/rate-limited actions, health/status projections, session/event/input/agent/log reads, **new-chat creation**, resumable **SSE event streaming**, idempotent send/delivery proof, and **exact-turn Stop**. The provider bridge should consume this existing API first and treat changes to CoS as evidence-driven exceptions.

The remaining controller gaps are now concrete. The send action does not expose model/reasoning selection; protocol-1 assistant text is capped at 4,000 characters and tool args/results at 2,000; no controller route resolves an exact canonical cwd to its CoS project; background workers/Goal/Loop are not currently constrained to the T3 root-turn lifecycle; interactive approval/question routing through T3 has not been demonstrated; and CoS compaction/handoff continuity must be treated as session migration rather than inferred from mutable browser state. V1 needs full-length credential-redacted assistant content plus an enforced provider-session `backgroundWork=disabled` policy, but raw full tool args/results remain outside scope.

The official TypeScript ACP SDK is public. Stable ACP v1 and experimental v2 are separate entry points, so the bridge can use v1 as a compatibility floor and add exact-version v2 support only for features that justify the draft dependency.

### The current CoS contract is stateful and permissioned

CoS Core exposes filesystem reads/patches, terminal execution/continuation, plans, workers, session lifecycle, and composed calls. Its execution model has approved workspace roots, per-operation live guards, exact chat/session identity requirements in normal operation, and distinct semantics for output limits, completed process continuation, worker families, and session completion. CoS Desktop additionally operates browser/native UI through exact tab/page/window identities.

The compatibility layer must therefore preserve CoS as the final authority over actions on the host. T3 authorization cannot silently expand CoS filesystem or command authority. Permission mapping must advertise only modes the bridge can actually enforce.

### T3 and CoS have compatible host-ownership assumptions, but same-host is not an auth boundary

T3's architecture treats the environment/server host as the owner of provider processes, project files, credentials, Git operations, attachments, and worktrees; remote clients are control surfaces over that host. CoS likewise operates on explicitly approved host roots and locally connected browser/desktop state.

This is favorable for a same-host integration as a deployment model. It does **not** make loopback trustworthy. The bridge/controller boundary still needs an authenticated peer, audience-bound credentials, replay protection, origin/CSRF defense for HTTP, bounded request bodies/queues, and a way to distinguish the intended CoS/T3 instance from a first-binder or stale endpoint. Remote T3 clients can remain remote, but the actual CoS work should execute on the environment host under an explicitly authenticated local bridge.

### Identity and durable resume require an explicit mapping layer

T3 has environment/project/thread/provider-session/turn/request identities. CoS has chat/session/request identity and worker-family identity, and the exact companion session matters for authorized calls. These identifiers are not interchangeable.

CoS `v2.1.39` gives the bridge a usable durable session key: a new chat started through `POST /v1/inputs` is created under the caller-supplied lowercase UUID, which becomes the CoS session id and can be followed immediately through session/event reads. Each admitted send also has a caller-supplied idempotency UUID plus delivery proof; recorded events carry turn/message/input identifiers where applicable.

The bridge still needs its own binding record because T3 V2 has more identities than CoS exposes. Map T3 environment/project/thread/provider-session/provider-thread/provider-turn/run/run-attempt and relevant node/message/runtime-request/item identities to CoS session/input/turn/message/generation/worker identities. Retries must reuse or reject the original operation deterministically. State should contain identifiers, continuity outcomes and protocol progress only; avoid duplicating the transcript because CoS and T3 already own their respective durable histories.

### Cancellation has a real CoS primitive, but still needs conformance testing

T3 distinguishes requesting an interrupt from observing terminal completion and explicitly tests races such as Stop arriving before provider turn startup finishes. Exact CoS `v2.1.39` already exposes both sides of that lifecycle: `POST /v1/inputs/{id}/cancel` withdraws a message only while delivery is provably pending, and `POST /v1/sessions/{id}/stop` targets the exact `activeTurnId`. A late stop cannot stop a newer answer, and the recorded `turn_end` event—not the `202` response—is the proof that the active answer ended.

The bridge can therefore implement a real interrupt path without inventing a CoS API. It still needs layered semantics around that primitive: stop admitting new work for the T3 turn; use the exact CoS turn id; wait for the matching `turn_end`; suppress stale late results from completing the T3 run; and separately represent effects that were already dispatched through tools/processes/workers. Interrupt should remain unadvertised until the conformance spike proves those terminal/race cases through the installed build.

### CoS already provides a resumable event stream; granularity is the remaining question

CoS `v2.1.39` records structured session history and exposes the same projection both as paged reads and Server-Sent Events. `GET /v1/sessions/{id}/events/stream` uses event `seq` as an SSE id, accepts `Last-Event-ID`/`from` for reconnect, replays recorded rows, emits revisions with new sequence numbers, has a 15-second idle heartbeat, caps concurrent streams at four, and explicitly terminates slow/max-duration/stopped/session-gone/error streams so a caller can reconnect.

Transport is sufficient; fidelity is not yet sufficient. The published event projection includes session/turn start/end, user and assistant messages, errors, final tool-call summaries/results/changes, images/page-tool activity, handoffs and agent messages. It intentionally redacts and caps free text and publishes final tool-call records rather than a complete incremental provider protocol. The bridge should translate only what is authoritative, never scrape rendered ChatGPT UI, and obtain full content from a controller-owned extension before claiming transcript parity.

### V1 permission semantics are fixed-capability and CoS-owned

T3 provider integrations can expose permission modes, but v1 cannot enforce T3 runtime-mode downgrades inside CoS. CoS permission state is finer-grained and controlled by live guards plus prior authorization. The bridge therefore does **not** advertise T3 host-tool permission modes as if they governed CoS and never treats a T3 mode as an override of CoS authorization.

The safe v1 rule is fixed-capability: setup tells the user that the configured CoS instance's current Core/Desktop/browser/plugin authority is the authority the provider may exercise. The bridge rechecks controller/action readiness at admission points but does not pretend that a T3 "read-only" or "full access" label changes CoS's host-tool guards. A narrower future provider capability profile must be enforced by CoS itself before the bridge advertises it.

ACP does not move enforcement into T3. Registry/local ACP agents normally run their own tools under their own sandbox/approval model. The CoS side therefore remains the only host-tool authority for this bridge. V1 adds one explicit CoS-owned provider-session restriction—`backgroundWork=disabled`—because otherwise a worker/Goal/Loop continuation could outlive T3's root turn.

### Workspace mapping should use shared host paths first

T3 attachments/worktrees live on the environment host. CoS filesystem tools reject paths outside approved roots, but CoS durable prime-session workspace currently derives from a bound `projectId`. V1 therefore admits only a T3 cwd that exactly equals a canonical CoS project root. An arbitrary T3 worktree or subdirectory is rejected explicitly until CoS has a durable session-workspace primitive for that exact path.

Copying/mirroring entire workspaces introduces reconciliation and Git-identity problems and should be deferred unless shared-root access proves impossible. The plan must also distinguish **CoS filesystem-tool root checks** from **shell child authority**: a command launched as the logged-in user may have broader OS access than a file tool admitted under an approved root. Reparse points/symlinks/junctions require canonicalization and revalidation at the mutation boundary.

### Provider-instance/account isolation must be preserved

T3 supports provider instances/accounts and expects provider-specific credentials/configuration to stay isolated. A CoS provider integration should not rely on ambient global credentials if multiple CoS identities or hosts are ever supported. The bridge configuration should bind a T3 provider instance to one explicit CoS endpoint/session/account context.

### Recommended implementation language and dependency strategy

TypeScript/Node remains the best default, but the dependency rationale changed. A standalone adapter should depend on the **public ACP SDK and a project-owned CoS controller client**, not on unpublished T3 workspace packages. T3-specific behavior should be exercised through ACP conformance and black-box T3 integration tests.

If ACP proves insufficient, a native T3 adapter should live in a T3 source checkout/fork/upstream contribution and follow the current provider package boundaries (`packages/provider-<name>`, `provider-core`, `provider-testing`) rather than vendoring internal contracts into this standalone project.

The project should avoid bundled/minified desktop assets and direct browser/DOM scraping. Public source contracts, CoS's controller boundary, ACP, and documented T3 provider behavior are the maintainable seams.

## Research review verdict

The documentary and executable research is now sufficient for a comprehensive implementation plan. The information base had several material assumptions that the final validation corrected:

1. It treated legacy T3 `v0.0.42` and current Orchestration V2 as one provider architecture.
2. It assumed a standalone bridge could consume published T3 provider/contracts packages; those packages are private monorepo workspaces, so ACP is the cleaner external seam.
3. It underestimated the installed CoS controller. Exact `v2.1.39` already has new-chat creation, idempotent input/delivery proof, resumable SSE session events and exact active-turn Stop. A mandatory CoS controller extension is therefore **not** a prerequisite for a minimal provider spike.
4. It initially pinned the older PATH CLI instead of the running T3 server. Live testing showed the desktop/server is `20261013.3040` / `ffb4af8…`; that is the real first compatibility target.
5. It overestimated protocol-1 output fidelity. The controller deliberately caps projected message/tool text and exposes project ids without a path catalog. Those are production-quality gaps even though the control semantics themselves are sound.
6. It assumed ACP prompt text was equivalent to the user's message. Live capture proved current T3 injects T3-only MCP/orchestration/runtime/PR instructions around or beside the user request. Because v1 deliberately does not forward the `t3-code` MCP server into CoS, a production bridge must normalize those exact pinned wrappers or obtain an upstream T3 suppression option; verbatim forwarding is incorrect.

The reversible ACP spike has now answered the basic T3 side: Local ACP launches successfully on Windows via a real executable, receives the exact project cwd, gets one injected T3 MCP server on real sessions, streams assistant text into the UI, settles normal turns, and receives `session/cancel` when the user presses Stop. T3 provider-validation probes also create disposable ACP sessions outside the project cwd, so `session/new` **must be side-effect free**: the bridge should create the CoS browser chat lazily on the first real prompt, not during ACP session allocation.

The exact CoS `v2.1.39` controller tests were also executed locally. `control-api.test.ts`, `control-api-reads.test.ts`, `control-api-stream.test.ts`, and `control-api-actions.test.ts` passed **136/136**. This confirms the protocol-1 listener/auth contract, read projections, SSE resume/concurrency behavior, idempotent new-chat/send semantics, ambiguous-delivery handling and exact-turn Stop at the pinned release.

The remaining unknowns are implementation/design decisions rather than architecture blockers: the exact shape/versioning of the assistant-content and project-resolver controller extension, whether a future T3 prompt-suppression option replaces the pinned normalizer, and when deferred features such as model/reasoning selection, external approvals, attachments, remote control, worktrees and higher concurrency earn separate support gates.

## Threat model and trust boundaries

The compatibility layer crosses several independent authority boundaries. The implementation plan should name them explicitly rather than treating “local” or “same user” as trusted:

1. **Remote/local T3 client → T3 environment/server.** T3 owns its own pairing/session/environment authorization and thread permissions.
2. **T3 server → local ACP process.** Process launch does not by itself prove that later endpoints or reconnects belong to the same intended bridge instance. The bridge needs instance identity and bounded protocol input.
3. **ACP bridge → CoS local control API.** Use a controller-specific authenticated handshake/token and verify the intended CoS instance. Loopback is reachable by other local processes and is not a user boundary.
4. **CoS controller → ChatGPT/browser companion.** Browser/chat identity is mutable and user-driven. Actions must be bound to exact session/chat/generation identities; UI state and page content are observations, not authorization.
5. **CoS → Core/Desktop/Plugins and OS processes.** These domains have different powers. Filesystem admission, arbitrary shell execution, browser/native UI control, and third-party account actions cannot share one coarse “allowed” bit.

The concrete adversaries/failure sources are a buggy or malicious local process, a malicious webpage attempting localhost requests, untrusted repository/page/tool content, replayed/stale messages, a remote T3 user with broader authority than CoS, an overbroad external plugin, and ordinary browser/user interference that invalidates a previously observed target.

Mutating operations need replay-safe identities and an **ambiguous-delivery** outcome. CoS Desktop guidance explicitly warns that a dispatched UI action may have happened even when the caller receives an error; the same rule should apply to controller sends and third-party plugin effects. The bridge must inspect authoritative state before retrying rather than automatically replaying an uncertain mutation.

Logs and telemetry must treat provider-supplied/user-supplied identifiers as hostile strings: use bridge-generated correlation IDs, structured fields/escaping, content-free metrics by default, and redaction tests that cover partial credentials as well as full tokens. Raw prompts, repository contents, page text, tool bodies/results, auth headers and plugin payloads should not become routine bridge logs.

## Product decisions locked by the revised plan

The final draft adopts concrete defaults so implementation can begin without another architecture round:

- Treat **T3→CoS provider compatibility** as the primary goal because it is the path that requires new compatibility code; document CoS→T3 MCP integration as a secondary capability.
- Pin the first implementation/conformance lane to the **running T3 Orchestration V2 server**, `0.0.46-nightly.20261013.3040` / git SHA `ffb4af8d5d4fcfc5e9322295ff846a6d1e7ffbf8`. Treat the older PATH CLI (`20261010.2948`) as separate tooling and avoid using it to mutate the newer server's data store. Track current upstream in a separate drift lane. Treat `v0.0.42` as optional legacy support only if explicitly required.
- Build **Windows-first** because that is the active host, while keeping paths/process APIs portable.
- Scope v1's **intended product behavior** to coding workflows: prompts, assistant/tool timeline, filesystem/terminal work, cancellation, errors and restart/reconnect. Do not claim that Desktop/browser/plugins are excluded until the spike proves a per-provider enforcement mechanism or a dedicated CoS configuration/profile that actually removes those surfaces. Likewise, expose T3 approvals/questions only if they can be routed before the corresponding effect.
- Implement a **Local ACP command** with the public ACP SDK, accepting the protocol version T3 negotiates while advertising only capabilities the bridge really implements. Do not depend on unpublished T3 workspace packages from this project.
- Reuse **CoS local control API protocol 1** for authentication, health, send/idempotency, delivery proof, SSE cursors and Stop. Add the smallest backwards-compatible controller extension needed for full-fidelity assistant content, exact project-path discovery and an enforceable/attestable provider-session `backgroundWork=disabled` policy; keep CoS as the only session/outbox/orchestration owner.
- Run the bridge and CoS controller on the **same host as the T3 environment/server**, with explicit authenticated instance binding; do not treat loopback as authentication.
- Let **CoS remain authoritative for permissions** and do not advertise T3 runtime modes as host-tool controls. Treat the provider as fixed-capability for Core/Desktop/browser/plugins under the user's current CoS configuration; require the CoS-owned v1 provider-session policy `backgroundWork=disabled` so workers/Goal/Loop/continuations cannot escape the root-turn lifecycle.
- Persist only compact **identity/binding/idempotency/cursor/lifecycle-policy state** in the bridge: session binding, operation ids, SSE cursor/generation, normalized interaction mode, cancellation intent/target and terminal outcome. Make the ACP session id a durable bridge identity and support ACP `session/resume` (or `session/load` if full replay is implemented) so a restarted provider process reattaches to the same CoS chat instead of creating another one.

Choices that do not block Phase 0 are deliberately deferred to their release gates: whether the CoS provider extension lands upstream or ships as a provenance-pinned companion build, when macOS/Linux earn support, whether legacy T3 `v0.0.42` gets a separate lane, when remote T3 control becomes safe, and whether CoS→T3 MCP packaging becomes a second product direction. Browser-driven ChatGPT execution is accepted as a dependency of this compatibility layer and is covered by explicit recovery/version/support gates rather than treated as an unexamined transport detail.

## Historical pre-implementation planning gates

The following was the pre-implementation gate list used to shape `PLAN.md`. Current completion/remaining status is maintained in `PLAN.md`, not in this historical checklist:

1. **Exact-version pin — COMPLETE.** Primary T3 server: `ffb4af8d5d4fcfc5e9322295ff846a6d1e7ffbf8` (`20261013.3040`). CoS: `87ae9d631f82d8da2f462d910410031ad8f97ac5` (`2.1.39`, controller protocol 1). Keep current upstream, older CLI and legacy `v0.0.42` separate.
2. **Protocol-1 controller conformance — COMPLETE offline.** The exact pinned listener/read/SSE/action suite passed 136/136. A later device/user-enabled live smoke should confirm endpoint discovery against the installed app, but transport semantics are no longer an architecture unknown.
3. **Minimal ACP conformance — COMPLETE live.** A disposable Local ACP process on the running T3 server proved initialize, session creation, project cwd, injected T3 MCP, streamed assistant update, normal terminal completion and user Stop→`session/cancel`→cancelled terminal behavior.
4. **Full identity/idempotency model.** Map T3 environment/project/thread/provider-session/provider-thread/provider-turn/run/run-attempt/node/message/runtime-request/item identities to CoS chat/session/input/request/generation/worker identities. Prove duplicate sends, ambiguous delivery, restart and stale-result rejection.
5. **Transport/auth gate.** Authenticate T3/ACP/CoS instance transitions; use audience-bound/revocable credentials; reject browser origins on HTTP controller routes; bound bodies, frames, queues and fanout; prove replay/endpoint-substitution resistance; never reuse the browser-bridge secret as the provider-controller credential.
6. **Capability/permission gate.** Prove unsupported V2/ACP protocol capabilities remain unadvertised and T3 permission modes never masquerade as CoS tool-policy enforcement. V1 is same-user/local-control under the current CoS permissions; re-check controller/action readiness on every prompt/restart and defer remote T3 control until CoS exposes an enforceable per-provider/session policy.
7. **Workspace/OS authority gate.** Prove exact canonical CoS project-root matching, and prove worktrees/subdirectories, paths outside approved roots, Windows junction/reparse changes and ambiguous mappings fail closed. Test shell-child authority separately from filesystem-tool root admission. General worktree support is deferred.
8. **Cancellation/late-effect gate.** Test Stop before acceptance, during model work, shell child, composed Core execution, approval wait, worker/subagent activity, browser input (if ever enabled), transport loss and reconnect. Late results must not turn an interrupted run into success, and already-dispatched side effects must be represented honestly.
9. **Background-work gate.** For v1, prove the CoS provider-session policy prevents worker/Goal/Loop/continuation creation, survives restart/compaction/handoff, and is revalidated before prompts and terminal success. Later native background-work support needs separate pending-work, cancellation, isolation and late-completion semantics.
10. **Event/recovery gate.** Preserve protocol-1 sequence/cursor semantics, add full-fidelity content retrieval/streaming, prove reconnect/backpressure and compaction/handoff migration, and leave runtime questions/approvals/model switching unadvertised until an exact pre-effect path exists.
11. **Observability/privacy gate.** Test structured hostile IDs, log-injection resistance, token/partial-secret redaction, content-free metrics, retention/deletion, and explicit audit fields for cancellation and possibly-dispatched effects.
12. **Replay/drift gate.** Exercise T3's relevant shared provider scenarios (`simple`, `multi_turn`, `queued_turn`, `provider_thread_resume`, `message_steering`, interrupt variants, plan/questions, tool approvals, subagents and rollback where advertised). Record which scenarios are unsupported rather than emulating them falsely. Run a separate drift check against current T3 HEAD.
13. **End-to-end gate.** From the T3 client, select the Local ACP CoS provider, bind/create the intended CoS conversation, request a code change, observe causal tool/file activity and terminal state, reconnect/resume, and Stop a real active turn without duplicate or stale mutation.

## Evidence used

Local evidence:

- `C:\Users\emilg\.t3\runtime\versions\0.0.42\t3.exe --version`
- `Get-Command t3` and `t3 --version`, resolving the active launcher to `C:\Users\emilg\.local\bin\t3.cmd` and reporting `0.0.46-nightly.20261010.2948`
- Running T3 desktop/server About/process/package metadata reporting `0.0.46-nightly.20261013.3040`, matched to upstream SHA `ffb4af8d5d4fcfc5e9322295ff846a6d1e7ffbf8`. The older PATH CLI emitted a migration-divergence warning when pointed at this newer app data, so it is not treated as the authoritative server contract.
- `t3 --help`, `t3 start --help`, `t3 project --help`, and `t3 auth --help`
- A live disposable Local ACP provider on the running T3 server. It was launched as `node.exe <probe-agent.mjs>`, received protocol version 2, exact project cwd `C:\Users\emilg\t3onsteroids`, one injected T3 MCP server, streamed assistant text into T3, completed a normal turn, and received `session/cancel` followed by a cancelled terminal result when Stop was pressed. Provider-validation probes also invoked `session/new` outside the real project, proving that ACP session allocation must be side-effect free. The same live capture recorded T3's full first-prompt `<t3_code_instructions>` wrapper plus separate runtime/PR-linking block, and a later same-mode prompt with only the user text plus that runtime block.
- A direct execution of the exact pinned `t3AcpPromptWithInstructions()` implementation confirmed its transition matrix: first default prompt wrapped with T3 MCP guidance, same-mode subsequent prompt unwrapped, default→plan prompt wrapped with plan/T3 MCP guidance, and `/compact` left unwrapped. This matches the exact adapter's mode-transition tests and makes the prompt-normalization seam deterministic for the pinned SHA.
- Installed `Chat On Steroids.exe` file/product version `2.1.39` at `C:\Users\emilg\AppData\Local\Programs\Chat On Steroids\Chat On Steroids.exe`; local executable SHA-256 `78D2D0C266E4AEA3151463A289B12F567BA287AC515EA35A1909A0CFC100ABB6` and `resources\app.asar` SHA-256 `D10CE831EA330C5C50FB54DD79B339332C3C56733D0A12F25BFC7D6804908F98` provide a reproducible binary baseline.
- The live CoS process owns authenticated loopback surfaces; an unauthenticated request to the browser-bridge listener at `127.0.0.1:8765` returns `401 Unauthorized`. This confirms that a loopback listener exists and is authenticated, but it is **not** evidence that the opt-in local control API is currently enabled, and the browser bridge must not be confused with the provider-controller boundary.
- The CoS local control API is currently **off** on this machine: `%APPDATA%\chat-on-steroids\control-api\` does not currently contain an endpoint or token. A live controller/action spike therefore requires the user to enable **Local control API** and, for mutating tests, **Allow actions** in CoS; the research review did not silently change those settings.
- npm registry probes for `@t3tools/contracts`, `@t3tools/provider-core`, and `@t3tools/provider-testing` returned `E404`, matching their upstream `private:true` workspace-package status.
- The live Chat On Steroids Core/Desktop contracts exposed to this session, including filesystem/terminal/plans/workers/session semantics and approved-root/live-guard behavior.
- Exact CoS `v2.1.39` tests run locally after `npm ci`: `control-api.test.ts`, `control-api-reads.test.ts`, `control-api-stream.test.ts`, and `control-api-actions.test.ts` — **4 files, 136 tests, all passed**. These executable tests cover listener/auth, route projections, SSE resume/concurrency and action/idempotency/Stop semantics; the action contract also rejects `images`/`attachments` request fields and enforces the 64,000-character text limit.
- `/skills/computer-use/SKILL.md`, especially its exact tab/page/window identity rules, observe-before-act rule, and warning that a UI input can already have happened when a dispatch returns an error.
- `/steve/agents/bug-fix-plan.md` security findings used as local engineering evidence for why loopback alone is not an authorization boundary, browser-origin localhost requests matter, first-binder/endpoint impersonation must be considered, and untrusted identifiers must not be written to logs unsafely.

Public upstream evidence consulted during research:

- T3 Code repository (`pingdotgg/t3code`) at four separately reviewed source identities: legacy `v0.0.42` / `719a76ca1dbf5490f1aa33ffb9966301e02be9a9`, older PATH-CLI nightly `4f63275ac7885281d245022e65f1e9e8816b1382`, running desktop/server nightly `ffb4af8d5d4fcfc5e9322295ff846a6d1e7ffbf8`, and reviewed October 16 upstream HEAD `67bca6c224b3caf61dc7824f6487d754bcad8f8c`.
- Current T3 provider-integration guidance and V2 sources, including `packages/provider-core/src/server/ProviderAdapter.ts`, `packages/contracts/src/orchestrationV2.ts`, provider instance/dispatch/RPC contracts, orchestration-v2 lifecycle services, ACP provider implementation, and replay/conformance harnesses and fixtures.
- T3 documentation for outside agents/MCP, ACP providers, provider integration, environment auth, provider/account behavior, remote architecture, permission modes, Orchestration V2 and internal overview.
- The legacy `v0.0.42` ProviderService/ProviderAdapter/runtime-event sources and ACP v1 runtime, kept as a distinct legacy lane rather than used as the current architecture model.
- CoS exact installed release source, public tag `v2.1.39` / `87ae9d631f82d8da2f462d910410031ad8f97ac5` (package version `2.1.39`, release merge dated October 15, 2026), plus its architecture/setup/security/tool-surface documentation. Exact-tag inspection confirmed control API protocol `1`, new-chat creation, idempotent delivery/outbox proof, resumable SSE event streaming, exact-turn Stop, worker control, authentication/rate/body/queue limits, and the distinction between approved file roots and unsandboxed shell-child authority.
- CoS controller/API release documentation and the historical external-controller proposal, used to compare protocol-1's implemented chat/worker controls with broader external-controller ideas without assuming proposal text describes the current API.
- Official Agent Client Protocol TypeScript SDK/schema documentation: stable ACP v1 and the separately exported experimental ACP v2 API. The v1 content schema requires agents to support `Text` and `ResourceLink` prompt blocks; image/audio/embedded-resource prompt variants are capability-gated.

### Source pins to capture for the architecture/conformance spike

For T3 V2, snapshot the exact installed-nightly versions of the orchestration/provider contracts rather than relying on package version numbers (the private workspace-package versions do not equal the app tag):

- `packages/contracts/src/orchestrationV2.ts`, `providerInstance.ts`, `orchestrationDispatch.ts`, `rpc.ts` and adjacent tests.
- `packages/provider-core/src/server/ProviderAdapter.ts`, `selectionTransition.ts`.
- `apps/server/src/orchestration-v2/` session management, selection-transition, turn start/control, runtime request, provider-event ingestion, execution/finalization, event sink/outbox/effect worker, command receipt, message intake/stop/stream/coalescing, and checkpoint services plus adjacent tests.
- Provider replay/conformance harnesses and scenarios for simple/multi-turn, resume, steering/queueing, interrupt variants, plan/questions, tool approvals, subagents, rollback and background-work behavior.
- `packages/effect-acp/` v1/v2 compat/protocol/schema sources and tests, plus `packages/provider-acp/src/server/` adapter/runtime/event/policy/terminal/session-config sources and tests.

If legacy `v0.0.42` support is chosen, pin and test its older `apps/server/src/provider/Services/ProviderAdapter.ts`, `ProviderService.ts`, legacy provider/runtime contracts, provider-service integration fixtures, and stable ACP runtime separately. For the CoS→T3 MCP lane, separately pin T3's MCP HTTP server/auth/tool-access/orchestrator contracts rather than mixing those tests into the provider lane.
