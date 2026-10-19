import { describe, expect, it, vi } from "vitest";
import { compatibility } from "../src/compatibility.js";
import {
  COS_PROVIDER_EXTENSION_FEATURES,
  COS_REQUIRED_ACTION_ROUTES,
  CosControllerClient,
  CosControllerError,
  parseHealth,
} from "../src/cos/index.js";

const extensionFeatures = Object.fromEntries(Object.values(COS_PROVIDER_EXTENSION_FEATURES).map((feature) => [feature, 1]));
const providerBuildId = compatibility.cos.providerExtension.buildId;
const extensionHealth = {
  protocol: 1,
  app: "chat-on-steroids",
  actions: { enabled: true, routes: [...COS_REQUIRED_ACTION_ROUTES] },
  features: extensionFeatures,
  providerExtension: { apiVersion: 1, buildId: providerBuildId },
};

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

describe("CoS provider extension contract", () => {
  it("distinguishes stock protocol 1 from the required extension feature set", async () => {
    expect(parseHealth({ ...extensionHealth, features: undefined }).features).toEqual({});
    const client = new CosControllerClient(async () => ({ baseUrl: "http://127.0.0.1:9", token: "secret" }), {
      fetch: vi.fn(async () => jsonResponse({ ...extensionHealth, features: { [COS_PROVIDER_EXTENSION_FEATURES.projectResolve]: 1 } })),
    });
    await expect(client.requireProviderExtension()).rejects.toMatchObject({ code: "provider_extension_unavailable" });

    const futureVersionClient = new CosControllerClient(async () => ({ baseUrl: "http://127.0.0.1:9", token: "secret" }), {
      fetch: vi.fn(async () => jsonResponse({
        ...extensionHealth,
        features: { ...extensionFeatures, [COS_PROVIDER_EXTENSION_FEATURES.turnDrain]: 2 },
      })),
    });
    await expect(futureVersionClient.requireProviderExtension()).rejects.toMatchObject({ code: "provider_extension_unavailable" });
  });

  it("requires the exact provider extension build identity as well as all four features", async () => {
    const missingClient = new CosControllerClient(async () => ({ baseUrl: "http://127.0.0.1:9", token: "secret" }), {
      fetch: vi.fn(async () => jsonResponse({ ...extensionHealth, providerExtension: undefined })),
    });
    await expect(missingClient.requireProviderExtension()).rejects.toMatchObject({ code: "provider_extension_unavailable" });

    const wrongBuildClient = new CosControllerClient(async () => ({ baseUrl: "http://127.0.0.1:9", token: "secret" }), {
      fetch: vi.fn(async () => jsonResponse({ ...extensionHealth, providerExtension: { apiVersion: 1, buildId: "b".repeat(40) } })),
    });
    await expect(wrongBuildClient.requireProviderExtension()).rejects.toMatchObject({ code: "provider_extension_unavailable" });

    const developmentClient = new CosControllerClient(async () => ({ baseUrl: "http://127.0.0.1:9", token: "secret" }), {
      fetch: vi.fn(async () => jsonResponse({ ...extensionHealth, providerExtension: { apiVersion: 1, buildId: "development" } })),
    });
    await expect(developmentClient.requireProviderExtension()).rejects.toMatchObject({ code: "provider_extension_unavailable" });

    const exactClient = new CosControllerClient(async () => ({ baseUrl: "http://127.0.0.1:9", token: "secret" }), {
      fetch: vi.fn(async () => jsonResponse(extensionHealth)),
    });
    await expect(exactClient.requireProviderExtension()).resolves.toMatchObject({ providerExtension: { apiVersion: 1, buildId: providerBuildId } });
    expect(parseHealth(extensionHealth).providerExtension).toEqual({ apiVersion: 1, buildId: providerBuildId });
  });

  it("requires every production send/cancel/Stop action route projected by protocol 1 health", async () => {
    const missingStop = new CosControllerClient(async () => ({ baseUrl: "http://127.0.0.1:9", token: "secret" }), {
      fetch: vi.fn(async () => jsonResponse({
        ...extensionHealth,
        actions: { enabled: true, routes: COS_REQUIRED_ACTION_ROUTES.filter((route) => route !== "POST /v1/sessions/{id}/stop") },
      })),
    });

    await expect(missingStop.requireProviderExtension()).rejects.toMatchObject({ code: "provider_extension_unavailable" });
  });

  it("resolves only the single exact canonical project returned by the controller", async () => {
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const text = String(url);
      if (text.endsWith("/v1/health")) return jsonResponse(extensionHealth);
      if (text.endsWith("/v1/projects/resolve") && init?.method === "POST") {
        expect(JSON.parse(String(init.body))).toEqual({ path: "C:\\Users\\emilg\\t3onsteroids" });
        return jsonResponse({ projectId: "project-1", name: "t3onsteroids", canonicalPath: "C:\\Users\\emilg\\t3onsteroids" });
      }
      throw new Error(`unexpected ${text}`);
    });
    const client = new CosControllerClient(async () => ({ baseUrl: "http://127.0.0.1:9", token: "secret" }), { fetch });
    await expect(client.resolveProject("C:\\Users\\emilg\\t3onsteroids")).resolves.toEqual({
      projectId: "project-1",
      name: "t3onsteroids",
      canonicalPath: "C:\\Users\\emilg\\t3onsteroids",
    });
  });

  it("maps exact-project failure without exposing a catalog fallback", async () => {
    const fetch = vi.fn(async (url: string | URL | Request) => {
      const text = String(url);
      if (text.endsWith("/v1/health")) return jsonResponse(extensionHealth);
      if (text.endsWith("/v1/projects/resolve")) return jsonResponse({ code: "project_unmapped" }, 404);
      throw new Error(`unexpected ${text}`);
    });
    const client = new CosControllerClient(async () => ({ baseUrl: "http://127.0.0.1:9", token: "secret" }), { fetch });
    await expect(client.resolveProject("C:\\worktree")).rejects.toMatchObject({ code: "project_unmapped" });
  });

  it("assembles full assistant content from stable event-identity chunks", async () => {
    const text = "x".repeat(5_500);
    const fetch = vi.fn(async (url: string | URL | Request) => {
      const value = String(url);
      if (value.endsWith("/v1/health")) return jsonResponse(extensionHealth);
      const parsed = new URL(value);
      const offset = Number(parsed.searchParams.get("offset"));
      const limit = Number(parsed.searchParams.get("limit"));
      const chunk = text.slice(offset, offset + limit);
      return jsonResponse({
        sessionId: "session-1",
        seq: 42,
        field: "assistantText",
        offset,
        text: chunk,
        totalLength: text.length,
        complete: offset + chunk.length === text.length,
      });
    });
    const client = new CosControllerClient(async () => ({ baseUrl: "http://127.0.0.1:9", token: "secret" }), { fetch });
    await expect(client.fullAssistantContent("session-1", 42, 2048)).resolves.toBe(text);
  });

  it("fails closed if assistant-content identity changes mid-read", async () => {
    let read = 0;
    const fetch = vi.fn(async (url: string | URL | Request) => {
      const value = String(url);
      if (value.endsWith("/v1/health")) return jsonResponse(extensionHealth);
      read += 1;
      return jsonResponse({
        sessionId: read === 1 ? "session-1" : "session-other",
        seq: 42,
        field: "assistantText",
        offset: read === 1 ? 0 : 2,
        text: "ab",
        totalLength: 4,
        complete: read === 2,
      });
    });
    const client = new CosControllerClient(async () => ({ baseUrl: "http://127.0.0.1:9", token: "secret" }), { fetch });
    await expect(client.fullAssistantContent("session-1", 42, 2)).rejects.toMatchObject({ code: "schema_mismatch" });
  });

  it("accepts only an enforced backgroundWork=disabled policy attestation", async () => {
    const fetch = vi.fn(async (url: string | URL | Request) => {
      const text = String(url);
      if (text.endsWith("/v1/health")) return jsonResponse(extensionHealth);
      if (text.endsWith("/v1/sessions/session-1")) {
        return jsonResponse({ id: "session-1", providerPolicy: { backgroundWork: "disabled", enforced: true } });
      }
      throw new Error(`unexpected ${text}`);
    });
    const client = new CosControllerClient(async () => ({ baseUrl: "http://127.0.0.1:9", token: "secret" }), { fetch });
    await expect(client.requireBackgroundWorkDisabled("session-1")).resolves.toEqual({ backgroundWork: "disabled", enforced: true });
  });

  it("rejects missing or weakened provider-policy attestations", async () => {
    const fetch = vi.fn(async (url: string | URL | Request) => {
      const text = String(url);
      if (text.endsWith("/v1/health")) return jsonResponse(extensionHealth);
      if (text.endsWith("/v1/sessions/session-1")) return jsonResponse({ id: "session-1", providerPolicy: { backgroundWork: "disabled", enforced: false } });
      throw new Error(`unexpected ${text}`);
    });
    const client = new CosControllerClient(async () => ({ baseUrl: "http://127.0.0.1:9", token: "secret" }), { fetch });
    await expect(client.requireBackgroundWorkDisabled("session-1")).rejects.toBeInstanceOf(CosControllerError);
    await expect(client.requireBackgroundWorkDisabled("session-1")).rejects.toMatchObject({ code: "provider_policy_unavailable" });
  });

  it("requires the extension before creating a provider-policy session", async () => {
    const fetch = vi.fn(async (url: string | URL | Request) => {
      const text = String(url);
      if (text.endsWith("/v1/health")) {
        return jsonResponse({ protocol: 1, app: "chat-on-steroids", actions: { enabled: true, routes: ["POST /v1/inputs"] } });
      }
      throw new Error(`unexpected ${text}`);
    });
    const client = new CosControllerClient(async () => ({ baseUrl: "http://127.0.0.1:9", token: "secret" }), { fetch });
    await expect(client.send({
      id: "33333333-3333-4333-8333-333333333333",
      text: "hello",
      providerPolicy: { backgroundWork: "disabled" },
    })).rejects.toMatchObject({ code: "provider_extension_unavailable" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("sends backgroundWork=disabled atomically with first input", async () => {
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const text = String(url);
      if (text.endsWith("/v1/health")) return jsonResponse(extensionHealth);
      if (text.endsWith("/v1/inputs") && init?.method === "POST") {
        expect(JSON.parse(String(init.body))).toMatchObject({ providerPolicy: { backgroundWork: "disabled" } });
        return jsonResponse({
          input: { id: "44444444-4444-4444-8444-444444444444", sessionId: "session-1", delivery: "pending" },
          replayed: false,
        }, 202);
      }
      throw new Error(`unexpected ${text}`);
    });
    const client = new CosControllerClient(async () => ({ baseUrl: "http://127.0.0.1:9", token: "secret" }), { fetch });
    await expect(client.send({
      id: "44444444-4444-4444-8444-444444444444",
      text: "hello",
      providerPolicy: { backgroundWork: "disabled" },
    })).resolves.toMatchObject({ sessionId: "session-1", delivery: "pending" });
  });
});
