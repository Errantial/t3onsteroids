import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { BridgeMetrics } from "../src/metrics.js";
import { runProductionAcpStdio } from "../src/acp/stdio.js";

describe("ACP metrics export", () => {
  const roots: string[] = [];
  afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

  it("writes a metadata-only snapshot only when explicitly requested", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "t3os-metrics-"));
    roots.push(root);
    const profile = path.join(root, "profile");
    const state = path.join(root, "state");
    const out = path.join(root, "evidence", "metrics.json");
    await fs.mkdir(profile, { recursive: true });
    const input = new PassThrough();
    const output = new PassThrough();
    const metrics = new BridgeMetrics();
    metrics.beginTurn("session-secret", 1, 10);
    metrics.markTurn("session-secret", 1, "cos_input_accepted");
    input.end();
    await runProductionAcpStdio({
      env: { ...process.env, T3ONSTEROIDS_COS_USER_DATA_DIR: profile, T3ONSTEROIDS_STATE_DIR: state, T3ONSTEROIDS_METRICS_PATH: out },
      stdin: input,
      stdout: output,
      metrics,
    });
    const snapshot = JSON.parse(await fs.readFile(out, "utf8"));
    expect(snapshot.recentTurns).toHaveLength(1);
    expect(snapshot.recentTurns[0].sessionKey).toMatch(/^[0-9a-f]{8}$/);
    expect(JSON.stringify(snapshot)).not.toContain("session-secret");
  });
});
