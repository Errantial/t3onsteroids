import { describe, expect, it } from "vitest";

import {
  evaluateRestartEvidence,
  evaluateSseReconnectEvidence,
  parseOptions,
  summarizeStatus,
} from "../scripts/step7-live-smoke-lib.mjs";

const healthyBrowser = {
  connectionState: "connected",
  bridgePaired: true,
  bridgePresent: true,
};

describe("Step 7 live-smoke harness evaluation", () => {
  it("accepts exactly one cursor-resuming reconnect with one bounded backoff", () => {
    const result = evaluateSseReconnectEvidence({
      browserBefore: healthyBrowser,
      browserAfter: healthyBrowser,
      intentionalDrop: { performed: true, afterSeq: 17, reconnectFrom: 18 },
      metrics: { sseReconnects: 1, sseConnectAttempts: 2, sseBackoffs: 1 },
      duplicateSeqCount: 0,
      turnEndObserved: true,
      turnDrainedObserved: true,
      finalMatched: true,
      toolLikeCount: 0,
    });
    expect(result.pass).toBe(true);
    expect(result.checks).toEqual(expect.objectContaining({
      intentionalDrop: true,
      exactCursorResume: true,
      oneReconnect: true,
      boundedBackoff: true,
    }));
  });

  it("rejects duplicate rows, wrong resume cursors and reconnect storms", () => {
    const result = evaluateSseReconnectEvidence({
      browserBefore: healthyBrowser,
      browserAfter: healthyBrowser,
      intentionalDrop: { performed: true, afterSeq: 17, reconnectFrom: 17 },
      metrics: { sseReconnects: 3, sseConnectAttempts: 4, sseBackoffs: 0 },
      duplicateSeqCount: 1,
      turnEndObserved: true,
      turnDrainedObserved: true,
      finalMatched: true,
      toolLikeCount: 0,
    });
    expect(result.pass).toBe(false);
    expect(result.checks).toMatchObject({ exactCursorResume: false, oneReconnect: false, boundedBackoff: false, noDuplicateRows: false });
  });

  it("accepts bridge and provider restart evidence only with bounded mutation/recovery counts", () => {
    const base = {
      firstTurn: { stopReason: "end_turn", finalMatched: true, toolLikeCount: 0 },
      secondTurn: { stopReason: "end_turn", finalMatched: true, toolLikeCount: 0 },
      sameSession: true,
      sessionInputDelta: 2,
      policyBefore: true,
      policyAfter: true,
      browserBefore: healthyBrowser,
      browserAfterRestart: healthyBrowser,
      browserAfter: healthyBrowser,
      metrics: { controllerActionCount: 4, backoffCount: 1, sseReconnectCount: 1 },
    };
    expect(evaluateRestartEvidence({ ...base, mode: "bridge", bridgeProcessRestarted: true }).pass).toBe(true);
    expect(evaluateRestartEvidence({
      ...base,
      mode: "provider",
      providerIdentityChanged: true,
      tokenChanged: true,
    }).pass).toBe(true);
    expect(evaluateRestartEvidence({
      ...base,
      mode: "provider",
      providerIdentityChanged: true,
      tokenChanged: false,
      metrics: { controllerActionCount: 9, backoffCount: 8, sseReconnectCount: 3 },
    }).pass).toBe(false);
  });

  it("parses only explicit option pairs and summarizes browser status without retaining unrelated fields", () => {
    expect(parseOptions(["--profile", "candidate", "--out-dir", "new-root"])).toEqual({ profile: "candidate", "out-dir": "new-root" });
    expect(() => parseOptions(["--profile"])).toThrow("missing value");
    expect(summarizeStatus({
      connection: { state: "connected", secret: "do-not-retain" },
      bridge: { paired: true, present: true, pageText: "private" },
      token: "secret",
    })).toEqual(healthyBrowser);
  });
});
