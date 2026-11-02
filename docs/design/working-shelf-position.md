# Working section at the top of the sidebar

Status: **planned, not implemented.** Target: v1.1.9 (client-only).

## Problem

The Working section collects threads that are working or monitoring. Today it is anchored to the
bottom of the sidebar: the list builder appends its header and rows after Active, and the header
carries `mt-auto`, which pushes the section (and everything after it) to the bottom of the column.
In practice the order is:

```
drafts
Pinned
Active
Working          <- mt-auto
Snoozed
Settled
```

A user who treats working threads as the most important part of the list has to look past the whole
inbox to find them. The request is an option to put the Working section at the **top of the thread
list** instead, keeping the current position as the default.

## Option

Add a per-client setting:

- `sidebarWorkingSectionOnTop: boolean`, default `false` (current behavior).
- Label: **Working section at top**.
- Shown in Settings → General → Sidebar directly under **Working section**, with a reset control.
- Only meaningful while `sidebarWorkingShelfEnabled` is on. When the Working section is off, the new
  row is hidden (or disabled with the existing explanation); the stored value is preserved.
- The boring sidebar (folder grouping) has no Working section; the setting has no effect there.

When `true`, the list order becomes:

```
drafts
Working          <- no mt-auto
Pinned
Active
Snoozed
Settled
```

"Top" means above Pinned and Active, after the draft block. Pinned and Active keep their internal
order and their Pinned/Active boundaries. Snoozed and Settled remain at the bottom.

## Behavior and edge cases

- **Default unchanged.** Existing users see exactly today's order until they opt in.
- **No working threads:** the header is not rendered; nothing moves.
- **Pinned threads on top off (Labs pin overhaul):** pinned threads already sort with Active; Working
  still renders first when the option is on.
- **Saved filter:** saved threads stay in the active list. The Working section keeps its chosen
  position; the option does not change which threads are saved.
- **Search/filtering:** section headers may be hidden while searching; ordering only applies to rows
  that survive the filter.
- **Collapse:** `workingShelfExpanded` and its local-storage key are unchanged; only position moves.
- **Drag and drop:** Working rows are not a drop target today and must not become one. Moving the
  header must not change section membership or the Pinned/Active drop boundaries. The drag label
  offset currently derives from the Pinned header; with Working above it, that header is lower, so
  the offset calculation must be rechecked against the list rect.
- **Bottom spacer:** the `mt-auto` spacer must move to the first bottom-shelf header when Working is
  on top. Today `working-header` owns it; `snoozed-header` only gets it when Working is empty. With
  Working at top, Snoozed (or Settled when Snoozed is empty) needs the spacer, otherwise the bottom
  shelves float directly under Active.
- **Motion and scroll:** the list is keyed by item order; moving the section changes the key and
  should preserve scroll position. Verify with a long list and with the Working section collapsed.
- **Mobile:** the setting is for the web/desktop sidebar. The mobile app has its own list and does
  not read `sidebarWorkingShelfEnabled`; leave mobile unchanged.

## Implementation sketch

1. **Contract** — `packages/contracts/src/settings.ts`
   - Add `sidebarWorkingSectionOnTop` to the unified settings schema with a default of `false`, and
     to the scoped optional keys next to `sidebarWorkingShelfEnabled`.
2. **Ordering** — `apps/web/src/components/Sidebar.tsx`
   - Read the setting in `useSidebarThreads`/`Sidebar` next to `sidebarWorkingShelfEnabled`.
   - Extract the `sidebarListItemsFresh` ordering from the component into a pure helper in
     `apps/web/src/components/Sidebar.logic.ts` (for example `buildSidebarListItems`), taking the
     partition, `workingSectionOnTop`, and the visible/collapsed rows. This makes the order testable
     without a DOM.
   - In the helper, push the `working-header` marker and `visibleWorkingThreads` rows before
     `pinned-header` when the option is on; otherwise keep the current position after Active.
   - Make the `mt-auto` class conditional: `working-header` keeps it only in the bottom position;
     when Working is on top, move it to `snoozed-header` (or `settled-header` when there are no
     snoozed rows).
3. **Settings UI** — `apps/web/src/components/settings/SettingsPanels.tsx` and `settingsSearch.ts`
   - Add the row under the existing Working section row with a `Switch`, reset button, and a
     searchable id (`working-section-at-top`). Include it in the changed-settings summary.
   - Hide it when `sidebarWorkingShelfEnabled` is off; the existing description already explains the
     boring-sidebar exception.
4. **Tests**
   - `Sidebar.logic.test.ts`: order with Working top/bottom, empty Working, Pinned on/off, Snoozed
     and Settled present/absent, and the bottom-spacer section selection.
   - A browser/DOM test for the rendered header order and the settings toggle if the existing test
     setup supports it.
   - Settings default/reset coverage in the web settings tests.
   - Manual check: long list, collapsed Working, Saved filter, drag an Active row to Pinned, drag a
     Working row out as chat context.
5. **Docs** — release notes for the next release, plus the Settings search entry and the changed
   settings list.

## Decisions

- **Above Pinned, not below it.** "Top of the list" is the request; Pinned and Active are long-lived
  sections, while Working is transient attention.
- **One boolean, not a second shelf.** The existing `sidebarWorkingShelfEnabled` still decides
  whether the section exists; this only decides where it sits.
- **Default off.** Changing the default would reorder every existing sidebar without consent.
- **Client setting.** No server, MCP, or runtime contract changes. It persists with the other client
  sidebar preferences and applies per client/browser profile.

## Risks

- The flex `mt-auto` spacer is the main visual risk; test the four combinations of Working/Snoozed
  presence.
- Drag/drop and autoscroll derive offsets from the first header; re-run the Sidebar drag tests.
- The list is memoized by item key; a settings change must rebuild the list, not only move JSX.

## Exit evidence

- Unit tests for the pure order helper and settings persistence.
- A desktop/web check with Working top and bottom, Pinned on and off, folder grouping on, and the
  Saved filter.
- No server/MCP changes; no migration.
