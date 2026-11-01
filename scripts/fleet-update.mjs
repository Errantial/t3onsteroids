#!/usr/bin/env node
/**
 * Fleet update for the three T3 instances.
 *
 * One machine at a time, stop on the first failure, never print credentials.
 *
 * Windows targets stop the T3 app and, when present, the WinSW `t3code` service that keeps the
 * installed exe locked, install the NSIS package silently, then start the service again (or
 * relaunch the app in the logged-on user's session) and verify the installed FileVersion.
 *
 * server-1 unpacks the Linux CLI runtime next to the current one, repoints its user unit, and
 * keeps the previous directory for rollback.
 *
 * Usage:
 *   node scripts/fleet-update.mjs --tag latest --targets all --dry-run
 *   node scripts/fleet-update.mjs --tag v1.1.6 --targets server1 --yes
 *   node scripts/fleet-update.mjs --tag v1.1.6 --targets home,server1 --yes
 *   node scripts/fleet-update.mjs --tag v1.1.6 --targets framework --allow-framework --yes
 *
 * `all` expands to home, server1, framework. A real run including `framework` requires
 * `--allow-framework` because restarting this machine's T3 ends the active conversation.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "Errantial/t3onsteroids";
const KNOWN_TARGETS = ["home", "framework", "server1"];

const TARGETS = {
  home: {
    kind: "windows-ssh",
    host: "laptop-5amudrke",
    sshArgs: ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15"],
    powershell: "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
  },
  framework: {
    kind: "windows-local",
  },
  server1: {
    kind: "linux-ssh",
    host: "server-1",
    sshArgs: ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15"],
    t3Home: "/home/opc/.t3-nightly",
    service: "t3code.service",
  },
};

function usage(message) {
  if (message) console.error(`fleet-update: ${message}`);
  console.error(
    "usage: node scripts/fleet-update.mjs [--tag latest|vX.Y.Z] [--targets all|home,framework,server1] [--dry-run] [--yes] [--allow-framework] [--keep-wsl-t3]",
  );
  process.exit(2);
}

function parseArgs(argv) {
  const options = { tag: "latest", targets: "all", dryRun: false, yes: false, allowFramework: false, keepWslT3: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--yes" || arg === "-y") options.yes = true;
    else if (arg === "--allow-framework") options.allowFramework = true;
    else if (arg === "--keep-wsl-t3") options.keepWslT3 = true;
    else if (arg === "--tag") options.tag = argv[++index] ?? usage("--tag needs a value");
    else if (arg.startsWith("--tag=")) options.tag = arg.slice(6);
    else if (arg === "--targets") options.targets = argv[++index] ?? usage("--targets needs a value");
    else if (arg.startsWith("--targets=")) options.targets = arg.slice(10);
    else if (arg === "--help" || arg === "-h") usage();
    else usage(`unknown argument ${arg}`);
  }
  return options;
}

function resolveTargets(spec) {
  if (spec === "all") return ["home", "server1", "framework"];
  const list = spec.split(",").map((item) => item.trim()).filter(Boolean);
  const unknown = list.filter((item) => !KNOWN_TARGETS.includes(item));
  if (unknown.length > 0) usage(`unknown target(s): ${unknown.join(", ")}`);
  return list;
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    ...options,
  });
}

function ghJson(path) {
  return JSON.parse(run("gh", ["api", path, "--jq", "."], { encoding: "utf8" }));
}

function loadRelease(tag) {
  const release =
    tag === "latest"
      ? ghJson(`repos/${REPO}/releases/latest`)
      : ghJson(`repos/${REPO}/releases/tags/${encodeURIComponent(tag)}`);
  const assets = new Map(release.assets.map((asset) => [asset.name, asset]));
  const windows = [...assets.keys()].find((name) => /^T3-Code-.+-x64\.exe$/.test(name));
  if (!windows) throw new Error(`release ${release.tag_name} has no Windows installer`);
  const version = windows.replace(/^T3-Code-/, "").replace(/-x64\.exe$/, "");
  const sums = assets.get("SHA256SUMS.txt");
  if (!sums) throw new Error(`release ${release.tag_name} has no SHA256SUMS.txt`);
  return { release, assets, version, windows, sums };
}

function linuxArchiveName(version, arch) {
  return `t3-${version}-linux-${arch}.tar.gz`;
}

function targetArchitecture(target) {
  const machine = ssh(target, "uname -m").trim().toLowerCase();
  return /^(aarch64|arm64)$/.test(machine) ? "arm64" : "x64";
}

function fetchBytes(url) {
  return fetch(url, { redirect: "follow" }).then((response) => {
    if (!response.ok) throw new Error(`GET ${url} -> ${response.status}`);
    return response.arrayBuffer().then((buffer) => Buffer.from(buffer));
  });
}

async function loadChecksums(sumsAsset) {
  const text = (await fetchBytes(sumsAsset.browser_download_url)).toString("utf8");
  const map = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line.trim());
    if (match) map.set(match[2].trim(), match[1].toLowerCase());
  }
  return map;
}

function powershell(encoded, options = {}) {
  return run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], options);
}

function encodePowerShell(script) {
  return Buffer.from(script, "utf16le").toString("base64");
}

function remotePowerShell(target, script) {
  const encoded = encodePowerShell(script);
  return run("ssh", [...target.sshArgs, target.host, `${target.powershell} -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}`]);
}

const INSTALLED_EXE = String.raw`$p = Join-Path $env:LOCALAPPDATA 'Programs\t3code\T3 Code (Beta).exe'; if (Test-Path $p) { (Get-Item $p).VersionInfo.FileVersion } else { '' }`;

function installedWindowsVersion(target, local) {
  const script = `[Console]::Out.Write((& { ${INSTALLED_EXE} }))`;
  return local ? powershell(encodePowerShell(script)).trim() : remotePowerShell(target, script).trim();
}

function localIsAdmin() {
  const script =
    "[Console]::Out.Write(([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))";
  return powershell(encodePowerShell(script)).trim().toLowerCase() === "true";
}

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

/**
 * Stops the WinSW service (if any) before the installer, because the service's headless child
 * keeps `T3 Code (Beta).exe` open and makes the silent NSIS install abort. Starts it again, or
 * relaunches the GUI through a one-shot `/IT` task so it lands in the logged-on user's session.
 */
function windowsInstallScript(url, expectedSha256, expectedVersion) {
  return String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$ConfirmPreference = 'None'

$url = '${url}'
$wantSha256 = '${expectedSha256}'.ToUpperInvariant()
$wantVersion = '${expectedVersion}'
$serviceName = 't3code'
$appDir = Join-Path $env:LOCALAPPDATA 'Programs\t3code'
$appExe = Join-Path $appDir 'T3 Code (Beta).exe'
$port = 3773

function Out-Line([string]$text) { [Console]::Out.WriteLine($text) }
function Get-ExeVersion { if (Test-Path -LiteralPath $appExe) { (Get-Item -LiteralPath $appExe).VersionInfo.FileVersion } else { '' } }
function Test-Admin { return ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) }
function Get-Listener { return (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1) }
function Wait-Listener([int]$seconds) {
  for ($i = 0; $i -lt $seconds; $i++) {
    if (Get-Listener) { return $true }
    Start-Sleep -Seconds 1
  }
  return $false
}

function Get-T3Home { if ($env:T3CODE_HOME) { return $env:T3CODE_HOME } return (Join-Path $env:USERPROFILE '.t3') }
function Get-OwnEnvironmentId {
  $path = Join-Path (Get-T3Home) 'userdata\environment-id'
  if (-not (Test-Path -LiteralPath $path)) { return '' }
  return (Get-Content -LiteralPath $path -Raw).Trim()
}
# A listener on :3773 is not proof that this machine's T3 answers it: WSL localhost forwarding
# (wslrelay.exe) can hold 127.0.0.1:3773 for a T3 server inside WSL, and T3 Connect's tunnel
# targets 127.0.0.1, so the phone would reach the wrong environment.
function Get-LoopbackEnvironment {
  try {
    $d = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $port + '/.well-known/t3/environment') -TimeoutSec 5 -UseBasicParsing
    return [pscustomobject]@{ environmentId = [string]$d.environmentId; os = [string]$d.platform.os }
  } catch { return $null }
}
function Get-LoopbackOwners {
  $names = @()
  foreach ($c in (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)) {
    $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
    $names += ('{0}:{1}({2})' -f $c.LocalAddress, $c.OwningProcess, $(if ($p) { $p.ProcessName } else { '?' }))
  }
  return ($names -join ',')
}
function Assert-OwnEnvironment([int]$seconds) {
  $own = Get-OwnEnvironmentId
  if (-not $own) { Out-Line 'loopback_identity=skipped (no environment-id file)'; return }
  $seen = $null
  for ($i = 0; $i -lt $seconds; $i++) {
    $seen = Get-LoopbackEnvironment
    if ($seen -and $seen.environmentId -eq $own) { Out-Line "loopback_identity=ok $own"; return }
    Start-Sleep -Seconds 1
  }
  $got = if ($seen) { "$($seen.environmentId) os=$($seen.os)" } else { 'no answer' }
  throw "127.0.0.1:$port answers environment $got, not this machine's $own (listeners: $(Get-LoopbackOwners)). A WSL/SSH-launched T3 is probably holding loopback via WSL localhost forwarding; T3 Connect would route the phone to it. Stop it (scripts/wsl-stray-t3.sh --stop) and rerun."
}

function Get-AppProcesses {
  $found = @()
  foreach ($p in (Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)) {
    if ($p.ProcessId -eq $PID) { continue }
    if ($p.ExecutablePath -and $p.ExecutablePath.StartsWith($appDir, [StringComparison]::OrdinalIgnoreCase)) { $found += $p; continue }
    if ($p.Name -eq 'T3 Code (Beta)') { $found += $p }
  }
  return $found
}

function Stop-App {
  Get-Process -Name 'T3 Code (Beta)' -ErrorAction SilentlyContinue | ForEach-Object {
    try { [void]$_.CloseMainWindow() } catch { }
  }
  Start-Sleep -Seconds 3
  for ($round = 1; $round -le 5; $round++) {
    $procs = Get-AppProcesses
    if ($procs.Count -eq 0) { break }
    foreach ($p in $procs) {
      try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop } catch { }
    }
    Start-Sleep -Seconds 2
  }
}

function Stop-T3Service {
  $svc = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
  if (-not $svc) { return $false }
  Out-Line 'service=stopping'
  $null = & sc.exe stop $serviceName 2>&1
  for ($i = 0; $i -lt 30; $i++) {
    $svc = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
    if (-not $svc -or $svc.Status -eq 'Stopped') { break }
    Start-Sleep -Seconds 1
  }
  if ($svc -and $svc.Status -ne 'Stopped') { throw "t3code service did not stop (state=$($svc.Status)); refusing to install over a locked exe" }
  return $true
}

function Start-T3Service {
  $svc = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
  if (-not $svc) { return $false }
  $null = & sc.exe start $serviceName 2>&1
  if (-not (Wait-Listener 120)) { throw ':3773 did not come back within 120s after starting t3code' }
  return $true
}

function Invoke-Installer {
  $p = Start-Process -FilePath $installer -ArgumentList '/S', '/currentuser' -PassThru
  while (-not $p.HasExited) {
    Start-Sleep -Seconds 2
    foreach ($q in (Get-AppProcesses)) {
      if ($q.ProcessId -eq $p.Id) { continue }
      try { Stop-Process -Id $q.ProcessId -Force -ErrorAction Stop } catch { }
    }
  }
  return $p.ExitCode
}

$svc = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
if ($svc -and -not (Test-Admin)) {
  throw 'the t3code service must be stopped to replace the installed exe; run this from an elevated shell'
}

$before = Get-ExeVersion
Out-Line "before=$before"

$installer = Join-Path $env:TEMP ("t3-fleet-" + $wantVersion + ".exe")
Invoke-WebRequest -Uri $url -OutFile $installer -UseBasicParsing
$hash = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToUpperInvariant()
if ($hash -ne $wantSha256) { throw "SHA256 mismatch: got $hash, wanted $wantSha256" }
Out-Line 'sha256=ok'

$hadService = Stop-T3Service
Stop-App

$installerExit = Invoke-Installer
$after = Get-ExeVersion
if ($after -ne $wantVersion) {
  Out-Line "retry=installed version is $after"
  $null = Stop-T3Service
  Stop-App
  $installerExit = Invoke-Installer
  $after = Get-ExeVersion
}

$http = 'down'
if ($hadService) {
  $null = Start-T3Service
  $http = 'listen'
} else {
  $relaunchTask = 'T3FleetRelaunch'
  $null = & schtasks.exe /create /tn $relaunchTask /tr ('"' + $appExe + '"') /sc once /st 00:00 /it /f 2>&1
  $null = & schtasks.exe /run /tn $relaunchTask 2>&1
  Start-Sleep -Seconds 3
  $null = & schtasks.exe /delete /tn $relaunchTask /f 2>&1
  if (Wait-Listener 120) { $http = 'listen' }
}

$listener = Get-Listener
$listenerPid = if ($listener) { $listener.OwningProcess } else { '' }
$serviceState = if (Get-Service -Name $serviceName -ErrorAction SilentlyContinue) { (Get-Service -Name $serviceName).Status } else { 'none' }

if ($http -eq 'listen') { Assert-OwnEnvironment 60 }

Out-Line "installer_exit=$installerExit"
Out-Line "after=$after"
Out-Line "service=$serviceState"
Out-Line "http=$http"
Out-Line "listener=$listenerPid"
Out-Line 'DONE'

if ($after -ne $wantVersion) { throw "installed version is $after, wanted $wantVersion" }
`;
}

function runLocalWindowsInstall(script) {
  if (localIsAdmin()) {
    return powershell(encodePowerShell(script), { encoding: "utf8" });
  }

  // Not elevated and the t3code service exists: run the same script through a one-shot
  // highest-privilege task, the same mechanism that was used to install v1.1.5 by hand.
  const dir = join(process.env.LOCALAPPDATA ?? tmpdir(), "t3-fleet");
  mkdirSync(dir, { recursive: true });
  const scriptPath = join(dir, "update.ps1");
  const logPath = join(dir, "update.log");
  const donePath = join(dir, "update.done");
  const runnerPath = join(dir, "run.cmd");
  rmSync(donePath, { force: true });
  rmSync(logPath, { force: true });
  writeFileSync(scriptPath, script, "utf8");
  writeFileSync(
    runnerPath,
    [
      "@echo off",
      `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${scriptPath}" > "${logPath}" 2>&1`,
      `if %errorlevel%==0 echo done > "${donePath}"`,
      "",
    ].join("\r\n"),
    "utf8",
  );

  const task = "T3FleetUpdate";
  run("schtasks.exe", ["/create", "/tn", task, "/tr", `cmd.exe /c "${runnerPath}"`, "/sc", "once", "/st", "00:00", "/rl", "HIGHEST", "/f"]);
  run("schtasks.exe", ["/run", "/tn", task]);
  console.log(`[framework] scheduled ${task}; log: ${logPath}`);

  const deadline = Date.now() + 20 * 60 * 1000;
  while (!existsSync(donePath) && Date.now() < deadline) sleepSync(3000);
  try {
    run("schtasks.exe", ["/delete", "/tn", task, "/f"]);
  } catch {
    // The one-shot task may already have removed itself; cleanup is best-effort.
  }
  const output = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
  process.stdout.write(output);
  if (!existsSync(donePath)) throw new Error(`the scheduled update did not finish; read ${logPath}`);
  return output;
}

function linuxVersionScript(target) {
  return `
set -e
unit="$HOME/.config/systemd/user/${target.service}"
dir=$(sed -n 's|^ExecStart=\\(.*\\)/t3 __service-launcher$|\\1|p' "$unit" | head -1)
if [ -z "$dir" ]; then echo ""; exit 0; fi
"$dir/t3" --version
`;
}

function linuxInstallScript(target, url, expectedSha256, version) {
  const dest = `${target.t3Home}/runtime/versions/${version}`;
  return `
set -euo pipefail
unit="$HOME/.config/systemd/user/${target.service}"
archive=$(mktemp /tmp/t3-XXXXXX.tar.gz)
curl -fsSL '${url}' -o "$archive"
sum=$(sha256sum "$archive" | awk '{print $1}')
if [ "$sum" != '${expectedSha256}' ]; then echo "SHA256 mismatch: $sum" >&2; exit 1; fi
old=$(sed -n 's|^ExecStart=\\(.*\\)/t3 __service-launcher$|\\1|p' "$unit" | head -1)
dest='${dest}'
if [ ! -d "$dest" ]; then
  mkdir -p "$dest"
  tar -xzf "$archive" --strip-components=1 -C "$dest"
fi
rm -f "$archive"
"$dest/t3" --version >/dev/null
state='${target.t3Home}/runtime/service-state.json'
if [ -f "$state" ]; then cp -p "$state" "$state.bak"; fi
if [ -f "$state" ] && grep -q '"activeVersion"' "$state"; then
  sed -i 's|"activeVersion"[[:space:]]*:[[:space:]]*"[^"]*"|"activeVersion": "'"${version}"'"|' "$state"
else
  printf '{\\n  "protocol": 3,\\n  "activeVersion": "%s"\\n}\\n' '${version}' > "$state"
fi
sed -i "s|^ExecStart=.*/t3 __service-launcher$|ExecStart=$dest/t3 __service-launcher|" "$unit"
export XDG_RUNTIME_DIR=/run/user/$(id -u)
systemctl --user daemon-reload
systemctl --user restart ${target.service}
for i in $(seq 1 30); do
  if curl -fsS -o /dev/null "http://127.0.0.1:3773/"; then break; fi
  sleep 2
done
code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:3773/" || true)
echo "old=$old"
echo "new=$dest"
echo "http=$code"
"$dest/t3" --version
`;
}

// Lists (and with stop=true, stops) T3 servers that T3's SSH bootstrap launched inside this WSL
// distro on the host's default port. Mirrors T3's own REMOTE_STOP_SCRIPT: SIGTERM, wait 2 s,
// then drop pid/port/managed so the stale pid is not adopted. "external" servers are left alone.
function wslStrayT3Script(stop) {
  return `
set -u
port=3773
found=0
for dir in "$HOME"/.t3/ssh-launch/*/; do
  [ -f "$dir/pid" ] || continue
  pid=$(cat "$dir/pid" 2>/dev/null || true)
  p=$(cat "$dir/port" 2>/dev/null || true)
  kind=$(cat "$dir/managed" 2>/dev/null || echo managed)
  [ "$p" = "$port" ] || continue
  [ "$kind" = "external" ] && continue
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null || continue
  found=1
  echo "stray_wsl_t3=pid:$pid port:$p dir:$dir"
  if [ "${stop ? "1" : "0"}" = "1" ]; then
    kill -TERM "$pid" 2>/dev/null || true
    n=0; while kill -0 "$pid" 2>/dev/null && [ $n -lt 20 ]; do n=$((n+1)); sleep 0.1; done
    if kill -0 "$pid" 2>/dev/null; then echo "stray_wsl_t3_stop=failed pid:$pid"; exit 1; fi
    rm -f "$dir/pid" "$dir/port" "$dir/managed"
    echo "stray_wsl_t3_stop=ok pid:$pid"
  fi
done
[ $found -eq 0 ] && echo "stray_wsl_t3=none"
exit 0
`;
}

function ssh(target, script, options = {}) {
  return run("ssh", [...target.sshArgs, target.host, script], options);
}

function planLine(text) {
  console.log(`  ${text}`);
}

async function updateWindows(name, target, release, checksums, options) {
  const asset = release.assets.get(release.windows);
  const expected = checksums.get(release.windows);
  if (!expected) throw new Error(`SHA256SUMS does not cover ${release.windows}`);

  const local = target.kind === "windows-local";
  const before = installedWindowsVersion(target, local);
  console.log(`[${name}] before=${before || "unknown"}`);

  planLine(`install ${release.windows} (${asset.size} bytes) from ${asset.browser_download_url}`);
  planLine(`sha256 ${expected}`);
  planLine("stop the t3code service (when present) and the T3 app, verify the downloaded hash");
  planLine("install silently with /S /currentuser, then start the service or relaunch the app");
  planLine("verify the installed FileVersion and wait for :3773");
  planLine("verify 127.0.0.1:3773 answers this machine's own environment id (not a WSL/SSH-launched T3)");
  if (target.kind === "windows-ssh") {
    planLine(`${options.keepWslT3 ? "report" : "stop"} SSH-launched T3 servers on :3773 inside ${target.host}'s WSL first`);
    const stray = ssh(target, wslStrayT3Script(!options.dryRun && !options.keepWslT3)).trim();
    for (const line of stray.split("\n")) console.log(`[${name}] ${line}`);
  }

  if (options.dryRun) return;

  const script = windowsInstallScript(asset.browser_download_url, expected, release.version);
  const result = local ? runLocalWindowsInstall(script) : remotePowerShell(target, script);
  process.stdout.write(result.endsWith("\n") ? result : `${result}\n`);
}

function updateLinux(name, target, release, checksums, options) {
  const before = ssh(target, linuxVersionScript(target)).trim();
  console.log(`[${name}] before=${before || "unknown"}`);
  const arch = targetArchitecture(target);
  const archive = linuxArchiveName(release.version, arch);
  const asset = release.assets.get(archive);
  if (!asset) throw new Error(`release ${release.release.tag_name} has no ${archive}`);
  const expected = checksums.get(archive);
  if (!expected) throw new Error(`SHA256SUMS does not cover ${archive}`);
  planLine(`install ${archive} (${asset.size} bytes) from ${asset.browser_download_url}`);
  planLine(`sha256 ${expected}`);
  planLine(`extract to ${target.t3Home}/runtime/versions/${release.version}, keep the previous directory`);
  planLine(`repoint ${target.service} ExecStart and restart it`);
  if (options.dryRun) return;
  const result = ssh(target, linuxInstallScript(target, asset.browser_download_url, expected, release.version), { encoding: "utf8" });
  process.stdout.write(result);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const targets = resolveTargets(options.targets);
  if (targets.includes("framework") && !options.dryRun && !options.allowFramework) {
    throw new Error(
      "the framework target restarts this machine's T3 and ends the active thread; use --targets home,server1, or pass --allow-framework to accept the restart",
    );
  }

  const release = loadRelease(options.tag);
  const checksums = await loadChecksums(release.sums);
  const linuxAssets = [...release.assets.keys()].filter((name) => /^t3-.+-linux-(x64|arm64)\.tar\.gz$/.test(name));
  console.log(
    `release ${release.release.tag_name} version ${release.version} (windows ${release.windows}; linux ${linuxAssets.length > 0 ? linuxAssets.join(", ") : "missing"})`,
  );

  if (!options.dryRun && !options.yes && !process.stdin.isTTY) {
    throw new Error("refusing to update without --yes in a non-interactive shell");
  }

  for (const name of targets) {
    const target = TARGETS[name];
    if (!target) throw new Error(`unknown target ${name}`);
    console.log(`\n== ${name} (${target.kind}) ==`);
    if (target.kind === "linux-ssh") updateLinux(name, target, release, checksums, options);
    else await updateWindows(name, target, release, checksums, options);
  }

  if (options.dryRun) console.log("\ndry run complete; nothing was changed");
}

export { windowsInstallScript, linuxInstallScript, wslStrayT3Script };

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    const stderr = error && typeof error === "object" && "stderr" in error ? String(error.stderr ?? "").trim() : "";
    console.error(`fleet-update: ${message}${stderr ? `\n${stderr}` : ""}`);
    process.exit(1);
  });
}
