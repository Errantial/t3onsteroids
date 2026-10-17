import { describe, expect, it, vi } from "vitest";

import { CosControllerClient } from "../src/cos/index.js";
import { BridgeMetrics } from "../src/metrics.js";
import { BoundedAsyncQueue } from "../src/translate/queue.js";

const extensionHealth = {
  protocol: 1,
  app: "chat-on-steroids",
  actions: { enabled: true, routes: ["POST /v1/inputs"] },
  features: {
    "provider-project-resolve-v1": 1,
    "provider-assistant-content-v1": 1,
    "provider-session-policy-v1": 1,
    "provider-turn-drain-v1": 1,
  },
  providerExtension: { apiVersion: 1, buildId: "a".repeat(40) },
};

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

describe("Phase 6 performance and concurrency qualification", () => {
  it("keeps a bounded queue under a slow consumer", async () => {
    const queue = new BoundedAsyncQueue<number>(3);
    expect(queue.push(1)).toBe(true);
    expect(queue.push(2)).toBe(true);
    expect(queue.push(3)).toBe(true);
    expect(queue.push(4)).toBe(false);
    expect(queue.size).toBe(3);
    expect(queue.highWater).toBe(3);
    await expect(queue.shift()).resolves.toBe(1);
    expect(queue.size).toBe(2);
    expect(queue.highWater).toBe(3);
  });

  it("keeps bridge metrics metadata-only and content/token safe", () => {
    const token = "partial-secret-token-fixture";
    const prompt = "hostile prompt C:\\private\\repo with browser contents";
    const metrics = new BridgeMetrics();
    metrics.increment("promptReceived");
    metrics.increment("controllerReadCount");
    metrics.increment("sseConnectCount");
    metrics.observeDrainHighWater(42);
    metrics.observeQueueDepth(2, 5);
    const serialized = JSON.stringify(metrics.snapshot());
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain(prompt);
    expect(serialized).not.toContain("private");
    expect(JSON.parse(serialized)).toMatchObject({
      promptReceived: 1,
      controllerReadCount: 1,
      sseConnectCount: 1,
      drainHighWaterSeq: 42,
      currentQueueDepth: 2,
      maxQueueDepth: 5,
    });
    expect(JSON.parse(serialized).rssHighWaterBytes).toBeGreaterThan(0);
    expect(JSON.parse(serialized).lastUpdatedAt).toBeGreaterThanOrEqual(0);
  });

  it("wires controller attempts into the shared bridge metrics snapshot", async () => {
    const metrics = new BridgeMetrics();
    const fetch = vi.fn(async () => jsonResponse(extensionHealth));
    const client = new CosControllerClient(
      async () => ({ baseUrl: "http://127.0.0.1:9", token: "secret" }),
      { fetch },
      { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
      metrics,
    );
    await client.health();
    expect(metrics.snapshot()).toMatchObject({ controllerReadCount: 1 });
  });

  it("fetches long assistant content in O(final size) bytes", async () => {
    const finalText = "x".repeat(20_000);
    const fetch = vi.fn(async (url: string | URL | Request) => {
      const value = String(url);
      if (value.endsWith("/v1/health")) return jsonResponse(extensionHealth);
      const parsed = new URL(value);
      const offset = Number(parsed.searchParams.get("offset"));
      const limit = Number(parsed.searchParams.get("limit"));
      const chunk = finalText.slice(offset, offset + limit);
      return jsonResponse({
        sessionId: "s",
        seq: 9,
        field: "assistantText",
        offset,
        text: chunk,
        totalLength: finalText.length,
        complete: offset + chunk.length === finalText.length,
      });
    });
    const client = new CosControllerClient(async () => ({ baseUrl: "http://127.0.0.1:9", token: "secret" }), { fetch });
    await expect(client.fullAssistantContent("s", 9, 4096)).resolves.toBe(finalText);
    const metrics = client.metrics();
    expect(metrics.assistantContentBytes).toBe(finalText.length);
    expect(metrics.assistantContentRequests).toBe(Math.ceil(finalText.length / 4096));
  });

  it("does not spin on controller 503 queue_full", async () => {
    const fetch = vi.fn(async () => jsonResponse({ error: "queue_full" }, 503));
    const client = new CosControllerClient(
      async () => ({ baseUrl: "http://127.0.0.1:9", token: "secret" }),
      { fetch },
      { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 },
    );
    await expect(client.health()).rejects.toMatchObject({ code: "queue_full", retryable: true });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(client.metrics().readRetries).toBe(0);
  });

  it("bounds safe-read retries after restart/refusal", async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError("refused");
    });
    const client = new CosControllerClient(
      async () => ({ baseUrl: "http://127.0.0.1:9", token: "secret" }),
      { fetch },
      { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 },
    );
    await expect(client.health()).rejects.toMatchObject({ code: "controller_unavailable", retryable: true });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(client.metrics()).toMatchObject({ readAttempts: 3, readRetries: 2 });
  });

  it("reconnects SSE with bounded one-for-one reconnect attempts", async () => {
    let call = 0;
    const fetch = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return new Response('id: 1\nevent: assistant_message\ndata: {"seq":1,"position":1,"time":1,"kind":"assistant_message","source":"extension"}\n\n', {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      return new Response('id: 2\nevent: turn_end\ndata: {"seq":2,"position":2,"time":2,"kind":"turn_end","source":"extension","turnId":"t"}\n\n', {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    });
    const controller = new AbortController();
    const client = new CosControllerClient(
      async () => ({ baseUrl: "http://127.0.0.1:9", token: "secret" }),
      { fetch },
      { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 },
    );
    for await (const event of client.streamEvents("s", { signal: controller.signal })) {
      if (event.seq === 2) controller.abort();
    }
    expect(client.metrics()).toMatchObject({ sseConnectAttempts: 2, sseReconnects: 1 });
  });
});
