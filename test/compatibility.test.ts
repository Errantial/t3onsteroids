import fixture from "./fixtures/compatibility.json" with { type: "json" };
import { describe, expect, it } from "vitest";

import { compatibility } from "../src/compatibility.js";

describe("compatibility metadata", () => {
  it("matches the checked-in machine-readable fixture", () => {
    expect(compatibility).toEqual(fixture);
  });
});

