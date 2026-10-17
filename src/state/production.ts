import { DurableSessionStore, defaultStateDirectory } from "./durable.js";
import { DurableAdmissionLease, canonicalProfileIdentityHash, leaseReferencedSessionIds } from "./lease.js";

export interface ProductionStateContext {
  readonly stateDirectory: string;
  readonly profileIdentityHash: string;
  readonly sessionStore: DurableSessionStore;
  readonly admissionLease: DurableAdmissionLease;
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
): Promise<ProductionStateContext> {
  const stateDirectory = defaultStateDirectory(env);
  const profileIdentityHash = await canonicalProfileIdentityHash(userDataDir);
  const sessionStore = new DurableSessionStore(stateDirectory);
  const admissionLease = new DurableAdmissionLease(stateDirectory, profileIdentityHash);
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
