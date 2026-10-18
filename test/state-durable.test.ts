import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { discoverCosController } from "../src/cos/index.js";
import type { SessionState } from "../src/session/index.js";
import {
  DurableAdmissionLease,
  DurableSessionStore,
  HardLinkMutex,
  PowerShellWindowsProcessIdentity,
  StateLockBusyError,
  UnsupportedStateFilesystemError,
  canonicalProfileIdentityHash,
  createProductionStateContext,
  defaultStateDirectory,
  probeHardLinkStateFilesystem,
  type ProcessIdentityResult,
  type WindowsProcessIdentity,
} from "../src/state/index.js";

const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const secondSessionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const inputId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const turnId = "turn-1";

class FakeIdentity implements WindowsProcessIdentity {
  readonly queries = new Map<number, ProcessIdentityResult>();
  currentCalls = 0;
  constructor(readonly pid: number, readonly ticks: string) {}
  async current(): Promise<{ readonly pid: number; readonly processStartTicks: string }> {
    this.currentCalls += 1;
    return { pid: this.pid, processStartTicks: this.ticks };
  }
  async query(pid: number): Promise<ProcessIdentityResult> {
    if (pid === this.pid) return { status: "live", processStartTicks: this.ticks };
    return this.queries.get(pid) ?? { status: "identity_unknown", reason: "fixture_unknown" };
  }
}

const roots: string[] = [];
async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "t3os-state-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function initial(id = sessionId): SessionState {
  return {
    sessionId: id,
    bindingState: "unbound",
    interactionMode: "default",
    cancelIntent: "none",
    cwd: "C:\\repo",
  };
}

function store(root: string, identity = new FakeIdentity(1001, "638962560000000001"), now: () => number = Date.now): DurableSessionStore {
  return new DurableSessionStore(root, {
    now,
    probeFilesystem: true,
    mutex: { identity, timeoutMs: 1_000, pollMs: 2 },
  });
}

describe("Windows hard-link state mutex", () => {
  it.runIf(process.platform === "win32")("memoizes the current PowerShell process identity across repeated mutex instances", async () => {
    const root = await tempRoot();
    const locks = path.join(root, "locks");
    const identity = new PowerShellWindowsProcessIdentity();
    const query = vi.spyOn(identity, "query");

    const first = await new HardLinkMutex(locks, "one", { identity }).acquire();
    await first.release();
    const second = await new HardLinkMutex(locks, "two", { identity }).acquire();
    await second.release();

    expect(query.mock.calls.filter(([pid]) => pid === process.pid)).toHaveLength(1);
  });

  it.runIf(process.platform === "win32")("memoizes the default durable-store process identity across transitions", async () => {
    const root = await tempRoot();
    const durable = new DurableSessionStore(root, { probeFilesystem: false });

    await durable.updateSession(sessionId, { kind: "create", state: initial() });
    await durable.updateSession(sessionId, { kind: "begin_input", inputId, generation: 1 });
    await durable.updateSession(sessionId, { kind: "bind_turn", inputId, generation: 1, turnId });
    await durable.updateSession(sessionId, { kind: "advance_cursor", inputId, generation: 1, seq: 1 });

    await expect(durable.readSession(sessionId)).resolves.toMatchObject({
      status: "found",
      value: { activeCosTurnId: turnId, cosEventCursor: 1 },
    });
  });

  it("acquires only after complete owner metadata exists and survives an orphan temp file", async () => {
    const root = await tempRoot();
    await probeHardLinkStateFilesystem(root);
    const locks = path.join(root, "locks", "unit");
    await fs.mkdir(path.join(locks, "tmp"), { recursive: true });
    await fs.writeFile(path.join(locks, "tmp", "orphan.owner"), "orphan", "utf8");
    const identity = new FakeIdentity(101, "638962560000000101");
    const mutex = new HardLinkMutex(locks, "critical", { identity, timeoutMs: 100 });

    const handle = await mutex.acquire();
    const fixed = JSON.parse(await fs.readFile(path.join(locks, "critical.lock"), "utf8"));
    expect(fixed).toMatchObject({ pid: 101, processStartTicks: identity.ticks, nonce: handle.owner.nonce });
    expect(await fs.readFile(path.join(locks, "tmp", "orphan.owner"), "utf8")).toBe("orphan");
    await handle.release();
    await expect(fs.stat(path.join(locks, "critical.lock"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["not_found", "pid_reused"] as const)("reclaims a short mutex only with positive stale proof: %s", async (reason) => {
    const root = await tempRoot();
    const locks = path.join(root, "locks");
    const firstIdentity = new FakeIdentity(111, "638962560000000111");
    const abandoned = await new HardLinkMutex(locks, "critical", { identity: firstIdentity }).acquire();
    const secondIdentity = new FakeIdentity(222, "638962560000000222");
    secondIdentity.queries.set(111, reason === "not_found"
      ? { status: "not_found" }
      : { status: "live", processStartTicks: "638962560000009999" });
    const replacement = await new HardLinkMutex(locks, "critical", { identity: secondIdentity, timeoutMs: 100 }).acquire();
    expect(replacement.owner.pid).toBe(222);
    expect(replacement.owner.nonce).not.toBe(abandoned.owner.nonce);
    await replacement.release();
  });

  it("never reclaims on identity ambiguity or matching live identity", async () => {
    const root = await tempRoot();
    const locks = path.join(root, "locks");
    const firstIdentity = new FakeIdentity(111, "638962560000000111");
    await new HardLinkMutex(locks, "critical", { identity: firstIdentity }).acquire();

    for (const result of [
      { status: "identity_unknown", reason: "timeout" } as const,
      { status: "identity_unknown", reason: "access_denied" } as const,
      { status: "identity_unknown", reason: "malformed_output" } as const,
      { status: "live", processStartTicks: firstIdentity.ticks } as const,
    ]) {
      const contender = new FakeIdentity(222, "638962560000000222");
      contender.queries.set(111, result);
      await expect(new HardLinkMutex(locks, "critical", { identity: contender, timeoutMs: 0 }).acquire())
        .rejects.toBeInstanceOf(StateLockBusyError);
    }
  });

  it("fails the capability probe instead of falling back when hard links are unavailable", async () => {
    const root = await tempRoot();
    vi.spyOn(fs, "link").mockRejectedValueOnce(Object.assign(new Error("no links"), { code: "EPERM" }));
    await expect(probeHardLinkStateFilesystem(root)).rejects.toBeInstanceOf(UnsupportedStateFilesystemError);
  });

  it.runIf(process.platform === "win32")("reads the current process start ticks through bounded PowerShell identity", async () => {
    const identity = new PowerShellWindowsProcessIdentity();
    await expect(identity.query(process.pid)).resolves.toMatchObject({ status: "live", processStartTicks: expect.stringMatching(/^[1-9][0-9]+$/) });
  });
});

describe("durable tagged session state", () => {
  it("queues same-process overlapping mutations before the hard-link mutex timeout", async () => {
    const root = await tempRoot();
    const identity = new FakeIdentity(1001, "638962560000000001");
    const durable = new DurableSessionStore(root, {
      probeFilesystem: false,
      mutex: { identity, timeoutMs: 25, pollMs: 2 },
    });
    await durable.updateSession(sessionId, { kind: "create", state: initial() });
    await durable.updateSession(sessionId, { kind: "begin_input", inputId, generation: 1 });
    await durable.updateSession(sessionId, { kind: "bind_turn", inputId, generation: 1, turnId });

    const originalWriteFile = fs.writeFile.bind(fs);
    let delayed = false;
    const writeSpy = vi.spyOn(fs, "writeFile").mockImplementation(async (...args: Parameters<typeof fs.writeFile>) => {
      const [file] = args;
      if (!delayed && String(file).includes(`${sessionId}.json.`)) {
        delayed = true;
        await new Promise((resolve) => setTimeout(resolve, 75));
      }
      return originalWriteFile(...args);
    });

    try {
      const cursor = durable.updateSession(sessionId, { kind: "advance_cursor", inputId, generation: 1, seq: 9 });
      await new Promise((resolve) => setTimeout(resolve, 5));
      const cancel = durable.updateSession(sessionId, { kind: "set_cancel", inputId, generation: 1, turnId });
      await expect(Promise.all([cursor, cancel])).resolves.toEqual([
        expect.objectContaining({ status: "updated" }),
        expect.objectContaining({ status: "updated" }),
      ]);
    } finally {
      writeSpy.mockRestore();
    }

    await expect(durable.readSession(sessionId)).resolves.toMatchObject({
      status: "found",
      value: {
        cosEventCursor: 9,
        cancelIntent: "requested",
        providerTranslation: { cursor: 9, cancelRequested: true, turnId },
      },
    });
  });

  it("serializes concurrent cursor and cancellation transitions without erasing either winner", async () => {
    const root = await tempRoot();
    const durable = store(root);
    await expect(durable.updateSession(sessionId, { kind: "create", state: initial() })).resolves.toMatchObject({ status: "updated", value: { revision: 1 } });
    await durable.updateSession(sessionId, { kind: "begin_input", inputId, generation: 1 });
    await durable.updateSession(sessionId, { kind: "bind_turn", inputId, generation: 1, turnId });

    await Promise.all([
      durable.updateSession(sessionId, { kind: "advance_cursor", inputId, generation: 1, seq: 9 }),
      durable.updateSession(sessionId, { kind: "set_cancel", inputId, generation: 1, turnId }),
    ]);

    await expect(durable.readSession(sessionId)).resolves.toMatchObject({
      status: "found",
      value: {
        revision: 5,
        cosEventCursor: 9,
        cancelIntent: "requested",
        cancelTargetTurnId: turnId,
        providerTranslation: { cursor: 9, cancelRequested: true, turnId },
      },
    });
  });

  it("serializes prompt acceptance and cancellation without erasing mode or cancel state", async () => {
    const root = await tempRoot();
    const durable = store(root);
    await durable.updateSession(sessionId, { kind: "create", state: initial() });
    await durable.updateSession(sessionId, { kind: "begin_input", inputId, generation: 1, pendingInteractionMode: "plan" });
    await durable.updateSession(sessionId, {
      kind: "binding",
      inputId,
      generation: 1,
      bindingState: "bound",
      canonicalCwd: "C:\\repo",
      cosProjectId: "project-1",
    });
    await durable.updateSession(sessionId, { kind: "bind_turn", inputId, generation: 1, turnId });

    await Promise.all([
      durable.updateSession(sessionId, { kind: "promote_mode", inputId, generation: 1 }),
      durable.updateSession(sessionId, { kind: "set_cancel", inputId, generation: 1, turnId }),
    ]);

    await expect(durable.readSession(sessionId)).resolves.toMatchObject({
      status: "found",
      value: {
        bindingState: "bound",
        interactionMode: "plan",
        cancelIntent: "requested",
        cancelTargetTurnId: turnId,
        providerTranslation: { cancelRequested: true, turnId },
      },
    });
  });

  it("rejects stale generation and wrong input transitions without advancing revision", async () => {
    const root = await tempRoot();
    const durable = store(root);
    await durable.updateSession(sessionId, { kind: "create", state: initial() });
    await durable.updateSession(sessionId, { kind: "begin_input", inputId, generation: 2 });
    const before = await durable.readSession(sessionId);
    expect(before).toMatchObject({ status: "found", value: { revision: 2 } });
    await expect(durable.updateSession(sessionId, { kind: "advance_cursor", inputId, generation: 1, seq: 8 })).resolves.toMatchObject({ status: "stale_generation" });
    await expect(durable.updateSession(sessionId, { kind: "advance_cursor", inputId: "other-input", generation: 2, seq: 8 })).resolves.toMatchObject({ status: "wrong_input" });
    const after = await durable.readSession(sessionId);
    expect(after).toMatchObject({ status: "found", value: { revision: 2 } });
    if (after.status !== "found") throw new Error("expected durable session");
    expect(after.value).not.toHaveProperty("cosEventCursor");
  });

  it("generation-guards binding and mode transitions when a first-input UUID is reused after not_sent", async () => {
    const root = await tempRoot();
    const durable = store(root);
    await durable.updateSession(sessionId, { kind: "create", state: initial() });
    await durable.updateSession(sessionId, { kind: "begin_input", inputId: sessionId, generation: 1, pendingInteractionMode: "plan" });
    await durable.updateSession(sessionId, { kind: "settle_not_sent", inputId: sessionId, generation: 1 });
    await durable.updateSession(sessionId, { kind: "begin_input", inputId: sessionId, generation: 2, pendingInteractionMode: "plan" });
    const before = await durable.readSession(sessionId);
    expect(before).toMatchObject({ status: "found", value: { revision: 4, generation: 2, interactionMode: "default", pendingInteractionMode: "plan" } });

    await expect(durable.updateSession(sessionId, {
      kind: "binding", inputId: sessionId, generation: 1, bindingState: "bound", canonicalCwd: "C:\\stale", cosProjectId: "stale",
    })).resolves.toMatchObject({ status: "stale_generation" });
    await expect(durable.updateSession(sessionId, { kind: "promote_mode", inputId: sessionId, generation: 1 })).resolves.toMatchObject({ status: "stale_generation" });
    await expect(durable.updateSession(sessionId, { kind: "revert_mode", inputId: sessionId, generation: 1 })).resolves.toMatchObject({ status: "stale_generation" });

    const after = await durable.readSession(sessionId);
    expect(after).toEqual(before);
  });

  it("promotes or reverts a pending interaction mode only for its exact input", async () => {
    const root = await tempRoot();
    const durable = store(root);
    await durable.updateSession(sessionId, { kind: "create", state: initial() });
    await durable.updateSession(sessionId, { kind: "begin_input", inputId, generation: 1, pendingInteractionMode: "plan" });
    await expect(durable.updateSession(sessionId, { kind: "promote_mode", inputId: "other", generation: 1 })).resolves.toMatchObject({ status: "wrong_input" });
    await durable.updateSession(sessionId, { kind: "promote_mode", inputId, generation: 1 });
    await expect(durable.readSession(sessionId)).resolves.toMatchObject({ status: "found", value: { interactionMode: "plan" } });

    const nextInput = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    await durable.updateSession(sessionId, { kind: "settle_not_sent", inputId, generation: 1 });
    await durable.updateSession(sessionId, { kind: "begin_input", inputId: nextInput, generation: 2, pendingInteractionMode: "default" });
    await durable.updateSession(sessionId, { kind: "revert_mode", inputId: nextInput, generation: 2 });
    const reverted = await durable.readSession(sessionId);
    expect(reverted).toMatchObject({ status: "found", value: { interactionMode: "plan" } });
    if (reverted.status !== "found") throw new Error("expected durable session");
    expect(reverted.value).not.toHaveProperty("pendingInteractionMode");
  });

  it("requires turn_end, drain, final range acceptance and exact outcome before terminal settlement", async () => {
    const root = await tempRoot();
    const durable = store(root);
    await durable.updateSession(sessionId, { kind: "create", state: initial() });
    await durable.updateSession(sessionId, { kind: "begin_input", inputId, generation: 1 });
    await durable.updateSession(sessionId, { kind: "bind_turn", inputId, generation: 1, turnId });
    await expect(durable.updateSession(sessionId, { kind: "settle_terminal", inputId, generation: 1, turnId, stopReason: "end_turn" })).resolves.toMatchObject({ status: "wrong_turn" });
    await durable.updateSession(sessionId, { kind: "record_assistant_final", inputId, generation: 1, turnId, seq: 1 });
    await durable.updateSession(sessionId, { kind: "record_turn_end", inputId, generation: 1, turnId, seq: 2, outcome: "completed" });
    await durable.updateSession(sessionId, { kind: "record_drain", inputId, generation: 1, turnId, seq: 3, finalAssistantSeq: 1 });
    await expect(durable.updateSession(sessionId, { kind: "settle_terminal", inputId, generation: 1, turnId, stopReason: "end_turn" })).resolves.toMatchObject({ status: "wrong_turn" });
    await durable.updateSession(sessionId, {
      kind: "advance_assistant_range", inputId, generation: 1, turnId, finalAssistantSeq: 1,
      expectedOffset: 0, nextOffset: 5, totalLength: 5, complete: true,
    });
    await expect(durable.updateSession(sessionId, { kind: "settle_terminal", inputId, generation: 1, turnId, stopReason: "end_turn" })).resolves.toMatchObject({ status: "updated" });
    const terminalPersisted = await durable.readSession(sessionId);
    expect(terminalPersisted).toMatchObject({
      status: "found",
      value: {
        activeInputId: inputId,
        activeCosTurnId: turnId,
        providerTranslation: { terminal: "end_turn", drainSeq: 3, cursor: 3 },
      },
    });
    await expect(durable.updateSession(sessionId, { kind: "finalize_terminal", inputId, generation: 1, turnId, stopReason: "end_turn" })).resolves.toMatchObject({ status: "updated" });
    const settled = await durable.readSession(sessionId);
    expect(settled).toMatchObject({ status: "found", value: { generation: 1, cosEventCursor: 3, cancelIntent: "none" } });
    if (settled.status !== "found") throw new Error("expected durable session");
    expect(settled.value).not.toHaveProperty("providerTranslation");
    expect(settled.value).not.toHaveProperty("activeInputId");
  });

  it("settles authoritative not_sent only while no native turn exists and reverts pending mode", async () => {
    const root = await tempRoot();
    const durable = store(root);
    await durable.updateSession(sessionId, { kind: "create", state: initial() });
    await durable.updateSession(sessionId, { kind: "begin_input", inputId, generation: 1, pendingInteractionMode: "plan" });
    await durable.updateSession(sessionId, {
      kind: "binding",
      inputId,
      generation: 1,
      bindingState: "create_pending",
      canonicalCwd: "C:\\repo",
      cosProjectId: "project-1",
    });
    await expect(durable.updateSession(sessionId, { kind: "settle_not_sent", inputId, generation: 1 })).resolves.toMatchObject({ status: "updated" });
    const notSent = await durable.readSession(sessionId);
    expect(notSent).toMatchObject({ status: "found", value: { bindingState: "unbound", interactionMode: "default" } });
    if (notSent.status !== "found") throw new Error("expected durable session");
    expect(notSent.value).not.toHaveProperty("providerTranslation");
    expect(notSent.value).not.toHaveProperty("canonicalCwd");
    expect(notSent.value).not.toHaveProperty("cosProjectId");
  });

  it.each([
    { initialMode: "default" as const, pendingMode: "plan" as const },
    { initialMode: "plan" as const, pendingMode: "default" as const },
  ])("keeps $initialMode→$pendingMode mode state correct at every restart boundary", async ({ initialMode, pendingMode }) => {
    const boundaries = ["pre_post", "dispatched_no_response", "accepted_before_promotion", "proven_not_sent"] as const;
    for (const boundary of boundaries) {
      const root = await tempRoot();
      const durable = store(root);
      const pendingInput = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
      const leaseId = "33333333-3333-4333-8333-333333333333";
      await durable.updateSession(sessionId, {
        kind: "create",
        state: {
          ...initial(),
          bindingState: "bound",
          interactionMode: initialMode,
          canonicalCwd: "C:\\repo",
          cosProjectId: "project-1",
          generation: 1,
        },
      });
      await durable.updateSession(sessionId, {
        kind: "begin_input",
        inputId: pendingInput,
        generation: 2,
        leaseId,
        pendingInteractionMode: pendingMode,
      });
      if (boundary !== "pre_post") {
        await durable.updateSession(sessionId, { kind: "mark_dispatched", inputId: pendingInput, generation: 2 });
      }

      // A new store instance models restart: the persisted journal alone decides whether the
      // pending mode remains tentative, promotes, or reverts.
      const restarted = store(root);
      await expect(restarted.readSession(sessionId)).resolves.toMatchObject({
        status: "found",
        value: {
          interactionMode: initialMode,
          pendingInteractionMode: pendingMode,
          modeTransitionInputId: pendingInput,
          inputDispatchState: boundary === "pre_post" ? "prepared" : "dispatched",
        },
      });

      if (boundary === "accepted_before_promotion") {
        await restarted.updateSession(sessionId, { kind: "promote_mode", inputId: pendingInput, generation: 2 });
        const promoted = await restarted.readSession(sessionId);
        expect(promoted).toMatchObject({ status: "found", value: { interactionMode: pendingMode, generation: 2 } });
        if (promoted.status !== "found") throw new Error("expected promoted durable session");
        expect(promoted.value).not.toHaveProperty("pendingInteractionMode");
      } else if (boundary === "pre_post" || boundary === "proven_not_sent") {
        await restarted.updateSession(sessionId, { kind: "settle_not_sent", inputId: pendingInput, generation: 2 });
        const reverted = await restarted.readSession(sessionId);
        expect(reverted).toMatchObject({ status: "found", value: { interactionMode: initialMode, generation: 2 } });
        if (reverted.status !== "found") throw new Error("expected reverted durable session");
        expect(reverted.value).not.toHaveProperty("pendingInteractionMode");
        expect(reverted.value).not.toHaveProperty("modeTransitionInputId");
      } else {
        await expect(restarted.readSession(sessionId)).resolves.toMatchObject({
          status: "found",
          value: { interactionMode: initialMode, pendingInteractionMode: pendingMode, generation: 2 },
        });
      }
    }
  });

  it.each(["corrupt", "future"] as const)("quarantines %s source bytes without overwriting them and blocks later writes", async (kind) => {
    const root = await tempRoot();
    const durable = store(root);
    await durable.init();
    const file = path.join(root, "sessions", `${sessionId}.json`);
    const source = kind === "corrupt" ? Buffer.from('{"schemaVersion":1,') : Buffer.from(JSON.stringify({ schemaVersion: 99, future: true }));
    await fs.writeFile(file, source);
    const digest = createHash("sha256").update(source).digest("hex");
    const first = await durable.readSession(sessionId);
    expect(first).toEqual(kind === "corrupt"
      ? { status: "corrupt", sha256: digest }
      : { status: "unsupportedSchema", sha256: digest, schemaVersion: 99 });
    expect(await fs.readFile(file)).toEqual(source);
    expect(JSON.parse(await fs.readFile(path.join(root, "quarantine", `${sessionId}.json`), "utf8"))).toMatchObject({
      schemaVersion: 1,
      reason: kind === "corrupt" ? "state_corrupt" : "state_schema_unsupported",
      sourceSha256: digest,
    });
    expect(await durable.readSession(sessionId)).toEqual(first);
    await expect(durable.updateSession(sessionId, { kind: "mark_broken", reason: "ambiguous_recovery" })).resolves.toEqual({ status: "quarantined" });
    expect(await fs.readFile(file)).toEqual(source);
  });

  it("prunes only old broken records and retains bound resumable sessions", async () => {
    const root = await tempRoot();
    let now = 1_000;
    const durable = store(root, new FakeIdentity(1001, "638962560000000001"), () => now);
    await durable.updateSession(sessionId, { kind: "create", state: { ...initial(), bindingState: "broken", recoveryReason: "ambiguous_recovery" } });
    await durable.updateSession(secondSessionId, { kind: "create", state: { ...initial(secondSessionId), bindingState: "bound", canonicalCwd: "C:\\repo", cosProjectId: "p" } });
    now += 31 * 24 * 60 * 60 * 1000;
    await expect(durable.pruneBroken()).resolves.toBe(1);
    await expect(durable.readSession(sessionId)).resolves.toEqual({ status: "missing" });
    await expect(durable.readSession(secondSessionId)).resolves.toMatchObject({ status: "found", value: { bindingState: "bound" } });
  });
});

describe("profile-wide durable admission lease", () => {
  it("keeps one long-lived lease across owner death evidence until authoritative proof releases it", async () => {
    const root = await tempRoot();
    const hash = "a".repeat(64);
    const firstIdentity = new FakeIdentity(101, "638962560000000101");
    const first = new DurableAdmissionLease(root, hash, { identity: firstIdentity, mutex: { timeoutMs: 100 } });
    const acquired = await first.acquire({ sessionId, inputId, generation: 1, ownerId: "owner-1" });
    expect(acquired.status).toBe("acquired");

    const secondIdentity = new FakeIdentity(202, "638962560000000202");
    secondIdentity.queries.set(101, { status: "not_found" });
    const second = new DurableAdmissionLease(root, hash, { identity: secondIdentity, mutex: { timeoutMs: 100 } });
    const held = await second.acquire({ sessionId: secondSessionId, inputId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", generation: 1, ownerId: "owner-2" });
    expect(held).toMatchObject({ status: "held", lease: { leaseId: acquired.lease.leaseId, ownerPid: 101 } });

    await expect(first.releaseAfterProof(acquired.lease.leaseId, {
      kind: "drained", sessionId, inputId, generation: 1, turnId, drainSeq: 9, cursor: 8, terminal: "end_turn", policyAttested: true,
    })).resolves.toBe("proof_mismatch");
    await expect(first.releaseAfterProof(acquired.lease.leaseId, {
      kind: "drained", sessionId, inputId, generation: 1, turnId, drainSeq: 9, cursor: 9, terminal: "end_turn", policyAttested: true,
    })).resolves.toBe("released");
  });

  it("an old reconciler cannot delete a replacement lease created after its proof", async () => {
    const root = await tempRoot();
    const hash = "b".repeat(64);
    const identity = new FakeIdentity(303, "638962560000000303");
    const lease = new DurableAdmissionLease(root, hash, { identity, mutex: { timeoutMs: 100 } });
    const old = await lease.acquire({ sessionId, inputId, generation: 1, ownerId: "owner-1" });
    expect(old.status).toBe("acquired");
    await lease.releaseAfterProof(old.lease.leaseId, { kind: "not_sent", sessionId, inputId, generation: 1 });
    const nextInput = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const replacement = await lease.acquire({ sessionId: secondSessionId, inputId: nextInput, generation: 1, ownerId: "owner-2" });
    expect(replacement.status).toBe("acquired");
    await expect(lease.releaseAfterProof(old.lease.leaseId, { kind: "not_sent", sessionId, inputId, generation: 1 })).resolves.toBe("changed");
    await expect(lease.read()).resolves.toMatchObject({ status: "found", lease: { leaseId: replacement.lease.leaseId } });
  });

  it("hashes only the canonical profile directory into a stable non-path lease identity", async () => {
    const root = await tempRoot();
    const profile = path.join(root, "Profile");
    await fs.mkdir(profile);
    const hash = await canonicalProfileIdentityHash(profile);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain("Profile");
    await expect(canonicalProfileIdentityHash(profile)).resolves.toBe(hash);
  });

  it("resolves production state only from LOCALAPPDATA or the explicit state-dir override", async () => {
    const root = await tempRoot();
    const local = path.join(root, "LocalAppData");
    const override = path.join(root, "explicit-state");

    expect(defaultStateDirectory({ LOCALAPPDATA: local })).toBe(path.join(local, "t3onsteroids", "state"));
    expect(defaultStateDirectory({ LOCALAPPDATA: local, T3ONSTEROIDS_STATE_DIR: override })).toBe(path.resolve(override));
    expect(() => defaultStateDirectory({})).toThrow("LOCALAPPDATA is required");
  });

  it.runIf(process.platform === "win32")("constructs one production state domain from canonical profile identity without endpoint metadata", async () => {
    const root = await tempRoot();
    const profile = path.join(root, "Profile");
    const stateRoot = path.join(root, "state");
    await fs.mkdir(profile);

    const context = await createProductionStateContext(profile, {
      T3ONSTEROIDS_STATE_DIR: stateRoot,
      LOCALAPPDATA: path.join(root, "ignored-local"),
      T3ONSTEROIDS_FAKE_CONTROLLER_PORT: "25580",
      T3ONSTEROIDS_FAKE_CONTROLLER_TOKEN: "must-not-affect-identity",
    });

    expect(context.stateDirectory).toBe(path.resolve(stateRoot));
    expect(context.sessionStore.root).toBe(path.resolve(stateRoot));
    expect(context.profileIdentityHash).toMatch(/^[0-9a-f]{64}$/);
    expect(context.profileIdentityHash).toBe(await canonicalProfileIdentityHash(profile));
    expect(context.profileIdentityHash).not.toContain("Profile");
    await expect(context.admissionLease.read()).resolves.toEqual({ status: "missing" });
  });

  it.runIf(process.platform === "win32")("keeps the admission domain stable across explicit controller port/token rotation", async () => {
    const root = await tempRoot();
    const profile = path.join(root, "Profile");
    const control = path.join(profile, "control-api");
    const stateRoot = path.join(root, "state");
    await fs.mkdir(control, { recursive: true });
    await fs.writeFile(path.join(control, "endpoint.json"), JSON.stringify({ url: "http://127.0.0.1:25580", pid: 101 }));
    await fs.writeFile(path.join(control, "token"), "token-one\n");
    const firstDiscovery = await discoverCosController(profile);
    const first = await createProductionStateContext(profile, { T3ONSTEROIDS_STATE_DIR: stateRoot });
    const held = await first.admissionLease.acquire({ sessionId, inputId, generation: 1, ownerId: "rotation-owner" });
    expect(held.status).toBe("acquired");

    await fs.writeFile(path.join(control, "endpoint.json"), JSON.stringify({ url: "http://127.0.0.1:29999", pid: 202 }));
    await fs.writeFile(path.join(control, "token"), "token-two\n");
    const secondDiscovery = await discoverCosController(profile);
    const second = await createProductionStateContext(profile, { T3ONSTEROIDS_STATE_DIR: stateRoot });

    expect(firstDiscovery).toMatchObject({ baseUrl: "http://127.0.0.1:25580", token: "token-one", pid: 101 });
    expect(secondDiscovery).toMatchObject({ baseUrl: "http://127.0.0.1:29999", token: "token-two", pid: 202 });
    expect(second.profileIdentityHash).toBe(first.profileIdentityHash);
    await expect(second.admissionLease.read()).resolves.toMatchObject({
      status: "found",
      lease: { leaseId: held.lease.leaseId, sessionId, inputId, generation: 1 },
    });
  });

  it.runIf(process.platform === "win32")("prunes expired broken records when the production state context starts", async () => {
    const root = await tempRoot();
    const profile = path.join(root, "Profile");
    const stateRoot = path.join(root, "state");
    await fs.mkdir(profile);
    const seeded = new DurableSessionStore(stateRoot, {
      probeFilesystem: false,
      now: () => 1,
      mutex: { identity: new FakeIdentity(707, "638962560000000707"), timeoutMs: 1_000, pollMs: 2 },
    });
    await seeded.updateSession(sessionId, {
      kind: "create",
      state: { ...initial(), bindingState: "broken", recoveryReason: "ambiguous_recovery" },
    });

    const context = await createProductionStateContext(profile, { T3ONSTEROIDS_STATE_DIR: stateRoot });
    await expect(context.sessionStore.readSession(sessionId)).resolves.toEqual({ status: "missing" });
  });

  it.runIf(process.platform === "win32")("never prunes an expired broken session that is still named by the profile lease", async () => {
    const root = await tempRoot();
    const profile = path.join(root, "Profile");
    const stateRoot = path.join(root, "state");
    await fs.mkdir(profile);
    const seeded = new DurableSessionStore(stateRoot, {
      probeFilesystem: false,
      now: () => 1,
      mutex: { identity: new FakeIdentity(808, "638962560000000808"), timeoutMs: 1_000, pollMs: 2 },
    });
    await seeded.updateSession(sessionId, {
      kind: "create",
      state: { ...initial(), bindingState: "broken", recoveryReason: "ambiguous_recovery" },
    });
    const hash = await canonicalProfileIdentityHash(profile);
    const held = new DurableAdmissionLease(stateRoot, hash, {
      identity: new FakeIdentity(809, "638962560000000809"),
      mutex: { timeoutMs: 1_000, pollMs: 2 },
    });
    await held.acquire({ sessionId, inputId, generation: 1, ownerId: "held-owner" });

    const context = await createProductionStateContext(profile, { T3ONSTEROIDS_STATE_DIR: stateRoot });
    await expect(context.sessionStore.readSession(sessionId)).resolves.toMatchObject({
      status: "found",
      value: { bindingState: "broken", recoveryReason: "ambiguous_recovery" },
    });
    await expect(context.admissionLease.read()).resolves.toMatchObject({ status: "found", lease: { sessionId } });
  });

  it.runIf(process.platform === "win32")("protects sessions referenced by every profile lease in the shared production state root", async () => {
    const root = await tempRoot();
    const profileA = path.join(root, "Profile-A");
    const profileB = path.join(root, "Profile-B");
    const stateRoot = path.join(root, "state");
    await Promise.all([fs.mkdir(profileA), fs.mkdir(profileB)]);

    const protectedSession = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const seeded = new DurableSessionStore(stateRoot, {
      probeFilesystem: false,
      now: () => 1,
      mutex: { identity: new FakeIdentity(810, "638962560000000810"), timeoutMs: 1_000, pollMs: 2 },
    });
    await seeded.updateSession(protectedSession, {
      kind: "create",
      state: {
        ...initial(),
        sessionId: protectedSession,
        bindingState: "broken",
        recoveryReason: "ambiguous_recovery",
      },
    });
    const hashB = await canonicalProfileIdentityHash(profileB);
    const leaseB = new DurableAdmissionLease(stateRoot, hashB, {
      identity: new FakeIdentity(811, "638962560000000811"),
      mutex: { timeoutMs: 1_000, pollMs: 2 },
    });
    await leaseB.acquire({
      sessionId: protectedSession,
      inputId,
      generation: 1,
      ownerId: "profile-b-owner",
    });

    // Starting a different profile shares the same sessions/ root and must therefore honor B's
    // lease before doing global retention pruning.
    await createProductionStateContext(profileA, { T3ONSTEROIDS_STATE_DIR: stateRoot });
    await expect(seeded.readSession(protectedSession)).resolves.toMatchObject({
      status: "found",
      value: { bindingState: "broken", recoveryReason: "ambiguous_recovery" },
    });
    await expect(leaseB.read()).resolves.toMatchObject({ status: "found", lease: { sessionId: protectedSession } });
  });
});
