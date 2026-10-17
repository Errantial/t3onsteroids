import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { implementationCommit } from "../scripts/implementation-commit.mjs";

const roots: string[] = [];

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
}

async function commit(cwd: string, file: string, content: string, message: string): Promise<string> {
  const full = path.join(cwd, file);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content);
  git(cwd, ["add", "--", file]);
  git(cwd, ["commit", "-m", message]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("implementation commit identity", () => {
  it("ignores evidence-only and release-manifest commits but advances on implementation inputs", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "t3os-implementation-commit-"));
    roots.push(root);
    git(root, ["init"]);
    git(root, ["config", "user.email", "fixture@example.invalid"]);
    git(root, ["config", "user.name", "fixture"]);

    const implementation = await commit(root, "src/runtime.ts", "export const a = 1;\n", "implementation");
    await commit(root, "docs/evidence/v1.md", "PASS\n", "evidence");
    await commit(root, "src/release-manifest.ts", "export const gates = {};\n", "gate status");
    expect(implementationCommit(root)).toBe(implementation);

    const next = await commit(root, "scripts/helper.mjs", "export const b = 2;\n", "implementation script");
    expect(implementationCommit(root)).toBe(next);
  });
});
