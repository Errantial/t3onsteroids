# Repository instructions

- Keep T3 and CoS compatibility behavior behind explicit versioned contracts.
- Do not import unpublished `@t3tools/*` packages into the external bridge/provider package as a way to reach into T3 internals. Inside the T3 monorepo itself, normal workspace `@t3tools/*` imports are expected when they follow existing package boundaries.
- Keep ACP startup and `session/new` side-effect free with respect to CoS.
- Do not log prompt text, assistant text, repository contents, controller tokens, tool bodies/results, browser/page text, or raw configuration.
- Unsupported provider capabilities must fail explicitly rather than be approximated.
- Design the migration for Windows and Linux from the start. Keep platform-neutral provider/orchestration logic separate from explicit OS adapters for paths/storage, process containment/identity, secure secrets, browser artifacts/launch and prerequisite diagnostics. Windows may be the first live conformance/release gate when necessary, but Linux must not require an architectural rewrite and full cross-platform support is not claimed until Linux live qualification passes.
- When testing T3 Code, use the Chat On Steroids browser/background browser-control path instead of the T3 Code desktop app. Do not take over or foreground the desktop app for qualification/testing when browser-based background testing is available; preserve the user's ability to keep using the machine concurrently.
- For repository/file/terminal work in this project, use the **Chat On Steroids Core (FW)** connector specifically. Do not switch to Core, Beta, Desktop, or other CoS connectors unless the user explicitly asks; the FW connector has the intended workspace/root access and using another connector can produce misleading access failures or inconsistent behavior.
- When multiple implementation subagents run concurrently, give each one an isolated git branch/worktree rooted at the agreed frozen base or dependency commit. Do not let concurrent agents share one mutable worktree or merge/rebase each other's branches; the integration owner merges completed slice commits in dependency order.
- Never open pull requests, issues or discussions against the upstream `pingdotgg/t3code` repository. T3 changes ship only as a maintained patch series or fork; local T3 clones keep `origin`'s push URL disabled.

## Release workflow

Every release publishes Windows **and** Linux artifacts together. The Windows installer keeps the
desktop path; the Linux artifact is the standalone CLI runtime that headless servers run.

### What server-1 runs (reference shape)

`server-1` runs `t3code.service` as a **user** systemd unit
(`~/.config/systemd/user/t3code.service`, user `opc`):

```text
ExecStart=/home/opc/.t3-nightly/runtime/versions/<full-version>/t3 __service-launcher
Environment=T3CODE_HOME=/home/opc/.t3-nightly
```

`<full-version>` is a directory unpacked from `t3-<full-version>-linux-<arch>.tar.gz` (layout: `t3`,
`t3.bin`, `client/`, `lib/`, `node_modules/`, `resource-monitor/<platform>-<arch>/`, `.install-complete`).
**server-1 is aarch64**, so its artifact is `...-linux-arm64.tar.gz` and its resource monitor lives
under `resource-monitor/linux-arm64/`. The unit is not rewritten by the app, so a release installs a
new directory and points the unit at it, keeping the previous one for rollback. No deb/AppImage is
needed for this host; do not add one unless a Linux desktop install is actually wanted.

### Version rule

- Artifact names and the runtime directory use the **full** version:
  `0.1.5-v1.1.6.YYYYMMDD.<sha12>.connect1`.
- The SSH bootstrap downloads upstream archives under the **base** tag (`v0.1.5`), because only the
  base version is published upstream. `remoteRuntimeReleaseVersion()` strips the fork suffix before
  the runner builds that URL; never pass the full version there (that was the 404 that spawned the
  old sync workaround).
- GitHub release tags use the fork tag (`v1.1.6`), never the full version.

### Where Linux artifacts are built

Build on the Framework in **WSL Ubuntu**, cross-targeting the architecture server-1 runs
(**arm64** today), from a clone of `Errantial/t3code` at the release commit:

```bash
export PATH="$PWD/node_modules/.bin:$PATH"   # cli.ts spawns `vp` from PATH
pnpm install
vp run --filter @t3tools/web build            # apps/web/dist
node apps/server/scripts/cli.ts build         # bundles the server and copies the web client

# resource monitor for the target arch
rustup target add aarch64-unknown-linux-gnu
cd native/resource-monitor
CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER=aarch64-linux-gnu-gcc \
  cargo build --release --target aarch64-unknown-linux-gnu
cd ../..
mkdir -p apps/server/dist/resource-monitor/linux-arm64
cp native/resource-monitor/target/aarch64-unknown-linux-gnu/release/t3-resource-monitor \
  apps/server/dist/resource-monitor/linux-arm64/

# arm64 executable. `vp pack` accepts no linux-arm64 target, so produce the SEA bundle with the
# host build and inject it into the official arm64 Node 26.12.1 binary (the same steps as
# scripts/lib/linux-arm64-sea.ts, which only runs natively).
(cd apps/server && T3CODE_PACK_EXE=1 vp pack)   # apps/server/dist-exe/bin.mjscurl -fsSL https://nodejs.org/dist/v26.12.1/node-v26.12.1-linux-arm64.tar.xz -o /tmp/node-arm64.tar.xz
tar -xJf /tmp/node-arm64.tar.xz -C /tmp --strip-components=1
cp /tmp/bin/node /tmp/node-arm64
# sea-arm64.json: {"main":"apps/server/dist-exe/bin.mjs","output":"/tmp/sea.blob",
#                  "mainFormat":"module","disableExperimentalSEAWarning":true,"useCodeCache":false}
node --experimental-sea-config /tmp/sea-arm64.json
node node_modules/postject/dist/cli.js /tmp/node-arm64 NODE_SEA_BLOB /tmp/sea.blob \
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
cp /tmp/node-arm64 apps/server/dist-exe/t3-linux-arm64
chmod +x apps/server/dist-exe/t3-linux-arm64

node scripts/build-cli-archive.ts \
  --platform linux --arch arm64 \
  --version 0.1.5-v1.1.6.YYYYMMDD.<sha12>.connect1 \
  --output-dir /root/release-cli
node scripts/smoke-cli-archive.ts \
  --archive /root/release-cli/t3-<version>-linux-arm64.tar.gz \
  --expect-version <version>
```

For an x86_64 Linux host use `node apps/server/scripts/cli.ts build-exe` directly (no injection)
and `--arch x64`; everything else is unchanged. Build **natively on the host only if cross-build
fails**, and never on server-1 while its T3 is serving users.

One-time WSL setup: **Node 26.12.1** (`vp pack` refuses other versions for native CLI executables;
install the official tarball and link `node`/`npm`/`npx`), `npm install -g pnpm@12.14.0`,
`patchelf`, `build-essential`, `python3`, `gcc-aarch64-linux-gnu`, `rustup`.

Why WSL and not GitHub Actions right now: the fork's `Release` workflow is scheduled but every run
stays `pending` with no jobs, so Actions is not usable on the fork as configured; Docker is not
installed on the Framework. WSL is local, uses the glibc/patchelf toolchain the archive expects, and
has its own disk. Revisit GitHub Actions once the fork's workflow actually runs; prefer it then,
because it removes the local toolchain dependency.

Do not build the Linux archive on Windows directly: the build produces a Linux SEA binary and needs
`patchelf`. Check free space first (keep at least 10 GB), and delete the WSL stage and
`release-cli` after uploading.

### Assets per release

- Windows: `T3-Code-<full>-x64.exe`, `.exe.blockmap`, `latest.yml`.
- Linux: `t3-<full>-linux-x64.tar.gz`. `latest-linux.yml` only when a Linux **desktop** build ships;
  the CLI tarball is not consumed by electron-updater.
- `t3onsteroids-<release>-source.zip`, `t3onsteroids-<release>-t3-patches.zip`.
- `SHA256SUMS.txt` covering every asset above.

### Post-publish verification

1. `gh release view <tag>` lists every expected asset.
2. `HEAD` every asset URL and expect 200; `latest.yml` must name the installer and its
   `sha512`/`size` must match the uploaded exe.
3. `/releases/latest` must be the new tag and not a prerelease or draft.
4. Confirm each machine's update path: Windows T3 shows the update from
   `Errantial/t3onsteroids` `latest`; server-1 answers on `:3773` after the fleet update.
5. Record the result in `docs/evidence/<release>-release.md`.

## Fleet updates

`scripts/fleet-update.mjs` updates the T3 instances over SSH (one machine at a time, stopping on the
first failure). It never prints keys or tokens.

```bash
# show the plan only
node scripts/fleet-update.mjs --tag latest --targets all --dry-run

# update one machine
node scripts/fleet-update.mjs --tag v1.1.6 --targets server1

# update the two machines that are safe to restart remotely (the Framework kills this thread)
node scripts/fleet-update.mjs --tag v1.1.6 --targets home,server1
```

Targets: `home` (laptop-5amudrke), `framework` (this machine, local), `server1` (Oracle Linux), or
`all`. `all` expands to home, server1, framework in that order, but a real run refuses `framework`
because restarting its T3 ends the active conversation; use `--dry-run` for the Framework, then run
the installer and `Restart-Service t3code` yourself from an elevated shell. Windows targets install
the NSIS installer silently (`/S`) and start T3 again; server-1 unpacks the Linux runtime next to
the current one, repoints `t3code.service`, restarts it, and keeps the previous directory for
rollback. Updating restarts T3 and interrupts running threads.

