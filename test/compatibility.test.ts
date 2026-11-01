import fixture from "./fixtures/compatibility.json" with { type: "json" };
import packageMetadata from "../package.json" with { type: "json" };
import { describe, expect, it } from "vitest";

import { PINNED_T3_SHA } from "../src/acp/index.js";
import { compatibility } from "../src/compatibility.js";

describe("compatibility metadata", () => {
  it("matches the checked-in machine-readable fixture", () => {
    // The fixture pins the T3/CoS/ACP baseline; the bridge release version is
    // derived from package.json and must not be duplicated in the fixture.
    expect(compatibility).toEqual({
      ...fixture,
      bridge: { ...fixture.bridge, version: compatibility.bridge.version },
    });
    expect(compatibility.bridge.version).toBe(packageMetadata.version);
  });

  it("keeps the runtime T3 pin identical to the compatibility baseline", () => {
    expect(PINNED_T3_SHA).toBe(compatibility.t3.sha);
  });
});

