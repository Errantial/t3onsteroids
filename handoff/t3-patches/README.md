# T3 Code patch series

Maintained patches that add features to T3 Code forks. They are never sent upstream: do not open PRs, issues or discussions against `pingdotgg/t3code`.

Each directory holds a `git am`-able series for one T3 base commit:

| Directory | T3 base | Status |
| --- | --- | --- |
| `pinned-ffb4af8d/` | `ffb4af8d5d4fcfc5e9322295ff846a6d1e7ffbf8` (the pinned support tuple) | applies clean; web typecheck, focused tests, fmt and lint pass |
| `main-2026-10-29-6d450a42/` | upstream `main` `6d450a4284852af137b2f3407fddd89eb76e7644` | applies clean; the ComposerFooterControls extraction needed a port; focused tests were not re-run and the typecheck is unverified because the install used the pinned lockfile (302 missing-dependency errors, none in these files) |

## Apply

```sh
git switch -c my-fork-branch <base-sha>
git am --3way handoff/t3-patches/<directory>/*.patch
```

If a hunk conflicts on a newer base, port it by hand: the series keeps its footprint in `ChatView.tsx`/`ChatComposer.tsx` to a few lines and puts everything else in new files.

## Series

- `0001` `feat(web): optional per-thread tokens/sec readout`: last finished turn's average output tokens/sec next to the context-window meter, toggled from the meter popover (off by default, remembered per thread on the client). Uses only a complete provider-reported main-agent total and the turn's wall time; shows nothing otherwise (so nothing for the CoS provider until it reports token usage).
- `0002` `feat(acp): report per-turn token usage from the prompt response`: maps the usage an ACP agent returns with `session/prompt` into the normalized per-turn `TurnTokenUsage`, so the readout above works for ACP providers that report tokens. A report that carries thought tokens is stored as `partial` (ACP does not say whether output already includes them), which the readout ignores rather than understating a rate. Verified on the pinned base with new adapter tests plus pure-mapping tests. The `main` port applies and its pure-mapping tests pass; its adapter integration test and typecheck were not run. One unrelated Windows failure exists in `AcpRegistryAdapterV2.test.ts` (no win32-x64 fixture distribution), identical without these patches.
