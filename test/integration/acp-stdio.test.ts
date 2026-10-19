import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promises as fs } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

type InputMode = "active" | "pending_cancel";

interface FakeSession {
  readonly sessionId: string;
  readonly inputId: string;
  readonly turnId: string | null;
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
  readonly buildId = "a".repeat(40);
  readonly stopRequests: { sessionId: string; turnId: string }[] = [];
  readonly pendingCancels: string[] = [];
  readonly server: Server;
  nextMode: InputMode = "active";
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
      json(res, 200, {
        protocol: 1,
        app: "chat-on-steroids",
        actions: { enabled: true, routes: ["POST /v1/inputs"] },
        features: {
          "provider-project-resolve-v1": 1,
          "provider-assistant-content-v1": 1,
          "provider-session-policy-v1": 1,
          "provider-turn-drain-v1": 1,
        },
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
      this.pendingCancels.push(inputId);
      session.delivery = "not_sent";
      session.providerState = "not_sent";
      json(res, 200, { ok: true });
      return;
    }

    const sessionPath = url.pathname.match(/^\/v1\/sessions\/([^/]+)$/);
    if (req.method === "GET" && sessionPath) {
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
      for (const event of session.events) {
        if (Number(event.seq) >= from) this.writeEvent(res, event);
      }
      this.streams.set(sessionId, res);
      for (const resolve of this.streamWaiters.get(sessionId) ?? []) resolve();
      this.streamWaiters.delete(sessionId);
      req.once("close", () => this.streams.delete(sessionId));
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

function childStream(child: ChildProcessWithoutNullStreams): acp.Stream {
  return acp.ndJsonStream(
    Writable.toWeb(child.stdin) as unknown as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
  );
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
