import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sourceFiles(join(dir, entry.name))
      : entry.name.endsWith(".ts")
        ? [join(dir, entry.name)]
        : [],
  );
}

// CoS drives a ChatGPT browser chat and has no authoritative token counts, so the bridge must
// not report any. T3 shows its tokens/sec readout and context meter only for threads whose
// provider reports usage; this keeps CoS-backed threads out of both until a versioned usage
// contract (docs/usage-contract.md) is deliberately implemented.
describe("usage reporting is intentionally absent", () => {
  it("never emits ACP usage_update or per-prompt usage", () => {
    const offenders = sourceFiles(join(__dirname, "..", "src")).filter((file) =>
      /usage_update|\busage\s*:/.test(readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
