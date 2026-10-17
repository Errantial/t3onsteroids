#!/usr/bin/env node

import { compatibility } from "../compatibility.js";
import { runSetupDiagnostics } from "../diagnostics.js";
import { releaseReadiness } from "../release.js";

export async function main(argv: readonly string[]): Promise<number> {
  if (argv.includes("--compatibility")) {
    process.stdout.write(`${JSON.stringify(compatibility)}\n`);
    return 0;
  }

  if (argv.includes("--release-readiness")) {
    process.stdout.write(`${JSON.stringify(releaseReadiness())}\n`);
    return 0;
  }

  if (argv.includes("--diagnose")) {
    const userDataIndex = argv.indexOf("--user-data-dir");
    const cwdIndex = argv.indexOf("--cwd");
    const userDataDir = userDataIndex >= 0 ? argv[userDataIndex + 1] : undefined;
    if (!userDataDir) {
      process.stderr.write("--diagnose requires --user-data-dir <path>.\n");
      return 2;
    }
    const cwd = cwdIndex >= 0 ? argv[cwdIndex + 1] : undefined;
    const result = await runSetupDiagnostics({ userDataDir, ...(cwd ? { cwd } : {}) });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result.ready ? 0 : 3;
  }

  if (argv.includes("--help") || argv.length === 0) {
    process.stdout.write(
      [
        "t3onsteroids",
        "",
        "T3 Code compatibility bridge for Chat On Steroids.",
        "",
        "Options:",
        "  --compatibility  Print pinned compatibility metadata",
        "  --release-readiness  Print release support boundaries",
        "  --diagnose --user-data-dir <path> [--cwd <path>]  Run read-only setup diagnostics",
        "  --help           Show this help",
      ].join("\n") + "\n",
    );
    return 0;
  }

  process.stderr.write("No command supplied. Use --help for supported release/setup commands.\n");
  return 2;
}

void main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
