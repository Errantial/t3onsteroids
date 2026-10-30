# T3-HEAD ACP acceptance probe

Source of the probe run on 2026-10-30 against upstream T3 HEAD
`dd148481531a0a090780a2ade20588566db099a2`:

1. Clone/fetch upstream and install:
   `git clone --filter=blob:none https://github.com/pingdotgg/t3code <checkout>`
   `git -C <checkout> fetch --depth 1 origin dd148481531a0a090780a2ade20588566db099a2`
   `git -C <checkout> checkout --detach FETCH_HEAD`
   `pnpm@12.14.0 install --filter t3... --frozen-lockfile`
2. Copy `bridge-acceptance.test.ts` into `<checkout>/packages/effect-acp/src/`.
3. From the checkout:
   `pnpm --filter effect-acp exec vp test run --config ../../vite.config.ts src/bridge-acceptance.test.ts`

The probe uses T3 HEAD's own `AcpClient` to spawn `dist/cli/index.js`, negotiate initialize,
create a session and complete one prompt. Expected result: protocolVersion 1, nonempty session id,
`stopReason: end_turn`.

Observed 2026-10-30: PASS in 18.03 s (1 test). The full pinned V1-19 UI matrix still requires a
configured T3 HEAD server/web profile.

## T3 HEAD server + CLI acceptance (2026-10-30)

The headless server lane was also exercised:

1. Seed `<base-dir>/userdata/settings.json` with an `acpRegistry` provider:
   `{ source: "local", commandPath: "<node.exe>", commandArgs: ["<repo>/dist/cli/index.js"] }` and
   environment variables for `T3ONSTEROIDS_COS_USER_DATA_DIR` / `T3ONSTEROIDS_STATE_DIR`.
2. `node apps/server/dist/bin.mjs serve --base-dir <base-dir> --port 8795 --host 127.0.0.1
   --no-browser <repo>`.
3. `node apps/server/dist/bin.mjs project add <repo> --base-dir <base-dir>`.
4. `thread start <repo> "Reply with exactly T3HEADCLI and nothing else." --provider cosbridge
   --model gpt-6-thinking --wait --json --base-dir <base-dir>` ? `reply:"T3HEADCLI"`.
5. `thread send <threadId> "Reply with exactly T3HEADSECOND and nothing else." --wait --json` ?
   `reply:"T3HEADSECOND"`.

A `--worktree HEAD` thread created its checkout outside CoS approved roots and failed closed as
designed; a successful worktree lane needs the T3 worktree base under an approved CoS root.

## Worktree success lane (2026-10-30)

1. Add a normal Git repo inside the approved CoS root as a CoS project.
2. Set `worktreesDirectory` in T3 settings to a directory inside that approved root.
3. `t3 thread start <repo> "Reply with exactly T3HEADWORKTREE and nothing else." --worktree HEAD
   --branch accept-wt --provider cosbridge --model gpt-6-thinking --wait --json`.
4. Expected: `status:"completed"`, `reply:"T3HEADWORKTREE"`. Observed.

The earlier fail-closed worktree run used T3's default worktree base under the disposable T3 data
directory, which is outside the CoS approved roots.

## Attachment row (2026-10-30)

1. Run the provider build that elects the shell's multi-image picker (`286cff5`, extension stamp
   `df3b8ddd0870`) and load that extension copy in the qualification Chrome profile. Remove any
   older copy of the extension first: two loaded copies both poll the bridge and the UI rows stall.
2. Open an existing T3 thread, attach `t3-attach-test.png` (an 8x8 solid red PNG) through the
   composer's file input, type `Describe the attached image in one sentence, naming its color and
   size.` and submit.
3. Expected: the run completes and the reply names the image's color and size. Observed:
   `status=completed` for run `ordinal:7`, reply
   `The image is a solid bright red square measuring 8 x 8 pixels.` The CoS input `e813e66d`
   drained at `drainedSeq:45` with `turnId g-1p7u8akwzdcve-0-1`.

Known residual: when CoS opens a brand-new chat tab, the first image turn can complete on the page
while the extension never publishes `turn_start`/`turn_end`. The provider turn then stays
`admitted` and the prompt does not return. Sending the same prompt again in the now-open
conversation drains normally; the row above was accepted on that retry, and the ACP image probe
passed the same way. Text-only first turns were not observed to fail.
