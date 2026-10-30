/**
 * The CoS controller charges every authenticated read (600 per minute) and every action (30 per
 * minute) to one shared budget, however many bridged turns run. Polling loops are written for a
 * single turn, so a wait loop that reads twice per 500 ms would, with three turns waiting at once,
 * ask for 720 reads a minute and starve the very event streams it is waiting for. Stretching each
 * loop's interval by the lease capacity keeps the combined rate at or below the single-turn rate.
 */
export function scaledPollMs(baseMs: number, capacity: number): number {
  if (!Number.isFinite(baseMs) || baseMs <= 0) throw new Error("poll interval must be positive");
  if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error("capacity must be a positive integer");
  return baseMs * capacity;
}
