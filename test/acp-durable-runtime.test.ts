import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AcpBridgeRuntime, type BridgeController } from "../src/acp/index.js";
import type { CosProviderTurnAttestation } from "../src/cos/index.js";
import {
  DurableAdmissionLease,
  DurableSessionStore,
  type WindowsProcessIdentity,
} from "../src/state/index.js";
import type { ProviderTurnController, ProviderTurnOutputEffect } from "../src/translate/driver.js";
import type { ProviderTurnTranslationState } from "../src/translate/events.js";

const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const secondSessionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const turnId = "turn-durable-1";
const profileHash = "a".repeat(64);
const journalLeaseId = "11111111-1111-4111-8111-111111111111";
const roots: string[] = [];

class TestIdentity implements WindowsProcessIdentity {
  async current() { return { pid: process.pid, processStartTicks: "638962560000000777" }; }
  async query(pid: number) {
    return pid === process.pid
      ? { status: "live" as const, processStartTicks: "638962560000000777" }
      : { status: "identity_unknown" as const, reason: "test" };
  }
}

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "t3os-runtime-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function controller(overrides: Partial<BridgeController> = {}): BridgeController {
  return {
    resolveProject: vi.fn(async () => ({ projectId: "project-1", canonicalPath: "C:\\repo" })),
    input: vi.fn(async () => undefined),
    session: vi.fn(async () => ({ id: sessionId })),
    requireBackgroundWorkDisabled: vi.fn(async () => ({ backgroundWork: "disabled" as const, enforced: true as const })),
    cancelPendingInput: vi.fn(async () => undefined),
    stopExactTurn: vi.fn(async () => undefined),
    send: vi.fn(async (input) => ({ id: input.id, sessionId: input.sessionId ?? input.id, delivery: "sent" as const })),
    ...overrides,
  };
}

function durable(root: string) {
  const identity = new TestIdentity();
  const store = new DurableSessionStore(root, {
    probeFilesystem: false,
    mutex: { identity, timeoutMs: 1_000, pollMs: 2 },
  });
  const lease = new DurableAdmissionLease(root, profileHash, {
    identity,
    mutex: { identity, timeoutMs: 1_000, pollMs: 2 },
  });
  return { store, lease };
}

function runtime(
  ctrl: BridgeController,
  store: DurableSessionStore,
  lease: DurableAdmissionLease,
  makeUuid: () => string = () => sessionId,
): AcpBridgeRuntime {
  return new AcpBridgeRuntime({
    controller: ctrl,
    durableStore: store,
    durableLease: lease,
    ownerId: "runtime-owner",
    makeUuid,
    canonicalize: async (value) => value,
  });
}

function translation(extra: Partial<ProviderTurnTranslationState> = {}): ProviderTurnTranslationState {
  return {
    sessionId,
    inputId: sessionId,
    generation: 1,
    cursor: 0,
    cancelRequested: false,
    assistantFinals: {},
    ...extra,
  };
}

describe("durable ACP runtime boundaries", () => {
  it("settles the original pending prompt as cancelled when exact not_sent wins before a native turn exists", async () => {
    const root = await tempRoot();
    const { store, lease } = durable(root);
    let cancelled = false;
    const ctrl = controller({
      session: vi.fn(async () => ({
        id: sessionId,
        providerTurn: {
          inputId: sessionId,
          state: cancelled ? "not_sent" as const : "admitted" as const,
          turnId: null,
          drainedSeq: null,
          finalAssistantSeq: null,
        },
      })),
      input: vi.fn(async (id: string) => ({ id, sessionId, delivery: cancelled ? "not_sent" as const : "pending" as const })),
      cancelPendingInput: vi.fn(async () => { cancelled = true; }),
      send: vi.fn(async (input) => ({ id: input.id, sessionId, delivery: "pending" as const })),
    });
    const bridge = runtime(ctrl, store, lease);
    bridge.newSession({ cwd: "C:\\repo", mcpServers: [] });
    await bridge.prompt({ sessionId, prompt: [{ type: "text", text: "cancel me before turn" }] });

    await bridge.cancel(sessionId);
    const pending = bridge.awaitDurableProviderTurnOrCancelledNotSent(sessionId, { pollMs: 1 });
    await expect(pending).resolves.toEqual({ kind: "cancelled_not_sent" });
    await expect(lease.read()).resolves.toEqual({ status: "missing" });
    const settled = await store.readSession(sessionId);
    expect(settled).toMatchObject({ status: "found", value: { generation: 1, cancelIntent: "none" } });
    if (settled.status !== "found") throw new Error("expected settled session");
    expect(settled.value).not.toHaveProperty("providerTranslation");
    expect(settled.value).not.toHaveProperty("activeInputId");
  });

  it("keeps session/new memory-only and persists create_pending before an ambiguous first POST", async () => {
    const root = await tempRoot();
    const { store, lease } = durable(root);
    const ctrl = controller({
      send: vi.fn(async () => {
        await expect(store.readSession(sessionId)).resolves.toMatchObject({
          status: "found",
          value: {
            bindingState: "create_pending",
            activeInputId: sessionId,
            generation: 1,
            providerTranslation: { inputId: sessionId, generation: 1 },
          },
        });
        throw new TypeError("ambiguous dispatch");
      }),
    });
    const bridge = runtime(ctrl, store, lease);

    expect(bridge.newSession({ cwd: "C:\\repo", mcpServers: [] })).toEqual({ sessionId });
    await expect(store.readSession(sessionId)).resolves.toEqual({ status: "missing" });
    await expect(bridge.prompt({ sessionId, prompt: [{ type: "text", text: "hello" }] })).rejects.toThrow("ambiguous dispatch");

    await expect(store.readSession(sessionId)).resolves.toMatchObject({
      status: "found",
      value: { bindingState: "create_pending", generation: 1, activeInputId: sessionId, admissionLeaseId: expect.any(String) },
    });
    const held = await lease.read();
    expect(held).toMatchObject({
      status: "found",
      lease: { sessionId, inputId: sessionId, generation: 1 },
    });
    const journaled = await store.readSession(sessionId);
    if (held.status !== "found" || journaled.status !== "found") throw new Error("expected exact durable lease and session journal");
    expect(journaled.value.admissionLeaseId).toBe(held.lease.leaseId);
  });

  it("releases authoritative first-input not_sent and returns the session to unbound", async () => {
    const root = await tempRoot();
    const { store, lease } = durable(root);
    const ctrl = controller({
      send: vi.fn(async (input) => ({ id: input.id, sessionId: input.id, delivery: "not_sent" as const })),
    });
    const bridge = runtime(ctrl, store, lease);
    bridge.newSession({ cwd: "C:\\repo", mcpServers: [] });

    await expect(bridge.prompt({ sessionId, prompt: [{ type: "text", text: "hello" }] })).rejects.toMatchObject({ code: "session_broken" });
    const state = await store.readSession(sessionId);
    expect(state).toMatchObject({ status: "found", value: { bindingState: "unbound", generation: 1, interactionMode: "default" } });
    if (state.status !== "found") throw new Error("expected durable session");
    expect(state.value).not.toHaveProperty("providerTranslation");
    expect(state.value).not.toHaveProperty("activeInputId");
    await expect(lease.read()).resolves.toEqual({ status: "missing" });
  });

  it("retains the lease through turn_end and releases only after drained terminal proof is persisted", async () => {
    const root = await tempRoot();
    const { store, lease } = durable(root);
    const ctrl = controller({
      session: vi.fn(async () => ({
        id: sessionId,
        providerTurn: { inputId: sessionId, state: "drained" as const, turnId, drainedSeq: 3, finalAssistantSeq: null },
      })),
    });
    const bridge = runtime(ctrl, store, lease);
    bridge.newSession({ cwd: "C:\\repo", mcpServers: [] });
    await bridge.prompt({ sessionId, prompt: [{ type: "text", text: "hello" }] });

    await bridge.checkpointProviderTranslation(translation({
      turnId,
      cursor: 2,
      turnEndSeq: 2,
      turnOutcome: "completed",
    }));
    await expect(lease.read()).resolves.toMatchObject({ status: "found", lease: { inputId: sessionId, generation: 1 } });

    await bridge.checkpointProviderTranslation(translation({
      turnId,
      cursor: 3,
      turnEndSeq: 2,
      turnOutcome: "completed",
      drainSeq: 3,
      finalAssistantSeq: null,
      terminal: "end_turn",
    }));

    await expect(lease.read()).resolves.toEqual({ status: "missing" });
    const settled = await store.readSession(sessionId);
    expect(settled).toMatchObject({ status: "found", value: { generation: 1, cosEventCursor: 3, cancelIntent: "none" } });
    if (settled.status !== "found") throw new Error("expected durable session");
    expect(settled.value).not.toHaveProperty("providerTranslation");
    expect(settled.value).not.toHaveProperty("activeInputId");
  });

  it("persists an exact cancel target before Stop and keeps the lease until cancelled drain", async () => {
    const root = await tempRoot();
    const { store, lease } = durable(root);
    const stopExactTurn = vi.fn(async (_session: string, target: string) => {
      expect(target).toBe(turnId);
      await expect(store.readSession(sessionId)).resolves.toMatchObject({
        status: "found",
        value: {
          cancelIntent: "requested",
          cancelTargetTurnId: turnId,
          providerTranslation: { cancelRequested: true, turnId },
        },
      });
    });
    const ctrl = controller({
      stopExactTurn,
      session: vi.fn(async () => ({
        id: sessionId,
        providerTurn: { inputId: sessionId, state: "drained" as const, turnId, drainedSeq: 3, finalAssistantSeq: null },
      })),
    });
    const bridge = runtime(ctrl, store, lease);
    bridge.newSession({ cwd: "C:\\repo", mcpServers: [] });
    await bridge.prompt({ sessionId, prompt: [{ type: "text", text: "hello" }] });
    await bridge.checkpointProviderTranslation(translation({ turnId, cursor: 1 }));

    await bridge.cancel(sessionId);
    expect(stopExactTurn).toHaveBeenCalledWith(sessionId, turnId);
    await expect(lease.read()).resolves.toMatchObject({ status: "found" });

    await bridge.checkpointProviderTranslation(translation({
      turnId,
      cursor: 2,
      turnEndSeq: 2,
      turnOutcome: "stopped",
      cancelRequested: true,
    }));
    await expect(lease.read()).resolves.toMatchObject({ status: "found" });

    await bridge.checkpointProviderTranslation(translation({
      turnId,
      cursor: 3,
      turnEndSeq: 2,
      turnOutcome: "stopped",
      drainSeq: 3,
      finalAssistantSeq: null,
      terminal: "cancelled",
      cancelRequested: true,
    }));
    await expect(lease.read()).resolves.toEqual({ status: "missing" });
  });

  it("reconciles a crash after terminal persistence but before lease deletion", async () => {
    const root = await tempRoot();
    const { store, lease } = durable(root);
    const ctrl = controller({
      session: vi.fn(async () => ({
        id: sessionId,
        providerTurn: { inputId: sessionId, state: "drained" as const, turnId, drainedSeq: 3, finalAssistantSeq: null },
      })),
    });
    const first = runtime(ctrl, store, lease);
    first.newSession({ cwd: "C:\\repo", mcpServers: [] });
    await first.prompt({ sessionId, prompt: [{ type: "text", text: "hello" }] });
    await store.updateSession(sessionId, { kind: "bind_turn", inputId: sessionId, generation: 1, turnId });
    await store.updateSession(sessionId, { kind: "record_turn_end", inputId: sessionId, generation: 1, turnId, seq: 2, outcome: "completed" });
    await store.updateSession(sessionId, { kind: "record_drain", inputId: sessionId, generation: 1, turnId, seq: 3, finalAssistantSeq: null });
    await store.updateSession(sessionId, { kind: "settle_terminal", inputId: sessionId, generation: 1, turnId, stopReason: "end_turn" });
    await expect(lease.read()).resolves.toMatchObject({ status: "found" });

    const restarted = runtime(ctrl, store, lease, () => secondSessionId);
    await restarted.reconcilePersistedTerminal(sessionId);
    await expect(lease.read()).resolves.toEqual({ status: "missing" });
    const finalState = await store.readSession(sessionId);
    expect(finalState).toMatchObject({ status: "found", value: { cosEventCursor: 3, generation: 1 } });
    if (finalState.status !== "found") throw new Error("expected durable session");
    expect(finalState.value).not.toHaveProperty("providerTranslation");
    expect(ctrl.requireBackgroundWorkDisabled).toHaveBeenCalledWith(sessionId);
  });

  it("returns durable resume success for unknown and corrupt ids, then blocks the next prompt without CoS mutation", async () => {
    const root = await tempRoot();
    const { store, lease } = durable(root);
    const ctrl = controller();
    const bridge = runtime(ctrl, store, lease);

    await expect(bridge.resumeSession({ sessionId, cwd: "C:\\repo" })).resolves.toEqual({});
    await expect(store.readSession(sessionId)).resolves.toMatchObject({
      status: "found",
      value: { bindingState: "broken", recoveryReason: "unknown_resume" },
    });
    await expect(bridge.prompt({ sessionId, prompt: [{ type: "text", text: "no send" }] })).rejects.toMatchObject({ code: "session_broken" });

    await store.init();
    const corrupt = Buffer.from('{"schemaVersion":1,');
    const corruptPath = path.join(root, "sessions", `${secondSessionId}.json`);
    await fs.writeFile(corruptPath, corrupt);
    await expect(bridge.resumeSession({ sessionId: secondSessionId, cwd: "C:\\repo" })).resolves.toEqual({});
    expect(await fs.readFile(corruptPath)).toEqual(corrupt);
    await expect(bridge.prompt({ sessionId: secondSessionId, prompt: [{ type: "text", text: "still no send" }] })).rejects.toMatchObject({ code: "session_broken" });
    expect(ctrl.send).not.toHaveBeenCalled();
    expect(ctrl.resolveProject).not.toHaveBeenCalled();
  });

  it("keeps a mode change pending across ambiguous delivery, reverts it on not_sent, then promotes only the retry", async () => {
    const root = await tempRoot();
    const { store, lease } = durable(root);
    const send = vi.fn()
      .mockRejectedValueOnce(new TypeError("socket closed after dispatch"))
      .mockImplementationOnce(async (input: { id: string; sessionId?: string }) => ({ id: input.id, sessionId: input.sessionId ?? input.id, delivery: "sent" as const }));
    const ctrl = controller({
      input: vi.fn(async (id) => ({ id, sessionId: id, delivery: "not_sent" as const })),
      send,
    });
    const first = runtime(ctrl, store, lease);
    first.newSession({ cwd: "C:\\repo", mcpServers: [] });
    const planPrompt = [{ type: "text" as const, text: "<t3_code_instructions>\nmode plan\n</t3_code_instructions>\n\n<user_request>\ninspect\n</user_request>" }];

    await expect(first.prompt({ sessionId, prompt: planPrompt })).rejects.toThrow("socket closed after dispatch");
    await expect(store.readSession(sessionId)).resolves.toMatchObject({
      status: "found",
      value: { interactionMode: "default", pendingInteractionMode: "plan", generation: 1 },
    });

    const restarted = runtime(ctrl, store, lease);
    const result = await restarted.prompt({ sessionId, prompt: planPrompt });
    expect(result.session).toMatchObject({ interactionMode: "plan", generation: 2, bindingState: "bound" });
    expect(send).toHaveBeenCalledTimes(2);
    await expect(lease.read()).resolves.toMatchObject({ status: "found", lease: { generation: 2 } });
  });

  it("recovers a prepared input that crashed before lease acquisition without controller reconciliation", async () => {
    const root = await tempRoot();
    const { store, lease } = durable(root);
    await store.updateSession(sessionId, {
      kind: "create",
      state: { sessionId, cwd: "C:\\repo", bindingState: "unbound", interactionMode: "default", cancelIntent: "none" },
    });
    await store.updateSession(sessionId, { kind: "begin_input", inputId: sessionId, generation: 1, leaseId: journalLeaseId });
    await store.updateSession(sessionId, {
      kind: "binding", inputId: sessionId, generation: 1, bindingState: "create_pending", canonicalCwd: "C:\\repo", cosProjectId: "project-1",
    });
    const input = vi.fn(async () => undefined);
    const send = vi.fn(async (request: { id: string }) => ({ id: request.id, sessionId, delivery: "sent" as const }));
    const bridge = runtime(controller({ input, send }), store, lease);

    const result = await bridge.prompt({ sessionId, prompt: [{ type: "text", text: "retry safely" }] });
    expect(input).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
    expect(result.session).toMatchObject({ generation: 2, activeInputId: sessionId, inputDispatchState: "dispatched" });
    await expect(lease.read()).resolves.toMatchObject({ status: "found", lease: { generation: 2, inputId: sessionId } });
  });

  it("recovers a crash after lease acquisition but before the dispatched marker as proven not-sent", async () => {
    const root = await tempRoot();
    const { store, lease } = durable(root);
    await store.updateSession(sessionId, {
      kind: "create",
      state: { sessionId, cwd: "C:\\repo", bindingState: "unbound", interactionMode: "default", cancelIntent: "none" },
    });
    await store.updateSession(sessionId, { kind: "begin_input", inputId: sessionId, generation: 1, leaseId: journalLeaseId });
    await store.updateSession(sessionId, {
      kind: "binding", inputId: sessionId, generation: 1, bindingState: "create_pending", canonicalCwd: "C:\\repo", cosProjectId: "project-1",
    });
    await lease.acquire({ sessionId, inputId: sessionId, generation: 1, ownerId: "crashed-owner", leaseId: journalLeaseId });
    const input = vi.fn(async () => undefined);
    const send = vi.fn(async (request: { id: string }) => ({ id: request.id, sessionId, delivery: "sent" as const }));
    const bridge = runtime(controller({ input, send }), store, lease);

    const result = await bridge.prompt({ sessionId, prompt: [{ type: "text", text: "retry after pre-dispatch crash" }] });
    expect(input).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
    expect(result.session).toMatchObject({ generation: 2, inputDispatchState: "dispatched" });
    await expect(lease.read()).resolves.toMatchObject({ status: "found", lease: { generation: 2 } });
  });

  it("re-dispatches a persisted pending cancellation after restart and settles only on exact not_sent proof", async () => {
    const root = await tempRoot();
    const { store, lease } = durable(root);
    const first = runtime(controller(), store, lease);
    first.newSession({ cwd: "C:\\repo", mcpServers: [] });
    await first.prompt({ sessionId, prompt: [{ type: "text", text: "one" }] });
    await store.updateSession(sessionId, { kind: "set_cancel", inputId: sessionId, generation: 1 });

    let cancelled = false;
    const input = vi.fn(async (id: string) => ({ id, sessionId, delivery: cancelled ? "not_sent" as const : "pending" as const }));
    const cancelPendingInput = vi.fn(async () => { cancelled = true; });
    const nextInput = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const restarted = runtime(controller({ input, cancelPendingInput }), store, lease, () => nextInput);

    const result = await restarted.prompt({ sessionId, prompt: [{ type: "text", text: "after cancellation" }] });
    expect(cancelPendingInput).toHaveBeenCalledWith(sessionId);
    expect(result.session).toMatchObject({ generation: 2, activeInputId: nextInput, cancelIntent: "none" });
    await expect(lease.read()).resolves.toMatchObject({ status: "found", lease: { inputId: nextInput, generation: 2 } });
  });

  it("re-dispatches exact Stop after a crash with persisted active-turn cancellation and retains the lease", async () => {
    const root = await tempRoot();
    const { store, lease } = durable(root);
    const first = runtime(controller(), store, lease);
    first.newSession({ cwd: "C:\\repo", mcpServers: [] });
    await first.prompt({ sessionId, prompt: [{ type: "text", text: "one" }] });
    await first.checkpointProviderTranslation(translation({ turnId, cursor: 1 }));
    await store.updateSession(sessionId, { kind: "set_cancel", inputId: sessionId, generation: 1, turnId });

    const stopExactTurn = vi.fn(async () => undefined);
    const restarted = runtime(controller({ stopExactTurn }), store, lease);
    await expect(restarted.prompt({ sessionId, prompt: [{ type: "text", text: "must wait" }] })).rejects.toMatchObject({ code: "input_busy" });
    expect(stopExactTurn).toHaveBeenCalledWith(sessionId, turnId);
    await expect(lease.read()).resolves.toMatchObject({ status: "found", lease: { inputId: sessionId, generation: 1 } });
    await expect(store.readSession(sessionId)).resolves.toMatchObject({ status: "found", value: { cancelIntent: "requested", cancelTargetTurnId: turnId } });
  });

  it("fails closed if a create_pending recovery resolves to a different project", async () => {
    const root = await tempRoot();
    const { store, lease } = durable(root);
    const ambiguous = runtime(controller({ send: vi.fn(async () => { throw new TypeError("ambiguous"); }) }), store, lease);
    ambiguous.newSession({ cwd: "C:\\repo", mcpServers: [] });
    await expect(ambiguous.prompt({ sessionId, prompt: [{ type: "text", text: "one" }] })).rejects.toThrow("ambiguous");

    const input = vi.fn(async (id: string) => ({ id, sessionId, delivery: "sent" as const }));
    const restarted = runtime(controller({
      resolveProject: vi.fn(async () => ({ projectId: "project-2", canonicalPath: "C:\\repo" })),
      input,
    }), store, lease);
    await expect(restarted.prompt({ sessionId, prompt: [{ type: "text", text: "retry" }] })).rejects.toMatchObject({ code: "project_unmapped" });
    expect(input).not.toHaveBeenCalled();
    await expect(store.readSession(sessionId)).resolves.toMatchObject({ status: "found", value: { bindingState: "broken", recoveryReason: "project_remapped", cosProjectId: "project-1" } });
  });

  it("rejects accepted input records whose session identity does not match the exact ACP session", async () => {
    const root = await tempRoot();
    const { store, lease } = durable(root);
    const bridge = runtime(controller({
      send: vi.fn(async (input) => ({ id: input.id, sessionId: secondSessionId, delivery: "sent" as const })),
    }), store, lease);
    bridge.newSession({ cwd: "C:\\repo", mcpServers: [] });

    await expect(bridge.prompt({ sessionId, prompt: [{ type: "text", text: "wrong session" }] })).rejects.toMatchObject({ code: "session_broken" });
    await expect(store.readSession(sessionId)).resolves.toMatchObject({ status: "found", value: { bindingState: "broken", recoveryReason: "ambiguous_recovery" } });
    await expect(lease.read()).resolves.toMatchObject({ status: "found", lease: { sessionId, generation: 1 } });
  });

  it("uses the validated resumed cwd overlay while retaining the durable canonical project identity", async () => {
    const root = await tempRoot();
    const { store, lease } = durable(root);
    await store.updateSession(sessionId, {
      kind: "create",
      state: {
        sessionId,
        cwd: "C:\\old-spelling",
        canonicalCwd: "C:\\repo",
        cosProjectId: "project-1",
        bindingState: "bound",
        interactionMode: "default",
        cancelIntent: "none",
      },
    });
    const resolveProject = vi.fn(async (cwd: string) => ({ projectId: "project-1", canonicalPath: cwd }));
    const send = vi.fn(async (input: { id: string }) => ({ id: input.id, delivery: "not_sent" as const }));
    const bridge = new AcpBridgeRuntime({
      controller: controller({ resolveProject, send }),
      durableStore: store,
      durableLease: lease,
      ownerId: "runtime-owner",
      makeUuid: () => "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      canonicalize: async (value) => value === "C:\\repo\\." ? "C:\\repo" : value,
    });

    await expect(bridge.resumeSession({ sessionId, cwd: "C:\\repo\\." })).resolves.toEqual({});
    await expect(bridge.prompt({ sessionId, prompt: [{ type: "text", text: "continue one" }] })).rejects.toMatchObject({ code: "session_broken" });
    await expect(bridge.prompt({ sessionId, prompt: [{ type: "text", text: "continue two" }] })).rejects.toMatchObject({ code: "session_broken" });
    expect(resolveProject.mock.calls.map(([cwd]) => cwd)).toEqual(["C:\\repo\\.", "C:\\repo\\."]);
  });

  it.each([
    { initial: "default" as const, pending: "plan" as const },
    { initial: "plan" as const, pending: "default" as const },
  ])("promotes $initial→$pending after restart when acceptance happened before mode promotion", async ({ initial, pending }) => {
    const root = await tempRoot();
    const { store, lease } = durable(root);
    const pendingId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    await store.updateSession(sessionId, {
      kind: "create",
      state: {
        sessionId,
        cwd: "C:\\repo",
        canonicalCwd: "C:\\repo",
        cosProjectId: "project-1",
        bindingState: "bound",
        interactionMode: initial,
        cancelIntent: "none",
        generation: 1,
      },
    });
    await store.updateSession(sessionId, { kind: "begin_input", inputId: pendingId, generation: 2, leaseId: journalLeaseId, pendingInteractionMode: pending });
    await store.updateSession(sessionId, { kind: "mark_dispatched", inputId: pendingId, generation: 2 });
    await lease.acquire({ sessionId, inputId: pendingId, generation: 2, ownerId: "crashed-owner", leaseId: journalLeaseId });
    const ctrl = controller({ input: vi.fn(async (id: string) => ({ id, sessionId, delivery: "sent" as const })) });
    const restarted = runtime(ctrl, store, lease);

    await expect(restarted.prompt({ sessionId, prompt: [{ type: "text", text: "must not admit next yet" }] })).rejects.toMatchObject({ code: "input_busy" });
    await expect(store.readSession(sessionId)).resolves.toMatchObject({ status: "found", value: { interactionMode: pending, generation: 2 } });
    expect(ctrl.send).not.toHaveBeenCalled();
  });

  it("wires the controller driver through narrow durable checkpoints and releases only after accepted drain terminal", async () => {
    const root = await tempRoot();
    const { store, lease } = durable(root);
    let attested: CosProviderTurnAttestation = {
      inputId: sessionId,
      state: "active" as const,
      turnId,
      drainedSeq: null,
      finalAssistantSeq: null,
    };
    const bridge = runtime(controller({
      session: vi.fn(async () => ({ id: sessionId, providerTurn: attested })),
    }), store, lease);
    bridge.newSession({ cwd: "C:\\repo", mcpServers: [] });
    await bridge.prompt({ sessionId, prompt: [{ type: "text", text: "drive it" }] });
    const provider: ProviderTurnController = {
      session: async () => ({ id: sessionId, providerTurn: attested }),
      requireBackgroundWorkDisabled: async () => ({ backgroundWork: "disabled", enforced: true }),
      assistantContentChunk: async () => { throw new Error("no assistant body expected"); },
      streamEvents: async function* () {
        yield { seq: 1, position: 1, time: 1, kind: "turn_end", source: "extension", turnId, outcome: "completed" };
        attested = { inputId: sessionId, state: "drained", turnId, drainedSeq: 2, finalAssistantSeq: null };
        yield { seq: 2, position: 2, time: 2, kind: "turn_drained", source: "extension", turnId, inputId: sessionId, highWaterSeq: 2, finalAssistantSeq: null };
      },
    };
    const emitted: ProviderTurnOutputEffect[] = [];

    const result = await bridge.driveDurableProviderTurn(provider, {
      sessionId,
      emit: async (effect) => { emitted.push(effect); },
    });

    expect(result.terminal).toMatchObject({ stopReason: "end_turn", inputId: sessionId, turnId });
    expect(emitted).toEqual([expect.objectContaining({ kind: "terminal", stopReason: "end_turn" })]);
    await expect(lease.read()).resolves.toEqual({ status: "missing" });
    const settled = await store.readSession(sessionId);
    expect(settled).toMatchObject({ status: "found", value: { generation: 1, cosEventCursor: 2, cancelIntent: "none" } });
    if (settled.status !== "found") throw new Error("expected durable state");
    expect(settled.value).not.toHaveProperty("providerTranslation");
  });

  it("persists completion for an authoritative empty final and releases only after terminal acceptance", async () => {
    const root = await tempRoot();
    const { store, lease } = durable(root);
    let attested: CosProviderTurnAttestation = {
      inputId: sessionId, state: "active", turnId, drainedSeq: null, finalAssistantSeq: null,
    };
    const ctrl = controller({ session: vi.fn(async () => ({ id: sessionId, providerTurn: attested })) });
    const bridge = runtime(ctrl, store, lease);
    bridge.newSession({ cwd: "C:\\repo", mcpServers: [] });
    await bridge.prompt({ sessionId, prompt: [{ type: "text", text: "empty final" }] });

    const provider: ProviderTurnController = {
      session: async () => ({ id: sessionId, providerTurn: attested }),
      requireBackgroundWorkDisabled: async () => ({ backgroundWork: "disabled", enforced: true }),
      assistantContentChunk: async (_session, seq, offset = 0) => ({
        sessionId, seq, field: "assistantText", offset, text: "", totalLength: 0, complete: true,
      }),
      streamEvents: async function* () {
        yield { seq: 1, position: 1, time: 1, kind: "assistant_message", source: "extension", turnId, final: true, messageId: "empty", message: { text: "", truncated: false, chars: 0 } };
        yield { seq: 2, position: 2, time: 2, kind: "turn_end", source: "extension", turnId, outcome: "completed" };
        attested = { inputId: sessionId, state: "drained", turnId, drainedSeq: 3, finalAssistantSeq: 1 };
        yield { seq: 3, position: 3, time: 3, kind: "turn_drained", source: "extension", turnId, inputId: sessionId, highWaterSeq: 3, finalAssistantSeq: 1 };
      },
    };
    const emitted: ProviderTurnOutputEffect[] = [];
    const result = await bridge.driveDurableProviderTurn(provider, { sessionId, emit: async (effect) => { emitted.push(effect); } });

    expect(emitted).toEqual([expect.objectContaining({ kind: "terminal", stopReason: "end_turn" })]);
    expect(result.state).toMatchObject({ finalAssistantOffset: 0, finalAssistantTotalLength: 0, finalAssistantEmittedSeq: 1, terminal: "end_turn" });
    await expect(lease.read()).resolves.toEqual({ status: "missing" });
  });

  it("never adopts or deletes a same-generation replacement lease with a different exact lease id", async () => {
    const root = await tempRoot();
    const { store, lease } = durable(root);
    const first = runtime(controller({ send: vi.fn(async () => { throw new TypeError("ambiguous send"); }) }), store, lease);
    first.newSession({ cwd: "C:\\repo", mcpServers: [] });
    await expect(first.prompt({ sessionId, prompt: [{ type: "text", text: "one" }] })).rejects.toThrow("ambiguous send");
    const journal = await store.readSession(sessionId);
    const old = await lease.read();
    if (journal.status !== "found" || old.status !== "found") throw new Error("expected admitted old generation");
    expect(journal.value.admissionLeaseId).toBe(old.lease.leaseId);
    await expect(lease.releaseAfterProof(old.lease.leaseId, { kind: "not_sent", sessionId, inputId: sessionId, generation: 1 })).resolves.toBe("released");

    const replacementId = "22222222-2222-4222-8222-222222222222";
    await expect(lease.acquire({ sessionId, inputId: sessionId, generation: 1, ownerId: "replacement", leaseId: replacementId })).resolves.toMatchObject({
      status: "acquired", lease: { leaseId: replacementId },
    });
    const restarted = runtime(controller(), store, lease);
    await expect(restarted.prompt({ sessionId, prompt: [{ type: "text", text: "two" }] })).rejects.toMatchObject({ code: "input_busy" });
    await expect(lease.read()).resolves.toMatchObject({ status: "found", lease: { leaseId: replacementId, generation: 1 } });
  });

  it("retains terminal proof and lease when fresh policy attestation fails at release, then reconciles safely", async () => {
    const root = await tempRoot();
    const { store, lease } = durable(root);
    let policyFails = true;
    const ctrl = controller({
      session: vi.fn(async () => ({
        id: sessionId,
        providerTurn: { inputId: sessionId, state: "drained" as const, turnId, drainedSeq: 3, finalAssistantSeq: null },
      })),
      requireBackgroundWorkDisabled: vi.fn(async () => {
        if (policyFails) throw new Error("policy unavailable");
        return { backgroundWork: "disabled" as const, enforced: true as const };
      }),
    });
    const bridge = runtime(ctrl, store, lease);
    bridge.newSession({ cwd: "C:\\repo", mcpServers: [] });
    await bridge.prompt({ sessionId, prompt: [{ type: "text", text: "one" }] });
    await bridge.checkpointProviderTranslation(translation({ turnId, cursor: 2, turnEndSeq: 2, turnOutcome: "completed" }));
    await expect(bridge.checkpointProviderTranslation(translation({
      turnId, cursor: 3, turnEndSeq: 2, turnOutcome: "completed", drainSeq: 3, finalAssistantSeq: null, terminal: "end_turn",
    }))).rejects.toMatchObject({ code: "provider_policy_unavailable" });
    await expect(store.readSession(sessionId)).resolves.toMatchObject({ status: "found", value: { providerTranslation: { terminal: "end_turn" } } });
    await expect(lease.read()).resolves.toMatchObject({ status: "found" });

    policyFails = false;
    await bridge.reconcilePersistedTerminal(sessionId);
    await expect(lease.read()).resolves.toEqual({ status: "missing" });
  });
});
