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

## Release pipeline

Every release publishes the Windows desktop installer and the Linux CLI runtime together, from the
same fork commit. Follow the steps in order and record the result in
`docs/evidence/<release>-release.md`.

### Branch and commit conventions

- T3 source lives in `Errantial/t3code` (fork). Work on a feature branch off the maintained
  `fix/remote-runtime-sync` branch: `feat/<slug>` or `fix/<slug>`. `origin` is the upstream
  `pingdotgg/t3code` and must keep its push URL disabled; push to the fork remote. Never open PRs,
  issues or discussions against upstream.
- `t3onsteroids` carries the release notes, patches, scripts and evidence. Cut each release on
  `release/vX.Y.Z`; keep `main` a fast-forward of it.
- Commit subjects: `feat(scope): ...`, `fix(scope): ...`, `test(scope): ...`, `docs: ...`,
  `chore(scope): ...`. No force-push and no history rewrite on either repo.

### Version scheme

Three identifiers, never interchangeable:

| Identifier | Example | Used for |
| --- | --- | --- |
| Base T3 version | `0.1.5` | upstream `v0.1.5` tag; SSH bootstrap URL |
| Full fork version | `0.1.5-v1.1.6.20261101.<sha12>.connect1` | exe name, Linux runtime dir/archive, `latest.yml`, `t3 --version` |
| GitHub release tag | `v1.1.6` | release page, `gh release`, human links |

`<sha12>` is the first 12 characters of the T3 build commit. Run
`node scripts/update-release-package-versions.ts <full-version>` before bundling the CLI; without
it `t3 --version` reports the workspace version instead of the release. The SSH bootstrap strips
the fork suffix and downloads upstream under the base tag only; passing the full version there is
the 404 that spawned the old sync workaround.

### 1. Preflight

- T3 worktree clean, on the release branch, build commit pushed to `Errantial/t3code`.
- `t3onsteroids` clean, on `release/vX.Y.Z`, notes written in `docs/releases/vX.Y.Z.md`.
- At least 10 GB free on C: and on the Linux build host (48 GB is the comfortable Windows figure).
- `gh auth status` succeeds and `gh release view vX.Y.Z --repo Errantial/t3onsteroids` says the
  release does not exist yet. A published tag is never reused.

### 2. Tests and smoke checks (must pass before publishing)

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
node scripts/release-smoke.ts
```

Run the focused suites for anything touched as well, e.g. `vp test run <files>`. The MCP server
repo runs its own `pnpm test` (tsc plus node --test) before its tag. No release is published from a
red tree; if a check is flaky, rerun it and record the result rather than skipping it.

### 3. Build Windows

Build from a clean checkout of the release commit, in an empty `release/` directory:

```powershell
$env:T3CODE_DESKTOP_VERSION = '0.1.5-v1.1.6.YYYYMMDD.<sha12>.connect1'
$env:T3CODE_DESKTOP_UPDATE_REPOSITORY = 'Errantial/t3onsteroids'
$env:T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR = 'true'
pnpm dist:desktop:win:x64
```

Outputs: `release/T3-Code-<full>-x64.exe`, `.exe.blockmap`, `latest.yml`. The build fails with
ENOSPC rather than producing a partial installer; free space and rebuild, never publish a failed
run. The installer is unsigned unless the signing environment is configured; say which in the
release notes.

### 4. Build the Linux runtime

server-1 is aarch64 and runs the standalone CLI runtime as a user unit. Follow
[what server-1 runs](#reference-what-server-1-runs) and
[how the runtime is built](#reference-how-the-linux-runtime-is-built). Verify the extracted tree
before packing:

```bash
t3-<full>-linux-arm64/t3 --version     # must print the full version
node scripts/smoke-cli-archive.ts \
  --archive /root/release-cli/t3-<full>-linux-arm64.tar.gz \
  --expect-version <full-version>
```

For an x86_64 Linux host use `node apps/server/scripts/cli.ts build-exe` (no injection) and
`--arch x64`, then ship `t3-<full>-linux-x64.tar.gz`. Do not cross-build the arm64 runtime from
WSL: `vp pack` has no linux-arm64 target and cross-injected SEA output does not execute.

### 5. Assemble the asset set

Every release has all of these, named with the full version:

- Windows: `T3-Code-<full>-x64.exe`, `T3-Code-<full>-x64.exe.blockmap`, `latest.yml`.
- Linux: `t3-<full>-linux-<arch>.tar.gz` (arm64 for server-1, x64 for other hosts).
- `t3onsteroids-<release>-source.zip`, `t3onsteroids-<release>-t3-patches.zip`.
- `SHA256SUMS.txt` covering every asset above, generated last.
- `latest-linux.yml` only when a Linux **desktop** build ships; the CLI tarball is not consumed by
  electron-updater, so do not fake Linux updater metadata.

Check `latest.yml` before upload: its `version` is the full version and its `sha512` and `size`
match the exe byte for byte.

```powershell
$files = Get-ChildItem out -File | Where-Object { $_.Name -ne 'SHA256SUMS.txt' }
$lines = $files | ForEach-Object { (Get-FileHash $_.FullName -Algorithm SHA256).Hash + '  ' + $_.Name }
$lines | Set-Content out/SHA256SUMS.txt -Encoding ascii
```

### 6. Publish

```bash
gh release create vX.Y.Z --repo Errantial/t3onsteroids \
  --title "t3onsteroids vX.Y.Z" --notes-file docs/releases/vX.Y.Z.md \
  out/T3-Code-<full>-x64.exe \
  out/T3-Code-<full>-x64.exe.blockmap \
  out/latest.yml \
  out/t3-<full>-linux-arm64.tar.gz \
  out/t3onsteroids-X.Y.Z-source.zip \
  out/t3onsteroids-X.Y.Z-t3-patches.zip
gh release upload vX.Y.Z --repo Errantial/t3onsteroids out/SHA256SUMS.txt
```

The tag is the fork tag (`vX.Y.Z`), never the full version. Upload `SHA256SUMS.txt` after the
assets it covers. `--clobber` is only for repairing a missing or misnamed asset on an already
published release; replacing an installer silently needs a new patch release and a note.

### 7. Post-publish verification

1. `gh release view vX.Y.Z --repo Errantial/t3onsteroids` lists every expected asset.
2. HEAD every asset URL and expect 200:

   ```powershell
   $base = 'https://github.com/Errantial/t3onsteroids/releases/download/vX.Y.Z'
   (Get-Content out/SHA256SUMS.txt) | ForEach-Object {
     $name = $_.Split(' ', 2)[1].Trim()
     $r = Invoke-WebRequest -Uri "$base/$name" -Method Head -UseBasicParsing
     "$($r.StatusCode) $name $($r.Headers['Content-Length'])"
   }
   ```

3. `/releases/latest` is the new tag, not a prerelease or draft; `latest.yml` names the uploaded
   installer and matches its `sha512`/`size`.
4. Run `node scripts/fleet-update.mjs --tag vX.Y.Z --targets all --dry-run` and confirm every
   machine's before-version and the asset it would install.
5. Record the build, checksums, feed and verification in `docs/evidence/<release>-release.md`.

### 8. Fleet rollout

Dry-run first, then one machine at a time; the script stops on the first failure and keeps the
previous Linux runtime. Updating restarts T3 and interrupts running threads.

```bash
node scripts/fleet-update.mjs --tag vX.Y.Z --targets all --dry-run
node scripts/fleet-update.mjs --tag vX.Y.Z --targets home,server1 --yes
node scripts/fleet-update.mjs --tag vX.Y.Z --targets framework --allow-framework --yes
```

Run the Framework last (it restarts this conversation), or leave it to Emil. The Windows path stops
the WinSW `t3code` service around the NSIS install; server-1 keeps the previous
`~/.t3-nightly/runtime/versions/<full>` directory. If the release changes the MCP server, update
`t3code-mcp-v2` after the T3 rollout, restart its scheduled task, and verify the new tools before
calling it done.

### 9. Rollback

- Windows: stop the `t3code` service, run the previous installer `/S /currentuser` (the old
  installer is kept in the updater cache or the previous release assets), start the service, and
  confirm the exe `FileVersion` and `:3773`.
- Linux: point `ExecStart` back at the previous version directory, then
  `systemctl --user daemon-reload && systemctl --user restart t3code.service`; verify
  `t3 --version` and `http://127.0.0.1:3773/`. The old directory is never deleted during an
  update.
- Release: never delete the tag or assets. Publish a new patch release with the fix.
- MCP server: restore the previous tree from `C:\Users\Emil\apps\t3code-mcp-v2.bak-*`, rebuild,
  restart the `t3code-mcp` task, and re-run its smoke test.

### 10. Dev and verification T3 servers (never on :3773)

Port 3773 on 127.0.0.1 belongs to each machine's own T3. Inside WSL, 127.0.0.1 is forwarded to the
Windows host (`wslrelay.exe`), so a T3 started in WSL on :3773 shadows the host's T3 for every
loopback client. That includes the T3 Connect tunnel, which then routes the phone to the wrong
environment. This happened on the home laptop on 2026-10-31: a T3 SSH environment launched
`t3 serve --host 127.0.0.1 --port 3773 --base-dir ~/.t3` inside its WSL.

- Start throwaway servers only through `scripts/dev-t3-serve.sh -- <command>`. It uses port 3777
  or the next free port (never 3773), a scratch base dir (`~/.t3-dev` by default, never `~/.t3` or
  `~/.t3-nightly`), and stops the server when the command ends or fails.
- Do not add a T3 SSH environment that targets a WSL distro on a machine that runs its own
  Windows T3. `ssh laptop-5amudrke` and `ssh desktop-kc5chj8` land in WSL, so an SSH
  environment for them bootstraps a second T3 there. Connect to the Windows T3 at
  `http://<host>:3773` instead.
- `scripts/fleet-update.mjs` stops SSH-launched (`managed`) T3 servers on :3773 inside a
  `windows-ssh` target's WSL before installing (`--keep-wsl-t3` only reports them). After install,
  it fails unless `127.0.0.1:3773/.well-known/t3/environment` returns the machine's own
  `userdata/environment-id`. A bare listener check is not enough.
- To check a machine by hand, compare `Invoke-RestMethod http://127.0.0.1:3773/.well-known/t3/environment`
  `.environmentId` with `%USERPROFILE%\.t3\userdata\environment-id`.

### 11. Disk hygiene

- Check C: free before and after; keep at least 10 GB. Remove `release/`, staging directories and
  duplicate installers after upload. Keep one previous installer for rollback.
- WSL: remove `/root/t3build`, `/root/release-cli`, `/root/arm64` and downloaded Node tarballs
  after the build.
- server-1: remove `/tmp/t3build`, `/tmp/release-cli`, `/tmp/node26` and test tarballs; keep the
  previous runtime directory. Build with `nice` in `/tmp` while its T3 keeps serving.
- `out/` is gitignored; delete published artifacts from it once the evidence is recorded.

### Reference: what server-1 runs

`server-1` runs `t3code.service` as a **user** systemd unit
(`~/.config/systemd/user/t3code.service`, user `opc`):

```text
ExecStart=/home/opc/.t3-nightly/runtime/versions/<full-version>/t3 __service-launcher
Environment=T3CODE_HOME=/home/opc/.t3-nightly
```

`<full-version>` is a directory unpacked from `t3-<full-version>-linux-<arch>.tar.gz` (layout:
`t3`, `t3.bin`, `client/`, `lib/`, `node_modules/`, `resource-monitor/<platform>-<arch>/`,
`.install-complete`). **server-1 is aarch64**, so its artifact is `...-linux-arm64.tar.gz` and its
resource monitor lives under `resource-monitor/linux-arm64/`. The unit is not rewritten by the app,
so a release installs a new directory and points the unit at it, keeping the previous one for
rollback.

`__service-launcher` also reads `runtime/service-state.json`; its `activeVersion` decides which
runtime directory it spawns. Updating only `ExecStart` leaves the old runtime serving (the v1.1.5
update did exactly that). Always set `activeVersion` to the new full version and restart, and verify
`/.well-known/t3/environment` reports it. `scripts/fleet-update.mjs` updates both.

No deb/AppImage is needed for this host; do not add one unless a Linux desktop install is actually
wanted.

### Reference: how the Linux runtime is built

Build its runtime natively on an arm64 Linux host (server-1 is the only one available) in a scratch
directory, with **Node 26.12.1**. Node's SEA output does not execute on this host — `--build-sea`,
`vp pack` and a postject injection all produced `ENOEXEC` while the stock Node binary runs — so the
archive ships a launcher + Node + server bundle instead of a SEA:

```bash
# on the arm64 host, as the service user, in a scratch clone
export PATH=/tmp/node26/bin:$PATH
pnpm install
node scripts/update-release-package-versions.ts 0.1.5-v1.1.6.YYYYMMDD.<sha12>.connect1
vp run --filter @t3tools/web build
node apps/server/scripts/cli.ts build
(cd apps/server && T3CODE_PACK_EXE=1 vp pack)     # dist-exe/bin.mjs
cargo build --release --manifest-path native/resource-monitor/Cargo.toml

# assemble t3-<full>-linux-arm64/
#   t3         launcher: LD_LIBRARY_PATH="$DIR/lib" exec "$DIR/node" "$DIR/t3.mjs" "$@"
#   node       official Node 26.12.1 arm64 binary
#   t3.mjs     apps/server/dist-exe/bin.mjs
#   client/    apps/server/dist/client
#   node_modules/, lib/, resource-monitor/linux-arm64/, .install-complete
# then verify and pack:
t3-<full>-linux-arm64/t3 --version     # must print the release version
tar -czf t3-<full>-linux-arm64.tar.gz -C pack t3-<full>-linux-arm64
```

Clean the scratch clone and tarballs afterwards and keep at least 10 GB free. The Framework's WSL is
only needed for Windows builds; do not cross-build the arm64 runtime there (`vp pack` has no
linux-arm64 target, and cross-injected SEA output was verified not to execute). Keep server-1's T3
running while building: use `nice`, build in `/tmp`, and do not restart the service until the
artifact's `t3 --version` succeeds.

The archive builder records the bundled `libatomic` provenance with `dpkg-query` on Debian/Ubuntu
or `rpm` on Oracle Linux/Fedora, so an RPM build host (server-1) needs no shim. Its license header
names the package and source RPM the runtime actually carries.

Why not GitHub Actions yet: the fork's `Release` workflow is scheduled but every run stays
`pending` with no jobs, so Actions is not usable on the fork as configured. Revisit it once the
workflow actually runs; it remains the better long-term home for both architectures.

## Fleet updates

`scripts/fleet-update.mjs` updates the T3 instances over SSH (one machine at a time, stopping on the
first failure). It never prints keys or tokens.

```bash
# show the plan only
node scripts/fleet-update.mjs --tag latest --targets all --dry-run

# update one machine
node scripts/fleet-update.mjs --tag v1.1.6 --targets server1 --yes

# the routine fleet update (the Framework target restarts this conversation)
node scripts/fleet-update.mjs --tag v1.1.6 --targets home,server1 --yes

# the Framework is opt-in and should be last
node scripts/fleet-update.mjs --tag v1.1.6 --targets framework --allow-framework --yes
```

Targets: `home` (laptop-5amudrke), `framework` (this machine, local), `server1` (Oracle Linux), or
`all` (home, server1, framework in that order). A real run including `framework` requires
`--allow-framework`, because restarting its T3 ends the active conversation.

Windows targets:

- Stop the T3 app and, when the WinSW `t3code` service exists (the Framework), stop that service
  first. Its headless child keeps `T3 Code (Beta).exe` open, so the NSIS installer cannot replace
  the exe while it runs.
- Verify the download's SHA-256, then install `/S /currentuser`; a respawn guard kills any T3
  process the supervisor tries to start while NSIS is replacing files.
- Start `t3code` again (it exec's the same absolute path, so it now serves the new build) and wait
  for `:3773`. On machines without the service (the laptop), relaunch the app through a one-shot
  `/IT` scheduled task so it lands in the logged-on user's session.
- Print `before=` / `after=` from the installed `FileVersion`; a version mismatch fails the run.

Run a local Framework update from an elevated shell. If the process is not elevated and `t3code`
exists, the tool registers the one-shot `T3FleetUpdate` task with `/RL HIGHEST`; it runs
`%LOCALAPPDATA%\t3-fleet\update.ps1` and logs to `%LOCALAPPDATA%\t3-fleet\update.log`. That restart
ends the calling thread, so read the log afterwards.

server-1 unpacks the Linux runtime next to the current one, verifies `t3 --version`, repoints
`t3code.service`, restarts it, and keeps the previous directory for rollback. Updating restarts T3
and interrupts running threads.

