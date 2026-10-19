import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promises as fs } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { Readable, Transform, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { compatibility } from "../../src/compatibility.js";
import {
  DurableAdmissionLease,
  DurableSessionStore,
  canonicalProfileIdentityHash,
  type WindowsProcessIdentity,
} from "../../src/state/index.js";

type InputMode = "active" | "pending_cancel" | "pending_cancel_race";

interface FakeSession {
  readonly sessionId: string;
  readonly inputId: string;
  turnId: string | null;
  readonly mode: InputMode;
  delivery: "pending" | "sent" | "not_sent";
  providerState: "admitted" | "active" | "closing" | "drained" | "not_sent";
  drainedSeq: number | null;
  finalAssistantSeq: number | null;
  readonly events: Record<string, unknown>[];
}

const roots: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "t3os-stdio-"));
  roots.push(root);
  return root;
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function json(res: ServerResponse, status: number, value: unknown): void {
  const bytes = JSON.stringify(value);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(bytes) });
  res.end(bytes);
}

class FakeCos {
  readonly sessions = new Map<string, FakeSession>();
  readonly streams = new Map<string, ServerResponse>();
  readonly streamWaiters = new Map<string, (() => void)[]>();
  readonly inputs: FakeSession[] = [];
  readonly token = "stdio-integration-secret";
  readonly buildId = compatibility.cos.providerExtension.buildId;
  readonly stopRequests: { sessionId: string; turnId: string }[] = [];
  readonly pendingCancels: string[] = [];
  readonly pendingCancelAttempts: string[] = [];
  readonly streamRequests: { sessionId: string; from: number }[] = [];
  readonly assistantContent = new Map<string, string>();
  readonly server: Server;
  inputPostAttempts = 0;
  sessionReadCount = 0;
  missingProviderFeature: string | null = null;
  nextMode: InputMode = "active";
  nextInputHttpError: { status: number; error: string } | null = null;
  dropNextInputResponseAfterDispatch = false;
  wrapSessionDetail = false;
  private nextTurn = 1;

  constructor(readonly projectDir: string) {
    this.server = createServer((req, res) => void this.handle(req, res));
  }

  async listen(): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("fake CoS did not bind TCP");
    return address.port;
  }

  async close(): Promise<void> {
    for (const response of this.streams.values()) response.end();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private authenticate(req: IncomingMessage, res: ServerResponse): boolean {
    if (req.headers.authorization === `Bearer ${this.token}`) return true;
    json(res, 401, { error: "unauthorized" });
    return false;
  }

  private sessionSummary(session: FakeSession) {
    return {
      id: session.sessionId,
      activeTurnId: session.turnId,
      providerPolicy: { backgroundWork: "disabled", enforced: true },
      providerTurn: {
        inputId: session.inputId,
        state: session.providerState,
        turnId: session.turnId,
        drainedSeq: session.drainedSeq,
        finalAssistantSeq: session.finalAssistantSeq,
      },
    };
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!req.url || !this.authenticate(req, res)) return;
    const url = new URL(req.url, "http://127.0.0.1");

    if (req.method === "GET" && url.pathname === "/v1/health") {
      const features: Record<string, number> = {
        "provider-project-resolve-v1": 1,
        "provider-assistant-content-v1": 1,
        "provider-session-policy-v1": 1,
        "provider-turn-drain-v1": 1,
      };
      if (this.missingProviderFeature) delete features[this.missingProviderFeature];
      json(res, 200, {
        protocol: 1,
        app: "chat-on-steroids",
        actions: {
          enabled: true,
          routes: ["POST /v1/inputs", "POST /v1/inputs/{id}/cancel", "POST /v1/sessions/{id}/stop"],
        },
        features,
        providerExtension: { apiVersion: 1, buildId: this.buildId },
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/projects/resolve") {
      const request = await body(req);
      if (request.path !== this.projectDir) {
        json(res, 404, { error: "project_unmapped" });
        return;
      }
      json(res, 200, { projectId: "project-1", name: "Fixture", canonicalPath: this.projectDir });
      return;
    }

    if (req.method === "GET" && url.pathname === "/v1/inputs") {
      json(res, 200, {
        inputs: this.inputs.map((session) => ({ id: session.inputId, sessionId: session.sessionId, delivery: session.delivery })),
        total: this.inputs.length,
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/inputs") {
      this.inputPostAttempts += 1;
      if (this.nextInputHttpError) {
        const failure = this.nextInputHttpError;
        this.nextInputHttpError = null;
        json(res, failure.status, { error: failure.error });
        return;
      }
      const request = await body(req);
      const inputId = String(request.id ?? "");
      const sessionId = String(request.sessionId ?? inputId);
      const mode = this.nextMode;
      this.nextMode = "active";
      const turnId = mode === "active" ? `turn-${this.nextTurn++}` : null;
      const session: FakeSession = {
        sessionId,
        inputId,
        turnId,
        mode,
        delivery: mode === "active" ? "sent" : "pending",
        providerState: mode === "active" ? "active" : "admitted",
        drainedSeq: null,
        finalAssistantSeq: null,
        events: [],
      };
      this.sessions.set(sessionId, session);
      this.inputs.push(session);
      if (this.dropNextInputResponseAfterDispatch) {
        this.dropNextInputResponseAfterDispatch = false;
        res.destroy();
        return;
      }
      json(res, 200, { input: { id: inputId, sessionId, delivery: session.delivery }, replayed: false });
      return;
    }

    const inputCancel = url.pathname.match(/^\/v1\/inputs\/([^/]+)\/cancel$/);
    if (req.method === "POST" && inputCancel) {
      const inputId = decodeURIComponent(inputCancel[1]!);
      const session = this.inputs.find((entry) => entry.inputId === inputId);
      if (!session) {
        json(res, 404, { error: "input_not_found" });
        return;
      }
      this.pendingCancelAttempts.push(inputId);
      if (session.mode === "pending_cancel_race") {
        session.turnId = `turn-${this.nextTurn++}`;
        session.delivery = "sent";
        session.providerState = "active";
        json(res, 409, { error: "not_cancellable" });
        return;
      }
      this.pendingCancels.push(inputId);
      session.delivery = "not_sent";
      session.providerState = "not_sent";
      json(res, 200, { ok: true });
      return;
    }

    const sessionPath = url.pathname.match(/^\/v1\/sessions\/([^/]+)$/);
    if (req.method === "GET" && sessionPath) {
      this.sessionReadCount += 1;
      const session = this.sessions.get(decodeURIComponent(sessionPath[1]!));
      if (!session) {
        json(res, 404, { error: "session_not_found" });
        return;
      }
      const summary = this.sessionSummary(session);
      json(res, 200, this.wrapSessionDetail ? { session: summary } : summary);
      return;
    }

    const stopPath = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/stop$/);
    if (req.method === "POST" && stopPath) {
      const sessionId = decodeURIComponent(stopPath[1]!);
      const session = this.sessions.get(sessionId);
      const request = await body(req);
      if (!session || request.turnId !== session.turnId) {
        json(res, 409, { error: "wrong_turn" });
        return;
      }
      this.stopRequests.push({ sessionId, turnId: String(request.turnId) });
      session.providerState = "closing";
      res.writeHead(202, { "Content-Type": "application/json" });
      res.end("{}");
      return;
    }

    const eventList = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/events$/);
    if (req.method === "GET" && eventList) {
      const session = this.sessions.get(decodeURIComponent(eventList[1]!));
      if (!session) {
        json(res, 404, { error: "session_not_found" });
        return;
      }
      const from = Number(url.searchParams.get("from") ?? 0);
      json(res, 200, { events: session.events.filter((event) => Number(event.seq) >= from), total: session.events.length, nextFrom: null });
      return;
    }

    const assistantContentPath = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/events\/(\d+)\/assistant-content$/);
    if (req.method === "GET" && assistantContentPath) {
      const sessionId = decodeURIComponent(assistantContentPath[1]!);
      const seq = Number(assistantContentPath[2]);
      const text = this.assistantContent.get(`${sessionId}:${seq}`);
      if (text === undefined) {
        json(res, 404, { error: "assistant_content_not_found" });
        return;
      }
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? 16_384);
      const chunk = text.slice(offset, offset + limit);
      json(res, 200, {
        sessionId,
        seq,
        field: "assistantText",
        offset,
        text: chunk,
        totalLength: text.length,
        complete: offset + chunk.length >= text.length,
      });
      return;
    }

    const streamPath = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/events\/stream$/);
    if (req.method === "GET" && streamPath) {
      const sessionId = decodeURIComponent(streamPath[1]!);
      const session = this.sessions.get(sessionId);
      if (!session) {
        json(res, 404, { error: "session_not_found" });
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      const from = Number(url.searchParams.get("from") ?? 0);
      this.streamRequests.push({ sessionId, from });
      for (const event of session.events) {
        if (Number(event.seq) >= from) this.writeEvent(res, event);
      }
      this.streams.set(sessionId, res);
      for (const resolve of this.streamWaiters.get(sessionId) ?? []) resolve();
      this.streamWaiters.delete(sessionId);
      req.once("close", () => {
        if (this.streams.get(sessionId) === res) this.streams.delete(sessionId);
      });
      return;
    }

    json(res, 404, { error: "not_found" });
  }

  private writeEvent(res: ServerResponse, event: Record<string, unknown>): void {
    res.write(`id: ${String(event.seq)}\ndata: ${JSON.stringify(event)}\n\n`);
  }

  async waitForStream(sessionId: string): Promise<void> {
    if (this.streams.has(sessionId)) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`SSE stream did not open for ${sessionId}`)), 10_000);
      const done = () => { clearTimeout(timer); resolve(); };
      const waiters = this.streamWaiters.get(sessionId) ?? [];
      waiters.push(done);
      this.streamWaiters.set(sessionId, waiters);
    });
  }

  dropStream(sessionId: string): void {
    const stream = this.streams.get(sessionId);
    if (!stream) throw new Error(`SSE stream is not open for ${sessionId}`);
    stream.end();
  }

  seedActiveInput(sessionId: string, inputId = sessionId, turnId = `turn-${this.nextTurn++}`): FakeSession {
    const session: FakeSession = {
      sessionId,
      inputId,
      turnId,
      mode: "active",
      delivery: "sent",
      providerState: "active",
      drainedSeq: null,
      finalAssistantSeq: null,
      events: [],
    };
    this.sessions.set(sessionId, session);
    this.inputs.push(session);
    return session;
  }

  setAssistantContent(sessionId: string, seq: number, text: string): void {
    this.assistantContent.set(`${sessionId}:${seq}`, text);
  }

  emit(sessionId: string, kind: string, seq: number, extra: Record<string, unknown> = {}): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`unknown fake session ${sessionId}`);
    const event = {
      seq,
      position: seq,
      time: seq,
      kind,
      source: "extension",
      ...(session.turnId ? { turnId: session.turnId } : {}),
      ...extra,
    };
    if (kind === "turn_drained") {
      session.providerState = "drained";
      session.drainedSeq = seq;
      session.finalAssistantSeq = (extra.finalAssistantSeq as number | null | undefined) ?? null;
    }
    session.events.push(event);
    const stream = this.streams.get(sessionId);
    if (stream) this.writeEvent(stream, event);
  }
}

function childStream(
  child: ChildProcessWithoutNullStreams,
  throttle?: { readonly bytesPerChunk: number; readonly delayMs: number },
): acp.Stream {
  let source: Readable = child.stdout;
  if (throttle) {
    const slowed = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        let offset = 0;
        const pushNext = () => {
          if (offset >= bytes.length) {
            callback();
            return;
          }
          const end = Math.min(offset + throttle.bytesPerChunk, bytes.length);
          this.push(bytes.subarray(offset, end));
          offset = end;
          setTimeout(pushNext, throttle.delayMs);
        };
        pushNext();
      },
    });
    source = child.stdout.pipe(slowed);
  }
  const readable = Readable.toWeb(source) as unknown as ReadableStream<Uint8Array>;
  return acp.ndJsonStream(
    Writable.toWeb(child.stdin) as unknown as WritableStream<Uint8Array>,
    readable,
  );
}

const fixtureIdentity: WindowsProcessIdentity = {
  current: async () => ({ pid: 999_991, processStartTicks: "1" }),
  query: async () => ({ status: "not_found" }),
};

async function seededProductionState(profile: string, stateRoot: string) {
  await fs.mkdir(profile, { recursive: true });
  const store = new DurableSessionStore(stateRoot, { probeFilesystem: false, mutex: { identity: fixtureIdentity } });
  await store.init();
  const profileHash = await canonicalProfileIdentityHash(profile);
  const lease = new DurableAdmissionLease(stateRoot, profileHash, { identity: fixtureIdentity, mutex: { identity: fixtureIdentity } });
  return { store, lease };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

beforeAll(() => {
  const tsc = path.join(process.cwd(), "node_modules", "typescript", "bin", "tsc");
  const built = spawnSync(process.execPath, [tsc, "-p", "tsconfig.build.json"], {
    cwd: process.cwd(),
    encoding: "utf8",
    windowsHide: true,
  });
  if (built.status !== 0) throw new Error(`integration build failed\n${built.stdout}\n${built.stderr}`);
}, 30_000);

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (!child.killed) child.kill();
  }
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe.runIf(process.platform === "win32")("built ACP stdio provider", () => {
  it("negotiates stable v1 and keeps the prompt open through late tool activity until turn_drained", async () => {
    const root = await tempRoot();
    const profile = path.join(root, "profile");
    const control = path.join(profile, "control-api");
    const project = path.join(root, "project");
    const state = path.join(root, "state");
    const metrics = path.join(root, "evidence", "metrics.json");
    await Promise.all([fs.mkdir(control, { recursive: true }), fs.mkdir(project, { recursive: true })]);
    const fake = new FakeCos(project);
    fake.wrapSessionDetail = true;
    const port = await fake.listen();
    await fs.writeFile(path.join(control, "endpoint.json"), JSON.stringify({ url: `http://127.0.0.1:${port}`, pid: process.pid }));
    await fs.writeFile(path.join(control, "token"), `${fake.token}\n`);

    const child = spawn(process.execPath, [path.join(process.cwd(), "dist", "cli", "index.js")], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        T3ONSTEROIDS_COS_USER_DATA_DIR: profile,
        T3ONSTEROIDS_STATE_DIR: state,
        T3ONSTEROIDS_METRICS_PATH: metrics,
      },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(child);
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    const updates: acp.SessionNotification[] = [];

    try {
      await acp.client({ name: "stdio-integration" })
        .onNotification(acp.methods.client.session.update, ({ params }) => { updates.push(params); })
        .connectWith(childStream(child), async (ctx) => {
          const initialized = await ctx.request(acp.methods.agent.initialize, {
            protocolVersion: 2,
            clientCapabilities: {},
          });
          expect(initialized.protocolVersion).toBe(1);
          expect(initialized.agentInfo?.version).toBe("1.0.0");
          expect(initialized.agentCapabilities).toMatchObject({ promptCapabilities: {}, sessionCapabilities: { resume: {} } });

          const created = await ctx.request(acp.methods.agent.session.new, { cwd: project, mcpServers: [] });
          fake.nextMode = "active";
          let settled = false;
          const prompt = ctx.request(acp.methods.agent.session.prompt, {
            sessionId: created.sessionId,
            prompt: [{ type: "text", text: "write the fixture" }],
          }).finally(() => { settled = true; });

          await fake.waitForStream(created.sessionId);
          const session = fake.sessions.get(created.sessionId);
          if (!session?.turnId) throw new Error("active fake session lacks turn id");
          fake.emit(created.sessionId, "turn_end", 1, { outcome: "completed" });
          await new Promise((resolve) => setTimeout(resolve, 50));
          expect(settled).toBe(false);

          fake.emit(created.sessionId, "tool_call", 2, {
            tool: {
              callId: "call-1",
              outcome: "ok",
              summary: { title: "Edited fixture" },
              changes: [{ path: path.join(project, "fixture.txt"), added: 1, removed: 0 }],
              args: { text: "RAW SECRET" },
              result: { text: "RAW RESULT" },
            },
          });
          await waitUntil(() => updates.some((entry) => entry.update.sessionUpdate === "tool_call"));
          expect(settled).toBe(false);
          expect(JSON.stringify(updates)).not.toContain("RAW SECRET");
          expect(JSON.stringify(updates)).not.toContain("RAW RESULT");

          fake.emit(created.sessionId, "turn_drained", 3, {
            inputId: session.inputId,
            highWaterSeq: 3,
            finalAssistantSeq: null,
          });
          await expect(prompt).resolves.toEqual({ stopReason: "end_turn" });
          const liveMetrics = JSON.parse(await fs.readFile(metrics, "utf8")) as Record<string, unknown>;
          expect(liveMetrics).toMatchObject({
            promptReceived: 1,
            cosInputAcceptedOrReconciled: 1,
            matchingTurnEndObserved: 1,
            matchingTurnDrainedObserved: 1,
            acpTerminalSent: 1,
          });
        });
    } finally {
      child.stdin.end();
      await fake.close();
    }
    expect(stderr).toBe("");
  }, 30_000);

  it("reconciles response loss after input dispatch without posting a duplicate input", async () => {
    const root = await tempRoot();
    const profile = path.join(root, "profile");
    const control = path.join(profile, "control-api");
    const project = path.join(root, "project");
    const state = path.join(root, "state");
    await Promise.all([fs.mkdir(control, { recursive: true }), fs.mkdir(project, { recursive: true })]);
    const fake = new FakeCos(project);
    fake.wrapSessionDetail = true;
    fake.dropNextInputResponseAfterDispatch = true;
    const port = await fake.listen();
    await fs.writeFile(path.join(control, "endpoint.json"), JSON.stringify({ url: `http://127.0.0.1:${port}`, pid: process.pid }));
    await fs.writeFile(path.join(control, "token"), `${fake.token}\n`);

    const child = spawn(process.execPath, [path.join(process.cwd(), "dist", "cli", "index.js")], {
      cwd: process.cwd(),
      env: { ...process.env, T3ONSTEROIDS_COS_USER_DATA_DIR: profile, T3ONSTEROIDS_STATE_DIR: state },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(child);
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });

    try {
      await acp.client({ name: "step8-v1-06" }).connectWith(childStream(child), async (ctx) => {
        await ctx.request(acp.methods.agent.initialize, { protocolVersion: 2, clientCapabilities: {} });
        const created = await ctx.request(acp.methods.agent.session.new, { cwd: project, mcpServers: [] });
        const prompt = ctx.request(acp.methods.agent.session.prompt, {
          sessionId: created.sessionId,
          prompt: [{ type: "text", text: "response-loss fixture" }],
        });
        await fake.waitForStream(created.sessionId);
        expect(fake.inputPostAttempts).toBe(1);
        expect(fake.inputs).toHaveLength(1);
        const session = fake.sessions.get(created.sessionId);
        if (!session?.turnId) throw new Error("response-loss fixture lacks turn id");
        fake.emit(created.sessionId, "turn_end", 1, { outcome: "completed" });
        fake.emit(created.sessionId, "turn_drained", 2, {
          inputId: session.inputId,
          highWaterSeq: 2,
          finalAssistantSeq: null,
        });
        await expect(prompt).resolves.toEqual({ stopReason: "end_turn" });
        expect(fake.inputPostAttempts).toBe(1);
        expect(fake.inputs).toHaveLength(1);
      });
    } finally {
      child.stdin.end();
      await fake.close();
    }
    expect(stderr).toBe("");
  }, 30_000);

  it("resumes the built provider SSE stream from the exact cursor after a deliberate disconnect", async () => {
    const root = await tempRoot();
    const profile = path.join(root, "profile");
    const control = path.join(profile, "control-api");
    const project = path.join(root, "project");
    const state = path.join(root, "state");
    const metrics = path.join(root, "evidence", "metrics.json");
    await Promise.all([fs.mkdir(control, { recursive: true }), fs.mkdir(project, { recursive: true })]);
    const fake = new FakeCos(project);
    fake.wrapSessionDetail = true;
    const port = await fake.listen();
    await fs.writeFile(path.join(control, "endpoint.json"), JSON.stringify({ url: `http://127.0.0.1:${port}`, pid: process.pid }));
    await fs.writeFile(path.join(control, "token"), `${fake.token}\n`);

    const child = spawn(process.execPath, [path.join(process.cwd(), "dist", "cli", "index.js")], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        T3ONSTEROIDS_COS_USER_DATA_DIR: profile,
        T3ONSTEROIDS_STATE_DIR: state,
        T3ONSTEROIDS_METRICS_PATH: metrics,
      },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(child);
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });

    try {
      await acp.client({ name: "step8-v1-09" }).connectWith(childStream(child), async (ctx) => {
        await ctx.request(acp.methods.agent.initialize, { protocolVersion: 2, clientCapabilities: {} });
        const created = await ctx.request(acp.methods.agent.session.new, { cwd: project, mcpServers: [] });
        const prompt = ctx.request(acp.methods.agent.session.prompt, {
          sessionId: created.sessionId,
          prompt: [{ type: "text", text: "sse reconnect fixture" }],
        });
        await fake.waitForStream(created.sessionId);
        const session = fake.sessions.get(created.sessionId);
        if (!session?.turnId) throw new Error("SSE fixture lacks turn id");

        fake.emit(created.sessionId, "turn_start", 1);
        await waitUntil(() => fake.sessionReadCount >= 1);
        fake.dropStream(created.sessionId);
        await waitUntil(() => fake.streamRequests.length >= 2);
        expect(fake.streamRequests.slice(0, 2)).toEqual([
          { sessionId: created.sessionId, from: 0 },
          { sessionId: created.sessionId, from: 2 },
        ]);

        fake.emit(created.sessionId, "turn_end", 2, { outcome: "completed" });
        fake.emit(created.sessionId, "turn_drained", 3, {
          inputId: session.inputId,
          highWaterSeq: 3,
          finalAssistantSeq: null,
        });
        await expect(prompt).resolves.toEqual({ stopReason: "end_turn" });
        const snapshot = JSON.parse(await fs.readFile(metrics, "utf8")) as Record<string, number>;
        expect(snapshot.sseConnectCount).toBe(2);
        expect(snapshot.sseReconnectCount).toBe(1);
        expect(snapshot.backoffCount).toBe(1);
      });
    } finally {
      child.stdin.end();
      await fake.close();
    }
    expect(stderr).toBe("");
  }, 30_000);

  it("sends exact Stop for an active cancellation and settles only after the matching drain", async () => {
    const root = await tempRoot();
    const profile = path.join(root, "profile");
    const control = path.join(profile, "control-api");
    const project = path.join(root, "project");
    const state = path.join(root, "state");
    await Promise.all([fs.mkdir(control, { recursive: true }), fs.mkdir(project, { recursive: true })]);
    const fake = new FakeCos(project);
    fake.wrapSessionDetail = true;
    const port = await fake.listen();
    await fs.writeFile(path.join(control, "endpoint.json"), JSON.stringify({ url: `http://127.0.0.1:${port}`, pid: process.pid }));
    await fs.writeFile(path.join(control, "token"), `${fake.token}\n`);

    const child = spawn(process.execPath, [path.join(process.cwd(), "dist", "cli", "index.js")], {
      cwd: process.cwd(),
      env: { ...process.env, T3ONSTEROIDS_COS_USER_DATA_DIR: profile, T3ONSTEROIDS_STATE_DIR: state },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(child);
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });

    try {
      await acp.client({ name: "stdio-integration" }).connectWith(childStream(child), async (ctx) => {
        await ctx.request(acp.methods.agent.initialize, { protocolVersion: 2, clientCapabilities: {} });
        const created = await ctx.request(acp.methods.agent.session.new, { cwd: project, mcpServers: [] });
        fake.nextMode = "active";
        let settled = false;
        const prompt = ctx.request(acp.methods.agent.session.prompt, {
          sessionId: created.sessionId,
          prompt: [{ type: "text", text: "cancel the active turn" }],
        }).finally(() => { settled = true; });

        await fake.waitForStream(created.sessionId);
        const session = fake.sessions.get(created.sessionId);
        if (!session?.turnId) throw new Error("active fake session lacks turn id");
        await ctx.notify(acp.methods.agent.session.cancel, { sessionId: created.sessionId });
        await waitUntil(() => fake.stopRequests.length === 1);
        expect(fake.stopRequests).toEqual([{ sessionId: created.sessionId, turnId: session.turnId }]);

        fake.emit(created.sessionId, "turn_end", 1, { outcome: "stopped" });
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(settled).toBe(false);

        fake.emit(created.sessionId, "turn_drained", 2, {
          inputId: session.inputId,
          highWaterSeq: 2,
          finalAssistantSeq: null,
        });
        await expect(prompt).resolves.toEqual({ stopReason: "cancelled" });
      });
    } finally {
      child.stdin.end();
      await fake.close();
    }
    expect(stderr).toBe("");
  }, 30_000);

  it("converts a pending-cancel 409 race into exact Stop when the sent turn appears before bind", async () => {
    const root = await tempRoot();
    const profile = path.join(root, "profile");
    const control = path.join(profile, "control-api");
    const project = path.join(root, "project");
    const state = path.join(root, "state");
    await Promise.all([fs.mkdir(control, { recursive: true }), fs.mkdir(project, { recursive: true })]);
    const fake = new FakeCos(project);
    fake.wrapSessionDetail = true;
    const port = await fake.listen();
    await fs.writeFile(path.join(control, "endpoint.json"), JSON.stringify({ url: `http://127.0.0.1:${port}`, pid: process.pid }));
    await fs.writeFile(path.join(control, "token"), `${fake.token}\n`);

    const child = spawn(process.execPath, [path.join(process.cwd(), "dist", "cli", "index.js")], {
      cwd: process.cwd(),
      env: { ...process.env, T3ONSTEROIDS_COS_USER_DATA_DIR: profile, T3ONSTEROIDS_STATE_DIR: state },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(child);
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });

    try {
      await acp.client({ name: "stdio-integration" }).connectWith(childStream(child), async (ctx) => {
        await ctx.request(acp.methods.agent.initialize, { protocolVersion: 2, clientCapabilities: {} });
        const created = await ctx.request(acp.methods.agent.session.new, { cwd: project, mcpServers: [] });
        fake.nextMode = "pending_cancel_race";
        let settled = false;
        const prompt = ctx.request(acp.methods.agent.session.prompt, {
          sessionId: created.sessionId,
          prompt: [{ type: "text", text: "cancel while the native turn appears" }],
        }).finally(() => { settled = true; });

        await waitUntil(() => fake.sessions.has(created.sessionId));
        await ctx.notify(acp.methods.agent.session.cancel, { sessionId: created.sessionId });
        await waitUntil(() => fake.stopRequests.length === 1);
        const session = fake.sessions.get(created.sessionId);
        if (!session?.turnId) throw new Error("race fake session did not materialize a turn id");
        expect(fake.pendingCancelAttempts).toEqual([session.inputId]);
        expect(fake.pendingCancels).toEqual([]);
        expect(fake.stopRequests).toEqual([{ sessionId: created.sessionId, turnId: session.turnId }]);
        expect(settled).toBe(false);

        fake.emit(created.sessionId, "turn_end", 1, { outcome: "stopped" });
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(settled).toBe(false);
        fake.emit(created.sessionId, "turn_drained", 2, {
          inputId: session.inputId,
          highWaterSeq: 2,
          finalAssistantSeq: null,
        });
        await expect(prompt).resolves.toEqual({ stopReason: "cancelled" });
      });
    } finally {
      child.stdin.end();
      await fake.close();
    }
    expect(stderr).toContain("Error handling notification");
    expect(stderr).toContain("request_failed");
    expect(stderr).not.toContain("cancel while the native turn appears");
  }, 30_000);

  it("reattaches a healthy durable session after child restart without posting a replacement input", async () => {
    const root = await tempRoot();
    const profile = path.join(root, "profile");
    const control = path.join(profile, "control-api");
    const project = path.join(root, "project");
    const state = path.join(root, "state");
    await Promise.all([fs.mkdir(control, { recursive: true }), fs.mkdir(project, { recursive: true })]);
    const fake = new FakeCos(project);
    fake.wrapSessionDetail = true;
    const port = await fake.listen();
    await fs.writeFile(path.join(control, "endpoint.json"), JSON.stringify({ url: `http://127.0.0.1:${port}`, pid: process.pid }));
    await fs.writeFile(path.join(control, "token"), `${fake.token}\n`);
    const env = { ...process.env, T3ONSTEROIDS_COS_USER_DATA_DIR: profile, T3ONSTEROIDS_STATE_DIR: state };
    let sessionId = "";
    let stderr = "";

    const first = spawn(process.execPath, [path.join(process.cwd(), "dist", "cli", "index.js")], {
      cwd: process.cwd(), env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(first);
    first.stderr.on("data", (chunk) => { stderr += String(chunk); });
    await acp.client({ name: "stdio-integration" }).connectWith(childStream(first), async (ctx) => {
      await ctx.request(acp.methods.agent.initialize, { protocolVersion: 2, clientCapabilities: {} });
      const created = await ctx.request(acp.methods.agent.session.new, { cwd: project, mcpServers: [] });
      sessionId = created.sessionId;
      const prompt = ctx.request(acp.methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: "establish durable session" }],
      });
      await fake.waitForStream(sessionId);
      const session = fake.sessions.get(sessionId);
      if (!session?.turnId) throw new Error("active fake session lacks turn id");
      fake.emit(sessionId, "turn_end", 1, { outcome: "completed" });
      fake.emit(sessionId, "turn_drained", 2, { inputId: session.inputId, highWaterSeq: 2, finalAssistantSeq: null });
      await expect(prompt).resolves.toEqual({ stopReason: "end_turn" });
    });
    first.stdin.end();
    if (first.exitCode === null) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("first provider child did not exit")), 5_000);
        first.once("exit", () => { clearTimeout(timer); resolve(); });
      });
    }

    const inputPostsBeforeResume = fake.inputPostAttempts;
    const second = spawn(process.execPath, [path.join(process.cwd(), "dist", "cli", "index.js")], {
      cwd: process.cwd(), env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(second);
    second.stderr.on("data", (chunk) => { stderr += String(chunk); });
    try {
      await acp.client({ name: "stdio-integration" }).connectWith(childStream(second), async (ctx) => {
        await ctx.request(acp.methods.agent.initialize, { protocolVersion: 2, clientCapabilities: {} });
        await expect(ctx.request(acp.methods.agent.session.resume, { sessionId, cwd: project, mcpServers: [] })).resolves.toEqual({});
        expect(fake.inputPostAttempts).toBe(inputPostsBeforeResume);
        expect(fake.inputs).toHaveLength(inputPostsBeforeResume);
      });
    } finally {
      second.stdin.end();
      await fake.close();
    }
    expect(stderr).toBe("");
  }, 30_000);

  it("reconciles a persisted accepted-send boundary through a restarted built provider without replay", async () => {
    const root = await tempRoot();
    const profile = path.join(root, "profile");
    const control = path.join(profile, "control-api");
    const project = path.join(root, "project");
    const state = path.join(root, "state");
    await Promise.all([fs.mkdir(control, { recursive: true }), fs.mkdir(project, { recursive: true })]);
    const fake = new FakeCos(project);
    fake.wrapSessionDetail = true;
    const port = await fake.listen();
    await fs.writeFile(path.join(control, "endpoint.json"), JSON.stringify({ url: `http://127.0.0.1:${port}`, pid: process.pid }));
    await fs.writeFile(path.join(control, "token"), `${fake.token}\n`);
    const seeded = await seededProductionState(profile, state);

    const sendSessionId = "11111111-1111-4111-8111-111111111111";
    const sendLeaseId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await seeded.store.updateSession(sendSessionId, {
      kind: "create",
      state: { sessionId: sendSessionId, cwd: project, bindingState: "unbound", interactionMode: "default", cancelIntent: "none" },
    });
    await seeded.store.updateSession(sendSessionId, { kind: "begin_input", inputId: sendSessionId, generation: 1, leaseId: sendLeaseId });
    await seeded.store.updateSession(sendSessionId, {
      kind: "binding", inputId: sendSessionId, generation: 1, bindingState: "create_pending", canonicalCwd: project, cosProjectId: "project-1",
    });
    await seeded.store.updateSession(sendSessionId, { kind: "mark_dispatched", inputId: sendSessionId, generation: 1 });
    await seeded.lease.acquire({ sessionId: sendSessionId, inputId: sendSessionId, generation: 1, ownerId: "crashed-bridge", leaseId: sendLeaseId });
    fake.seedActiveInput(sendSessionId);

    const child = spawn(process.execPath, [path.join(process.cwd(), "dist", "cli", "index.js")], {
      cwd: process.cwd(),
      env: { ...process.env, T3ONSTEROIDS_COS_USER_DATA_DIR: profile, T3ONSTEROIDS_STATE_DIR: state },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(child);
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });

    try {
      await acp.client({ name: "step8-v1-10" }).connectWith(childStream(child), async (ctx) => {
        await ctx.request(acp.methods.agent.initialize, { protocolVersion: 2, clientCapabilities: {} });

        await expect(ctx.request(acp.methods.agent.session.resume, { sessionId: sendSessionId, cwd: project, mcpServers: [] })).resolves.toEqual({});
        await expect(ctx.request(acp.methods.agent.session.prompt, {
          sessionId: sendSessionId,
          prompt: [{ type: "text", text: "must reconcile accepted input" }],
        })).rejects.toMatchObject({ data: { code: "input_busy" } });
        expect(fake.inputPostAttempts).toBe(0);
        await expect(seeded.store.readSession(sendSessionId)).resolves.toMatchObject({
          status: "found",
          value: { bindingState: "bound", generation: 1, activeInputId: sendSessionId },
        });

        await expect(seeded.lease.read()).resolves.toMatchObject({
          status: "found",
          lease: { sessionId: sendSessionId, inputId: sendSessionId, generation: 1 },
        });
      });
    } finally {
      child.stdin.end();
      await fake.close();
    }
    expect(stderr).toBe("");
  }, 30_000);

  it("replays only the persisted exact Stop boundary after built-provider restart", async () => {
    const root = await tempRoot();
    const profile = path.join(root, "profile");
    const control = path.join(profile, "control-api");
    const project = path.join(root, "project");
    const state = path.join(root, "state");
    await Promise.all([fs.mkdir(control, { recursive: true }), fs.mkdir(project, { recursive: true })]);
    const fake = new FakeCos(project);
    fake.wrapSessionDetail = true;
    const port = await fake.listen();
    await fs.writeFile(path.join(control, "endpoint.json"), JSON.stringify({ url: `http://127.0.0.1:${port}`, pid: process.pid }));
    await fs.writeFile(path.join(control, "token"), `${fake.token}\n`);
    const seeded = await seededProductionState(profile, state);

    const sessionId = "22222222-2222-4222-8222-222222222222";
    const leaseId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const turnId = "turn-cancel-boundary";
    await seeded.store.updateSession(sessionId, {
      kind: "create",
      state: {
        sessionId,
        cwd: project,
        canonicalCwd: project,
        cosProjectId: "project-1",
        bindingState: "bound",
        interactionMode: "default",
        cancelIntent: "none",
      },
    });
    await seeded.store.updateSession(sessionId, { kind: "begin_input", inputId: sessionId, generation: 1, leaseId });
    await seeded.store.updateSession(sessionId, { kind: "mark_dispatched", inputId: sessionId, generation: 1 });
    await seeded.store.updateSession(sessionId, { kind: "bind_turn", inputId: sessionId, generation: 1, turnId });
    await seeded.store.updateSession(sessionId, { kind: "set_cancel", inputId: sessionId, generation: 1, turnId });
    await seeded.lease.acquire({ sessionId, inputId: sessionId, generation: 1, ownerId: "crashed-bridge", leaseId });
    fake.seedActiveInput(sessionId, sessionId, turnId);

    const child = spawn(process.execPath, [path.join(process.cwd(), "dist", "cli", "index.js")], {
      cwd: process.cwd(),
      env: { ...process.env, T3ONSTEROIDS_COS_USER_DATA_DIR: profile, T3ONSTEROIDS_STATE_DIR: state },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(child);
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });

    try {
      await acp.client({ name: "step8-v1-10-cancel" }).connectWith(childStream(child), async (ctx) => {
        await ctx.request(acp.methods.agent.initialize, { protocolVersion: 2, clientCapabilities: {} });
        await expect(ctx.request(acp.methods.agent.session.resume, { sessionId, cwd: project, mcpServers: [] })).resolves.toEqual({});
        const prompt = ctx.request(acp.methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: "text", text: "must reconcile exact stop" }],
        });
        await waitUntil(() => fake.stopRequests.length === 1);
        expect(fake.stopRequests).toEqual([{ sessionId, turnId }]);
        fake.emit(sessionId, "turn_end", 1, { outcome: "stopped" });
        await expect(prompt).rejects.toMatchObject({ data: { code: "input_busy" } });
        expect(fake.inputPostAttempts).toBe(0);
        await expect(seeded.lease.read()).resolves.toMatchObject({ status: "found", lease: { sessionId, inputId: sessionId, generation: 1 } });
      });
    } finally {
      child.stdin.end();
      await fake.close();
    }
    expect(stderr).toBe("");
  }, 30_000);

  it("keeps resume failures transport-successful and quarantined without provider mutation", async () => {
    const root = await tempRoot();
    const profile = path.join(root, "profile");
    const control = path.join(profile, "control-api");
    const project = path.join(root, "project");
    const otherProject = path.join(root, "other-project");
    const state = path.join(root, "state");
    await Promise.all([
      fs.mkdir(control, { recursive: true }),
      fs.mkdir(project, { recursive: true }),
      fs.mkdir(otherProject, { recursive: true }),
    ]);
    const fake = new FakeCos(project);
    const port = await fake.listen();
    await fs.writeFile(path.join(control, "endpoint.json"), JSON.stringify({ url: `http://127.0.0.1:${port}`, pid: process.pid }));
    await fs.writeFile(path.join(control, "token"), `${fake.token}\n`);
    const seeded = await seededProductionState(profile, state);

    const brokenId = "33333333-3333-4333-8333-333333333333";
    await seeded.store.updateSession(brokenId, {
      kind: "create",
      state: {
        sessionId: brokenId,
        cwd: project,
        canonicalCwd: project,
        cosProjectId: "project-1",
        bindingState: "broken",
        interactionMode: "default",
        cancelIntent: "none",
        recoveryReason: "ambiguous_recovery",
      },
    });

    const cwdMismatchId = "44444444-4444-4444-8444-444444444444";
    const additionalId = "55555555-5555-4555-8555-555555555555";
    for (const sessionId of [cwdMismatchId, additionalId]) {
      await seeded.store.updateSession(sessionId, {
        kind: "create",
        state: {
          sessionId,
          cwd: project,
          canonicalCwd: project,
          cosProjectId: "project-1",
          bindingState: "bound",
          interactionMode: "default",
          cancelIntent: "none",
        },
      });
    }

    const corruptId = "66666666-6666-4666-8666-666666666666";
    const futureId = "77777777-7777-4777-8777-777777777777";
    const sessionsDir = path.join(state, "sessions");
    const corruptBytes = Buffer.from('{"schemaVersion":1,');
    const futureBytes = Buffer.from(JSON.stringify({ schemaVersion: 99, future: true }));
    await fs.writeFile(path.join(sessionsDir, `${corruptId}.json`), corruptBytes);
    await fs.writeFile(path.join(sessionsDir, `${futureId}.json`), futureBytes);

    const child = spawn(process.execPath, [path.join(process.cwd(), "dist", "cli", "index.js")], {
      cwd: process.cwd(),
      env: { ...process.env, T3ONSTEROIDS_COS_USER_DATA_DIR: profile, T3ONSTEROIDS_STATE_DIR: state },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(child);
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });

    try {
      await acp.client({ name: "step8-v1-12" }).connectWith(childStream(child), async (ctx) => {
        await ctx.request(acp.methods.agent.initialize, { protocolVersion: 2, clientCapabilities: {} });
        const postsBefore = fake.inputPostAttempts;

        await expect(ctx.request(acp.methods.agent.session.resume, { sessionId: brokenId, cwd: project, mcpServers: [] })).resolves.toEqual({});
        await expect(ctx.request(acp.methods.agent.session.prompt, { sessionId: brokenId, prompt: [{ type: "text", text: "blocked" }] }))
          .rejects.toMatchObject({ data: { code: "session_broken" } });

        await expect(ctx.request(acp.methods.agent.session.resume, { sessionId: cwdMismatchId, cwd: otherProject, mcpServers: [] })).resolves.toEqual({});
        await expect(ctx.request(acp.methods.agent.session.prompt, { sessionId: cwdMismatchId, prompt: [{ type: "text", text: "blocked" }] }))
          .rejects.toMatchObject({ data: { code: "session_broken" } });
        await expect(seeded.store.readSession(cwdMismatchId)).resolves.toMatchObject({ status: "found", value: { recoveryReason: "cwd_mismatch" } });

        await expect(ctx.request(acp.methods.agent.session.resume, {
          sessionId: additionalId,
          cwd: project,
          mcpServers: [],
          additionalDirectories: [otherProject],
        } as never)).resolves.toEqual({});
        await expect(ctx.request(acp.methods.agent.session.prompt, { sessionId: additionalId, prompt: [{ type: "text", text: "blocked" }] }))
          .rejects.toMatchObject({ data: { code: "session_broken" } });
        await expect(seeded.store.readSession(additionalId)).resolves.toMatchObject({ status: "found", value: { recoveryReason: "additional_directories" } });

        for (const [sessionId, source] of [[corruptId, corruptBytes], [futureId, futureBytes]] as const) {
          await expect(ctx.request(acp.methods.agent.session.resume, { sessionId, cwd: project, mcpServers: [] })).resolves.toEqual({});
          await expect(ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "blocked" }] }))
            .rejects.toMatchObject({ data: { code: "session_broken" } });
          expect(await fs.readFile(path.join(sessionsDir, `${sessionId}.json`))).toEqual(source);
          await expect(fs.stat(path.join(state, "quarantine", `${sessionId}.json`))).resolves.toBeDefined();
        }

        expect(fake.inputPostAttempts).toBe(postsBefore);
        expect(fake.inputs).toHaveLength(0);
      });
    } finally {
      child.stdin.end();
      await fake.close();
    }
    expect(stderr).toBe("");
  }, 30_000);

  it("fails explicit provider validation before any /v1/inputs mutation", async () => {
    const root = await tempRoot();
    const profile = path.join(root, "profile");
    const control = path.join(profile, "control-api");
    const project = path.join(root, "project");
    const state = path.join(root, "state");
    await Promise.all([fs.mkdir(control, { recursive: true }), fs.mkdir(project, { recursive: true })]);
    const fake = new FakeCos(project);
    fake.missingProviderFeature = "provider-turn-drain-v1";
    const port = await fake.listen();
    await fs.writeFile(path.join(control, "endpoint.json"), JSON.stringify({ url: `http://127.0.0.1:${port}`, pid: process.pid }));
    await fs.writeFile(path.join(control, "token"), `${fake.token}\n`);

    const child = spawn(process.execPath, [path.join(process.cwd(), "dist", "cli", "index.js")], {
      cwd: process.cwd(),
      env: { ...process.env, T3ONSTEROIDS_COS_USER_DATA_DIR: profile, T3ONSTEROIDS_STATE_DIR: state },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(child);
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });

    try {
      await acp.client({ name: "stdio-integration" }).connectWith(childStream(child), async (ctx) => {
        await ctx.request(acp.methods.agent.initialize, { protocolVersion: 2, clientCapabilities: {} });
        const created = await ctx.request(acp.methods.agent.session.new, { cwd: project, mcpServers: [] });
        await expect(ctx.request(acp.methods.agent.session.prompt, {
          sessionId: created.sessionId,
          prompt: [{ type: "text", text: "must fail provider validation" }],
        })).rejects.toMatchObject({ data: { code: "provider_extension_unavailable" } });
        expect(fake.inputPostAttempts).toBe(0);
        expect(fake.inputs).toHaveLength(0);
      });
    } finally {
      child.stdin.end();
      await fake.close();
    }
    expect(stderr).toBe("");
  }, 30_000);

  it("maps controller rate limiting without action retry spin", async () => {
    const root = await tempRoot();
    const profile = path.join(root, "profile");
    const control = path.join(profile, "control-api");
    const project = path.join(root, "project");
    const state = path.join(root, "state");
    await Promise.all([fs.mkdir(control, { recursive: true }), fs.mkdir(project, { recursive: true })]);
    const fake = new FakeCos(project);
    fake.wrapSessionDetail = true;
    const port = await fake.listen();
    await fs.writeFile(path.join(control, "endpoint.json"), JSON.stringify({ url: `http://127.0.0.1:${port}`, pid: process.pid }));
    await fs.writeFile(path.join(control, "token"), `${fake.token}\n`);

    const child = spawn(process.execPath, [path.join(process.cwd(), "dist", "cli", "index.js")], {
      cwd: process.cwd(),
      env: { ...process.env, T3ONSTEROIDS_COS_USER_DATA_DIR: profile, T3ONSTEROIDS_STATE_DIR: state },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(child);
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });

    try {
      await acp.client({ name: "step8-v1-16" }).connectWith(childStream(child), async (ctx) => {
        await ctx.request(acp.methods.agent.initialize, { protocolVersion: 2, clientCapabilities: {} });

        const rateLimited = await ctx.request(acp.methods.agent.session.new, { cwd: project, mcpServers: [] });
        fake.nextInputHttpError = { status: 429, error: "rate_limited" };
        await expect(ctx.request(acp.methods.agent.session.prompt, {
          sessionId: rateLimited.sessionId,
          prompt: [{ type: "text", text: "rate limit fixture" }],
        })).rejects.toMatchObject({ data: { code: "rate_limited" } });
        expect(fake.inputPostAttempts).toBe(1);
        expect(fake.inputs).toHaveLength(0);
      });
    } finally {
      child.stdin.end();
      await fake.close();
    }
    expect(stderr).toBe("");
  }, 30_000);

  it("surfaces a blocking provider usage failure as terminal failure instead of false success", async () => {
    const root = await tempRoot();
    const profile = path.join(root, "profile");
    const control = path.join(profile, "control-api");
    const project = path.join(root, "project");
    const state = path.join(root, "state");
    await Promise.all([fs.mkdir(control, { recursive: true }), fs.mkdir(project, { recursive: true })]);
    const fake = new FakeCos(project);
    fake.wrapSessionDetail = true;
    const port = await fake.listen();
    await fs.writeFile(path.join(control, "endpoint.json"), JSON.stringify({ url: `http://127.0.0.1:${port}`, pid: process.pid }));
    await fs.writeFile(path.join(control, "token"), `${fake.token}\n`);

    const child = spawn(process.execPath, [path.join(process.cwd(), "dist", "cli", "index.js")], {
      cwd: process.cwd(),
      env: { ...process.env, T3ONSTEROIDS_COS_USER_DATA_DIR: profile, T3ONSTEROIDS_STATE_DIR: state },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(child);
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });

    try {
      await acp.client({ name: "step8-v1-16-provider" }).connectWith(childStream(child), async (ctx) => {
        await ctx.request(acp.methods.agent.initialize, {
          protocolVersion: 2,
          clientCapabilities: { session: { notices: {} } },
        });
        const created = await ctx.request(acp.methods.agent.session.new, { cwd: project, mcpServers: [] });
        const prompt = ctx.request(acp.methods.agent.session.prompt, {
          sessionId: created.sessionId,
          prompt: [{ type: "text", text: "provider usage failure fixture" }],
        });
        await fake.waitForStream(created.sessionId);
        const session = fake.sessions.get(created.sessionId);
        if (!session?.turnId) throw new Error("provider failure fixture lacks turn id");
        fake.emit(created.sessionId, "chat_error", 1, {
          recoverable: false,
          blocking: true,
          message: { text: "Provider usage limit reached", truncated: false, chars: 28 },
        });
        fake.emit(created.sessionId, "turn_end", 2, { outcome: "failed" });
        fake.emit(created.sessionId, "turn_drained", 3, {
          inputId: session.inputId,
          highWaterSeq: 3,
          finalAssistantSeq: null,
        });
        await expect(prompt).rejects.toMatchObject({ data: { code: "provider_terminal_failure" } });
        expect(fake.inputPostAttempts).toBe(1);
        expect(fake.inputs).toHaveLength(1);
      });
    } finally {
      child.stdin.end();
      await fake.close();
    }
    expect(stderr).toBe("");
  }, 30_000);

  it("keeps built-stdio output bounded and complete with a deliberately slow ACP consumer", async () => {
    const root = await tempRoot();
    const profile = path.join(root, "profile");
    const control = path.join(profile, "control-api");
    const project = path.join(root, "project");
    const state = path.join(root, "state");
    const metrics = path.join(root, "evidence", "metrics.json");
    await Promise.all([fs.mkdir(control, { recursive: true }), fs.mkdir(project, { recursive: true })]);
    const fake = new FakeCos(project);
    fake.wrapSessionDetail = true;
    const port = await fake.listen();
    await fs.writeFile(path.join(control, "endpoint.json"), JSON.stringify({ url: `http://127.0.0.1:${port}`, pid: process.pid }));
    await fs.writeFile(path.join(control, "token"), `${fake.token}\n`);

    const child = spawn(process.execPath, [path.join(process.cwd(), "dist", "cli", "index.js")], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        T3ONSTEROIDS_COS_USER_DATA_DIR: profile,
        T3ONSTEROIDS_STATE_DIR: state,
        T3ONSTEROIDS_METRICS_PATH: metrics,
      },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(child);
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    let assistant = "";

    try {
      await acp.client({ name: "step8-v1-18" })
        .onNotification(acp.methods.client.session.update, async ({ params }) => {
          if (params.update.sessionUpdate === "agent_message_chunk" && params.update.content?.type === "text") {
            assistant += params.update.content.text;
          }
        })
        .connectWith(childStream(child, { bytesPerChunk: 64, delayMs: 2 }), async (ctx) => {
          await ctx.request(acp.methods.agent.initialize, { protocolVersion: 2, clientCapabilities: {} });
          const created = await ctx.request(acp.methods.agent.session.new, { cwd: project, mcpServers: [] });
          const prompt = ctx.request(acp.methods.agent.session.prompt, {
            sessionId: created.sessionId,
            prompt: [{ type: "text", text: "slow consumer fixture" }],
          });
          await fake.waitForStream(created.sessionId);
          const session = fake.sessions.get(created.sessionId);
          if (!session?.turnId) throw new Error("slow-consumer fixture lacks turn id");
          const finalText = "S".repeat(80_000);
          fake.setAssistantContent(created.sessionId, 1, finalText);
          fake.emit(created.sessionId, "assistant_message", 1, {
            final: true,
            message: { text: finalText.slice(0, 4_000), truncated: true, chars: finalText.length },
          });
          fake.emit(created.sessionId, "turn_end", 2, { outcome: "completed" });
          fake.emit(created.sessionId, "turn_drained", 3, {
            inputId: session.inputId,
            highWaterSeq: 3,
            finalAssistantSeq: 1,
          });
          await expect(prompt).resolves.toEqual({ stopReason: "end_turn" });
          expect(assistant).toBe(finalText);
        });
    } finally {
      child.stdin.end();
      await fake.close();
    }
    const snapshot = JSON.parse(await fs.readFile(metrics, "utf8")) as Record<string, number>;
    expect(snapshot.acpTerminalSent).toBe(1);
    expect(snapshot.maxQueueDepth).toBe(0);
    expect(snapshot.rssHighWaterBytes).toBeLessThan(256 * 1024 * 1024);
    expect(stderr).toBe("");
  }, 60_000);

  it("returns cancelled for pending-input not_sent and quarantines unknown resume without CoS mutation", async () => {
    const root = await tempRoot();
    const profile = path.join(root, "profile");
    const control = path.join(profile, "control-api");
    const project = path.join(root, "project");
    const state = path.join(root, "state");
    await Promise.all([fs.mkdir(control, { recursive: true }), fs.mkdir(project, { recursive: true })]);
    const fake = new FakeCos(project);
    const port = await fake.listen();
    await fs.writeFile(path.join(control, "endpoint.json"), JSON.stringify({ url: `http://127.0.0.1:${port}`, pid: process.pid }));
    await fs.writeFile(path.join(control, "token"), `${fake.token}\n`);

    const child = spawn(process.execPath, [path.join(process.cwd(), "dist", "cli", "index.js")], {
      cwd: process.cwd(),
      env: { ...process.env, T3ONSTEROIDS_COS_USER_DATA_DIR: profile, T3ONSTEROIDS_STATE_DIR: state },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(child);
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });

    try {
      await acp.client({ name: "stdio-integration" }).connectWith(childStream(child), async (ctx) => {
        await ctx.request(acp.methods.agent.initialize, { protocolVersion: 2, clientCapabilities: {} });
        const created = await ctx.request(acp.methods.agent.session.new, { cwd: project, mcpServers: [] });
        fake.nextMode = "pending_cancel";
        const prompt = ctx.request(acp.methods.agent.session.prompt, {
          sessionId: created.sessionId,
          prompt: [{ type: "text", text: "cancel before turn" }],
        });
        await waitUntil(() => fake.sessions.has(created.sessionId));
        await ctx.notify(acp.methods.agent.session.cancel, { sessionId: created.sessionId });
        await expect(prompt).resolves.toEqual({ stopReason: "cancelled" });
        expect(fake.pendingCancels).toEqual([created.sessionId]);

        const postsBeforeResume = fake.inputs.length;
        const unknown = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
        await expect(ctx.request(acp.methods.agent.session.resume, { sessionId: unknown, cwd: project, mcpServers: [] })).resolves.toEqual({});
        await expect(ctx.request(acp.methods.agent.session.prompt, {
          sessionId: unknown,
          prompt: [{ type: "text", text: "must not reach CoS" }],
        })).rejects.toMatchObject({ data: { code: "session_broken" } });
        expect(fake.inputs).toHaveLength(postsBeforeResume);
      });
    } finally {
      child.stdin.end();
      await fake.close();
    }
    expect(stderr).toBe("");
  }, 30_000);
});
