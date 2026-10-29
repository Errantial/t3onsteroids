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

export type DurableLeaseAcquireResult =
  | { readonly status: "acquired"; readonly lease: DurableLeaseRecord }
  | { readonly status: "held"; readonly lease: DurableLeaseRecord };

export type DurableLeaseReadResult =
  | { readonly status: "found"; readonly lease: DurableLeaseRecord }
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

const HEX_64 = /^[0-9a-f]{64}$/;
const SESSION_ID = /^[0-9a-z-]{8,64}$/i;
const LEASE_ID = /^[0-9a-f-]{36}$/i;

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

async function writeAndSync(file: string, contents: string): Promise<void> {
  const handle = await fs.open(file, "wx", 0o600);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function atomicWrite(target: string, value: object): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeAndSync(temp, JSON.stringify(value));
    await fs.rename(temp, target);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => undefined);
  }
}

export async function canonicalProfileIdentityHash(userDataDir: string): Promise<string> {
  const canonical = await fs.realpath(path.resolve(userDataDir));
  // The supported lane is Windows/NTFS, where path identity is case-insensitive. Lowercasing the
  // canonical directory avoids two lease domains for casing-only spellings of the same profile.
  const stable = process.platform === "win32" ? path.win32.normalize(canonical).toLowerCase() : path.normalize(canonical);
  return sha256(stable);
}

/**
 * Structural ceiling of lease slots per profile. It matches the CoS controller's global SSE budget:
 * every active bridged turn holds one event stream, so more slots than streams could never run.
 * What a deployment may actually use is the separate, evidence-gated `capacity`.
 */
export const MAX_LEASE_SLOTS = 4;

export interface DurableAdmissionLeaseOptions {
  /**
   * Concurrent turns the profile admits. Defaults to 1, the V1 single-turn behavior. Lowering it
   * never strands existing leases: every slot up to MAX_LEASE_SLOTS is still read, released and
   * counted as occupied, and capacity only gates new admissions.
   */
  readonly capacity?: number;
  readonly mutex?: HardLinkMutexOptions;
  readonly identity?: WindowsProcessIdentity;
  readonly now?: () => number;
}

export class DurableAdmissionLease {
  private readonly now: () => number;
  private readonly identity: WindowsProcessIdentity;
  private readonly capacity: number;

  /** Turns this lease admits at once; polling loops scale their interval by it. */
  get maxConcurrentTurns(): number {
    return this.capacity;
  }

  constructor(
    private readonly stateRoot: string,
    readonly controllerIdentityHash: string,
    private readonly options: DurableAdmissionLeaseOptions = {},
  ) {
    if (!HEX_64.test(controllerIdentityHash)) throw new Error("invalid controller profile identity hash");
    const capacity = options.capacity ?? 1;
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > MAX_LEASE_SLOTS) {
      throw new Error(`lease capacity must be an integer from 1 to ${MAX_LEASE_SLOTS}`);
    }
    this.capacity = capacity;
    this.now = options.now ?? Date.now;
    this.identity = options.identity ?? options.mutex?.identity ?? new PowerShellWindowsProcessIdentity();
  }

  /** Slot 0 keeps the V1 file name, so single-slot state needs no migration. */
  private file(slot = 0): string {
    const name = slot === 0 ? this.controllerIdentityHash : `${this.controllerIdentityHash}.s${slot}`;
    return path.join(this.stateRoot, "leases", `${name}.json`);
  }

  private mutex(): HardLinkMutex {
    return new HardLinkMutex(path.join(this.stateRoot, "locks", "profiles"), `profile-${this.controllerIdentityHash}`, {
      ...this.options.mutex,
      identity: this.identity,
    });
  }

  private async readSlot(slot: number): Promise<DurableLeaseReadResult> {
    let bytes: Buffer;
    try {
      bytes = await fs.readFile(this.file(slot));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" };
      throw error;
    }
    try {
      const value = JSON.parse(bytes.toString("utf8"));
      if (!validRecord(value) || value.controllerIdentityHash !== this.controllerIdentityHash) {
        return { status: "corrupt", sha256: sha256(bytes) };
      }
      return { status: "found", lease: value };
    } catch {
      return { status: "corrupt", sha256: sha256(bytes) };
    }
  }

  /** Every held lease with its slot, or the first corrupt slot. Any corrupt slot fails closed. */
  async readSlots(): Promise<
    | { readonly status: "ok"; readonly held: ReadonlyArray<{ readonly slot: number; readonly lease: DurableLeaseRecord }> }
    | { readonly status: "corrupt"; readonly sha256: string }
  > {
    const held: Array<{ slot: number; lease: DurableLeaseRecord }> = [];
    for (let slot = 0; slot < MAX_LEASE_SLOTS; slot++) {
      const result = await this.readSlot(slot);
      if (result.status === "corrupt") return result;
      if (result.status === "found") held.push({ slot, lease: result.lease });
    }
    return { status: "ok", held };
  }

  /** The lowest-slot held lease. With the default capacity of 1 this is the profile's only lease. */
  async read(): Promise<DurableLeaseReadResult> {
    const slots = await this.readSlots();
    if (slots.status === "corrupt") return slots;
    const first = slots.held[0];
    return first ? { status: "found", lease: first.lease } : { status: "missing" };
  }

  /** The exact lease a session journal named, wherever it lives. Recovery must use this, never read(). */
  async readByLeaseId(leaseId: string): Promise<DurableLeaseReadResult> {
    if (!LEASE_ID.test(leaseId)) return { status: "missing" };
    const slots = await this.readSlots();
    if (slots.status === "corrupt") return slots;
    const match = slots.held.find((entry) => entry.lease.leaseId === leaseId);
    return match ? { status: "found", lease: match.lease } : { status: "missing" };
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
        (input.leaseId !== undefined && !LEASE_ID.test(input.leaseId))) {
      throw new Error("invalid lease admission record");
    }
    return this.mutex().withLock(async () => {
      const slots = await this.readSlots();
      if (slots.status === "corrupt") throw new Error(`lease_corrupt:${slots.sha256}`);
      // One active root turn per session, and never more turns than capacity admits.
      const sameSession = slots.held.find((entry) => entry.lease.sessionId === input.sessionId);
      if (sameSession) return { status: "held", lease: sameSession.lease };
      const occupied = new Set(slots.held.map((entry) => entry.slot));
      const first = slots.held[0];
      if (first && slots.held.length >= this.capacity) return { status: "held", lease: first.lease };
      const slot = Array.from({ length: MAX_LEASE_SLOTS }, (_, index) => index).find((index) => !occupied.has(index));
      if (slot === undefined) throw new Error("lease_slots_exhausted");
      const processIdentity = await this.identity.current();
      const now = this.now();
      const lease: DurableLeaseRecord = {
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
      await atomicWrite(this.file(slot), lease);
      return { status: "acquired", lease };
    });
  }

  async heartbeat(leaseId: string): Promise<"updated" | "missing" | "changed"> {
    return this.mutex().withLock(async () => {
      const slots = await this.readSlots();
      if (slots.status === "corrupt") throw new Error("lease_corrupt");
      if (slots.held.length === 0) return "missing";
      const match = slots.held.find((entry) => entry.lease.leaseId === leaseId);
      if (!match) return "changed";
      await atomicWrite(this.file(match.slot), { ...match.lease, heartbeatAt: this.now() });
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

  async releaseAfterProof(expectedLeaseId: string, proof: LeaseReleaseProof): Promise<LeaseReleaseResult> {
    if (!LEASE_ID.test(expectedLeaseId)) return "changed";
    // Reconciliation that produced `proof` happened before this call, outside the mutex. Inside
    // the short critical section we only compare the exact lease generation and delete it.
    return this.mutex().withLock(async () => {
      const slots = await this.readSlots();
      if (slots.status === "corrupt") throw new Error("lease_corrupt");
      if (slots.held.length === 0) return "missing";
      const match = slots.held.find((entry) => entry.lease.leaseId === expectedLeaseId);
      if (!match) return "changed";
      if (!this.proofMatches(match.lease, proof)) return "proof_mismatch";
      await fs.unlink(this.file(match.slot));
      return "released";
    });
  }
}

/**
 * Enumerate every valid profile lease in the shared production state root and return the
 * referenced ACP session ids that must be protected from age-based pruning. A corrupt lease in a
 * hash-named production slot fails closed: pruning cannot safely decide which journal it protects.
 */
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
  const profiles = new Set<string>();
  for (const name of names) {
    const match = /^([0-9a-f]{64})(?:\.s[1-9][0-9]*)?\.json$/.exec(name);
    if (match?.[1]) profiles.add(match[1]);
  }
  for (const profileHash of profiles) {
    const slots = await new DurableAdmissionLease(stateRoot, profileHash).readSlots();
    if (slots.status === "corrupt") {
      throw new Error(`lease_corrupt:${profileHash}:${slots.sha256}`);
    }
    for (const entry of slots.held) protectedSessions.add(entry.lease.sessionId);
  }
  return protectedSessions;
}

const TERMINALS = new Set<StableTerminalStopReason>(["end_turn", "cancelled"]);
