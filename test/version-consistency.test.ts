import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { AcpBridgeRuntime } from "../src/acp/index.js";
import { compatibility } from "../src/compatibility.js";
import { releaseReadiness } from "../src/release.js";
import type { SessionState } from "../src/session/index.js";
import { MemoryStateStore } from "../src/state/index.js";

describe("release version consistency", () => {
  it("derives ACP, compatibility, release readiness and built CLI metadata from package.json", () => {
    const packageJson = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as { version: string };
    expect(packageJson.version).toBe("1.1.2");
    const runtime = new AcpBridgeRuntime({
      store: new MemoryStateStore<SessionState>(),
      controller: {
        resolveProject: async () => { throw new Error("unused"); },
        send: async () => { throw new Error("unused"); },
        session: async () => { throw new Error("unused"); },
      },
    });
    expect(runtime.initialize(2).agentInfo?.version).toBe(packageJson.version);
    expect(compatibility.bridge.version).toBe(packageJson.version);
    expect(releaseReadiness().bridgeVersion).toBe(packageJson.version);

    const cli = path.join(process.cwd(), "dist", "cli", "index.js");
    const compatibilityOutput = JSON.parse(execFileSync(process.execPath, [cli, "--compatibility"], { cwd: process.cwd(), encoding: "utf8", windowsHide: true })) as { bridge: { version: string } };
    const readinessOutput = JSON.parse(execFileSync(process.execPath, [cli, "--release-readiness"], { cwd: process.cwd(), encoding: "utf8", windowsHide: true })) as { bridgeVersion: string };
    expect(compatibilityOutput.bridge.version).toBe(packageJson.version);
    expect(readinessOutput.bridgeVersion).toBe(packageJson.version);
  });
});
