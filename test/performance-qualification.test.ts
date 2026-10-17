import { describe, expect, it } from "vitest";

import { median, nearestRankPercentile, qualifyStep7Performance } from "../src/performance-qualification.js";

describe("Step 7 performance qualification", () => {
  it("uses nearest-rank p95 exactly, including N=10 => maximum", () => {
    expect(nearestRankPercentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95)).toBe(10);
    expect(nearestRankPercentile([10, 1, 2, 3], 0.5)).toBe(2);
    expect(() => nearestRankPercentile([1], 0)).toThrow(RangeError);
  });

  it("computes medians for the variance-sensitive direct/bridged comparison", () => {
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([])).toBeNull();
  });

  it("passes the fixed v1 budgets with ten short paired samples and a bounded slow consumer", () => {
    const bridged = Array.from({ length: 10 }, (_, index) => ({
      preSendMs: 20 + index,
      drainMs: 100 + index * 10,
      postDrainMs: 30 + index,
      endToEndMs: 1_000 + index * 20,
    }));
    const direct = Array.from({ length: 10 }, (_, index) => ({ endToEndMs: 900 + index * 20 }));
    const result = qualifyStep7Performance({
      bridged,
      direct,
      slowConsumer: {
        rssHighWaterBytes: 200 * 1024 * 1024,
        maxQueueDepth: 16,
        queueCapacity: 16,
        sseReconnectCount: 2,
        backoffCount: 1,
        controllerReadCount: 20,
        controllerActionCount: 12,
        drainedWithinMs: 5_000,
      },
    });
    expect(result.pass).toBe(true);
    expect(result.preSendP95Ms).toBe(29);
    expect(result.drainP95Ms).toBe(190);
    expect(result.postDrainP95Ms).toBe(39);
  });

  it("fails closed on each hard release budget", () => {
    const bridged = Array.from({ length: 10 }, () => ({ preSendMs: 251, drainMs: 1_001, postDrainMs: 251 }));
    const direct = Array.from({ length: 9 }, () => ({ endToEndMs: 1_000 }));
    const result = qualifyStep7Performance({
      bridged,
      direct,
      slowConsumer: {
        rssHighWaterBytes: 256 * 1024 * 1024,
        maxQueueDepth: 17,
        queueCapacity: 16,
        sseReconnectCount: 3,
        backoffCount: 0,
        controllerReadCount: 0,
        controllerActionCount: 0,
        drainedWithinMs: null,
      },
    });
    expect(result.pass).toBe(false);
    expect(result.checks).toEqual({
      bridgedSampleCount: true,
      directSampleCount: false,
      preSendP95: false,
      drainP95: false,
      postDrainP95: false,
      drainDeadline: false,
      rssHighWater: false,
      queueBound: false,
      reconnectBound: false,
    });
  });
});
