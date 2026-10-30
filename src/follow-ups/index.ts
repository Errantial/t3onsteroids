import type { CosBackgroundWork } from "../cos/index.js";
import type { FollowUpState } from "../session/index.js";

/**
 * Announces provider work that outlived the ACP turn that started it.
 *
 * The turn already ended; this runs beside the ACP session and watches the provider projection
 * until every registered item is terminal, then reports the outcome once. Items are cleared from
 * durable state only after the announcement is written, so a restart before that point re-announces
 * instead of losing the result.
 */
export interface AnnounceFollowUpsDeps {
  readonly backgroundWork?: (sessionId: string) => Promise<CosBackgroundWork | undefined>;
  readonly read: () => Promise<readonly FollowUpState[] | undefined>;
  readonly write: (items: readonly FollowUpState[]) => Promise<void>;
  readonly emit: (text: string) => Promise<void>;
  readonly pollMs?: number;
  readonly maxWaitMs?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export type AnnounceOutcome = "announced" | "nothing" | "timeout";

const DEFAULT_POLL_MS = 2_000;
const DEFAULT_MAX_WAIT_MS = 30 * 60_000;

export async function announceFollowUps(
  sessionId: string,
  deps: AnnounceFollowUpsDeps
): Promise<AnnounceOutcome> {
  const items = await deps.read();
  if (!items || items.length === 0) return "nothing";
  if (!deps.backgroundWork) return "nothing";
  const pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
  const maxWaitMs = deps.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + maxWaitMs;

  let latest: CosBackgroundWork | undefined;
  for (;;) {
    latest = await deps.backgroundWork(sessionId);
    if (!latest) return "nothing";
    const registered = new Set(items.map((item) => item.id));
    const stillPending = latest.pending.filter((item) => registered.has(item.id) && item.terminal !== true);
    if (stillPending.length === 0) break;
    if (now() >= deadline) return "timeout";
    await sleep(pollMs);
  }

  const byId = new Map(latest.pending.map((item) => [item.id, item]));
  const lines = items.map((item) => {
    const current = byId.get(item.id);
    const outcome = current?.outcome ?? (current?.terminal === true ? "completed" : "completed");
    const label = item.label.trim() || item.id;
    return `Background work finished: ${label} — ${outcome}.`;
  });
  await deps.emit(lines.join("\n"));
  await deps.write([]);
  return "announced";
}
