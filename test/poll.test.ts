import { describe, expect, it } from "vitest";

import { scaledPollMs } from "../src/state/index.js";

describe("capacity-scaled controller polling", () => {
  it("leaves the single-turn interval unchanged", () => {
    expect(scaledPollMs(500, 1)).toBe(500);
    expect(scaledPollMs(50, 1)).toBe(50);
  });

  it("stretches the interval with the admission capacity", () => {
    expect(scaledPollMs(500, 2)).toBe(1_000);
    expect(scaledPollMs(50, 4)).toBe(200);
  });

  it("rejects non-positive intervals and invalid capacities", () => {
    expect(() => scaledPollMs(0, 1)).toThrow("poll interval must be positive");
    expect(() => scaledPollMs(Number.NaN, 1)).toThrow("poll interval must be positive");
    expect(() => scaledPollMs(500, 0)).toThrow("capacity must be a positive integer");
    expect(() => scaledPollMs(500, 1.5)).toThrow("capacity must be a positive integer");
  });
});
