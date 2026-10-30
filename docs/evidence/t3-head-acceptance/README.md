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
