import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { main } from "../../src/cli/index.js";

describe("Phase 0 offline acceptance", () => {
  it("loads protocol fixtures without T3 or CoS installed", async () => {
    const path = fileURLToPath(new URL("../fixtures/acp-initialize-v1.json", import.meta.url));
    const parsed = JSON.parse(await readFile(path, "utf8")) as { method: string };
    expect(parsed.method).toBe("initialize");
  });

  it("keeps the development CLI side-effect free", async () => {
    await expect(main(["--help"])).resolves.toBe(0);
  });
});
