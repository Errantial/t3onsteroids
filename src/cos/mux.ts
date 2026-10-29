import type { CosControllerDiscovery, CosEvent, RetryPolicy } from "./index.js";

/**
 * One controller connection for several chats (`provider-event-stream-mux-v1`).
 *
 * The controller caps held event streams at four, so a provider that follows four chats with one
 * stream each leaves no room for any other client. This hub keeps a single connection for the whole
 * subscription set and fans frames out by `sessionId`. Cursors are per session and are always sent
 * on (re)connect, so a reconnect replays nothing and a new subscription does not disturb the others
 * beyond one shared reconnect.
 */

export class MuxUnsupportedError extends Error {
  constructor() {
    super("CoS controller does not serve the multiplexed event stream");
    this.name = "MuxUnsupportedError";
  }
}

interface Subscriber {
  readonly sessionId: string;
  readonly signal: AbortSignal;
  cursor: number;
  readonly queue: CosEvent[];
  wake: (() => void) | undefined;
  failure: unknown;
  done: boolean;
}

export interface MuxHubOptions {
  readonly discover: () => Promise<CosControllerDiscovery>;
  readonly fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  readonly retryPolicy: RetryPolicy;
  readonly rolloverMs?: number;
  readonly idleTimeoutMs?: number;
  /** Called when a discovery/transport failure means the next attempt must rediscover. */
  readonly invalidateDiscovery?: () => void;
  readonly onConnect?: () => void;
  readonly onReconnect?: () => void;
  readonly onBackoff?: () => void;
}

const MAX_QUEUED_EVENTS = 1024;
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class MuxHub {
  private readonly subscribers = new Map<string, Subscriber>();
  private running = false;
  private connection: AbortController | undefined;
  private generation = 0;
  private readonly rolloverMs: number;
  private readonly idleTimeoutMs: number;

  constructor(private readonly options: MuxHubOptions) {
    this.rolloverMs = options.rolloverMs ?? 29 * 60_000;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 45_000;
  }

  /** Subscribes one session. The generator ends when the signal aborts or the stream fails. */
  async *stream(sessionId: string, from: number, signal: AbortSignal): AsyncGenerator<CosEvent> {
    if (this.subscribers.has(sessionId)) {
      throw new Error(`Session ${sessionId} already has a multiplexed stream`);
    }
    const subscriber: Subscriber = { sessionId, signal, cursor: from, queue: [], wake: undefined, failure: undefined, done: false };
    this.subscribers.set(sessionId, subscriber);
    // A new session must join the same connection; reopening with every cursor is lossless.
    this.restart();
    this.ensureRunning();
    const onAbort = (): void => this.remove(subscriber);
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      for (;;) {
        if (signal.aborted) return;
        if (subscriber.queue.length > 0) {
          yield subscriber.queue.shift()!;
          continue;
        }
        if (subscriber.failure !== undefined) throw subscriber.failure;
        if (subscriber.done) return;
        await new Promise<void>((resolve) => { subscriber.wake = resolve; });
        subscriber.wake = undefined;
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
      this.remove(subscriber);
    }
  }

  /** Forces a shared reconnect after a Stop boundary; per-session cursors keep replay harmless. */
  reconnect(sessionId: string, reason: string): void {
    if (!this.subscribers.has(sessionId)) return;
    this.restart(reason);
  }

  private remove(subscriber: Subscriber): void {
    subscriber.done = true;
    if (this.subscribers.get(subscriber.sessionId) === subscriber) this.subscribers.delete(subscriber.sessionId);
    subscriber.wake?.();
    if (this.subscribers.size === 0) {
      this.connection?.abort(new Error("sse_no_subscribers"));
      this.connection = undefined;
    }
  }

  private restart(reason = "sse_subscription_changed"): void {
    this.generation += 1;
    this.connection?.abort(new Error(reason));
    this.connection = undefined;
  }

  private fail(error: unknown): void {
    for (const subscriber of this.subscribers.values()) {
      subscriber.failure = error;
      subscriber.wake?.();
    }
  }

  private push(sessionId: string, event: CosEvent): void {
    const subscriber = this.subscribers.get(sessionId);
    if (!subscriber || event.seq < subscriber.cursor) return;
    subscriber.cursor = event.seq + 1;
    subscriber.queue.push(event);
    if (subscriber.queue.length > MAX_QUEUED_EVENTS) {
      subscriber.failure = new Error("Multiplexed event stream consumer is too slow");
      subscriber.wake?.();
      this.restart("sse_slow_consumer");
      return;
    }
    subscriber.wake?.();
  }

  private async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    let connectedOnce = false;
    let reconnectAttempt = 0;
    try {
      while (this.subscribers.size > 0) {
        const subscribers = [...this.subscribers.values()];
        const sessions = subscribers.map((subscriber) => subscriber.sessionId);
        const cursors = subscribers.map((subscriber) => `${subscriber.sessionId}:${subscriber.cursor}`).join(",");
        const query = new URLSearchParams({ sessions: sessions.join(","), cursors });
        const generation = this.generation;
        const controller = new AbortController();
        this.connection = controller;
        let rolloverTimer: ReturnType<typeof setTimeout> | undefined;
        let idleTimer: ReturnType<typeof setTimeout> | undefined;
        const resetIdle = (): void => {
          if (idleTimer !== undefined) clearTimeout(idleTimer);
          idleTimer = setTimeout(() => controller.abort(new Error("sse_idle_timeout")), this.idleTimeoutMs);
        };
        let sawEvent = false;
        try {
          const discovery = await this.options.discover();
          if (generation !== this.generation) continue;
          this.options.onConnect?.();
          if (connectedOnce) this.options.onReconnect?.();
          resetIdle();
          rolloverTimer = setTimeout(() => controller.abort(new Error("sse_rollover")), this.rolloverMs);
          const response = await this.options.fetch(`${discovery.baseUrl}/v1/events/stream?${query.toString()}`, {
            headers: { Accept: "text/event-stream", Authorization: `Bearer ${discovery.token}` },
            signal: controller.signal,
          });
          if (generation !== this.generation) {
            try { await response.body?.cancel(); } catch { /* invalidated connection */ }
            continue;
          }
          if (!response.ok) {
            try { await response.body?.cancel(); } catch { /* invalidated connection */ }
            if ([400, 404, 405, 501].includes(response.status)) throw new MuxUnsupportedError();
            throw new Error(`Multiplexed event stream failed with HTTP ${response.status}`);
          }
          if (!response.body) throw new Error("Multiplexed event stream has no body");
          connectedOnce = true;
          const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
          let buffer = "";
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value.length > 0) resetIdle();
            buffer += value;
            for (;;) {
              const lf = buffer.indexOf("\n\n");
              const crlf = buffer.indexOf("\r\n\r\n");
              if (lf < 0 && crlf < 0) break;
              const useCrlf = crlf >= 0 && (lf < 0 || crlf < lf);
              const boundary = useCrlf ? crlf : lf;
              const frame = buffer.slice(0, boundary).replace(/\r/g, "");
              buffer = buffer.slice(boundary + (useCrlf ? 4 : 2));
              let eventName: string | undefined;
              const dataLines: string[] = [];
              for (const line of frame.split("\n")) {
                if (line.startsWith("event:")) eventName = line.slice(6).trim();
                else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
              }
              if (dataLines.length === 0 || eventName === "end") continue;
              let parsed: unknown;
              try {
                parsed = JSON.parse(dataLines.join("\n"));
              } catch {
                throw new Error("Multiplexed SSE event data is malformed JSON");
              }
              if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Multiplexed SSE event is not an object");
              const row = parsed as Record<string, unknown>;
              const sessionId = typeof row.sessionId === "string" ? row.sessionId : undefined;
              const seq = typeof row.seq === "number" ? row.seq : undefined;
              if (sessionId === undefined || seq === undefined) throw new Error("Multiplexed SSE event lacks sessionId or seq");
              this.push(sessionId, { ...(row as CosEvent), seq });
              sawEvent = true;
            }
          }
          reconnectAttempt = sawEvent ? 0 : reconnectAttempt + 1;
          this.options.onBackoff?.();
          const exponential = Math.min(this.options.retryPolicy.baseDelayMs * 2 ** Math.max(0, reconnectAttempt - 1), this.options.retryPolicy.maxDelayMs);
          await delay(exponential);
        } catch (error) {
          if (error instanceof MuxUnsupportedError) {
            this.fail(error);
            break;
          }
          if (controller.signal.aborted) {
            if (this.subscribers.size === 0) break;
            // A subscription change or Stop boundary: reopen at once with current cursors.
            continue;
          }
          this.options.invalidateDiscovery?.();
          this.options.onBackoff?.();
          reconnectAttempt += 1;
          const exponential = Math.min(this.options.retryPolicy.baseDelayMs * 2 ** Math.max(0, reconnectAttempt - 1), this.options.retryPolicy.maxDelayMs);
          await delay(exponential);
        } finally {
          if (rolloverTimer !== undefined) clearTimeout(rolloverTimer);
          if (idleTimer !== undefined) clearTimeout(idleTimer);
          if (this.connection === controller) this.connection = undefined;
        }
      }
    } finally {
      this.running = false;
    }
  }

  /** Starts the shared loop if a subscription is waiting for it. */
  ensureRunning(): void {
    void this.run().catch((error) => this.fail(error));
  }
}
