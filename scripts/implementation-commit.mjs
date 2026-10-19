import { execFileSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const IMPLEMENTATION_PATHS = [
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "tsconfig.build.json",
  "eslint.config.js",
  "vitest.config.ts",
  "src",
  "test",
  "scripts",
];

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
}

export function implementationCommit(cwd = process.cwd()) {
  const commits = git(["rev-list", "HEAD", "--", ...IMPLEMENTATION_PATHS], cwd)
    .split(/\r?\n/)
    .filter(Boolean);
  for (const commit of commits) {
    const names = git(["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", commit], cwd)
      .split(/\r?\n/)
      .filter(Boolean);
    if (names.some((name) => name !== "src/release-manifest.ts" && (
      IMPLEMENTATION_PATHS.includes(name)
      || name.startsWith("src/")
      || name.startsWith("test/")
      || name.startsWith("scripts/")
    ))) return commit;
  }
  throw new Error("No implementation-input commit found");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${implementationCommit()}\n`);
}
