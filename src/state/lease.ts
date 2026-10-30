import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import type { StableTerminalStopReason } from "../translate/events.js";
import {
  HardLinkMutex,
  type HardLinkMutexOptions,
  type WindowsProcessIdentity,
  PowerShellWindowsProcessIdentity,
} from "./mutex.js";

export interface DurableLeaseRecord {
  readonly schemaVersion: 1;
  readonly leaseId: string;
  readonly controllerIdentityHash: string;
  readonly sessionId: string;
  readonly inputId: string;
  readonly generation: number;
  readonly ownerId: string;
  readonly ownerPid: number;
  readonly ownerProcessStartTicks: string;
  readonly acquiredAt: number;
  readonly heartbeatAt: number;
}

export interface DurableQueuedLeaseRecord {
  readonly lease: DurableLeaseRecord;
  readonly queueSequence: number;
  readonly queuedAt: number;
}

interface DurableLeaseState {
  readonly schemaVersion: 2;
  readonly controllerIdentityHash: string;
  active: DurableLeaseRecord[];
  waiting: DurableQueuedLeaseRecord[];
  nextQueueSequence: number;
}

export type DurableLeaseAcquireResult =
  | { readonly status: "acquired"; readonly lease: DurableLeaseRecord }
  | { readonly status: "held"; readonly lease: DurableLeaseRecord }
  | { readonly status: "cancelled"; readonly lease: DurableLeaseRecord };

export type DurableLeaseReadResult =
  | { readonly status: "found"; readonly lease: DurableLeaseRecord }
  | { readonly status: "missing" }
  | { readonly status: "corrupt"; readonly sha256: string };

export type DurableLeaseLookupResult =
  | { readonly status: "active"; readonly lease: DurableLeaseRecord }
  | { readonly status: "queued"; readonly lease: DurableLeaseRecord; readonly queuePosition: number }
  | { readonly status: "missing" }
  | { readonly status: "corrupt"; readonly sha256: string };

export type DurableLeaseCollectionReadResult =
  | { readonly status: "found"; readonly active: readonly DurableLeaseRecord[]; readonly waiting: readonly DurableQueuedLeaseRecord[] }
  | { readonly status: "missing" }
  | { readonly status: "corrupt"; readonly sha256: string };

export type LeaseReleaseProof =
  | {
      readonly kind: "drained";
      readonly sessionId: string;
      readonly inputId: string;
      readonly generation: number;
      readonly turnId: string;
      readonly drainSeq: number;
      readonly cursor: number;
      readonly terminal: StableTerminalStopReason;
      readonly policyAttested: true;
    }
  | {
      readonly kind: "not_sent";
      readonly sessionId: string;
      readonly inputId: string;
      readonly generation: number;
    };

export type LeaseReleaseResult = "released" | "missing" | "changed" | "proof_mismatch";
export type QueuedLeaseCancelResult = "removed" | "active" | "missing";

const HEX_64 = /^[0-9a-f]{64}$/;
const SESSION_ID = /^[0-9a-z-]{8,64}$/i;
const LEASE_ID = /^[0-9a-f-]{36}$/i;
const MAX_ACTIVE_LEASES = 4;
const MAX_QUEUED_LEASES = 64;

function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function validRecord(value: unknown): value is DurableLeaseRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const keys = [
    "schemaVersion", "leaseId", "controllerIdentityHash", "sessionId", "inputId", "generation", "ownerId",
    "ownerPid", "ownerProcessStartTicks", "acquiredAt", "heartbeatAt",
  ];
  if (Object.keys(row).some((key) => !keys.includes(key)) || row.schemaVersion !== 1) return false;
  return typeof row.leaseId === "string" && LEASE_ID.test(row.leaseId) &&
    typeof row.controllerIdentityHash === "string" && HEX_64.test(row.controllerIdentityHash) &&
    typeof row.sessionId === "string" && SESSION_ID.test(row.sessionId) &&
    typeof row.inputId === "string" && row.inputId.length > 0 && row.inputId.length <= 64 &&
    Number.isSafeInteger(row.generation) && Number(row.generation) > 0 &&
    typeof row.ownerId === "string" && row.ownerId.length > 0 && row.ownerId.length <= 128 &&
    Number.isSafeInteger(row.ownerPid) && Number(row.ownerPid) > 0 &&
    typeof row.ownerProcessStartTicks === "string" && /^[1-9][0-9]{0,24}$/.test(row.ownerProcessStartTicks) &&
    typeof row.acquiredAt === "number" && Number.isFinite(row.acquiredAt) && row.acquiredAt >= 0 &&
    typeof row.heartbeatAt === "number" && Number.isFinite(row.heartbeatAt) && row.heartbeatAt >= row.acquiredAt;
}

function validState(value: unknown): value is DurableLeaseState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some((key) => !["schemaVersion", "controllerIdentityHash", "active", "waiting", "nextQueueSequence"].includes(key)) ||
      row.schemaVersion !== 2 || typeof row.controllerIdentityHash !== "string" || !HEX_64.test(row.controllerIdentityHash) ||
      !Array.isArray(row.active) || row.active.length > MAX_ACTIVE_LEASES ||
      !Array.isArray(row.waiting) || row.waiting.length > MAX_QUEUED_LEASES ||
      !Number.isSafeInteger(row.nextQueueSequence) || Number(row.nextQueueSequence) < 1) return false;

  const leaseIds = new Set<string>();
  const sessionIds = new Set<string>();
  for (const lease of row.active) {
    if (!validRecord(lease) || lease.controllerIdentityHash !== row.controllerIdentityHash ||
        leaseIds.has(lease.leaseId) || sessionIds.has(lease.sessionId)) return false;
    leaseIds.add(lease.leaseId);
    sessionIds.add(lease.sessionId);
  }
  let previousSequence = 0;
  for (const value of row.waiting) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const queued = value as Record<string, unknown>;
    if (Object.keys(queued).some((key) => !["lease", "queueSequence", "queuedAt"].includes(key)) ||
        !validRecord(queued.lease) || queued.lease.controllerIdentityHash !== row.controllerIdentityHash ||
        !Number.isSafeInteger(queued.queueSequence) || Number(queued.queueSequence) <= previousSequence ||
        typeof queued.queuedAt !== "number" || !Number.isFinite(queued.queuedAt) || queued.queuedAt < 0 ||
        leaseIds.has(queued.lease.leaseId) || sessionIds.has(queued.lease.sessionId)) return false;
    previousSequence = Number(queued.queueSequence);
    leaseIds.add(queued.lease.leaseId);
    sessionIds.add(queued.lease.sessionId);
  }
  return Number(row.nextQueueSequence) > previousSequence;
}

async function writeAndSync(file: string, contents: string): Promise<void> {
  const handle = await fs.open(file, "wx", 0o600);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

const WINDOWS_SHARING_ERRORS = new Set(["EPERM", "EACCES", "EBUSY"]);
const WINDOWS_REPLACE_MAX_ATTEMPTS = 12;

function isWindowsSharingError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return process.platform === "win32" && typeof code === "string" && WINDOWS_SHARING_ERRORS.has(code);
}

function retryDelayMs(attempt: number): number {
  return Math.min(5 * (2 ** attempt), 100);
}

async function atomicWrite(target: string, value: object): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  const contents = JSON.stringify(value);
  try {
    await writeAndSync(temp, contents);
    const maxAttempts = process.platform === "win32" ? WINDOWS_REPLACE_MAX_ATTEMPTS : 1;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        await fs.rename(temp, target);
        return;
      } catch (error) {
        if (!isWindowsSharingError(error)) throw error;
        try {
          if (await fs.readFile(target, "utf8") === contents) return;
        } catch (readError) {
          if ((readError as NodeJS.ErrnoException).code !== "ENOENT" && !isWindowsSharingError(readError)) throw readError;
        }
        if (attempt + 1 >= maxAttempts) throw error;
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs(attempt)));
      }
    }
  } finally {
    await fs.rm(temp, { force: true }).catch(() => undefined);
  }
}
export async function canonicalProfileIdentityHash(userDataDir: string): Promise<string> {
  const canonical = await fs.realpath(path.resolve(userDataDir));
  const stable = process.platform === "win32" ? path.win32.normalize(canonical).toLowerCase() : path.normalize(canonical);
  return sha256(stable);
}

export interface DurableAdmissionLeaseOptions {
  readonly mutex?: HardLinkMutexOptions;
  readonly identity?: WindowsProcessIdentity;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly maxConcurrentTurns?: number;
  readonly maxQueuedTurns?: number;
  readonly queuePollMs?: number;
}

type StateRead =
  | { readonly status: "found"; readonly state: DurableLeaseState }
  | { readonly status: "missing" }
  | { readonly status: "corrupt"; readonly sha256: string };

type AcquireDecision =
  | { readonly status: "acquired"; readonly lease: DurableLeaseRecord }
  | { readonly status: "held"; readonly lease: DurableLeaseRecord }
  | { readonly status: "wait"; readonly lease: DurableLeaseRecord };

export class DurableAdmissionLease {
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly identity: WindowsProcessIdentity;
  readonly maxConcurrentTurns: number;
  private readonly maxQueuedTurns: number;
  private readonly queuePollMs: number;

  constructor(
    private readonly stateRoot: string,
    readonly controllerIdentityHash: string,
    private readonly options: DurableAdmissionLeaseOptions = {},
  ) {
    if (!HEX_64.test(controllerIdentityHash)) throw new Error("invalid controller profile identity hash");
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.identity = options.identity ?? options.mutex?.identity ?? new PowerShellWindowsProcessIdentity();
    this.maxConcurrentTurns = options.maxConcurrentTurns ?? 1;
    this.maxQueuedTurns = options.maxQueuedTurns ?? 0;
    this.queuePollMs = options.queuePollMs ?? 25;
    if (!Number.isSafeInteger(this.maxConcurrentTurns) || this.maxConcurrentTurns < 1 || this.maxConcurrentTurns > MAX_ACTIVE_LEASES) {
      throw new Error(`maxConcurrentTurns must be between 1 and ${MAX_ACTIVE_LEASES}`);
    }
    if (!Number.isSafeInteger(this.maxQueuedTurns) || this.maxQueuedTurns < 0 || this.maxQueuedTurns > MAX_QUEUED_LEASES) {
      throw new Error(`maxQueuedTurns must be between 0 and ${MAX_QUEUED_LEASES}`);
    }
    if (!Number.isSafeInteger(this.queuePollMs) || this.queuePollMs < 1 || this.queuePollMs > 5_000) {
      throw new Error("queuePollMs must be between 1 and 5000");
    }
  }

  private file(): string {
    return path.join(this.stateRoot, "leases", `${this.controllerIdentityHash}.json`);
  }

  private mutex(): HardLinkMutex {
    return new HardLinkMutex(path.join(this.stateRoot, "locks", "profiles"), `profile-${this.controllerIdentityHash}`, {
      ...this.options.mutex,
      identity: this.identity,
    });
  }

  private emptyState(): DurableLeaseState {
    return { schemaVersion: 2, controllerIdentityHash: this.controllerIdentityHash, active: [], waiting: [], nextQueueSequence: 1 };
  }

  private async readState(): Promise<StateRead> {
    let bytes: Buffer;
    const maxAttempts = process.platform === "win32" ? WINDOWS_REPLACE_MAX_ATTEMPTS : 1;
    for (let attempt = 0; ; attempt += 1) {
      try {
        bytes = await fs.readFile(this.file());
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" };
        if (!isWindowsSharingError(error) || attempt + 1 >= maxAttempts) throw error;
        await this.sleep(retryDelayMs(attempt));
      }
    }
    try {
      const value: unknown = JSON.parse(bytes.toString("utf8"));
      if (validRecord(value) && value.controllerIdentityHash === this.controllerIdentityHash) {
        return { status: "found", state: {
          schemaVersion: 2, controllerIdentityHash: this.controllerIdentityHash,
          active: [value], waiting: [], nextQueueSequence: 1,
        } };
      }
      if (validState(value) && value.controllerIdentityHash === this.controllerIdentityHash) {
        return { status: "found", state: value };
      }
      return { status: "corrupt", sha256: sha256(bytes) };
    } catch {
      return { status: "corrupt", sha256: sha256(bytes) };
    }
  }
  private async writeState(state: DurableLeaseState): Promise<void> {
    if (state.active.length === 0 && state.waiting.length === 0) {
      await fs.rm(this.file(), { force: true });
      return;
    }
    await atomicWrite(this.file(), state);
  }

  async read(): Promise<DurableLeaseReadResult> {
    const result = await this.readState();
    if (result.status !== "found") return result;
    const lease = result.state.active[0] ?? result.state.waiting[0]?.lease;
    return lease ? { status: "found", lease } : { status: "missing" };
  }

  async readAll(): Promise<DurableLeaseCollectionReadResult> {
    const result = await this.readState();
    if (result.status !== "found") return result;
    if (result.state.active.length === 0 && result.state.waiting.length === 0) return { status: "missing" };
    return { status: "found", active: [...result.state.active], waiting: result.state.waiting.map((entry) => ({ ...entry, lease: { ...entry.lease } })) };
  }

  async readLease(leaseId: string): Promise<DurableLeaseLookupResult> {
    // Atomic replacement keeps each read all-or-nothing. Retry transient Windows sharing errors
    // in readState rather than taking the mutation mutex on every queue poll; polling under the
    // lock can starve the release that is needed to promote the head waiter.
    const result = await this.readState();
    if (result.status !== "found") return result;
    const active = result.state.active.find((lease) => lease.leaseId === leaseId);
    if (active) return { status: "active", lease: active };
    const index = result.state.waiting.findIndex((entry) => entry.lease.leaseId === leaseId);
    const queued = result.state.waiting[index];
    if (queued) return { status: "queued", lease: queued.lease, queuePosition: index + 1 };
    return { status: "missing" };
  }
  private async makeLease(input: {
    readonly sessionId: string;
    readonly inputId: string;
    readonly generation: number;
    readonly ownerId: string;
    readonly leaseId?: string;
  }): Promise<DurableLeaseRecord> {
    const processIdentity = await this.identity.current();
    const now = this.now();
    return {
      schemaVersion: 1,
      leaseId: input.leaseId ?? randomUUID(),
      controllerIdentityHash: this.controllerIdentityHash,
      sessionId: input.sessionId,
      inputId: input.inputId,
      generation: input.generation,
      ownerId: input.ownerId,
      ownerPid: processIdentity.pid,
      ownerProcessStartTicks: processIdentity.processStartTicks,
      acquiredAt: now,
      heartbeatAt: now,
    };
  }

  private async promoteWaiting(state: DurableLeaseState): Promise<boolean> {
    let changed = false;
    while (state.active.length < this.maxConcurrentTurns && state.waiting.length > 0) {
      const head = state.waiting[0];
      if (!head) break;
      const owner = await this.identity.query(head.lease.ownerPid);
      if (owner.status === "not_found" || (owner.status === "live" && owner.processStartTicks !== head.lease.ownerProcessStartTicks)) {
        state.waiting.shift();
        changed = true;
        continue;
      }
      if (owner.status !== "live") break;
      state.active.push(head.lease);
      state.waiting.shift();
      changed = true;
    }
    return changed;
  }

  private async waitForAdmission(lease: DurableLeaseRecord): Promise<DurableLeaseAcquireResult> {
    for (;;) {
      const current = await this.readLease(lease.leaseId);
      if (current.status === "active") return { status: "acquired", lease: current.lease };
      if (current.status === "missing") return { status: "cancelled", lease };
      if (current.status === "corrupt") throw new Error(`lease_corrupt:${current.sha256}`);
      await this.sleep(this.queuePollMs);
    }
  }

  async acquire(input: {
    readonly sessionId: string;
    readonly inputId: string;
    readonly generation: number;
    readonly ownerId: string;
    readonly leaseId?: string;
  }): Promise<DurableLeaseAcquireResult> {
    if (!SESSION_ID.test(input.sessionId) || !input.inputId || input.inputId.length > 64 ||
        !Number.isSafeInteger(input.generation) || input.generation < 1 || !input.ownerId || input.ownerId.length > 128 ||
        (input.leaseId !== undefined && !LEASE_ID.test(input.leaseId))) throw new Error("invalid lease admission record");

    const decision = await this.mutex().withLock(async (): Promise<AcquireDecision> => {
      const existing = await this.readState();
      if (existing.status === "corrupt") throw new Error(`lease_corrupt:${existing.sha256}`);
      const state = existing.status === "found" ? existing.state : this.emptyState();
      const promoted = await this.promoteWaiting(state);
      const duplicate = [...state.active, ...state.waiting.map((entry) => entry.lease)]
        .find((lease) => lease.sessionId === input.sessionId || (input.leaseId !== undefined && lease.leaseId === input.leaseId));
      if (duplicate) {
        if (promoted) await this.writeState(state);
        return { status: "held", lease: duplicate };
      }
      if (state.active.length < this.maxConcurrentTurns && state.waiting.length === 0) {
        const lease = await this.makeLease(input);
        state.active.push(lease);
        await this.writeState(state);
        return { status: "acquired", lease };
      }
      if (state.waiting.length >= this.maxQueuedTurns) {
        if (promoted) await this.writeState(state);
        const held = state.active[0] ?? state.waiting[0]?.lease;
        if (!held) throw new Error("admission scheduler invariant violated: full queue without an existing ticket");
        return { status: "held", lease: held };
      }
      const lease = await this.makeLease(input);
      state.waiting.push({ lease, queueSequence: state.nextQueueSequence, queuedAt: this.now() });
      state.nextQueueSequence += 1;
      await this.writeState(state);
      return { status: "wait", lease };
    });
    if (decision.status === "wait") return this.waitForAdmission(decision.lease);
    return decision;
  }

  async heartbeat(leaseId: string): Promise<"updated" | "missing" | "changed"> {
    return this.mutex().withLock(async () => {
      const current = await this.readState();
      if (current.status === "missing") return "missing";
      if (current.status !== "found") throw new Error("lease_corrupt");
      const activeIndex = current.state.active.findIndex((lease) => lease.leaseId === leaseId);
      if (activeIndex >= 0) {
        const lease = current.state.active[activeIndex];
        if (!lease) return "missing";
        current.state.active[activeIndex] = { ...lease, heartbeatAt: this.now() };
        await this.writeState(current.state);
        return "updated";
      }
      const queuedIndex = current.state.waiting.findIndex((entry) => entry.lease.leaseId === leaseId);
      const queued = current.state.waiting[queuedIndex];
      if (!queued || queuedIndex < 0) return "missing";
      current.state.waiting[queuedIndex] = { ...queued, lease: { ...queued.lease, heartbeatAt: this.now() } };
      await this.writeState(current.state);
      return "updated";
    });
  }

  private proofMatches(lease: DurableLeaseRecord, proof: LeaseReleaseProof): boolean {
    if (proof.sessionId !== lease.sessionId || proof.inputId !== lease.inputId || proof.generation !== lease.generation) return false;
    if (proof.kind === "not_sent") return true;
    return proof.turnId.length > 0 && proof.turnId.length <= 256 &&
      Number.isSafeInteger(proof.drainSeq) && proof.drainSeq > 0 &&
      Number.isSafeInteger(proof.cursor) && proof.cursor >= proof.drainSeq &&
      proof.policyAttested === true && TERMINALS.has(proof.terminal);
  }

  async cancelQueued(leaseId: string): Promise<QueuedLeaseCancelResult> {
    if (!LEASE_ID.test(leaseId)) return "missing";
    return this.mutex().withLock(async () => {
      const current = await this.readState();
      if (current.status === "missing") return "missing";
      if (current.status !== "found") throw new Error("lease_corrupt");
      if (current.state.active.some((lease) => lease.leaseId === leaseId)) return "active";
      const index = current.state.waiting.findIndex((entry) => entry.lease.leaseId === leaseId);
      if (index < 0) return "missing";
      current.state.waiting.splice(index, 1);
      await this.promoteWaiting(current.state);
      await this.writeState(current.state);
      return "removed";
    });
  }

  async releaseAfterProof(expectedLeaseId: string, proof: LeaseReleaseProof): Promise<LeaseReleaseResult> {
    if (!LEASE_ID.test(expectedLeaseId)) return "changed";
    return this.mutex().withLock(async () => {
      const current = await this.readState();
      if (current.status === "missing") return "missing";
      if (current.status !== "found") throw new Error("lease_corrupt");
      const activeIndex = current.state.active.findIndex((lease) => lease.leaseId === expectedLeaseId);
      const queuedIndex = current.state.waiting.findIndex((entry) => entry.lease.leaseId === expectedLeaseId);
      const active = activeIndex >= 0 ? current.state.active[activeIndex] : undefined;
      const queued = queuedIndex >= 0 ? current.state.waiting[queuedIndex]?.lease : undefined;
      const lease = active ?? queued;
      if (!lease) return "changed";
      if (queued && proof.kind !== "not_sent") return "proof_mismatch";
      if (!this.proofMatches(lease, proof)) return "proof_mismatch";
      if (activeIndex >= 0) current.state.active.splice(activeIndex, 1);
      else current.state.waiting.splice(queuedIndex, 1);
      await this.promoteWaiting(current.state);
      await this.writeState(current.state);
      return "released";
    });
  }
}

export async function leaseReferencedSessionIds(stateRoot: string): Promise<ReadonlySet<string>> {
  const leasesDir = path.join(stateRoot, "leases");
  let names: string[];
  try {
    names = await fs.readdir(leasesDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set();
    throw error;
  }

  const protectedSessions = new Set<string>();
  for (const name of names) {
    const match = /^([0-9a-f]{64})\.json$/.exec(name);
    if (!match) continue;
    const profileHash = match[1];
    if (!profileHash) continue;
    const current = await new DurableAdmissionLease(stateRoot, profileHash).readAll();
    if (current.status === "corrupt") throw new Error(`lease_corrupt:${profileHash}:${current.sha256}`);
    if (current.status === "found") {
      for (const lease of current.active) protectedSessions.add(lease.sessionId);
      for (const queued of current.waiting) protectedSessions.add(queued.lease.sessionId);
    }
  }
  return protectedSessions;
}

const TERMINALS = new Set<StableTerminalStopReason>(["end_turn", "cancelled"]);
