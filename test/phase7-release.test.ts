import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { main } from "../src/cli/index.js";
import { compatibility } from "../src/compatibility.js";
import { runSetupDiagnostics } from "../src/diagnostics.js";
import { releaseReadiness } from "../src/release.js";
import { v1ReleaseGateManifest } from "../src/release-manifest.js";
import { COS_REQUIRED_ACTION_ROUTES, CosControllerClient, type CosControllerDiscovery } from "../src/cos/index.js";

const extensionHealth = {
  protocol: 1,
  app: "chat-on-steroids",
  actions: { enabled: true, routes: [...COS_REQUIRED_ACTION_ROUTES] },
  features: {
    "provider-project-resolve-v1": 1,
    "provider-assistant-content-v1": 1,
    "provider-session-policy-v1": 1,
    "provider-turn-drain-v1": 1,
  },
  providerExtension: { apiVersion: 1, buildId: compatibility.cos.providerExtension.buildId },
};
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function diagnosticRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "t3os-diagnostics-"));
  roots.push(root);
  await fs.mkdir(path.join(root, "control-api"));
  return root;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

describe("Phase 7 release readiness", () => {
  it("keeps the supported release lane explicitly pinned and single-turn", () => {
    const readiness = releaseReadiness();
    expect(readiness).toMatchObject({
      bridgeVersion: "1.0.0",
      supportedConcurrency: 1,
      platform: "win32-x64",
      t3Pinned: true,
      cosPinned: true,
      controllerProtocol: 1,
      productionAcpEntrypoint: true,
      cosProviderExtensionReady: true,
      eventTranslatorReady: true,
      durableRecoveryReady: true,
    });
    expect(readiness.liveAcceptanceRequired).toBe(v1ReleaseGateManifest.gates.liveAcceptance.status !== "pass");
    expect(readiness.currentHeadDriftRequired).toBe(v1ReleaseGateManifest.gates.t3HeadDrift.status !== "pass");
    expect(readiness.releaseQualified).toBe(
      Object.values(v1ReleaseGateManifest.gates).every((gate) => gate.status === "pass"),
    );
  });

  it("diagnoses exact extension/actions/project readiness without returning credentials", async () => {
    const discovery: CosControllerDiscovery = { baseUrl: "http://127.0.0.1:9", token: "do-not-leak" };
    const fetch = vi.fn(async (url: string | URL | Request) => {
      const text = String(url);
      if (text.endsWith("/v1/health")) return json(extensionHealth);
      if (text.endsWith("/v1/projects/resolve")) return json({ projectId: "p", name: "repo", canonicalPath: "C:\\repo" });
      throw new Error(`unexpected ${text}`);
    });
    const result = await runSetupDiagnostics({
      userDataDir: "C:\\fake",
      cwd: "C:\\repo",
      discover: vi.fn(async () => discovery),
      clientFactory: (discover) => new CosControllerClient(discover, { fetch }),
    }).catch((error) => ({ error }));
    // The filesystem precheck intentionally fails for the fake path before network discovery.
    expect(JSON.stringify(result)).not.toContain("do-not-leak");
  });

  it.each([
    [compatibility.cos.providerExtension.buildId, true],
    ["b".repeat(40), false],
    ["development", false],
  ])("diagnoses provider-extension build %s against the exact compatibility pin", async (buildId, expectedReady) => {
    const root = await diagnosticRoot();
    const discovery: CosControllerDiscovery = { baseUrl: "http://127.0.0.1:9", token: "diagnostic-secret" };
    const health = { ...extensionHealth, providerExtension: { apiVersion: 1, buildId } };
    const fetch = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith("/v1/health")) return json(health);
      throw new Error(`unexpected ${String(url)}`);
    });
    const result = await runSetupDiagnostics({
      userDataDir: root,
      discover: vi.fn(async () => discovery),
      clientFactory: (discover) => new CosControllerClient(discover, { fetch }),
    });

    expect(result.ready).toBe(expectedReady);
    expect(result.items.find((item) => item.id === "provider-extension")?.status).toBe(expectedReady ? "ok" : "error");
    expect(JSON.stringify(result)).not.toContain("diagnostic-secret");
  });

  it("derives extension, actions and required routes from one health snapshot without stale mixing", async () => {
    const root = await diagnosticRoot();
    const discovery: CosControllerDiscovery = { baseUrl: "http://127.0.0.1:9", token: "diagnostic-secret" };
    let healthReads = 0;
    const fetch = vi.fn(async (url: string | URL | Request) => {
      if (!String(url).endsWith("/v1/health")) throw new Error(`unexpected ${String(url)}`);
      healthReads += 1;
      return json(healthReads === 1
        ? extensionHealth
        : {
            ...extensionHealth,
            actions: { enabled: false, routes: [] },
            providerExtension: { apiVersion: 1, buildId: "development" },
          });
    });

    const result = await runSetupDiagnostics({
      userDataDir: root,
      discover: vi.fn(async () => discovery),
      clientFactory: (discover) => new CosControllerClient(discover, { fetch }),
    });

    expect(healthReads).toBe(1);
    expect(result.ready).toBe(true);
    expect(result.items.find((item) => item.id === "provider-extension")?.status).toBe("ok");
    expect(result.items.find((item) => item.id === "actions")?.status).toBe("ok");
    expect(result.items.find((item) => item.id === "action-routes")?.status).toBe("ok");
  });

  it("keeps diagnostics explicit when user-data is unavailable", async () => {
    const result = await runSetupDiagnostics({ userDataDir: "Z:\\definitely-missing-t3onsteroids" });
    expect(result.ready).toBe(false);
    expect(result.items[0]).toMatchObject({ id: "control-api-dir", status: "error" });
  });

  it("prints release support boundaries through the side-effect-free CLI", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await expect(main(["--release-readiness"])).resolves.toBe(0);
    expect(write).toHaveBeenCalledWith(expect.stringContaining('"supportedConcurrency":1'));
    write.mockRestore();
  });
});
