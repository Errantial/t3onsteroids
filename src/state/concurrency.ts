import { MAX_LEASE_SLOTS } from "./lease.js";

/**
 * Concurrent bridged turns the release is qualified for. Raising this is a qualification result
 * (PLAN.md post-v1 roadmap), never a configuration choice: concurrency must be advertised from
 * measured support, so it stays 1 until live evidence for a higher ceiling is recorded.
 */
export const QUALIFIED_MAX_CONCURRENT_TURNS = 1;

export const MAX_CONCURRENT_TURNS_ENV = "T3COS_MAX_CONCURRENT_TURNS";
/** Set to `1` only for qualification runs that deliberately exercise unqualified concurrency. */
export const CONCURRENCY_QUALIFICATION_ENV = "T3COS_CONCURRENCY_QUALIFICATION";

/**
 * Resolve how many turns the admission lease may hold at once. Unset means the qualified ceiling.
 * A request above the ceiling fails explicitly instead of being clamped, so nobody believes they
 * are running concurrent chats on an unqualified build.
 */
export function resolveLeaseCapacity(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[MAX_CONCURRENT_TURNS_ENV]?.trim();
  if (raw === undefined || raw === "") return QUALIFIED_MAX_CONCURRENT_TURNS;
  if (!/^[1-9][0-9]?$/.test(raw)) throw new Error(`${MAX_CONCURRENT_TURNS_ENV} must be a positive integer`);
  const requested = Number(raw);
  if (requested > MAX_LEASE_SLOTS) {
    throw new Error(`${MAX_CONCURRENT_TURNS_ENV} cannot exceed ${MAX_LEASE_SLOTS} (the controller event-stream budget)`);
  }
  if (requested > QUALIFIED_MAX_CONCURRENT_TURNS && env[CONCURRENCY_QUALIFICATION_ENV] !== "1") {
    throw new Error(
      `Concurrent turns above ${QUALIFIED_MAX_CONCURRENT_TURNS} are not qualified; ` +
        `${CONCURRENCY_QUALIFICATION_ENV}=1 is required for qualification runs only`,
    );
  }
  return requested;
}
