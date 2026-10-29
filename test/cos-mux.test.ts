import { describe, expect, it, vi } from "vitest";

import { MuxHub, MuxUnsupportedError } from "../src/cos/mux.js";
import type { CosEvent } from "../src/cos/index.js";

const discovery = { baseUrl: "http://127.0.0.1:1", token: "test-token" };
const event = (seq: number, sessionId?: string): CosEvent => ({
  seq,
  position: seq,
  time: seq,
  kind: "note",
  source: "app",
  ...(sessionId === undefined ? {} : { sessionId }),
});

function sse(): { response: Response; push: (sessionId: string, row: CosEvent) => void; end: () => void; abort: () => void } {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
  const encoder = new TextEncoder();
  return {
    response: new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
    push(sessionId, row) {
      controller.enqueue(encoder.encode(`event: ${row.kind}\ndata: ${JSON.stringify({ sessionId, ...row })}\n\n`));
    },
    end() { controller.close(); },
    abort() { try { controller.error(new DOMException("Aborted", "AbortError")); } catch { /* already closed */ } },
  };
}

function hub(fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>) {
  return new MuxHub({
    discover: async () => discovery,
    fetch,
    retryPolicy: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 5 },
  });
}

async function take(stream: AsyncIterable<CosEvent>, count: number): Promise<CosEvent[]> {
  const out: CosEvent[] = [];
  for await (const row of stream) {
    out.push(row);
    if (out.length >= count) break;
  }
  return out;
}

describe("multiplexed controller event stream", () => {
  it("carries two chats on one connection and routes frames by session", async () => {
    const calls: string[] = [];
    const streams: Array<ReturnType<typeof sse>> = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push(String(input));
      const next = sse();
      streams.push(next);
      init?.signal?.addEventListener("abort", () => next.abort(), { once: true });
      return next.response;
    });
    const mux = hub(fetch);
    const controller = new AbortController();
    const a = take(mux.stream("session-aaaaaaaa", 0, controller.signal), 1);
    const b = take(mux.stream("session-bbbbbbbb", 0, controller.signal), 1);
    await vi.waitFor(() => expect(calls.some((call) => call.includes("session-aaaaaaaa%2Csession-bbbbbbbb"))).toBe(true));
    const latest = streams.at(-1)!;
    latest.push("session-bbbbbbbb", event(1));
    latest.push("session-aaaaaaaa", event(1));
    await expect(a).resolves.toMatchObject([{ seq: 1 }]);
    await expect(b).resolves.toMatchObject([{ seq: 1 }]);
    expect(calls.at(-1)).toContain("sessions=session-aaaaaaaa%2Csession-bbbbbbbb");
    expect(calls.at(-1)).toContain("cursors=session-aaaaaaaa%3A0%2Csession-bbbbbbbb%3A0");
    controller.abort();
  });

  it("drops frames at or before each subscriber's cursor", async () => {
    const stream = sse();
    const mux = hub(async () => stream.response);
    const controller = new AbortController();
    const result = take(mux.stream("session-aaaaaaaa", 5, controller.signal), 1);
    await vi.waitFor(() => expect(stream.response.body).toBeTruthy());
    stream.push("session-aaaaaaaa", event(4));
    stream.push("session-aaaaaaaa", event(5));
    await expect(result).resolves.toMatchObject([{ seq: 5 }]);
    controller.abort();
  });

  it("reconnects with every cursor when another chat joins", async () => {
    const calls: string[] = [];
    const streams: Array<ReturnType<typeof sse>> = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push(String(input));
      const next = sse();
      streams.push(next);
      init?.signal?.addEventListener("abort", () => next.abort(), { once: true });
      return next.response;
    });
    const mux = hub(fetch);
    const controller = new AbortController();
    const a = take(mux.stream("session-aaaaaaaa", 3, controller.signal), 1);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const b = take(mux.stream("session-bbbbbbbb", 7, controller.signal), 1);
    await vi.waitFor(() => expect(calls.some((call) => call.includes("session-aaaaaaaa%3A3") && call.includes("session-bbbbbbbb%3A7"))).toBe(true));
    const latest = calls.at(-1)!;
    expect(latest).toContain("session-aaaaaaaa%3A3");
    expect(latest).toContain("session-bbbbbbbb%3A7");
    streams.at(-1)!.push("session-aaaaaaaa", event(3));
    streams.at(-1)!.push("session-bbbbbbbb", event(7));
    await expect(a).resolves.toMatchObject([{ seq: 3 }]);
    await expect(b).resolves.toMatchObject([{ seq: 7 }]);
    controller.abort();
  });

  it("fails explicitly when the controller does not serve the route", async () => {
    const mux = hub(async () => new Response(JSON.stringify({ error: "not_found" }), { status: 404 }));
    const controller = new AbortController();
    await expect(take(mux.stream("session-aaaaaaaa", 0, controller.signal), 1)).rejects.toBeInstanceOf(MuxUnsupportedError);
    controller.abort();
  });
});
