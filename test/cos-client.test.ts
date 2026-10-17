import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  CosControllerClient,
  CosControllerError,
  discoverCosController,
  parseHealth,
  type CosControllerDiscovery,
} from "../src/cos/index.js";

const health = { protocol: 1, app: "chat-on-steroids", actions: { enabled: true, routes: ["POST /v1/inputs"] } };

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

describe("CoS protocol-1 controller client", () => {
  it("validates health deterministically", () => {
    expect(parseHealth(health)).toMatchObject({ protocol: 1, app: "chat-on-steroids", actionsEnabled: true });
    expect(() => parseHealth({ ...health, protocol: 2 })).toThrowError(CosControllerError);
    expect(() => parseHealth({ ...health, actions: { enabled: "yes", routes: [] } })).toThrow(/must be boolean/);
  });

  it("discovers loopback endpoint/token without exposing the token in errors", async () => {
    const dir = await mkdtemp(join(tmpdir(), "t3os-cos-"));
    const control = join(dir, "control-api");
    await mkdir(control);
    await writeFile(join(control, "endpoint.json"), JSON.stringify({ url: "http://127.0.0.1:4567", pid: 42 }));
    await writeFile(join(control, "token"), "super-secret-token\n");
    const discovered = await discoverCosController(dir);
    expect(discovered).toEqual({ baseUrl: "http://127.0.0.1:4567", token: "super-secret-token", pid: 42, startedAt: undefined });
    await writeFile(join(control, "endpoint.json"), JSON.stringify({ url: "https://example.com" }));
    await expect(discoverCosController(dir)).rejects.not.toThrow(/super-secret-token/);
  });

  it("refreshes endpoint/token after auth rotation on safe reads", async () => {
    const discoveries: CosControllerDiscovery[] = [
      { baseUrl: "http://127.0.0.1:1", token: "old" },
      { baseUrl: "http://127.0.0.1:2", token: "new" },
    ];
    const discover = vi.fn(async () => discoveries[Math.min(discover.mock.calls.length - 1, 1)]!);
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get("Authorization");
      return auth === "Bearer old" ? jsonResponse({ code: "unauthorized" }, 401) : jsonResponse(health);
    });
    const client = new CosControllerClient(discover, { fetch });
    await expect(client.health()).resolves.toMatchObject({ protocol: 1, actionsEnabled: true });
    expect(discover).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("reconciles an ambiguous send before deciding whether to retry", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    let postCount = 0;
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const text = String(url);
      if (text.endsWith("/v1/health")) return jsonResponse(health);
      if (text.endsWith("/v1/inputs") && init?.method === "POST") {
        postCount += 1;
        throw new TypeError("socket closed after dispatch");
      }
      if (text.includes("/v1/inputs?id=")) return jsonResponse([{ id, sessionId: id, delivery: "sent" }]);
      throw new Error(`unexpected ${text}`);
    });
    const client = new CosControllerClient(async () => ({ baseUrl: "http://127.0.0.1:9", token: "secret" }), { fetch });
    await expect(client.send({ id, text: "hello" })).resolves.toEqual({ id, sessionId: id, delivery: "sent" });
    expect(postCount).toBe(1);
  });

  it("returns delivery_unconfirmed when ambiguous send has no authoritative row", async () => {
    const id = "22222222-2222-4222-8222-222222222222";
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const text = String(url);
      if (text.endsWith("/v1/health")) return jsonResponse(health);
      if (text.endsWith("/v1/inputs") && init?.method === "POST") throw new TypeError("timeout");
      if (text.includes("/v1/inputs?id=")) return jsonResponse([]);
      throw new Error(`unexpected ${text}`);
    });
    const client = new CosControllerClient(async () => ({ baseUrl: "http://127.0.0.1:9", token: "secret" }), { fetch });
    await expect(client.send({ id, text: "hello" })).rejects.toMatchObject({ code: "delivery_unconfirmed", retryable: false });
  });

  it("waits for the exact matching turn_end after Stop", async () => {
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const text = String(url);
      if (text.includes("/stop") && init?.method === "POST") return new Response(null, { status: 202 });
      if (text.includes("/events")) {
        return jsonResponse([
          { seq: 1, type: "turn_end", turnId: "stale-turn" },
          { seq: 2, type: "turn_end", turnId: "target-turn" },
        ]);
      }
      throw new Error(`unexpected ${text}`);
    });
    const client = new CosControllerClient(async () => ({ baseUrl: "http://127.0.0.1:9", token: "secret" }), { fetch });
    await expect(client.stopExactTurn("session", "target-turn", { timeoutMs: 200, pollMs: 1 })).resolves.toMatchObject({ seq: 2, turnId: "target-turn" });
  });

  it("uses bounded retry/backoff for safe reads", async () => {
    const fetch = vi.fn(async () => {
      if (fetch.mock.calls.length < 3) throw new TypeError("refused");
      return jsonResponse(health);
    });
    const client = new CosControllerClient(async () => ({ baseUrl: "http://127.0.0.1:9", token: "secret" }), { fetch }, { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 });
    await expect(client.health()).resolves.toMatchObject({ protocol: 1 });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("resumes SSE from the last observed sequence after reconnect", async () => {
    const seen: string[] = [];
    let call = 0;
    const fetch = vi.fn(async (url: string | URL | Request) => {
      seen.push(String(url));
      call += 1;
      if (call === 1) {
        return new Response('id: 5\ndata: {"seq":5,"type":"assistant_message"}\n\n', { status: 200, headers: { "Content-Type": "text/event-stream" } });
      }
      return new Response('id: 6\ndata: {"seq":6,"type":"turn_end","turnId":"t"}\n\n', { status: 200, headers: { "Content-Type": "text/event-stream" } });
    });
    const controller = new AbortController();
    const client = new CosControllerClient(async () => ({ baseUrl: "http://127.0.0.1:9", token: "secret" }), { fetch }, { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 });
    const rows = [];
    for await (const event of client.streamEvents("session", { signal: controller.signal })) {
      rows.push(event);
      if (event.seq === 6) controller.abort();
    }
    expect(rows.map((row) => row.seq)).toEqual([5, 6]);
    expect(seen[1]).toContain("from=6");
  });
});
