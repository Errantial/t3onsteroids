# Maintained T3 patch: post-settle background work

`post-settle-background-work.patch` applies to upstream `dd148481531a0a090780a2ade20588566db099a2`
(the pinned T3 HEAD this lane accepts against) and is the only T3-side change the fire-and-forget
background-work contract needs.

## What it does

An ACP agent may advertise, on its `initialize` handshake:

```json
{ "agentCapabilities": { "_meta": { "cosBackgroundWork": true } } }
```

When it does, the host accepts the agent's out-of-turn `session/update` notifications after a turn
has settled, buffers them as a wake, and offers a continuation run. When it does not, behaviour is
exactly upstream: nothing an agent says after its turn can wake the host.

## The three hunks

1. `packages/provider-acp/src/server/adapter.ts` — `acpAdvertisesBackgroundWork()` reads the
   advertised capability; a per-session `postSettleCapable` Ref carries it, and
   `bufferPostSettleWake` requires it in addition to the existing flavor flag.
2. Same file — no change to the wake evidence rules: a non-empty `agent_message_chunk`,
   `user_message_chunk` or background tool update is accepted exactly as for the Grok flavor today.
3. `packages/provider-acp-registry/src/server/adapter.ts` — the registry flavor declares
   `enablePostSettleContinuation: true`. That flag was already the coarse gate (only Grok set it);
   the handshake capability decides whether it takes effect, so every other registry agent is
   unaffected.

## Verification

- Built HEAD checkout: `pnpm install --frozen-lockfile`, then `pnpm run build:bundle` in
  `apps/server` (the workspace-level `build` script is broken in this environment).
- With a fake local agent advertising the capability, answering one prompt with `end_turn`, then
  emitting an out-of-turn `agent_message_chunk`: the host logged
  `orchestration-v2.acp-wake-turn-detected` and created a continuation run (`ordinal:2`).
- Without the capability the agent's post-settle chunk is ignored, as upstream does today.
- Known host behaviour in the headless CLI lane: the continuation run is created but not dispatched
  to the agent, which is why the bridge also keeps the follow-up text in its durable queue and
  delivers it at the next user prompt when no continuation prompt arrives.

---

# v1.1.2 patch: thread ChatGPT tab controls

`v1.1.2-0003-thread-chatgpt-tab-controls.patch` applies to `c8cd959156` - the exact commit the
`v1.1.1` installer was built from (ChatGPT Browser fork merge `493e87f8f9` + stable `0.1.5` +
patch series 0001/0002). It is the third patch of that release line, not a patch for the
`dd14848` background-work series above.

## What it adds

- The thread action menu offers **Show ChatGPT tab** and **Reload ChatGPT tab** for
  `chatgptBrowser` threads only. They are hidden for every other provider.
- `orchestration.controlBrowserTab` carries the action from the web UI to the server. The server
  resolves the thread's active provider thread to its provider session, and the provider resolves
  that session's ChatGPT conversation from the live operation it owns.
- **Show ChatGPT tab** uses the extension's existing `revealChats` path: it activates the tab and
  focuses its window, restoring it if the managed window is minimized.
- **Reload ChatGPT tab** force-reloads the exact tab with `chrome.tabs.reload(id, { bypassCache:
  true })`. It never opens a tab that does not exist.
- A thread whose provider session has no open tab fails explicitly ("The thread's browser tab is
  not open") instead of opening an unrelated conversation.

## Bounds

T3 treats ChatGPT observer tabs as execution resources: a thread's tab exists while that thread
has a live provider operation. That is exactly the stalled-tab case this control is for. An idle
thread has no tab to show, and the action says so.

## Verification

- `@t3tools/contracts`, `@t3tools/provider-core` and `@t3tools/provider-chatgpt-browser` typecheck.
- `nativeBrowser` 21/21 (new one-shot reveal delivery + no-tab refusal), `adapter` 19/19,
  provider host/driver plus `RpcAuthorization` 29/29.
- `apps/server` typecheck clean for the touched files; `apps/web` production build succeeds and
  `threadActionMenu.logic` tests pass.
- Dev-server live check: both entries render for a ChatGPT Browser thread, and **Show ChatGPT tab**
  on a working turn closes the menu without a failure toast, so the server resolved the live
  conversation and queued the reveal. The extension's reload half is covered by the unit boundary
  but was not positively observed in the live browser; managed tabs drain when the turn ends.

---

# v1.1.2 patch: pinned threads stay in activity order

`v1.1.2-0004-sidebar-pinned-threads-on-top.patch` applies to `c8cd959156` and is the fourth patch
of the v1.1.x line (after 0003).

## What it adds

- A client setting, `sidebarPinnedThreadsOnTop`, default `true`, exposed as **Pinned threads on
  top** in Settings → General and in settings search.
- On (`true`) behavior is unchanged: pinned threads keep their own section above the activity list.
- Off (`false`) pinned threads sort with every other thread by activity; the pinned section
  disappears. Snoozed and settled threads still win, and pinning still blocks auto-settling: the
  toggle only decides placement.

## Verification

- `@t3tools/contracts` typecheck clean; `Sidebar.logic` 68/68 including the new section cases;
  web typecheck shows only the pre-existing `ThreadActivityBanners` errors; web production build
  succeeds.
- Live dev server: the toggle renders in Settings → General with the documented description.
