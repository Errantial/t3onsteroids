import { describe, expect, it, vi } from "vitest";

import { AcpBridgeRuntime, type BridgeController } from "../src/acp/index.js";
import { compatibility } from "../src/compatibility.js";
import { COS_REQUIRED_ACTION_ROUTES, type CosControllerReadiness } from "../src/cos/index.js";
import type { SessionState } from "../src/session/index.js";
import { MemoryAdmissionLease, MemoryStateStore } from "../src/state/index.js";

const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const secondSessionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const inputId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const readiness: CosControllerReadiness = {
  protocol: 1,
  app: "chat-on-steroids",
  actionsEnabled: true,
  actionRoutes: [...COS_REQUIRED_ACTION_ROUTES],
  features: {
    "provider-project-resolve-v1": 1,
    "provider-assistant-content-v1": 1,
    "provider-session-policy-v1": 1,
    "provider-turn-drain-v1": 1,
    "provider-turn-recovery-v1": 1,
  },
  providerExtension: { apiVersion: 1, buildId: compatibility.cos.providerExtension.buildId },
};

function controller(overrides: Partial<BridgeController> = {}): BridgeController {
  return {
    health: vi.fn(async () => readiness),
    requireProviderExtension: vi.fn(async () => readiness),
    requireBackgroundWorkDisabled: vi.fn(async () => ({ backgroundWork: "disabled" as const, enforced: true as const })),
    resolveProject: vi.fn(async () => ({ projectId: "project-1", canonicalPath: "C:\\repo" })),
    input: vi.fn(async () => undefined),
    cancelPendingInput: vi.fn(async () => undefined),
    stopExactTurn: vi.fn(async () => undefined),
    send: vi.fn(async (input) => ({ id: input.id, sessionId: input.sessionId ?? input.id, delivery: "sent" as const })),
    ...overrides,
  };
}

describe("Phase 5 lifecycle and recovery hardening", () => {
  it("reports actions-disabled before any send", async () => {
    const ctrl = controller({ requireProviderExtension: vi.fn(async () => ({ ...readiness, actionsEnabled: false })) });
    const runtime = new AcpBridgeRuntime({
      controller: ctrl,
      store: new MemoryStateStore<SessionState>(),
      makeUuid: () => sessionId,
      canonicalize: async (path) => path,
    });
    runtime.newSession({ cwd: "C:\\repo", mcpServers: [] });
    await expect(runtime.prompt({ sessionId, prompt: [{ type: "text", text: "hello" }] })).rejects.toMatchObject({ code: "actions_disabled" });
    expect(ctrl.send).not.toHaveBeenCalled();
  });

  it("takes a new readiness snapshot at each prompt admission boundary", async () => {
    const snapshots = [readiness, { ...readiness, actionsEnabled: false }];
    const requireProviderExtension = vi.fn(async () => snapshots.shift() ?? readiness);
    const ctrl = controller({ requireProviderExtension });
    const ids = [sessionId, secondSessionId];
    const runtime = new AcpBridgeRuntime({
      controller: ctrl,
      store: new MemoryStateStore<SessionState>(),
      makeUuid: () => ids.shift()!,
      canonicalize: async (path) => path,
    });
    runtime.newSession({ cwd: "C:\\repo", mcpServers: [] });
    runtime.newSession({ cwd: "C:\\repo", mcpServers: [] });

    await expect(runtime.prompt({ sessionId, prompt: [{ type: "text", text: "first" }] })).resolves.toBeDefined();
    await expect(runtime.prompt({ sessionId: secondSessionId, prompt: [{ type: "text", text: "second" }] })).rejects.toMatchObject({ code: "actions_disabled" });
    expect(requireProviderExtension).toHaveBeenCalledTimes(2);
    expect(ctrl.send).toHaveBeenCalledTimes(1);
  });

  it("revalidates backgroundWork policy before each bound prompt and marks the session broken on loss", async () => {
    const store = new MemoryStateStore<SessionState>();
    await store.write(sessionId, {
      sessionId,
      cwd: "C:\\repo",
      bindingState: "bound",
      interactionMode: "default",
      cancelIntent: "none",
      canonicalCwd: "C:\\repo",
      cosProjectId: "project-1",
    });
    const ctrl = controller({
      requireBackgroundWorkDisabled: vi.fn(async () => {
        throw new Error("lost attestation");
      }),
    });
    const runtime = new AcpBridgeRuntime({ controller: ctrl, store, makeUuid: () => inputId, canonicalize: async (path) => path });

    await expect(runtime.prompt({ sessionId, prompt: [{ type: "text", text: "hello" }] })).rejects.toMatchObject({ code: "provider_policy_unavailable" });
    await expect(store.read(sessionId)).resolves.toMatchObject({ bindingState: "broken" });
    expect(ctrl.send).not.toHaveBeenCalled();
  });

  it("uses one stable admission domain across bridge runtimes", async () => {
    const lease = new MemoryAdmissionLease();
    const ctrl1 = controller();
    const ctrl2 = controller();
    const store1 = new MemoryStateStore<SessionState>();
    const store2 = new MemoryStateStore<SessionState>();
    const runtime1 = new AcpBridgeRuntime({
      controller: ctrl1,
      store: store1,
      lease,
      controllerIdentity: "profile-A",
      ownerId: "owner-1",
      makeUuid: () => sessionId,
      canonicalize: async (path) => path,
    });
    const runtime2 = new AcpBridgeRuntime({
      controller: ctrl2,
      store: store2,
      lease,
      controllerIdentity: "profile-A",
      ownerId: "owner-2",
      makeUuid: () => secondSessionId,
      canonicalize: async (path) => path,
    });
    runtime1.newSession({ cwd: "C:\\repo", mcpServers: [] });
    runtime2.newSession({ cwd: "C:\\repo", mcpServers: [] });

    await runtime1.prompt({ sessionId, prompt: [{ type: "text", text: "one" }] });
    await expect(runtime2.prompt({ sessionId: secondSessionId, prompt: [{ type: "text", text: "two" }] })).rejects.toMatchObject({ code: "input_busy" });
    expect(ctrl2.send).not.toHaveBeenCalled();
  });

  it("keeps the lease held after an ambiguous send failure", async () => {
    const lease = new MemoryAdmissionLease();
    const ctrl1 = controller({ send: vi.fn(async () => { throw new TypeError("socket closed after dispatch"); }) });
    const ctrl2 = controller();
    const runtime1 = new AcpBridgeRuntime({
      controller: ctrl1,
      store: new MemoryStateStore<SessionState>(),
      lease,
      controllerIdentity: "profile-A",
      ownerId: "owner-1",
      makeUuid: () => sessionId,
      canonicalize: async (path) => path,
    });
    const runtime2 = new AcpBridgeRuntime({
      controller: ctrl2,
      store: new MemoryStateStore<SessionState>(),
      lease,
      controllerIdentity: "profile-A",
      ownerId: "owner-2",
      makeUuid: () => secondSessionId,
      canonicalize: async (path) => path,
    });
    runtime1.newSession({ cwd: "C:\\repo", mcpServers: [] });
    runtime2.newSession({ cwd: "C:\\repo", mcpServers: [] });

    await expect(runtime1.prompt({ sessionId, prompt: [{ type: "text", text: "one" }] })).rejects.toThrow(/socket closed/);
    await expect(runtime2.prompt({ sessionId: secondSessionId, prompt: [{ type: "text", text: "two" }] })).rejects.toMatchObject({ code: "input_busy" });
    expect(ctrl2.send).not.toHaveBeenCalled();
  });

  it("persists cancellation intent before exact-turn Stop and targets only the saved turn", async () => {
    const store = new MemoryStateStore<SessionState>();
    await store.write(sessionId, {
      sessionId,
      cwd: "C:\\repo",
      bindingState: "bound",
      interactionMode: "default",
      cancelIntent: "none",
      canonicalCwd: "C:\\repo",
      cosProjectId: "project-1",
      activeInputId: inputId,
      activeCosTurnId: "turn-7",
    });
    const ctrl = controller();
    (ctrl.stopExactTurn as ReturnType<typeof vi.fn>).mockImplementation(async (_session, turn) => {
      expect(turn).toBe("turn-7");
      await expect(store.read(sessionId)).resolves.toMatchObject({ cancelIntent: "requested", cancelTargetTurnId: "turn-7" });
    });
    const runtime = new AcpBridgeRuntime({ controller: ctrl, store, canonicalize: async (path) => path });

    await runtime.cancel(sessionId);
    expect(ctrl.stopExactTurn).toHaveBeenCalledWith(sessionId, "turn-7");
    await expect(store.read(sessionId)).resolves.toMatchObject({ cancelIntent: "none" });
  });

  it("blocks new work while persisted cancellation intent is unresolved", async () => {
    const store = new MemoryStateStore<SessionState>();
    await store.write(sessionId, {
      sessionId,
      cwd: "C:\\repo",
      bindingState: "bound",
      interactionMode: "default",
      cancelIntent: "requested",
      cancelTargetTurnId: "turn-7",
      canonicalCwd: "C:\\repo",
      cosProjectId: "project-1",
      activeInputId: inputId,
      activeCosTurnId: "turn-7",
    });
    const ctrl = controller();
    const runtime = new AcpBridgeRuntime({ controller: ctrl, store, canonicalize: async (path) => path });

    await expect(runtime.prompt({ sessionId, prompt: [{ type: "text", text: "new" }] })).rejects.toMatchObject({ code: "session_broken" });
    expect(ctrl.send).not.toHaveBeenCalled();
  });

  it("marks remapped bound project as broken before send", async () => {
    const store = new MemoryStateStore<SessionState>();
    await store.write(sessionId, {
      sessionId,
      cwd: "C:\\repo",
      bindingState: "bound",
      interactionMode: "default",
      cancelIntent: "none",
      canonicalCwd: "C:\\repo",
      cosProjectId: "project-1",
    });
    const ctrl = controller({ resolveProject: vi.fn(async () => ({ projectId: "project-2", canonicalPath: "C:\\repo" })) });
    const runtime = new AcpBridgeRuntime({ controller: ctrl, store, makeUuid: () => inputId, canonicalize: async (path) => path });

    await expect(runtime.prompt({ sessionId, prompt: [{ type: "text", text: "hello" }] })).rejects.toMatchObject({ code: "project_unmapped" });
    await expect(store.read(sessionId)).resolves.toMatchObject({ bindingState: "broken" });
    expect(ctrl.send).not.toHaveBeenCalled();
  });
});
