import { describe, expect, it, vi } from "vitest";

import { main } from "../src/cli/index.js";
import { runSetupDiagnostics } from "../src/diagnostics.js";
import { releaseReadiness } from "../src/release.js";
import { CosControllerClient, type CosControllerDiscovery } from "../src/cos/index.js";

const extensionHealth = {
  protocol: 1,
  app: "chat-on-steroids",
  actions: { enabled: true, routes: ["POST /v1/inputs"] },
  features: {
    "provider-project-resolve-v1": 1,
    "provider-assistant-content-v1": 1,
    "provider-session-policy-v1": 1,
  },
};

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

describe("Phase 7 release readiness", () => {
  it("keeps the supported release lane explicitly pinned and single-turn", () => {
    expect(releaseReadiness()).toEqual({
      supportedConcurrency: 1,
      platform: "win32-x64",
      t3Pinned: true,
      cosPinned: true,
      controllerProtocol: 1,
      productionAcpEntrypoint: false,
      cosProviderExtensionReady: false,
      eventTranslatorReady: false,
      durableRecoveryReady: false,
      liveAcceptanceRequired: true,
      currentHeadDriftRequired: true,
      releaseQualified: false,
    });
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
