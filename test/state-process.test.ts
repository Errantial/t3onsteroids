import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { AcpBridgeRuntime } from "../src/acp/index.js";
import type { SessionState } from "../src/session/index.js";
import { DurableAdmissionLease, DurableSessionStore, type WindowsProcessIdentity } from "../src/state/index.js";

const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const inputId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const turnId = "turn-child";
const roots: string[] = [];

class ParentIdentity implements WindowsProcessIdentity {
  async current() { return { pid: process.pid, processStartTicks: "638962560000000777" }; }
  async query(pid: number) {
    return pid === process.pid
      ? { status: "live" as const, processStartTicks: "638962560000000777" }
      : { status: "identity_unknown" as const, reason: "parent_fixture" };
  }
}

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "t3os-process-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

const viteNode = path.join(process.cwd(), "node_modules", "vite-node", "dist", "cli.mjs");
const fixture = path.join(process.cwd(), "test", "fixtures", "state-child.ts");

function child(root: string, command: string, ...args: string[]): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [viteNode, fixture, command, root, ...args], {
    cwd: process.cwd(),
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function encoded(value: object): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function firstLine(proc: ChildProcessWithoutNullStreams): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => reject(new Error(`child line timeout: ${stderr}`)), 20_000);
    proc.stderr.on("data", (chunk) => { stderr += String(chunk); });
    proc.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      const newline = stdout.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timeout);
      try { resolve(JSON.parse(stdout.slice(0, newline)) as Record<string, unknown>); }
      catch (error) { reject(error); }
    });
    proc.once("error", reject);
  });
}

function nextLine(proc: ChildProcessWithoutNullStreams, timeoutMs = 20_000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => reject(new Error(`child next-line timeout: ${stderr}`)), timeoutMs);
    const onError = (error: Error) => {
      clearTimeout(timeout);
      cleanup();
      reject(error);
    };
    const onStderr = (chunk: Buffer | string) => { stderr += String(chunk); };
    const onStdout = (chunk: Buffer | string) => {
      stdout += String(chunk);
      const newline = stdout.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timeout);
      cleanup();
      try { resolve(JSON.parse(stdout.slice(0, newline)) as Record<string, unknown>); }
      catch (error) { reject(error); }
    };
    const cleanup = () => {
      proc.stdout.off("data", onStdout);
      proc.stderr.off("data", onStderr);
      proc.off("error", onError);
    };
    proc.stderr.on("data", onStderr);
    proc.stdout.on("data", onStdout);
    proc.once("error", onError);
  });
}

function completion(proc: ChildProcessWithoutNullStreams): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error(`child completion timeout: ${stderr}`));
    }, 30_000);
    proc.stdout.on("data", (chunk) => { stdout += String(chunk); });
    proc.stderr.on("data", (chunk) => { stderr += String(chunk); });
    proc.once("error", reject);
    proc.once("exit", (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
  });
}

describe.runIf(process.platform === "win32")("cross-process durable state", () => {
  it("serializes two real processes on one hard-link mutex and recovers a crashed complete owner", async () => {
    const root = await tempRoot();
    const first = child(root, "mutex-hold", "shared", "350");
    const firstDone = completion(first);
    await expect(firstLine(first)).resolves.toMatchObject({ event: "acquired" });
    const second = child(root, "mutex-hold", "shared", "0");
    const secondDone = completion(second);
    await expect(firstLine(second)).resolves.toMatchObject({ event: "acquired" });
    await expect(firstDone).resolves.toMatchObject({ code: 0 });
    await expect(secondDone).resolves.toMatchObject({ code: 0 });

    const crashed = child(root, "mutex-crash", "crashed");
    const crashedDone = completion(crashed);
    const acquired = await firstLine(crashed);
    expect(acquired).toMatchObject({ event: "acquired", owner: { pid: expect.any(Number), processStartTicks: expect.any(String) } });
    await expect(crashedDone).resolves.toMatchObject({ code: 17 });
    const fixed = path.join(root, "locks", "children", "crashed.lock");
    expect(JSON.parse(await fs.readFile(fixed, "utf8"))).toMatchObject((acquired.owner ?? {}) as object);
    const recovered = child(root, "mutex-hold", "crashed", "0");
    const recoveredDone = completion(recovered);
    await expect(firstLine(recovered)).resolves.toMatchObject({ event: "acquired" });
    await expect(recoveredDone).resolves.toMatchObject({ code: 0 });
  }, 30_000);

  it("leaves only an orphan owner temp when a process crashes before hard-link acquisition", async () => {
    const root = await tempRoot();
    const crashed = child(root, "mutex-crash-before-link", "prelink");
    const crashedDone = completion(crashed);
    const ready = await firstLine(crashed);
    expect(ready).toMatchObject({
      event: "owner_ready",
      temp: expect.stringMatching(/^prelink\..+\.owner$/),
      owner: { pid: expect.any(Number), processStartTicks: expect.any(String), nonce: expect.any(String) },
    });
    await expect(crashedDone).resolves.toMatchObject({ code: 19 });

    const fixed = path.join(root, "locks", "children", "prelink.lock");
    await expect(fs.stat(fixed)).rejects.toMatchObject({ code: "ENOENT" });
    const orphan = path.join(root, "locks", "children", "tmp", String(ready.temp));
    expect(JSON.parse(await fs.readFile(orphan, "utf8"))).toMatchObject((ready.owner ?? {}) as object);

    const next = child(root, "mutex-hold", "prelink", "0");
    const nextDone = completion(next);
    await expect(firstLine(next)).resolves.toMatchObject({ event: "acquired" });
    await expect(nextDone).resolves.toMatchObject({ code: 0 });
  }, 30_000);

  it("preserves concurrent cursor and cancel transitions from separate processes", async () => {
    const root = await tempRoot();
    const identity = new ParentIdentity();
    const store = new DurableSessionStore(root, { probeFilesystem: true, mutex: { identity } });
    const initial: SessionState = { sessionId, bindingState: "bound", interactionMode: "default", cancelIntent: "none" };
    await store.updateSession(sessionId, { kind: "create", state: initial });
    await store.updateSession(sessionId, { kind: "begin_input", inputId, generation: 1 });
    await store.updateSession(sessionId, { kind: "bind_turn", inputId, generation: 1, turnId });

    const cursor = child(root, "transition", sessionId, encoded({ kind: "advance_cursor", inputId, generation: 1, seq: 12 }));
    const cancel = child(root, "transition", sessionId, encoded({ kind: "set_cancel", inputId, generation: 1, turnId }));
    const cursorDone = completion(cursor);
    const cancelDone = completion(cancel);
    await expect(cursorDone).resolves.toMatchObject({ code: 0 });
    await expect(cancelDone).resolves.toMatchObject({ code: 0 });
    await expect(store.readSession(sessionId)).resolves.toMatchObject({
      status: "found",
      value: { cosEventCursor: 12, cancelIntent: "requested", cancelTargetTurnId: turnId, providerTranslation: { cursor: 12, cancelRequested: true } },
    });
  }, 30_000);

  it("preserves concurrent prompt-mode acceptance and exact cancellation from separate processes", async () => {
    const root = await tempRoot();
    const identity = new ParentIdentity();
    const store = new DurableSessionStore(root, { probeFilesystem: true, mutex: { identity } });
    const initial: SessionState = { sessionId, bindingState: "bound", interactionMode: "default", cancelIntent: "none" };
    await store.updateSession(sessionId, { kind: "create", state: initial });
    await store.updateSession(sessionId, { kind: "begin_input", inputId, generation: 1, pendingInteractionMode: "plan" });
    await store.updateSession(sessionId, { kind: "bind_turn", inputId, generation: 1, turnId });

    const promote = child(root, "transition", sessionId, encoded({ kind: "promote_mode", inputId, generation: 1 }));
    const cancel = child(root, "transition", sessionId, encoded({ kind: "set_cancel", inputId, generation: 1, turnId }));
    const promoteDone = completion(promote);
    const cancelDone = completion(cancel);
    await expect(promoteDone).resolves.toMatchObject({ code: 0 });
    await expect(cancelDone).resolves.toMatchObject({ code: 0 });
    await expect(store.readSession(sessionId)).resolves.toMatchObject({
      status: "found",
      value: {
        interactionMode: "plan",
        cancelIntent: "requested",
        cancelTargetTurnId: turnId,
        providerTranslation: { cancelRequested: true, turnId },
      },
    });
  }, 30_000);

  it("admits exactly one of two simultaneous profile-wide lease contenders", async () => {
    const root = await tempRoot();
    const hash = "d".repeat(64);
    const first = child(root, "lease-acquire", hash, sessionId, inputId, "1", "owner-one");
    const second = child(root, "lease-acquire", hash, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "dddddddd-dddd-4ddd-8ddd-dddddddddddd", "1", "owner-two");
    const firstDone = completion(first);
    const secondDone = completion(second);
    const [firstResult, secondResult] = await Promise.all([firstLine(first), firstLine(second)]);
    await expect(firstDone).resolves.toMatchObject({ code: 0 });
    await expect(secondDone).resolves.toMatchObject({ code: 0 });

    expect([firstResult.status, secondResult.status].sort()).toEqual(["acquired", "held"]);
    const firstLease = firstResult.lease as { leaseId: string };
    const secondLease = secondResult.lease as { leaseId: string };
    expect(firstLease.leaseId).toBe(secondLease.leaseId);
  }, 30_000);

  it("keeps a long-lived lease after its child owner exits and exposes it to the next process", async () => {
    const root = await tempRoot();
    const hash = "c".repeat(64);
    const first = child(root, "lease-crash", hash, sessionId, inputId, "1", "owner-one");
    const firstDone = completion(first);
    const firstResult = await firstLine(first);
    expect(firstResult).toMatchObject({ status: "acquired", lease: { ownerPid: expect.any(Number) } });
    await expect(firstDone).resolves.toMatchObject({ code: 23 });

    const next = child(root, "lease-acquire", hash, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "dddddddd-dddd-4ddd-8ddd-dddddddddddd", "1", "owner-two");
    const nextDone = completion(next);
    await expect(firstLine(next)).resolves.toMatchObject({ status: "held", lease: { leaseId: (firstResult.lease as { leaseId: string }).leaseId } });
    await expect(nextDone).resolves.toMatchObject({ code: 0 });

    const lease = new DurableAdmissionLease(root, hash, { identity: new ParentIdentity() });
    await expect(lease.read()).resolves.toMatchObject({ status: "found", lease: { ownerId: "owner-one" } });
  }, 30_000);

  it("prevents a stale reconciler process from deleting a newer replacement lease", async () => {
    const root = await tempRoot();
    const hash = "e".repeat(64);
    const identity = new ParentIdentity();
    const lease = new DurableAdmissionLease(root, hash, { identity, mutex: { timeoutMs: 5_000, pollMs: 10 } });
    const old = await lease.acquire({ sessionId, inputId, generation: 1, ownerId: "old-owner" });
    expect(old.status).toBe("acquired");
    await expect(lease.releaseAfterProof(old.lease.leaseId, { kind: "not_sent", sessionId, inputId, generation: 1 })).resolves.toBe("released");

    const replacementSession = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const replacementInput = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const replacement = await lease.acquire({ sessionId: replacementSession, inputId: replacementInput, generation: 1, ownerId: "new-owner" });
    expect(replacement.status).toBe("acquired");

    const stale = child(root, "lease-release", hash, old.lease.leaseId, encoded({ kind: "not_sent", sessionId, inputId, generation: 1 }));
    const staleDone = completion(stale);
    await expect(firstLine(stale)).resolves.toEqual({ status: "changed" });
    await expect(staleDone).resolves.toMatchObject({ code: 0 });
    await expect(lease.read()).resolves.toMatchObject({ status: "found", lease: { leaseId: replacement.lease.leaseId, ownerId: "new-owner" } });
  }, 30_000);

  it("keeps a waiting contender safe while stale reconciliation releases the old lease", async () => {
    const root = await tempRoot();
    const hash = "2".repeat(64);
    const identity = new ParentIdentity();
    const lease = new DurableAdmissionLease(root, hash, { identity, mutex: { timeoutMs: 5_000, pollMs: 10 } });
    const old = await lease.acquire({ sessionId, inputId, generation: 1, ownerId: "old-owner" });
    expect(old.status).toBe("acquired");

    const replacementSession = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const replacementInput = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const waiter = child(root, "lease-wait-acquire", hash, replacementSession, replacementInput, "1", "waiting-owner");
    const waiterDone = completion(waiter);
    const waiting = await firstLine(waiter);
    expect(waiting).toEqual({ status: "waiting", heldLeaseId: old.lease.leaseId });
    const acquiredLine = nextLine(waiter, 30_000);
    const stale = child(root, "lease-release", hash, old.lease.leaseId, encoded({ kind: "not_sent", sessionId, inputId, generation: 1 }));
    const staleDone = completion(stale);
    await expect(firstLine(stale)).resolves.toEqual({ status: "released" });
    await expect(staleDone).resolves.toMatchObject({ code: 0 });
    const acquired = await acquiredLine;
    expect(acquired).toMatchObject({ status: "acquired", lease: { sessionId: replacementSession, inputId: replacementInput, ownerId: "waiting-owner" } });
    await expect(waiterDone).resolves.toMatchObject({ code: 0 });

    const replacementLeaseId = (acquired.lease as { leaseId: string }).leaseId;
    const tooLate = child(root, "lease-release", hash, old.lease.leaseId, encoded({ kind: "not_sent", sessionId, inputId, generation: 1 }));
    const tooLateDone = completion(tooLate);
    await expect(firstLine(tooLate)).resolves.toEqual({ status: "changed" });
    await expect(tooLateDone).resolves.toMatchObject({ code: 0 });
    await expect(lease.read()).resolves.toMatchObject({ status: "found", lease: { leaseId: replacementLeaseId, ownerId: "waiting-owner" } });
  }, 30_000);

  it("recovers after a real process dies at the dispatched/no-response send boundary without duplicate send", async () => {
    const root = await tempRoot();
    const hash = "f".repeat(64);
    const crashed = child(root, "runtime-send-crash", hash, sessionId);
    const crashedDone = completion(crashed);
    await expect(firstLine(crashed)).resolves.toMatchObject({
      event: "send_dispatched",
      inputId: sessionId,
      tagged: { status: "found", value: { generation: 1, inputDispatchState: "dispatched", activeInputId: sessionId } },
      held: { status: "found", lease: { inputId: sessionId, generation: 1 } },
    });
    await expect(crashedDone).resolves.toMatchObject({ code: 31 });

    const identity = new ParentIdentity();
    const store = new DurableSessionStore(root, { probeFilesystem: false, mutex: { identity, timeoutMs: 5_000, pollMs: 10 } });
    const lease = new DurableAdmissionLease(root, hash, { identity, mutex: { identity, timeoutMs: 5_000, pollMs: 10 } });
    let sends = 0;
    const restarted = new AcpBridgeRuntime({
      controller: {
        resolveProject: async () => ({ projectId: "project-1", canonicalPath: "C:\\repo" }),
        input: async (id) => ({ id, delivery: "not_sent" as const }),
        send: async (input) => {
          sends += 1;
          return { id: input.id, sessionId, delivery: "sent" as const };
        },
      },
      durableStore: store,
      durableLease: lease,
      ownerId: "parent-runtime",
      makeUuid: () => sessionId,
      canonicalize: async (value) => value,
    });
    const result = await restarted.prompt({ sessionId, prompt: [{ type: "text", text: "retry after crash" }] });
    expect(sends).toBe(1);
    expect(result.session).toMatchObject({ generation: 2, activeInputId: sessionId, inputDispatchState: "dispatched" });
    await expect(lease.read()).resolves.toMatchObject({ status: "found", lease: { generation: 2, ownerId: "parent-runtime" } });
  }, 30_000);

  it("replays exact Stop after a real process dies after persisting active-turn cancellation", async () => {
    const root = await tempRoot();
    const hash = "1".repeat(64);
    const crashed = child(root, "runtime-cancel-crash", hash, sessionId, turnId);
    const crashedDone = completion(crashed);
    await expect(firstLine(crashed)).resolves.toMatchObject({
      event: "stop_dispatched",
      exactTurn: turnId,
      tagged: {
        status: "found",
        value: { cancelIntent: "requested", cancelTargetTurnId: turnId, providerTranslation: { turnId, cancelRequested: true } },
      },
      held: { status: "found", lease: { inputId: sessionId, generation: 1 } },
    });
    await expect(crashedDone).resolves.toMatchObject({ code: 33 });

    const identity = new ParentIdentity();
    const store = new DurableSessionStore(root, { probeFilesystem: false, mutex: { identity, timeoutMs: 5_000, pollMs: 10 } });
    const lease = new DurableAdmissionLease(root, hash, { identity, mutex: { identity, timeoutMs: 5_000, pollMs: 10 } });
    const stopped: string[] = [];
    const restarted = new AcpBridgeRuntime({
      controller: {
        resolveProject: async () => ({ projectId: "project-1", canonicalPath: "C:\\repo" }),
        stopExactTurn: async (_session, exactTurn) => { stopped.push(exactTurn); },
        send: async (input) => ({ id: input.id, sessionId, delivery: "sent" as const }),
      },
      durableStore: store,
      durableLease: lease,
      ownerId: "parent-runtime",
      canonicalize: async (value) => value,
    });
    await expect(restarted.prompt({ sessionId, prompt: [{ type: "text", text: "must wait for drain" }] })).rejects.toMatchObject({ code: "input_busy" });
    expect(stopped).toEqual([turnId]);
    await expect(lease.read()).resolves.toMatchObject({ status: "found", lease: { inputId: sessionId, generation: 1 } });
  }, 30_000);

  it.each([
    { stage: "after_begin_input", exitCode: 34, oldLease: "missing", resumesByRetry: true },
    { stage: "before_lease", exitCode: 35, oldLease: "missing", resumesByRetry: true },
    { stage: "after_lease", exitCode: 37, oldLease: "found", resumesByRetry: true },
    { stage: "accepted_before_promotion", exitCode: 39, oldLease: "found", resumesByRetry: false },
    { stage: "proven_not_sent", exitCode: 41, oldLease: "missing", resumesByRetry: true },
  ] as const)("recovers safely after a real child dies at send boundary $stage", async ({ stage, exitCode, oldLease, resumesByRetry }) => {
    const root = await tempRoot();
    const hash = "3".repeat(64);
    const crashed = child(root, "runtime-send-boundary-crash", hash, sessionId, stage);
    const crashedDone = completion(crashed);
    const evidence = await firstLine(crashed);
    expect(evidence).toMatchObject({ event: stage, tagged: { status: "found", value: { generation: 1, activeInputId: sessionId } }, held: { status: oldLease } });
    await expect(crashedDone).resolves.toMatchObject({ code: exitCode });

    const identity = new ParentIdentity();
    const store = new DurableSessionStore(root, { probeFilesystem: false, mutex: { identity, timeoutMs: 5_000, pollMs: 10 } });
    const lease = new DurableAdmissionLease(root, hash, { identity, mutex: { identity, timeoutMs: 5_000, pollMs: 10 } });
    let sends = 0;
    let inputReads = 0;
    const restarted = new AcpBridgeRuntime({
      controller: {
        resolveProject: async () => ({ projectId: "project-1", canonicalPath: "C:\\repo" }),
        input: async (id) => {
          inputReads += 1;
          return stage === "accepted_before_promotion" ? { id, sessionId, delivery: "sent" as const } : undefined;
        },
        send: async (input) => {
          sends += 1;
          return { id: input.id, sessionId, delivery: "sent" as const };
        },
      },
      durableStore: store,
      durableLease: lease,
      ownerId: "parent-runtime",
      makeUuid: () => sessionId,
      canonicalize: async (value) => value,
    });

    if (resumesByRetry) {
      const result = await restarted.prompt({ sessionId, prompt: [{ type: "text", text: `retry ${stage}` }] });
      expect(result.session).toMatchObject({ generation: 2, activeInputId: sessionId, inputDispatchState: "dispatched" });
      expect(sends).toBe(1);
      expect(inputReads).toBe(0);
      await expect(lease.read()).resolves.toMatchObject({ status: "found", lease: { generation: 2, ownerId: "parent-runtime" } });
    } else {
      await expect(restarted.prompt({ sessionId, prompt: [{ type: "text", text: "must finish accepted generation" }] })).rejects.toMatchObject({ code: "input_busy" });
      expect(sends).toBe(0);
      expect(inputReads).toBe(1);
      await expect(store.readSession(sessionId)).resolves.toMatchObject({ status: "found", value: { generation: 1, bindingState: "bound", interactionMode: "default" } });
      await expect(lease.read()).resolves.toMatchObject({ status: "found", lease: { generation: 1 } });
    }
  }, 30_000);

  it.each(["pending", "active"] as const)("replays exact $0 cancellation after a child dies immediately after persisting cancel intent", async (targetKind) => {
    const root = await tempRoot();
    const hash = targetKind === "pending" ? "4".repeat(64) : "5".repeat(64);
    const crashed = child(root, "runtime-cancel-before-action-crash", hash, sessionId, targetKind, turnId);
    const crashedDone = completion(crashed);
    await expect(firstLine(crashed)).resolves.toMatchObject({
      event: "cancel_persisted",
      targetKind,
      tagged: { status: "found", value: { cancelIntent: "requested", activeInputId: sessionId } },
      held: { status: "found", lease: { inputId: sessionId, generation: 1 } },
    });
    await expect(crashedDone).resolves.toMatchObject({ code: targetKind === "active" ? 43 : 45 });

    const identity = new ParentIdentity();
    const store = new DurableSessionStore(root, { probeFilesystem: false, mutex: { identity, timeoutMs: 5_000, pollMs: 10 } });
    const lease = new DurableAdmissionLease(root, hash, { identity, mutex: { identity, timeoutMs: 5_000, pollMs: 10 } });
    let pendingCancelled = false;
    const pendingCancels: string[] = [];
    const stops: string[] = [];
    const nextInput = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const restarted = new AcpBridgeRuntime({
      controller: {
        resolveProject: async () => ({ projectId: "project-1", canonicalPath: "C:\\repo" }),
        requireBackgroundWorkDisabled: async () => ({ backgroundWork: "disabled" as const, enforced: true as const }),
        input: async (id) => ({ id, sessionId, delivery: pendingCancelled ? "not_sent" as const : "pending" as const }),
        cancelPendingInput: async (id) => { pendingCancels.push(id); pendingCancelled = true; },
        stopExactTurn: async (_session, exactTurn) => { stops.push(exactTurn); },
        send: async (input) => ({ id: input.id, sessionId, delivery: "sent" as const }),
      },
      durableStore: store,
      durableLease: lease,
      ownerId: "parent-runtime",
      makeUuid: () => nextInput,
      canonicalize: async (value) => value,
    });

    if (targetKind === "active") {
      await expect(restarted.prompt({ sessionId, prompt: [{ type: "text", text: "must await active drain" }] })).rejects.toMatchObject({ code: "input_busy" });
      expect(stops).toEqual([turnId]);
      expect(pendingCancels).toEqual([]);
      await expect(lease.read()).resolves.toMatchObject({ status: "found", lease: { generation: 1 } });
    } else {
      const result = await restarted.prompt({ sessionId, prompt: [{ type: "text", text: "after pending cancel" }] });
      expect(pendingCancels).toEqual([sessionId]);
      expect(stops).toEqual([]);
      expect(result.session).toMatchObject({ generation: 2, activeInputId: nextInput });
      await expect(lease.read()).resolves.toMatchObject({ status: "found", lease: { generation: 2, inputId: nextInput } });
    }
  }, 30_000);

  it.each(["not_sent", "pending_then_not_sent"] as const)("recovers pending cancel after child dies after cancel dispatch with remote outcome $0", async (remoteOutcome) => {
    const root = await tempRoot();
    const hash = remoteOutcome === "not_sent" ? "6".repeat(64) : "7".repeat(64);
    const crashed = child(root, "runtime-pending-cancel-crash", hash, sessionId);
    const crashedDone = completion(crashed);
    await expect(firstLine(crashed)).resolves.toMatchObject({
      event: "pending_cancel_dispatched",
      exactInput: sessionId,
      tagged: { status: "found", value: { cancelIntent: "requested", activeInputId: sessionId } },
    });
    await expect(crashedDone).resolves.toMatchObject({ code: 47 });

    const identity = new ParentIdentity();
    const store = new DurableSessionStore(root, { probeFilesystem: false, mutex: { identity, timeoutMs: 5_000, pollMs: 10 } });
    const lease = new DurableAdmissionLease(root, hash, { identity, mutex: { identity, timeoutMs: 5_000, pollMs: 10 } });
    let cancelled = remoteOutcome === "not_sent";
    let replayed = 0;
    const nextInput = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const restarted = new AcpBridgeRuntime({
      controller: {
        resolveProject: async () => ({ projectId: "project-1", canonicalPath: "C:\\repo" }),
        requireBackgroundWorkDisabled: async () => ({ backgroundWork: "disabled" as const, enforced: true as const }),
        input: async (id) => ({ id, sessionId, delivery: cancelled ? "not_sent" as const : "pending" as const }),
        cancelPendingInput: async () => { replayed += 1; cancelled = true; },
        send: async (input) => ({ id: input.id, sessionId, delivery: "sent" as const }),
      },
      durableStore: store,
      durableLease: lease,
      ownerId: "parent-runtime",
      makeUuid: () => nextInput,
      canonicalize: async (value) => value,
    });
    const result = await restarted.prompt({ sessionId, prompt: [{ type: "text", text: "after ambiguous pending cancel" }] });
    expect(replayed).toBe(remoteOutcome === "not_sent" ? 0 : 1);
    expect(result.session).toMatchObject({ generation: 2, activeInputId: nextInput });
    await expect(lease.read()).resolves.toMatchObject({ status: "found", lease: { generation: 2, inputId: nextInput } });
  }, 30_000);

  it("finalizes cancelled terminal safely after a child dies after lease deletion but before durable cleanup", async () => {
    const root = await tempRoot();
    const hash = "8".repeat(64);
    const crashed = child(root, "runtime-cancel-terminal-finalize-crash", hash, sessionId, turnId);
    const crashedDone = completion(crashed);
    await expect(firstLine(crashed)).resolves.toMatchObject({
      event: "cancel_terminal_released",
      tagged: {
        status: "found",
        value: {
          cancelIntent: "requested",
          admissionLeaseId: expect.any(String),
          providerTranslation: { turnId, terminal: "cancelled", drainSeq: 3, cursor: 3 },
        },
      },
      held: { status: "missing" },
    });
    await expect(crashedDone).resolves.toMatchObject({ code: 49 });

    const identity = new ParentIdentity();
    const store = new DurableSessionStore(root, { probeFilesystem: false, mutex: { identity, timeoutMs: 5_000, pollMs: 10 } });
    const lease = new DurableAdmissionLease(root, hash, { identity, mutex: { identity, timeoutMs: 5_000, pollMs: 10 } });
    const restarted = new AcpBridgeRuntime({
      controller: {
        resolveProject: async () => ({ projectId: "project-1", canonicalPath: "C:\\repo" }),
        session: async () => ({
          id: sessionId,
          providerTurn: { inputId: sessionId, state: "drained" as const, turnId, drainedSeq: 3, finalAssistantSeq: null },
        }),
        requireBackgroundWorkDisabled: async () => ({ backgroundWork: "disabled" as const, enforced: true as const }),
        send: async (input) => ({ id: input.id, sessionId, delivery: "sent" as const }),
      },
      durableStore: store,
      durableLease: lease,
      ownerId: "parent-runtime",
      canonicalize: async (value) => value,
    });
    await restarted.reconcilePersistedTerminal(sessionId);
    await expect(lease.read()).resolves.toEqual({ status: "missing" });
    const settled = await store.readSession(sessionId);
    expect(settled).toMatchObject({ status: "found", value: { generation: 1, cosEventCursor: 3, cancelIntent: "none" } });
    if (settled.status !== "found") throw new Error("expected settled cancelled session");
    expect(settled.value).not.toHaveProperty("providerTranslation");
    expect(settled.value).not.toHaveProperty("admissionLeaseId");
  }, 30_000);
});
