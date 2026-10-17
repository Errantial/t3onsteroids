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

export interface DurableAdmissionLeaseOptions {
  readonly mutex?: HardLinkMutexOptions;
  readonly identity?: WindowsProcessIdentity;
  readonly now?: () => number;
}

export class DurableAdmissionLease {
  private readonly now: () => number;
  private readonly identity: WindowsProcessIdentity;

  constructor(
    private readonly stateRoot: string,
    readonly controllerIdentityHash: string,
    private readonly options: DurableAdmissionLeaseOptions = {},
  ) {
    if (!HEX_64.test(controllerIdentityHash)) throw new Error("invalid controller profile identity hash");
    this.now = options.now ?? Date.now;
    this.identity = options.identity ?? options.mutex?.identity ?? new PowerShellWindowsProcessIdentity();
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

  async read(): Promise<DurableLeaseReadResult> {
    let bytes: Buffer;
    try {
      bytes = await fs.readFile(this.file());
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
      const existing = await this.read();
      if (existing.status === "corrupt") throw new Error(`lease_corrupt:${existing.sha256}`);
      if (existing.status === "found") return { status: "held", lease: existing.lease };
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
      await atomicWrite(this.file(), lease);
      return { status: "acquired", lease };
    });
  }

  async heartbeat(leaseId: string): Promise<"updated" | "missing" | "changed"> {
    return this.mutex().withLock(async () => {
      const current = await this.read();
      if (current.status === "missing") return "missing";
      if (current.status !== "found") throw new Error("lease_corrupt");
      if (current.lease.leaseId !== leaseId) return "changed";
      await atomicWrite(this.file(), { ...current.lease, heartbeatAt: this.now() });
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
      const current = await this.read();
      if (current.status === "missing") return "missing";
      if (current.status !== "found") throw new Error("lease_corrupt");
      if (current.lease.leaseId !== expectedLeaseId) return "changed";
      if (!this.proofMatches(current.lease, proof)) return "proof_mismatch";
      await fs.unlink(this.file());
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
  for (const name of names) {
    const match = /^([0-9a-f]{64})\.json$/.exec(name);
    if (!match) continue;
    const profileHash = match[1];
    if (!profileHash) continue;
    const current = await new DurableAdmissionLease(stateRoot, profileHash).read();
    if (current.status === "corrupt") {
      throw new Error(`lease_corrupt:${profileHash}:${current.sha256}`);
    }
    if (current.status === "found") protectedSessions.add(current.lease.sessionId);
  }
  return protectedSessions;
}

const TERMINALS = new Set<StableTerminalStopReason>(["end_turn", "cancelled"]);
