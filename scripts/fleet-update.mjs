#!/usr/bin/env node
/**
 * Fleet update for the three T3 instances.
 *
 * One machine at a time, stop on the first failure, never print credentials. Windows targets
 * install the NSIS package silently; server-1 unpacks the Linux CLI runtime next to the current
 * one, repoints its user unit, and keeps the previous version for rollback.
 *
 * Usage:
 *   node scripts/fleet-update.mjs --tag latest --targets all --dry-run
 *   node scripts/fleet-update.mjs --tag v1.1.6 --targets server1 --yes
 *   node scripts/fleet-update.mjs --tag v1.1.6 --targets home,server1 --yes
 *
 * `all` expands to home, server1, framework; a real run refuses the framework target because
 * restarting its T3 ends the active conversation.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
    "usage: node scripts/fleet-update.mjs [--tag latest|vX.Y.Z] [--targets all|home,framework,server1] [--dry-run] [--yes]",
  );
  process.exit(2);
}

function parseArgs(argv) {
  const options = { tag: "latest", targets: "all", dryRun: false, yes: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--yes" || arg === "-y") options.yes = true;
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

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
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

function windowsInstallScript(url, expectedSha256) {
  return `
$ErrorActionPreference = 'Stop'
$installer = Join-Path $env:TEMP 't3-fleet-update.exe'
Invoke-WebRequest -Uri '${url}' -OutFile $installer -UseBasicParsing
$hash = (Get-FileHash $installer -Algorithm SHA256).Hash.ToLowerInvariant()
if ($hash -ne '${expectedSha256}') { throw "SHA256 mismatch: $hash" }
$process = Start-Process -FilePath $installer -ArgumentList '/S' -Wait -PassThru
if ($process.ExitCode -ne 0) { throw "installer exit $($process.ExitCode)" }
$exe = Join-Path $env:LOCALAPPDATA 'Programs\\t3code\\T3 Code (Beta).exe'
Start-Process -FilePath $exe | Out-Null
[Console]::Out.Write((Get-Item $exe).VersionInfo.FileVersion)
`;
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
  if (options.dryRun || local) {
    // The local machine is never restarted by this script; it only reports the plan.
    if (local && !options.dryRun) throw new Error("framework updates restart T3 and must be run by the user");
  }
  const before = installedWindowsVersion(target, local);
  console.log(`[${name}] before=${before || "unknown"}`);
  planLine(`install ${release.windows} (${asset.size} bytes) from ${asset.browser_download_url}`);
  planLine(`sha256 ${expected}`);
  if (options.dryRun) return;
  const after = local
    ? powershell(encodePowerShell(windowsInstallScript(asset.browser_download_url, expected))).trim()
    : remotePowerShell(target, windowsInstallScript(asset.browser_download_url, expected)).trim();
  console.log(`[${name}] after=${after || "unknown"}`);
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
  if (targets.includes("framework") && !options.dryRun) {
    throw new Error("the framework target would restart this thread's T3; run it last from an elevated shell, or use --dry-run");
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
    else updateWindows(name, target, release, checksums, options);
  }

  if (options.dryRun) console.log("\ndry run complete; nothing was changed");
}

main().catch((error) => {
  console.error(`fleet-update: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
