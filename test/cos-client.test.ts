import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { compatibility } from "../src/compatibility.js";
import {
  COS_REQUIRED_ACTION_ROUTES,
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

  it("does not reuse a successful provider-extension readiness snapshot inside the former TTL", async () => {
    let healthReads = 0;
    const extensionHealth = {
      ...health,
      actions: { enabled: true, routes: [...COS_REQUIRED_ACTION_ROUTES] },
      features: {
        "provider-project-resolve-v1": 1,
        "provider-assistant-content-v1": 1,
        "provider-session-policy-v1": 1,
        "provider-turn-drain-v1": 1,
        "provider-turn-recovery-v1": 1,
      },
      providerExtension: { apiVersion: 1, buildId: compatibility.cos.providerExtension.buildId },
    };
    const fetch = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith("/v1/health")) {
        healthReads += 1;
        return jsonResponse(healthReads === 1
          ? extensionHealth
          : { ...extensionHealth, providerExtension: { apiVersion: 1, buildId: "development" } });
      }
      throw new Error(`unexpected ${String(url)}`);
    });
    const client = new CosControllerClient(
      async () => ({ baseUrl: "http://127.0.0.1:9", token: "secret" }),
      { fetch },
    );

    await expect(client.requireProviderExtension()).resolves.toMatchObject({ actionsEnabled: true });
    await expect(client.requireProviderExtension()).rejects.toMatchObject({ code: "provider_extension_unavailable" });
    expect(healthReads).toBe(2);
  });

  it("re-discovers after controller restart/token rotation and validates the changed health snapshot", async () => {
    const oldDiscovery: CosControllerDiscovery = { baseUrl: "http://127.0.0.1:1", token: "old" };
    const newDiscovery: CosControllerDiscovery = { baseUrl: "http://127.0.0.1:2", token: "new" };
    const extensionHealth = {
      ...health,
      actions: { enabled: true, routes: [...COS_REQUIRED_ACTION_ROUTES] },
      features: compatibility.cos.providerExtension.features,
      providerExtension: { apiVersion: 1, buildId: compatibility.cos.providerExtension.buildId },
    };
    let discoveryReads = 0;
    let oldHealthReads = 0;
    const discover = vi.fn(async () => {
      discoveryReads += 1;
      return discoveryReads === 1 ? oldDiscovery : newDiscovery;
    });
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get("Authorization");
      if (auth === "Bearer old") {
        oldHealthReads += 1;
        return oldHealthReads === 1 ? jsonResponse(extensionHealth) : jsonResponse({ code: "unauthorized" }, 401);
      }
      return jsonResponse({ ...extensionHealth, actions: { enabled: true, routes: ["POST /v1/inputs"] } });
    });
    const client = new CosControllerClient(discover, { fetch });

    await expect(client.requireProviderExtension()).resolves.toMatchObject({ actionsEnabled: true });
    await expect(client.requireProviderExtension()).rejects.toMatchObject({ code: "provider_extension_unavailable" });
    expect(discover).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledTimes(3);
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

  it("re-discovers endpoint and token before sending exact Stop after a controller restart", async () => {
    const discoveries: CosControllerDiscovery[] = [
      { baseUrl: "http://127.0.0.1:1", token: "old" },
      { baseUrl: "http://127.0.0.1:2", token: "new" },
    ];
    const discover = vi.fn(async () => discoveries[Math.min(discover.mock.calls.length - 1, 1)]!);
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const text = String(url);
      const auth = new Headers(init?.headers).get("Authorization");
      if (text.endsWith("/v1/health") && text.startsWith("http://127.0.0.1:1")) return jsonResponse(health);
      if (text === "http://127.0.0.1:2/v1/sessions/session/stop" && auth === "Bearer new" && init?.method === "POST") {
        return jsonResponse({ live: {} }, 202);
      }
      throw new Error(`unexpected ${text} with ${auth}`);
    });
    const client = new CosControllerClient(discover, { fetch });

    await expect(client.health()).resolves.toMatchObject({ protocol: 1 });
    await expect(client.requestStopExactTurn("session", "turn")).resolves.toBeUndefined();

    expect(discover).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      "http://127.0.0.1:1/v1/health",
      "http://127.0.0.1:2/v1/sessions/session/stop",
    ]);
    expect(new Headers(fetch.mock.calls[1]?.[1]?.headers).get("Authorization")).toBe("Bearer new");
  });

  it("wakes a heartbeat-live session stream after exact Stop and resumes from its cursor", async () => {
    const discoveries: CosControllerDiscovery[] = [
      { baseUrl: "http://127.0.0.1:1", token: "old" },
      { baseUrl: "http://127.0.0.1:2", token: "new" },
    ];
    const discover = vi.fn(async () => discoveries[Math.min(discover.mock.calls.length - 1, 1)]!);
    const seen: Array<{ url: string; auth: string | null; body?: string }> = [];
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const text = String(url);
      seen.push({ url: text, auth: new Headers(init?.headers).get("Authorization"), ...(typeof init?.body === "string" ? { body: init.body } : {}) });
      if (text === "http://127.0.0.1:1/v1/sessions/s/events/stream") {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            const send = (value: string): void => controller.enqueue(new TextEncoder().encode(value));
            send('id: 5\nevent: assistant_message\ndata: {"seq":5,"position":5,"time":5,"kind":"assistant_message","source":"extension"}\n\n');
            const heartbeat = setInterval(() => {
              try { send(": keep-alive\n\n"); } catch { clearInterval(heartbeat); }
            }, 5);
            const stop = (): void => { clearInterval(heartbeat); controller.error(new DOMException("aborted", "AbortError")); };
            init?.signal?.addEventListener("abort", stop, { once: true });
          },
          cancel() { /* the abort listener clears the heartbeat interval */ },
        });
        return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
      }
      if (text === "http://127.0.0.1:2/v1/sessions/s/stop" && init?.method === "POST") return jsonResponse({ live: {} }, 202);
      if (text === "http://127.0.0.1:2/v1/sessions/s/events/stream?from=6") {
        return new Response(
          'id: 6\nevent: turn_end\ndata: {"seq":6,"position":6,"time":6,"kind":"turn_end","source":"extension","turnId":"t"}\n\n' +
          'id: 7\nevent: turn_drained\ndata: {"seq":7,"position":7,"time":7,"kind":"turn_drained","source":"app","turnId":"t","inputId":"11111111-1111-4111-8111-111111111111","highWaterSeq":7,"finalAssistantSeq":5}\n\n',
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        );
      }
      throw new Error(`unexpected ${text}`);
    });
    const abort = new AbortController();
    const client = new CosControllerClient(discover, { fetch }, { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 });
    const stream = client.streamEvents("s", { signal: abort.signal, idleTimeoutMs: 1_000, rolloverMs: 10_000 })[Symbol.asyncIterator]();

    await expect(stream.next()).resolves.toMatchObject({ value: { seq: 5 }, done: false });
    await expect(client.requestStopExactTurn("s", "t")).resolves.toBeUndefined();
    await expect(stream.next()).resolves.toMatchObject({ value: { seq: 6, kind: "turn_end", turnId: "t" }, done: false });
    await expect(stream.next()).resolves.toMatchObject({ value: { seq: 7, kind: "turn_drained", turnId: "t" }, done: false });
    abort.abort();
    await expect(stream.next()).resolves.toMatchObject({ done: true });

    expect(seen).toEqual([
      { url: "http://127.0.0.1:1/v1/sessions/s/events/stream", auth: "Bearer old" },
      { url: "http://127.0.0.1:2/v1/sessions/s/stop", auth: "Bearer new", body: JSON.stringify({ turnId: "t" }) },
      { url: "http://127.0.0.1:2/v1/sessions/s/events/stream?from=6", auth: "Bearer new" },
    ]);
  });

  it("retries only the same exact Stop after an ambiguous transport failure", async () => {
    const seen: Array<{ url: string; body?: string }> = [];
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), ...(typeof init?.body === "string" ? { body: init.body } : {}) });
      if (fetch.mock.calls.length === 1) throw new TypeError("response lost after dispatch");
      if (String(url).endsWith("/v1/sessions/s/stop")) return jsonResponse({ live: {} }, 202);
      throw new Error(`unexpected ${String(url)}`);
    });
    const client = new CosControllerClient(async () => ({ baseUrl: "http://127.0.0.1:9", token: "secret" }), { fetch }, { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 });

    await expect(client.requestStopExactTurn("s", "exact-turn")).resolves.toBeUndefined();
    expect(seen).toEqual([
      { url: "http://127.0.0.1:9/v1/sessions/s/stop", body: JSON.stringify({ turnId: "exact-turn" }) },
      { url: "http://127.0.0.1:9/v1/sessions/s/stop", body: JSON.stringify({ turnId: "exact-turn" }) },
    ]);
  });

  it("does not open a stale SSE connection when exact Stop races pending discovery", async () => {
    let resolveOldDiscovery!: (value: CosControllerDiscovery) => void;
    let signalFirstDiscovery!: () => void;
    const oldDiscovery = new Promise<CosControllerDiscovery>((resolve) => { resolveOldDiscovery = resolve; });
    const firstDiscoveryStarted = new Promise<void>((resolve) => { signalFirstDiscovery = resolve; });
    const discover = vi.fn(async () => {
      if (discover.mock.calls.length === 1) {
        signalFirstDiscovery();
        return oldDiscovery;
      }
      return { baseUrl: "http://127.0.0.1:2", token: "new" };
    });
    const seen: string[] = [];
    const fetch = vi.fn(async (url: string | URL | Request) => {
      const text = String(url);
      seen.push(text);
      if (text === "http://127.0.0.1:2/v1/sessions/s/stop") return jsonResponse({ live: {} }, 202);
      if (text === "http://127.0.0.1:2/v1/sessions/s/events/stream") {
        return new Response('id: 1\nevent: turn_end\ndata: {"seq":1,"position":1,"time":1,"kind":"turn_end","source":"extension","turnId":"t"}\n\n', {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      throw new Error(`unexpected controller endpoint: ${text}`);
    });
    const abort = new AbortController();
    const client = new CosControllerClient(discover, { fetch }, { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 });
    const stream = client.streamEvents("s", { signal: abort.signal, idleTimeoutMs: 1_000, rolloverMs: 5_000 })[Symbol.asyncIterator]();
    const firstEvent = stream.next();

    await firstDiscoveryStarted;
    await expect(client.requestStopExactTurn("s", "t")).resolves.toBeUndefined();
    resolveOldDiscovery({ baseUrl: "http://127.0.0.1:1", token: "old" });
    await expect(firstEvent).resolves.toMatchObject({ value: { seq: 1, kind: "turn_end", turnId: "t" }, done: false });
    abort.abort();
    await expect(stream.next()).resolves.toMatchObject({ done: true });

    expect(seen).toEqual([
      "http://127.0.0.1:2/v1/sessions/s/stop",
      "http://127.0.0.1:2/v1/sessions/s/events/stream",
    ]);
    expect(seen.some((url) => url.startsWith("http://127.0.0.1:1/"))).toBe(false);
  });

  it("bounds a stalled exact-Stop response body and retries only that same target", async () => {
    const seen: Array<{ url: string; body?: string }> = [];
    let firstRequestAborted = false;
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), ...(typeof init?.body === "string" ? { body: init.body } : {}) });
      if (fetch.mock.calls.length === 1) {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            init?.signal?.addEventListener("abort", () => {
              firstRequestAborted = true;
              try { controller.error(new DOMException("aborted", "AbortError")); } catch { /* already closed */ }
            }, { once: true });
          },
        });
        return new Response(body, { status: 202, headers: { "Content-Type": "application/json" } });
      }
      return jsonResponse({ live: {} }, 202);
    });
    const client = new CosControllerClient(
      async () => ({ baseUrl: "http://127.0.0.1:9", token: "secret" }),
      { fetch },
      { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1, stopRequestTimeoutMs: 10 },
    );

    await expect(client.requestStopExactTurn("s", "exact-turn")).resolves.toBeUndefined();

    expect(firstRequestAborted).toBe(true);
    expect(seen).toEqual([
      { url: "http://127.0.0.1:9/v1/sessions/s/stop", body: JSON.stringify({ turnId: "exact-turn" }) },
      { url: "http://127.0.0.1:9/v1/sessions/s/stop", body: JSON.stringify({ turnId: "exact-turn" }) },
    ]);
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

  it("classifies a bounded controller read deadline as retryable", async () => {
    const fetch = vi.fn(async () => jsonResponse({ error: "timeout", detail: "the app did not answer in time; /v1/health may still answer" }, 504));
    const client = new CosControllerClient(
      async () => ({ baseUrl: "http://127.0.0.1:9", token: "secret" }),
      { fetch },
      { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
    );
    await expect(client.session("session-1")).rejects.toMatchObject({
      code: "request_failed",
      status: 504,
      retryable: true,
    });
  });

  it("classifies a not-yet-readable provider session projection as retryable", async () => {
    const fetch = vi.fn(async () => jsonResponse({ error: "session_not_found" }, 404));
    const client = new CosControllerClient(
      async () => ({ baseUrl: "http://127.0.0.1:9", token: "secret" }),
      { fetch },
      { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
    );
    await expect(client.session("session-1")).rejects.toMatchObject({
      code: "request_failed",
      status: 404,
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

  it("re-discovers after a silent stale SSE connection and resumes from the last cursor", async () => {
    const discoveries: CosControllerDiscovery[] = [
      { baseUrl: "http://127.0.0.1:1", token: "old" },
      { baseUrl: "http://127.0.0.1:2", token: "new" },
    ];
    const discover = vi.fn(async () => {
      if (discover.mock.calls.length === 2) throw new Error("discovery files are being republished");
      return discoveries[Math.min(discover.mock.calls.length - 1, 1)]!;
    });
    const seen: Array<{ url: string; auth: string | null }> = [];
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const text = String(url);
      seen.push({ url: text, auth: new Headers(init?.headers).get("Authorization") });
      if (text.startsWith("http://127.0.0.1:1")) {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('id: 5\nevent: assistant_message\ndata: {"seq":5,"position":5,"time":5,"kind":"assistant_message","source":"extension"}\n\n'));
            init?.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")), { once: true });
          },
        });
        return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
      }
      return new Response('id: 6\nevent: turn_end\ndata: {"seq":6,"position":6,"time":6,"kind":"turn_end","source":"extension","turnId":"t"}\n\n', {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    });
    const abort = new AbortController();
    const client = new CosControllerClient(discover, { fetch }, { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 });
    const rows: number[] = [];

    for await (const event of client.streamEvents("s", { signal: abort.signal, idleTimeoutMs: 10, rolloverMs: 1_000 })) {
      rows.push(event.seq);
      if (event.seq === 6) abort.abort();
    }

    expect(rows).toEqual([5, 6]);
    expect(discover).toHaveBeenCalledTimes(3);
    expect(seen).toEqual([
      { url: "http://127.0.0.1:1/v1/sessions/s/events/stream", auth: "Bearer old" },
      { url: "http://127.0.0.1:2/v1/sessions/s/events/stream?from=6", auth: "Bearer new" },
    ]);
  });

  it("treats SSE heartbeat bytes as activity so a healthy quiet stream does not reconnect", async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const timers: ReturnType<typeof setTimeout>[] = [];
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const send = (value: string): void => controller.enqueue(new TextEncoder().encode(value));
          send('id: 5\nevent: assistant_message\ndata: {"seq":5,"position":5,"time":5,"kind":"assistant_message","source":"extension"}\n\n');
          timers.push(setTimeout(() => send(": keep-alive\n\n"), 10));
          timers.push(setTimeout(() => send(": keep-alive\n\n"), 20));
          timers.push(setTimeout(() => send('id: 6\nevent: turn_end\ndata: {"seq":6,"position":6,"time":6,"kind":"turn_end","source":"extension","turnId":"t"}\n\n'), 30));
          init?.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")), { once: true });
        },
        cancel() { for (const timer of timers) clearTimeout(timer); },
      });
      return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    });
    const abort = new AbortController();
    const client = new CosControllerClient(async () => ({ baseUrl: "http://127.0.0.1:9", token: "secret" }), { fetch });
    const rows: number[] = [];

    for await (const event of client.streamEvents("s", { signal: abort.signal, idleTimeoutMs: 40, rolloverMs: 1_000 })) {
      rows.push(event.seq);
      if (event.seq === 6) abort.abort();
    }

    expect(rows).toEqual([5, 6]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("reconnects after a controller end frame and resumes from the exact cursor", async () => {
    const seen: string[] = [];
    let call = 0;
    const fetch = vi.fn(async (url: string | URL | Request) => {
      seen.push(String(url));
      call += 1;
      if (call === 1) {
        return new Response(
          'id: 26\nevent: turn_end\ndata: {"seq":26,"position":26,"time":26,"kind":"turn_end","source":"extension","turnId":"t"}\n\n' +
          'event: end\ndata: {"reason":"error"}\n\n',
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        );
      }
      return new Response(
        'id: 27\nevent: turn_drained\ndata: {"seq":27,"position":27,"time":27,"kind":"turn_drained","source":"app","turnId":"t","inputId":"11111111-1111-4111-8111-111111111111","highWaterSeq":27,"finalAssistantSeq":25}\n\n',
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      );
    });
    const abort = new AbortController();
    const client = new CosControllerClient(
      async () => ({ baseUrl: "http://127.0.0.1:9", token: "secret" }),
      { fetch },
      { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 },
    );
    const rows = [];
    for await (const event of client.streamEvents("s", { signal: abort.signal })) {
      rows.push(event.seq);
      if (event.seq === 27) abort.abort();
    }
    expect(rows).toEqual([26, 27]);
    expect(seen[1]).toContain("from=27");
  });

  it("closes the active SSE transport when its consumer stops after a delivered event", async () => {
    let bodyCancelled = false;
    let requestAborted = false;
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      init?.signal?.addEventListener("abort", () => { requestAborted = true; }, { once: true });
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(
            'id: 7\nevent: turn_drained\ndata: {"seq":7,"position":7,"time":7,"kind":"turn_drained","source":"app","turnId":"t","inputId":"11111111-1111-4111-8111-111111111111","highWaterSeq":7,"finalAssistantSeq":5}\n\n',
          ));
        },
        cancel() { bodyCancelled = true; },
      });
      return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    });
    const client = new CosControllerClient(
      async () => ({ baseUrl: "http://127.0.0.1:9", token: "secret" }),
      { fetch },
      { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 },
    );

    for await (const event of client.streamEvents("session")) {
      expect(event.seq).toBe(7);
      break;
    }

    expect(bodyCancelled || requestAborted).toBe(true);
  });
});
