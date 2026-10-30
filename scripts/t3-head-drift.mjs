#!/usr/bin/env node
/* global process */
/**
 * T3-HEAD drift detection for the post-v1 compatibility lane.
 *
 * The pinned support tuple names one exact T3 SHA. This script asks the upstream repository for its
 * current HEAD and reports whether the pin still matches. It does not build or run T3: a different
 * HEAD is a compatibility *issue to investigate*, not a proven incompatibility, and widening the
 * support tuple still requires the full matrix against a built HEAD checkout.
 *
 * Output is one JSON object with no repository contents, credentials or page text.
 */
import { execFileSync } from "node:child_process";
import { compatibility } from "../dist/compatibility.js";

function option(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
}

const remote = option("remote", "https://github.com/pingdotgg/t3code");
const pinnedSha = compatibility.t3.sha;
let headSha = null;
let outcome = "unreachable";
try {
  const output = execFileSync("git", ["ls-remote", remote, "HEAD"], {
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  const match = /^([0-9a-f]{40})\s+HEAD$/m.exec(output.replaceAll("\r", ""));
  if (match) {
    headSha = match[1];
    outcome = headSha === pinnedSha ? "compatible" : "drift";
  }
} catch {
  outcome = "unreachable";
}

process.stdout.write(JSON.stringify({
  schemaVersion: 1,
  pinnedVersion: compatibility.t3.version,
  pinnedSha,
  remote,
  headSha,
  outcome,
  matrix: "not_run",
  wideningBlocked: outcome !== "compatible",
}) + "\n");
process.exit(outcome === "unreachable" ? 2 : 0);
