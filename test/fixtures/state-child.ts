import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";

import { AcpBridgeRuntime } from "../../src/acp/index.js";
import {
  DurableAdmissionLease,
  DurableSessionStore,
  HardLinkMutex,
  PowerShellWindowsProcessIdentity,
  type WindowsProcessIdentity,
} from "../../src/state/index.js";

const [command, root, ...args] = process.argv.slice(2);
if (!command || !root) throw new Error("missing child command/root");

function line(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function flushedLine(value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(`${JSON.stringify(value)}\n`, (error) => error ? reject(error) : resolve());
  });
}

class ChildIdentity implements WindowsProcessIdentity {
  async current() {
    return { pid: process.pid, processStartTicks: `6389625600${String(process.pid).padStart(8, "0")}` };
  }

  async query(pid: number) {
    if (pid === process.pid) {
      return { status: "live" as const, processStartTicks: `6389625600${String(process.pid).padStart(8, "0")}` };
    }
    return { status: "identity_unknown" as const, reason: "child_fixture_foreign_pid" };
  }
}

const childIdentity = new ChildIdentity();

function runtimeMutexOptions() {
  return { identity: childIdentity, timeoutMs: 5_000, pollMs: 10 } as const;
}

function runtimeStore(root: string): DurableSessionStore {
  return new DurableSessionStore(root, { probeFilesystem: false, mutex: runtimeMutexOptions() });
}

function runtimeLease(root: string, hash: string): DurableAdmissionLease {
  return new DurableAdmissionLease(root, hash, { identity: childIdentity, mutex: runtimeMutexOptions() });
}

switch (command) {
  case "mutex-hold": {
    const [name, holdRaw] = args;
    if (!name) throw new Error("missing mutex name");
    const holdMs = Number(holdRaw ?? 0);
    const handle = await new HardLinkMutex(`${root}\\locks\\children`, name, { timeoutMs: 5_000, pollMs: 10 }).acquire();
    line({ event: "acquired", owner: handle.owner });
    await new Promise((resolve) => setTimeout(resolve, holdMs));
    await handle.release();
    line({ event: "released" });
    break;
  }
  case "mutex-crash": {
    const [name] = args;
    if (!name) throw new Error("missing mutex name");
    const handle = await new HardLinkMutex(`${root}\\locks\\children`, name, { timeoutMs: 5_000 }).acquire();
    line({ event: "acquired", owner: handle.owner });
    process.exit(17);
    break;
  }
  case "mutex-crash-before-link": {
    const [name] = args;
    if (!name) throw new Error("missing mutex name");
    const identity = await new PowerShellWindowsProcessIdentity().current();
    const nonce = randomUUID();
    const owner = { ...identity, nonce, acquiredAt: Date.now() };
    const dir = path.join(root, "locks", "children", "tmp");
    await fs.mkdir(dir, { recursive: true });
    const temp = path.join(dir, `${name}.${nonce}.owner`);
    const handle = await fs.open(temp, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(owner), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    line({ event: "owner_ready", temp: path.basename(temp), owner });
    process.exit(19);
    break;
  }
  case "lease-acquire": {
    const [hash, sessionId, inputId, generationRaw, ownerId] = args;
    if (!hash || !sessionId || !inputId || !generationRaw || !ownerId) throw new Error("missing lease args");
    const lease = new DurableAdmissionLease(root, hash, { mutex: { timeoutMs: 5_000, pollMs: 10 } });
    line(await lease.acquire({ sessionId, inputId, generation: Number(generationRaw), ownerId }));
    break;
  }
  case "lease-wait-acquire": {
    const [hash, sessionId, inputId, generationRaw, ownerId] = args;
    if (!hash || !sessionId || !inputId || !generationRaw || !ownerId) throw new Error("missing lease wait args");
    const lease = new DurableAdmissionLease(root, hash, { mutex: { timeoutMs: 5_000, pollMs: 10 } });
    const deadline = Date.now() + 10_000;
    let announcedWaiting = false;
    for (;;) {
      const result = await lease.acquire({ sessionId, inputId, generation: Number(generationRaw), ownerId });
      if (result.status === "acquired") {
        line(result);
        break;
      }
      if (!announcedWaiting) {
        await flushedLine({ status: "waiting", heldLeaseId: result.lease.leaseId });
        announcedWaiting = true;
      }
      if (Date.now() >= deadline) throw new Error("lease waiter timed out");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    break;
  }
  case "lease-crash": {
    const [hash, sessionId, inputId, generationRaw, ownerId] = args;
    if (!hash || !sessionId || !inputId || !generationRaw || !ownerId) throw new Error("missing lease args");
    const lease = new DurableAdmissionLease(root, hash, { mutex: { timeoutMs: 5_000, pollMs: 10 } });
    line(await lease.acquire({ sessionId, inputId, generation: Number(generationRaw), ownerId }));
    process.exit(23);
    break;
  }
  case "lease-release": {
    const [hash, leaseId, encodedProof] = args;
    if (!hash || !leaseId || !encodedProof) throw new Error("missing lease release args");
    const proof = JSON.parse(Buffer.from(encodedProof, "base64url").toString("utf8"));
    const lease = new DurableAdmissionLease(root, hash, { mutex: { timeoutMs: 5_000, pollMs: 10 } });
    line({ status: await lease.releaseAfterProof(leaseId, proof) });
    break;
  }
  case "transition": {
    const [sessionId, encoded] = args;
    if (!sessionId || !encoded) throw new Error("missing transition args");
    const transition = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    const store = new DurableSessionStore(root, { probeFilesystem: false, mutex: { timeoutMs: 5_000, pollMs: 10 } });
    const result = await store.updateSession(sessionId, transition);
    line({ status: result.status });
    break;
  }
  case "runtime-send-crash": {
    const [hash, sessionId] = args;
    if (!hash || !sessionId) throw new Error("missing runtime send crash args");
    const store = runtimeStore(root);
    const lease = runtimeLease(root, hash);
    const bridge = new AcpBridgeRuntime({
      controller: {
        resolveProject: async () => ({ projectId: "project-1", canonicalPath: "C:\\repo" }),
        input: async () => undefined,
        send: async (input) => {
          const tagged = await store.readSession(sessionId);
          const held = await lease.read();
          await flushedLine({ event: "send_dispatched", inputId: input.id, tagged, held });
          process.exit(31);
        },
      },
      durableStore: store,
      durableLease: lease,
      ownerId: "child-runtime",
      makeUuid: () => sessionId,
      canonicalize: async (value) => value,
    });
    bridge.newSession({ cwd: "C:\\repo", mcpServers: [] });
    await bridge.prompt({ sessionId, prompt: [{ type: "text", text: "crash at send" }] });
    break;
  }
  case "runtime-send-boundary-crash": {
    const [hash, sessionId, stage] = args;
    if (!hash || !sessionId || !stage) throw new Error("missing runtime send boundary args");
    const exactSessionId = sessionId;
    const exactStage = stage;

    class BoundaryLease extends DurableAdmissionLease {
      override async acquire(input: Parameters<DurableAdmissionLease["acquire"]>[0]) {
        if (exactStage === "before_lease") {
          const tagged = await store.readSession(exactSessionId);
          await flushedLine({ event: exactStage, tagged, held: await this.read() });
          process.exit(35);
        }
        const result = await super.acquire(input);
        if (exactStage === "after_lease") {
          const tagged = await store.readSession(exactSessionId);
          await flushedLine({ event: exactStage, tagged, held: await this.read() });
          process.exit(37);
        }
        return result;
      }
    }

    class BoundaryStore extends DurableSessionStore {
      override async updateSession(...params: Parameters<DurableSessionStore["updateSession"]>) {
        const [targetSessionId, transition] = params;
        if (exactStage === "after_begin_input" && transition.kind === "binding" && transition.bindingState === "create_pending") {
          const tagged = await this.readSession(targetSessionId);
          await flushedLine({ event: exactStage, tagged, held: await lease.read() });
          process.exit(34);
        }
        if (exactStage === "accepted_before_promotion" && transition.kind === "promote_mode") {
          const tagged = await this.readSession(targetSessionId);
          await flushedLine({ event: exactStage, tagged, held: await lease.read() });
          process.exit(39);
        }
        if (exactStage === "proven_not_sent" && transition.kind === "settle_not_sent") {
          const tagged = await this.readSession(targetSessionId);
          await flushedLine({ event: exactStage, tagged, held: await lease.read() });
          process.exit(41);
        }
        return super.updateSession(...params);
      }
    }

    const store = new BoundaryStore(root, { probeFilesystem: false, mutex: runtimeMutexOptions() });
    const lease = new BoundaryLease(root, hash, { identity: childIdentity, mutex: runtimeMutexOptions() });
    const bridge = new AcpBridgeRuntime({
      controller: {
        resolveProject: async () => ({ projectId: "project-1", canonicalPath: "C:\\repo" }),
        input: async () => undefined,
        send: async (input) => ({
          id: input.id,
          sessionId: exactSessionId,
          delivery: exactStage === "proven_not_sent" ? "not_sent" as const : "sent" as const,
        }),
      },
      durableStore: store,
      durableLease: lease,
      ownerId: "child-runtime",
      makeUuid: () => exactSessionId,
      canonicalize: async (value) => value,
    });
    bridge.newSession({ cwd: "C:\\repo", mcpServers: [] });
    await bridge.prompt({ sessionId: exactSessionId, prompt: [{ type: "text", text: `crash at ${exactStage}` }] });
    break;
  }
  case "runtime-cancel-before-action-crash": {
    const [hash, sessionId, targetKind, turnId] = args;
    if (!hash || !sessionId || !targetKind) throw new Error("missing runtime cancel-before-action args");
    const exactSessionId = sessionId;
    const exactTargetKind = targetKind;
    class CancelStore extends DurableSessionStore {
      override async updateSession(...params: Parameters<DurableSessionStore["updateSession"]>) {
        const result = await super.updateSession(...params);
        const [, transition] = params;
        if (transition.kind === "set_cancel") {
          const tagged = await this.readSession(exactSessionId);
          await flushedLine({ event: "cancel_persisted", targetKind: exactTargetKind, tagged, held: await lease.read() });
          process.exit(exactTargetKind === "active" ? 43 : 45);
        }
        return result;
      }
    }
    const store = new CancelStore(root, { probeFilesystem: false, mutex: runtimeMutexOptions() });
    const lease = runtimeLease(root, hash);
    const bridge = new AcpBridgeRuntime({
      controller: {
        resolveProject: async () => ({ projectId: "project-1", canonicalPath: "C:\\repo" }),
        send: async (input) => ({ id: input.id, sessionId, delivery: "sent" as const }),
        cancelPendingInput: async () => undefined,
        stopExactTurn: async () => undefined,
      },
      durableStore: store,
      durableLease: lease,
      ownerId: "child-runtime",
      makeUuid: () => sessionId,
      canonicalize: async (value) => value,
    });
    bridge.newSession({ cwd: "C:\\repo", mcpServers: [] });
    await bridge.prompt({ sessionId, prompt: [{ type: "text", text: "cancel before action" }] });
    if (exactTargetKind === "active") {
      if (!turnId) throw new Error("active cancel requires turn id");
      await bridge.checkpointProviderTranslation({
        sessionId,
        inputId: sessionId,
        generation: 1,
        cursor: 1,
        turnId,
        cancelRequested: false,
        assistantFinals: {},
      });
    }
    await bridge.cancel(sessionId);
    break;
  }
  case "runtime-pending-cancel-crash": {
    const [hash, sessionId] = args;
    if (!hash || !sessionId) throw new Error("missing runtime pending cancel args");
    const store = runtimeStore(root);
    const lease = runtimeLease(root, hash);
    const bridge = new AcpBridgeRuntime({
      controller: {
        resolveProject: async () => ({ projectId: "project-1", canonicalPath: "C:\\repo" }),
        send: async (input) => ({ id: input.id, sessionId, delivery: "sent" as const }),
        cancelPendingInput: async (exactInput) => {
          const tagged = await store.readSession(sessionId);
          await flushedLine({ event: "pending_cancel_dispatched", exactInput, tagged, held: await lease.read() });
          process.exit(47);
        },
      },
      durableStore: store,
      durableLease: lease,
      ownerId: "child-runtime",
      makeUuid: () => sessionId,
      canonicalize: async (value) => value,
    });
    bridge.newSession({ cwd: "C:\\repo", mcpServers: [] });
    await bridge.prompt({ sessionId, prompt: [{ type: "text", text: "pending cancel crash" }] });
    await bridge.cancel(sessionId);
    break;
  }
  case "runtime-cancel-terminal-finalize-crash": {
    const [hash, sessionId, turnId] = args;
    if (!hash || !sessionId || !turnId) throw new Error("missing cancelled terminal finalize args");
    const exactSessionId = sessionId;
    class FinalizeCrashStore extends DurableSessionStore {
      override async updateSession(...params: Parameters<DurableSessionStore["updateSession"]>) {
        const [, transition] = params;
        if (transition.kind === "finalize_terminal") {
          const tagged = await this.readSession(exactSessionId);
          await flushedLine({ event: "cancel_terminal_released", tagged, held: await lease.read() });
          process.exit(49);
        }
        return super.updateSession(...params);
      }
    }
    const store = new FinalizeCrashStore(root, { probeFilesystem: false, mutex: runtimeMutexOptions() });
    const lease = runtimeLease(root, hash);
    const bridge = new AcpBridgeRuntime({
      controller: {
        resolveProject: async () => ({ projectId: "project-1", canonicalPath: "C:\\repo" }),
        session: async () => ({
          id: exactSessionId,
          providerTurn: { inputId: exactSessionId, state: "drained" as const, turnId, drainedSeq: 3, finalAssistantSeq: null },
        }),
        requireBackgroundWorkDisabled: async () => ({ backgroundWork: "disabled" as const, enforced: true as const }),
        send: async (input) => ({ id: input.id, sessionId: exactSessionId, delivery: "sent" as const }),
      },
      durableStore: store,
      durableLease: lease,
      ownerId: "child-runtime",
      makeUuid: () => exactSessionId,
      canonicalize: async (value) => value,
    });
    bridge.newSession({ cwd: "C:\\repo", mcpServers: [] });
    await bridge.prompt({ sessionId: exactSessionId, prompt: [{ type: "text", text: "cancel terminal finalize crash" }] });
    await bridge.checkpointProviderTranslation({
      sessionId: exactSessionId, inputId: exactSessionId, generation: 1, cursor: 1, turnId,
      cancelRequested: false, assistantFinals: {},
    });
    await store.updateSession(exactSessionId, { kind: "set_cancel", inputId: exactSessionId, generation: 1, turnId });
    await bridge.checkpointProviderTranslation({
      sessionId: exactSessionId, inputId: exactSessionId, generation: 1, cursor: 2, turnId,
      turnEndSeq: 2, turnOutcome: "stopped", cancelRequested: true, assistantFinals: {},
    });
    await bridge.checkpointProviderTranslation({
      sessionId: exactSessionId, inputId: exactSessionId, generation: 1, cursor: 3, turnId,
      turnEndSeq: 2, turnOutcome: "stopped", drainSeq: 3, finalAssistantSeq: null,
      terminal: "cancelled", cancelRequested: true, assistantFinals: {},
    });
    break;
  }
  case "runtime-cancel-crash": {
    const [hash, sessionId, turnId] = args;
    if (!hash || !sessionId || !turnId) throw new Error("missing runtime cancel crash args");
    const store = runtimeStore(root);
    const lease = runtimeLease(root, hash);
    const bridge = new AcpBridgeRuntime({
      controller: {
        resolveProject: async () => ({ projectId: "project-1", canonicalPath: "C:\\repo" }),
        send: async (input) => ({ id: input.id, sessionId, delivery: "sent" as const }),
        stopExactTurn: async (_session, exactTurn) => {
          const tagged = await store.readSession(sessionId);
          const held = await lease.read();
          await flushedLine({ event: "stop_dispatched", exactTurn, tagged, held });
          process.exit(33);
        },
      },
      durableStore: store,
      durableLease: lease,
      ownerId: "child-runtime",
      makeUuid: () => sessionId,
      canonicalize: async (value) => value,
    });
    bridge.newSession({ cwd: "C:\\repo", mcpServers: [] });
    await bridge.prompt({ sessionId, prompt: [{ type: "text", text: "crash at cancel" }] });
    await bridge.checkpointProviderTranslation({
      sessionId,
      inputId: sessionId,
      generation: 1,
      cursor: 1,
      turnId,
      cancelRequested: false,
      assistantFinals: {},
    });
    await bridge.cancel(sessionId);
    break;
  }
  default:
    throw new Error(`unknown child command ${command ?? ""}`);
}
