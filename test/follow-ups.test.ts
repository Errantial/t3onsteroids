import { describe, expect, it, vi } from "vitest";

import { announceFollowUps } from "../src/follow-ups/index.js";
import type { CosBackgroundWork } from "../src/cos/index.js";
import type { FollowUpState } from "../src/session/index.js";

const item = (over: Partial<FollowUpState> = {}): FollowUpState => ({
  id: "worker-1",
  label: "research",
  inputId: "input-1",
  state: "active",
  outcome: null,
  announcedSeq: null,
  ...over,
});

function deps(polls: readonly CosBackgroundWork[], over: Partial<Parameters<typeof announceFollowUps>[1]> = {}) {
  let index = 0;
  const emit = vi.fn(async (_text: string) => undefined);
  const write = vi.fn(async () => undefined);
  return {
    emit,
    write,
    value: {
      read: async () => [item()],
      write,
      emit,
      backgroundWork: async () => polls[Math.min(index++, polls.length - 1)],
      sleep: async () => undefined,
      now: () => 0,
      ...over,
    },
  };
}

describe("follow-up announcements", () => {
  it("waits for the work to finish and reports it once", async () => {
    const pending: CosBackgroundWork = {
      state: "pending",
      pending: [{ id: "worker-1", label: "research", state: "active", terminal: false, outcome: null, cancellable: true }],
    };
    const done: CosBackgroundWork = {
      state: "pending",
      pending: [{ id: "worker-1", label: "research", state: "finished", terminal: true, outcome: "completed", cancellable: false }],
    };
    const harness = deps([pending, pending, done]);
    await expect(announceFollowUps("session-1", harness.value)).resolves.toBe("announced");
    expect(harness.emit).toHaveBeenCalledTimes(1);
    expect(harness.emit.mock.calls[0]![0]).toBe("Background work finished: research — completed.");
    expect(harness.write).toHaveBeenCalledWith([]);
  });

  it("reports a failed outcome without inventing a completion", async () => {
    const failed: CosBackgroundWork = {
      state: "pending",
      pending: [{ id: "worker-1", label: "research", state: "failed", terminal: true, outcome: "failed", cancellable: false }],
    };
    const harness = deps([failed]);
    await expect(announceFollowUps("session-1", harness.value)).resolves.toBe("announced");
    expect(harness.emit.mock.calls[0]![0]).toBe("Background work finished: research — failed.");
  });

  it("does nothing when no work was registered or the controller has no projection", async () => {
    const empty = deps([{ state: "none", pending: [] }], { read: async () => [] });
    await expect(announceFollowUps("session-1", empty.value)).resolves.toBe("nothing");
    expect(empty.emit).not.toHaveBeenCalled();

    const projectionless = deps([{ state: "none", pending: [] }]);
    delete (projectionless.value as { backgroundWork?: unknown }).backgroundWork;
    await expect(announceFollowUps("session-1", projectionless.value)).resolves.toBe("nothing");
  });

  it("gives up after the wait instead of announcing a live item", async () => {
    const pending: CosBackgroundWork = {
      state: "pending",
      pending: [{ id: "worker-1", label: "research", state: "active", terminal: false, outcome: null, cancellable: true }],
    };
    let clock = 0;
    const harness = deps([pending], {
      now: () => (clock += 1_000),
      maxWaitMs: 2_000,
    });
    await expect(announceFollowUps("session-1", harness.value)).resolves.toBe("timeout");
    expect(harness.emit).not.toHaveBeenCalled();
    expect(harness.write).not.toHaveBeenCalled();
  });

  it("keeps the item registered when the announcement itself fails", async () => {
    const done: CosBackgroundWork = {
      state: "pending",
      pending: [{ id: "worker-1", label: "research", state: "finished", terminal: true, outcome: "completed", cancellable: false }],
    };
    const harness = deps([done], { emit: async () => { throw new Error("closed"); } });
    await expect(announceFollowUps("session-1", harness.value)).rejects.toThrow("closed");
    expect(harness.write).not.toHaveBeenCalled();
  });
});
