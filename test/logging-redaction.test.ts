import { describe, expect, it } from "vitest";

import { bridgeLogRecord } from "../src/logging.js";

describe("metadata-only bridge logging", () => {
  it("hashes hostile identifiers and cannot serialize content/config/token fields", () => {
    const token = "Bearer sk-live-partial-secret-XYZ";
    const prompt = "please inspect C:\\Users\\private\\secret-repo and browser text";
    const record = bridgeLogRecord({
      level: "error",
      operation: "provider_prompt",
      correlationId: `${token}:${prompt}`,
      acpSessionId: `../../${token}`,
      cosSessionId: `line\n${prompt}`,
      transition: "turn_drained",
      status: 409,
      errorCategory: "session_broken",
      latencyMs: 12,
      byteCount: 4096,
      queueDepth: 3,
      now: 123,
    });
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain(prompt);
    expect(serialized).not.toContain("secret-repo");
    expect(record).toMatchObject({
      timestamp: 123,
      operation: "provider_prompt",
      transition: "turn_drained",
      status: 409,
      queueDepth: 3,
    });
    expect(record.acpSession).toMatch(/^[0-9a-f]{12}$/);
    expect(record.cosSession).toMatch(/^[0-9a-f]{12}$/);
  });

  it("drops hostile free-form operation, transition, and error strings", () => {
    const secret = "Bearer partial-secret-XYZ";
    const serialized = JSON.stringify(bridgeLogRecord({
      level: "error",
      operation: `provider_prompt:${secret}`,
      transition: `turn_drained:${secret}`,
      errorCategory: `schema_mismatch:${secret}`,
      now: 1,
    }));
    expect(serialized).not.toContain(secret);
    expect(serialized).toContain('"operation":"provider_turn"');
    expect(serialized).not.toContain("transition");
    expect(serialized).not.toContain("errorCategory");
  });
});
