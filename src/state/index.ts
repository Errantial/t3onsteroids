export interface StateStore<T> {
  read(key: string): Promise<T | null>;
  write(key: string, value: T): Promise<void>;
}

export interface LeaseRecord {
  readonly controllerIdentity: string;
  readonly sessionId: string;
  readonly inputId: string;
  readonly generation: number;
  readonly ownerId: string;
}

export interface AdmissionLease {
  acquire(record: LeaseRecord): Promise<boolean>;
  read(controllerIdentity: string): Promise<LeaseRecord | null>;
  release(controllerIdentity: string, ownerId: string): Promise<void>;
}

export class MemoryStateStore<T> implements StateStore<T> {
  private readonly values = new Map<string, T>();

  async read(key: string): Promise<T | null> {
    return this.values.get(key) ?? null;
  }

  async write(key: string, value: T): Promise<void> {
    this.values.set(key, value);
  }
}

export class MemoryAdmissionLease implements AdmissionLease {
  private readonly leases = new Map<string, LeaseRecord>();

  async acquire(record: LeaseRecord): Promise<boolean> {
    if (this.leases.has(record.controllerIdentity)) return false;
    this.leases.set(record.controllerIdentity, record);
    return true;
  }

  async read(controllerIdentity: string): Promise<LeaseRecord | null> {
    return this.leases.get(controllerIdentity) ?? null;
  }

  async release(controllerIdentity: string, ownerId: string): Promise<void> {
    const current = this.leases.get(controllerIdentity);
    if (current?.ownerId === ownerId) this.leases.delete(controllerIdentity);
  }
}

export {
  DurableSessionStore,
  DURABLE_SESSION_SCHEMA_VERSION,
  StateIoError,
  defaultStateDirectory,
} from "./durable.js";
export type {
  DurableSessionRecord,
  DurableSessionStoreOptions,
  DurableSessionTransition,
  SessionTransitionResult,
  StateIoOperation,
  TaggedSessionRead,
} from "./durable.js";
export {
  HardLinkMutex,
  PowerShellWindowsProcessIdentity,
  StateLockBusyError,
  UnsupportedStateFilesystemError,
  probeHardLinkStateFilesystem,
} from "./mutex.js";
export type {
  HardLinkMutexHandle,
  HardLinkMutexOptions,
  LockOwnerRecord,
  ProcessIdentityResult,
  WindowsProcessIdentity,
} from "./mutex.js";
export {
  DurableAdmissionLease,
  canonicalProfileIdentityHash,
  leaseReferencedSessionIds,
} from "./lease.js";
export type {
  DurableAdmissionLeaseOptions,
  DurableLeaseAcquireResult,
  DurableLeaseCollectionReadResult,
  DurableLeaseLookupResult,
  DurableLeaseReadResult,
  DurableLeaseRecord,
  DurableQueuedLeaseRecord,
  LeaseReleaseProof,
  LeaseReleaseResult,
  QueuedLeaseCancelResult,
} from "./lease.js";
export { createProductionStateContext } from "./production.js";
export type { ProductionStateContext, ProductionStateContextOptions } from "./production.js";
