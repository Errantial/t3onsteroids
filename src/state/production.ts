import { DurableSessionStore, defaultStateDirectory } from "./durable.js";
import { DurableAdmissionLease, canonicalProfileIdentityHash, leaseReferencedSessionIds } from "./lease.js";
import { PowerShellWindowsProcessIdentity } from "./mutex.js";

export interface ProductionStateContext {
  readonly stateDirectory: string;
  readonly profileIdentityHash: string;
  readonly sessionStore: DurableSessionStore;
  readonly admissionLease: DurableAdmissionLease;
}

export interface ProductionStateContextOptions {
  /** Resolve the exact current-process identity before serving live mutations. */
  readonly warmProcessIdentity?: boolean;
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
  const admissionLease = new DurableAdmissionLease(stateDirectory, profileIdentityHash, {
    identity: processIdentity,
    mutex: { identity: processIdentity },
  });
  if (options.warmProcessIdentity) {
    // The live ACP provider warms this once during startup so the first durable mutation stays free
    // of PowerShell launch latency. Generic state-context consumers can remain lazy when they never
    // mutate state, which also avoids unnecessary child-process pressure in read-only/test paths.
    await processIdentity.current();
  }
  await sessionStore.init();
  const protectedSessions = await leaseReferencedSessionIds(stateDirectory);
  await sessionStore.pruneBroken(undefined, protectedSessions);
  return {
    stateDirectory,
    profileIdentityHash,
    sessionStore,
    admissionLease,
  };
}
