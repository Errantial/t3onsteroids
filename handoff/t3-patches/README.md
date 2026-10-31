# T3 Code patch series

Maintained patches that add features to T3 Code forks. They are never sent upstream: do not open PRs, issues or discussions against `pingdotgg/t3code`.

Each directory holds a `git am`-able series for one T3 base commit:

| Directory | T3 base | Status |
| --- | --- | --- |
| `pinned-ffb4af8d/` | `ffb4af8d5d4fcfc5e9322295ff846a6d1e7ffbf8` (the release-qualified v1.0.0 support tuple) | applies clean; web typecheck, focused tests, fmt and lint pass; sandboxed browser verification with a mock ACP agent passes |
| `main-2026-10-29-6d450a42/` | `6d450a4284852af137b2f3407fddd89eb76e7644` = **`v0.1.5` stable** (also `v0.1.5-nightly.20261029.3877`) | applies clean; full `vp` typecheck 36/36 packages, web production build, and focused web/ACP tests pass (2026-10-29) |

## Apply

```sh
git switch -c my-fork-branch <base-sha>
git am --3way handoff/t3-patches/<directory>/*.patch
```

If a hunk conflicts on a newer base, port it by hand: the series keeps its footprint in `ChatView.tsx`/`ChatComposer.tsx` to a few lines and puts everything else in new files.

## Series

- `0001` `feat(web): optional per-thread tokens/sec readout`: last finished turn's average output tokens/sec next to the context-window meter, toggled from the meter popover (off by default, remembered per thread on the client). Uses only a complete provider-reported main-agent total and the turn's wall time; shows nothing otherwise (so nothing for the CoS provider until it reports token usage).
- `0002` `feat(acp): report per-turn token usage from the prompt response`: maps the usage an ACP agent returns with `session/prompt` into the normalized per-turn `TurnTokenUsage`, so the readout above works for ACP providers that report tokens. A report that carries thought tokens is stored as `partial` (ACP does not say whether output already includes them), which the readout ignores rather than understating a rate. Verified on the pinned base with new adapter tests plus pure-mapping tests. On the `v0.1.5-nightly.20261029.3877` port the whole repository typechecks (36/36 packages), `AcpAdapterV2.test.ts` passes 72/72 including the usage-mapping case, and the web production build succeeds.
- `0003` `feat(chatgpt-browser): show or reload a thread's ChatGPT tab` (applies on top of the v1.1.1 build commit `c8cd959156`, i.e. the ChatGPT Browser fork merge `493e87f8f9` + stable `0.1.5` + `0001`/`0002`): adds **Show ChatGPT tab** and **Reload ChatGPT tab** to the thread action menu for ChatGPT Browser threads. The server resolves the thread's active provider session, the provider resolves the conversation from that session's live operation, and the extension focuses the tab (the existing reveal path) or force-reloads it with `bypassCache`. A thread with no open tab fails explicitly. Verified with contracts/provider-core/server typecheck, provider tests 21/21 + 19/19 + 29/29, the web production build and menu-logic tests. Live dev-server check: both entries render on a ChatGPT Browser thread, the entries are absent for Codex threads, and **Show ChatGPT tab** on a working turn closes the menu without a failure toast, so the server resolved the live conversation and queued the reveal; an idle thread reports "Could not show the ChatGPT tab" explicitly. Real-Chromium extension check: Show focused the conversation tab and window, and Reload kept the tab id, changed `performance.timeOrigin` and cleared an injected marker.
- `0005` `fix(chatgpt-browser): move the revealed ChatGPT window on-screen`: the managed worker window is parked at `-10000,-10000`, so the original reveal focused an invisible window. A reveal now restores a minimized window, moves an off-screen normal window to `80,80`, and focuses it. Verified in Chromium 1223 with the shipped extension: window bounds changed `-10000,-10000` → `80,80`, tab active and window focused; reload evidence as above.
- `0006` `fix(web): link fork update notes to the fork's release tag`: fork versions embed the release tag after the T3 base version (`0.1.5-v1.1.4...`), so the update UI pointed at a nonexistent `/tag/v0.1.5-v1.1.4...`. The UI now extracts the embedded fork tag (`v1.1.4`) and keeps the previous behavior for upstream versions. Verified with `desktopUpdate.logic.test.ts` 8/8.
- `0004` `feat(web): keep pinned threads in activity order when the setting is off`: adds the **Pinned threads on top** setting (default on). Pinning still keeps a thread from auto-settling; turning the setting off sorts pinned threads with every other thread by activity and removes the pinned section. `resolveSidebarThreadSection` honors the flag, snoozed/settled still win, and the settings panel and search index expose it. Verified with the contracts typecheck, `Sidebar.logic` 68/68, web typecheck (only the pre-existing `ThreadActivityBanners` errors) and the web production build; the toggle renders in Settings → General on the live dev server.

## Browser verification (2026-10-29)

The pinned series was applied to a clean `ffb4af8d` checkout, dependencies installed from the lockfile, and the web API was started in dev mode against an isolated sandbox home. A local mock ACP agent registered as a "Local command" ACP instance reported `usage_update` (context window) and a complete `usage` object on `session/prompt`, then a thread was created and a prompt was sent through the web UI in a headless Chrome driven over CDP.

Result: the readout is absent by default, the meter popover offers "Show tokens/sec", enabling it renders `465 tok/s` next to the meter (`aria-label="Last turn averaged 465 tok/s"`), and the choice survives a reload for that thread. This closes the browser-verification gap for the pinned series; the `0.1.5` port has its own full typecheck, web build and focused-test pass recorded above.
