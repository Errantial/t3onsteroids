import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function evaluate(fixture: string, inputId: string, turnId: string) {
  const stdout = execFileSync(process.execPath, [
    resolve("scripts/step7-tool-eligibility.mjs"),
    resolve(fixture),
    inputId,
    turnId,
  ], { encoding: "utf8" });
  return JSON.parse(stdout) as {
    eligibleNoTool: boolean;
    reason: string | null;
    toolLikeCount: number;
    toolLike: Array<{ kind: string; turnId: string | null; name: string | null; attribution: string | null }>;
  };
}

describe("Step 7 no-tool eligibility", () => {
  it("rejects request-attributed read and page_tool rows even when they have no turnId", () => {
    const result = evaluate(
      "test/fixtures/step7-missed-tool-events.json",
      "54536a86-8a18-45ef-a27a-e3915416ca82",
      "g-1xca7p11dxohza-0-1",
    );
    expect(result).toMatchObject({
      eligibleNoTool: false,
      reason: "request_owned_read_or_page_tool",
      toolLikeCount: 2,
    });
    expect(result.toolLike).toEqual([
      expect.objectContaining({ kind: "tool_call", turnId: null, name: "read", attribution: "request_id" }),
      expect.objectContaining({ kind: "page_tool", turnId: null }),
    ]);
  });
});
