import fixture from "./fixtures/compatibility.json" with { type: "json" };
import { describe, expect, it } from "vitest";

import { PINNED_T3_SHA } from "../src/acp/index.js";
import { compatibility } from "../src/compatibility.js";

describe("compatibility metadata", () => {
  it("matches the checked-in machine-readable fixture", () => {
    expect(compatibility).toEqual(fixture);
  });

  it("keeps the runtime T3 pin identical to the compatibility baseline", () => {
    expect(PINNED_T3_SHA).toBe(compatibility.t3.sha);
  });
});

