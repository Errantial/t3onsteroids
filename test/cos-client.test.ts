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
    await writeFile(join(control, "endpoint.json"), JSON.stringify({ protocol: 1, port: 4567, pid: 42, startedAt: "2026-10-17T16:00:00.000Z" }));
    await writeFile(join(control, "token"), "super-secret-token\n");
    const discovered = await discoverCosController(dir);
    expect(discovered).toEqual({ baseUrl: "http://127.0.0.1:4567", token: "super-secret-token", pid: 42, startedAt: "2026-10-17T16:00:00.000Z" });

    await writeFile(join(control, "endpoint.json"), JSON.stringify({ url: "http://127.0.0.1:4567", pid: 42 }));
    await expect(discoverCosController(dir)).resolves.toMatchObject({ baseUrl: "http://127.0.0.1:4567", pid: 42 });

    await writeFile(join(control, "endpoint.json"), JSON.stringify({ protocol: 2, port: 4567 }));
    await expect(discoverCosController(dir)).rejects.toMatchObject({ code: "protocol_mismatch" });
    await writeFile(join(control, "endpoint.json"), JSON.stringify({ protocol: 1, port: 0 }));
    await expect(discoverCosController(dir)).rejects.toMatchObject({ code: "schema_mismatch" });
    await writeFile(join(control, "endpoint.json"), JSON.stringify({ url: "https://example.com" }));
    await expect(discoverCosController(dir)).rejects.not.toThrow(/super-secret-token/);

    await writeFile(join(control, "endpoint.json"), "{not-json");
    await expect(discoverCosController(dir)).rejects.toMatchObject({ code: "schema_mismatch" });
    await writeFile(join(control, "endpoint.json"), JSON.stringify({ url: "::not-a-url::" }));
    await expect(discoverCosController(dir)).rejects.toMatchObject({ code: "schema_mismatch" });
    await writeFile(join(control, "endpoint.json"), JSON.stringify({ url: "http://u:p@127.0.0.1:4567/base?x#y" }));
    await expect(discoverCosController(dir)).rejects.toMatchObject({ code: "schema_mismatch" });
  });

  it("wraps malformed JSON responses deterministically without leaking response bodies", async () => {
    const fetch = vi.fn(async () => new Response("raw-secret-body", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    const client = new CosControllerClient(async () => ({ baseUrl: "http://127.0.0.1:9", token: "token-secret" }), { fetch });
    const failure = await client.health().catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "schema_mismatch" });
    expect(String((failure as Error).message)).not.toContain("raw-secret-body");
    expect(String((failure as Error).message)).not.toContain("token-secret");
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
      if (text.endsWith("/v1/inputs?limit=500")) return jsonResponse({ inputs: [{ id, sessionId: id, delivery: "sent" }], total: 1 });
      throw new Error(`unexpected ${text}`);
    });
    const client = new CosControllerClient(async () => ({ baseUrl: "http://127.0.0.1:9", token: "secret" }), { fetch });
    await expect(client.send({ id, text: "hello" })).resolves.toEqual({ id, sessionId: id, delivery: "sent" });
    expect(postCount).toBe(1);
  });

  it("strictly validates successful mutation response schemas", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const text = String(url);
      if (text.endsWith("/v1/health")) return jsonResponse(health);
      if (text.endsWith("/v1/inputs") && init?.method === "POST") return jsonResponse({ input: { id, sessionId: id, delivery: "sent" } });
      throw new Error(`unexpected ${text}`);
    });
    const client = new CosControllerClient(async () => ({ baseUrl: "http://127.0.0.1:9", token: "secret" }), { fetch });
    await expect(client.send({ id, text: "hello" })).rejects.toMatchObject({ code: "schema_mismatch" });
  });

  it("returns delivery_unconfirmed when ambiguous send has no authoritative row", async () => {
    const id = "22222222-2222-4222-8222-222222222222";
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const text = String(url);
      if (text.endsWith("/v1/health")) return jsonResponse(health);
      if (text.endsWith("/v1/inputs") && init?.method === "POST") throw new TypeError("timeout");
      if (text.endsWith("/v1/inputs?limit=500")) return jsonResponse({ inputs: [], total: 0 });
      throw new Error(`unexpected ${text}`);
    });
    const client = new CosControllerClient(async () => ({ baseUrl: "http://127.0.0.1:9", token: "secret" }), { fetch });
    await expect(client.send({ id, text: "hello" })).rejects.toMatchObject({ code: "delivery_unconfirmed", retryable: false });
  });

  it("waits for the exact matching turn_end after Stop", async () => {
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const text = String(url);
      if (text.includes("/stop") && init?.method === "POST") return jsonResponse({}, 202);
      if (text.includes("/events")) {
        return jsonResponse({ events: [
          { seq: 1, position: 1, time: 1, kind: "turn_end", source: "extension", turnId: "stale-turn" },
          { seq: 2, position: 2, time: 2, kind: "turn_end", source: "extension", turnId: "target-turn" },
        ], total: 2, nextFrom: 3 });
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

  it("classifies temporary controller read saturation as retryable", async () => {
    const fetch = vi.fn(async () => jsonResponse({ error: "busy", detail: "too many reads are waiting on the app; retry shortly" }, 503));
    const client = new CosControllerClient(
      async () => ({ baseUrl: "http://127.0.0.1:9", token: "secret" }),
      { fetch },
      { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
    );
    await expect(client.session("session-1")).rejects.toMatchObject({
      code: "request_failed",
      status: 503,
      retryable: true,
    });
  });

  it("resumes SSE from the last observed sequence after reconnect", async () => {
    const seen: string[] = [];
    let call = 0;
    const fetch = vi.fn(async (url: string | URL | Request) => {
      seen.push(String(url));
      call += 1;
      if (call === 1) {
        return new Response('id: 5\nevent: assistant_message\ndata: {"seq":5,"position":5,"time":5,"kind":"assistant_message","source":"extension"}\n\n', { status: 200, headers: { "Content-Type": "text/event-stream" } });
      }
      return new Response('id: 6\nevent: turn_end\ndata: {"seq":6,"position":6,"time":6,"kind":"turn_end","source":"extension","turnId":"t"}\n\n', { status: 200, headers: { "Content-Type": "text/event-stream" } });
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

  it("parses CRLF SSE frames and records bounded reconnect backoff", async () => {
    let call = 0;
    const fetch = vi.fn(async () => {
      call += 1;
      if (call === 1) throw new TypeError("temporary refusal");
      return new Response('id: 7\r\nevent: turn_end\r\ndata: {"seq":7,"position":7,"time":7,"kind":"turn_end","source":"extension","turnId":"t"}\r\n\r\n', {
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
    const rows = [];
    for await (const event of client.streamEvents("session", { signal: controller.signal })) {
      rows.push(event);
      controller.abort();
    }
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ seq: 7, kind: "turn_end", turnId: "t" });
    expect(client.metrics()).toMatchObject({ sseConnectAttempts: 2, sseReconnects: 0, sseBackoffs: 1 });
  });

  it("fails closed on malformed SSE JSON", async () => {
    const fetch = vi.fn(async () => new Response("data: {not-json}\n\n", { status: 200 }));
    const client = new CosControllerClient(async () => ({ baseUrl: "http://127.0.0.1:9", token: "secret" }), { fetch });
    const read = async () => {
      for await (const _event of client.streamEvents("s")) void _event;
    };
    await expect(read()).rejects.toMatchObject({ code: "schema_mismatch" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rolls over a long-lived SSE stream and resumes from the exact cursor", async () => {
    const seen: string[] = [];
    let call = 0;
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      seen.push(String(url));
      call += 1;
      if (call === 1) {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('id: 8\ndata: {"seq":8,"position":8,"time":8,"kind":"assistant_message","source":"extension"}\n\n'));
            init?.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")), { once: true });
          },
        });
        return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
      }
      return new Response('id: 9\ndata: {"seq":9,"position":9,"time":9,"kind":"turn_end","source":"extension","turnId":"t"}\n\n', { status: 200 });
    });
    const abort = new AbortController();
    const client = new CosControllerClient(async () => ({ baseUrl: "http://127.0.0.1:9", token: "secret" }), { fetch }, { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 });
    const rows = [];
    for await (const event of client.streamEvents("s", { signal: abort.signal, rolloverMs: 5 })) {
      rows.push(event.seq);
      if (event.seq === 9) abort.abort();
    }
    expect(rows).toEqual([8, 9]);
    expect(seen[1]).toContain("from=9");
  });
});
