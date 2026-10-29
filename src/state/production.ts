import { mkdir } from "node:fs/promises";
import path from "node:path";
import { DurableSessionStore, defaultStateDirectory } from "./durable.js";
import { DurableAdmissionLease, canonicalProfileIdentityHash, leaseReferencedSessionIds } from "./lease.js";
import { PowerShellWindowsProcessIdentity } from "./mutex.js";
import { releaseReadiness } from "../release.js";

export interface ProductionStateContext {
  readonly stateDirectory: string;
  readonly profileIdentityHash: string;
  readonly sessionStore: DurableSessionStore;
  readonly admissionLease: DurableAdmissionLease;
}

export interface ProductionStateContextOptions {
  /** Resolve the exact current-process identity before serving live mutations. */
  readonly warmProcessIdentity?: boolean;
  /** Test/qualification override; production otherwise follows the measured release capability. */
  readonly maxConcurrentTurns?: number;
  /** Test/qualification override; zero preserves immediate busy behavior. */
  readonly maxQueuedTurns?: number;
}

/**
 * Build the production filesystem-backed state domain for one canonical CoS profile.
 *
 * This intentionally accepts only the user-data directory plus process environment. Endpoint
 * ports, controller PIDs and bearer tokens therefore cannot influence the admission domain.
 * Initializing the session store runs the required hard-link capability probe before any prompt
 * can be admitted.
 */
export async function createProductionStateContext(
  userDataDir: string,
  env: NodeJS.ProcessEnv = process.env,
  options: ProductionStateContextOptions = {},
): Promise<ProductionStateContext> {
  const stateDirectory = defaultStateDirectory(env);
  const profileIdentityHash = await canonicalProfileIdentityHash(userDataDir);
  // Production state mutations share one verified process identity. Constructing a fresh
  // PowerShell-backed identity for every short session mutex would launch a new PowerShell query
  // per durable transition and can time out under load before the first provider-event checkpoint.
  // The identity object itself memoizes current(), while still querying other PIDs when stale-lock
  // proof is actually required.
  const processIdentity = new PowerShellWindowsProcessIdentity();
  const sessionStore = new DurableSessionStore(stateDirectory, { mutex: { identity: processIdentity } });
  const supportedConcurrency = options.maxConcurrentTurns ?? releaseReadiness().supportedConcurrency;
  const admissionLease = new DurableAdmissionLease(stateDirectory, profileIdentityHash, {
    identity: processIdentity,
    // Profile admission is the one intentionally contended short mutex when multiple T3 threads
    // start together. Poll it more closely than the general-purpose 25 ms mutex default so a
    // contender does not pay one or more full 25 ms sleeps after the fsynced lease-state write has
    // already released. Stale-owner proof still uses the mutex's independent 100 ms grace.
    mutex: { identity: processIdentity, pollMs: 5 },
    maxConcurrentTurns: supportedConcurrency,
    maxQueuedTurns: options.maxQueuedTurns ?? (supportedConcurrency > 1 ? 8 : 0),
  });
  if (options.warmProcessIdentity) {
    // The live ACP provider warms this once during startup so the first durable mutation stays free
    // of PowerShell launch latency. Generic state-context consumers can remain lazy when they never
    // mutate state, which also avoids unnecessary child-process pressure in read-only/test paths.
    await processIdentity.current();
  }
  // These directories are deterministic local state scaffolding, not CoS I/O. Creating them with
  // the state domain keeps the first provider prompt from paying directory-creation latency inside
  // the profile-wide lease/mutex critical path while preserving every durable write and fsync.
  await Promise.all([
    sessionStore.init(),
    mkdir(path.join(stateDirectory, "leases"), { recursive: true }),
    mkdir(path.join(stateDirectory, "locks", "profiles", "tmp"), { recursive: true }),
  ]);
  const protectedSessions = await leaseReferencedSessionIds(stateDirectory);
  await sessionStore.pruneBroken(undefined, protectedSessions);
  return {
    stateDirectory,
    profileIdentityHash,
    sessionStore,
    admissionLease,
  };
}
