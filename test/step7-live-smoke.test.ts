import { describe, expect, it } from "vitest";

import {
  buildCrossSessionStaleFixture,
  evaluateRestartEvidence,
  evaluateSseReconnectEvidence,
  isRestartCheckpointLifecycleUpdate,
  parseOptions,
  providerBrowserReady,
  proveProviderSessionInputs,
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
      authoritativeInputProof: true,
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

  it("proves restart inputs from confirmed session events without relying on retained global input lists", () => {
    const events = [
      { seq: 1, kind: "user_message", inputId: "input-a", inputDelivery: "confirmed" },
      { seq: 2, kind: "turn_drained", inputId: "input-a", turnId: "turn-a", highWaterSeq: 2 },
      { seq: 3, kind: "user_message", inputId: "input-b", inputDelivery: "confirmed" },
      { seq: 4, kind: "turn_drained", inputId: "input-b", turnId: "turn-b", highWaterSeq: 4 },
    ];
    expect(proveProviderSessionInputs(events, 2)).toBe(true);
    expect(proveProviderSessionInputs(events.slice(0, 3), 2)).toBe(false);
    expect(proveProviderSessionInputs([...events, { seq: 5, kind: "user_message", inputId: "input-c", inputDelivery: "confirmed" }], 2)).toBe(false);
  });

  it("ignores only the exact extension restart-checkpoint page-tool projection", () => {
    expect(isRestartCheckpointLifecycleUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "cos-event:11",
      title: "Executed workflow restart checkpoint",
      kind: "other",
      status: "completed",
    })).toBe(true);
    expect(isRestartCheckpointLifecycleUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "cos-event:10",
      title: "Restarted the development workflow",
      kind: "other",
      status: "completed",
    })).toBe(true);
    expect(isRestartCheckpointLifecycleUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "cos-event:12",
      title: "Clicked Save",
      kind: "other",
      status: "completed",
    })).toBe(false);
    expect(isRestartCheckpointLifecycleUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "request-tool-1",
      title: "Executed workflow restart checkpoint",
      status: "completed",
    })).toBe(false);
    for (const title of ["Computed current working directory", "Invoked plugin despite user’s no-tools instruction"]) {
      expect(isRestartCheckpointLifecycleUpdate({
        sessionUpdate: "tool_call",
        toolCallId: "cos-event:99",
        title,
        kind: "other",
        status: "completed",
      })).toBe(false);
    }
  });

  it("builds cross-session stale evidence from drain identity without comparing independent session cursors", () => {
    const setup = buildCrossSessionStaleFixture([
      { seq: 900, position: 12, time: 100, kind: "turn_end", source: "extension", turnId: "source-turn", outcome: "completed" },
      { seq: 901, position: 13, time: 101, kind: "turn_drained", source: "app", turnId: "source-turn", inputId: "source-input" },
    ], [
      { seq: 4, kind: "turn_end" },
      { seq: 5, kind: "turn_drained" },
    ], "source-session");
    expect(setup).toEqual({
      fixture: {
        seq: 4,
        position: 12,
        time: 100,
        kind: "turn_end",
        source: "extension",
        turnId: "source-turn",
        inputId: "source-input",
        sessionId: "source-session",
        outcome: "completed",
      },
      sourceEventSequence: 900,
      targetLastSeq: 5,
    });
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

  it("treats provider browser readiness as pairing/presence, independent of the Core MCP tunnel", () => {
    expect(providerBrowserReady({ connectionState: "disconnected", bridgePaired: true, bridgePresent: true })).toBe(true);
    expect(providerBrowserReady({ connectionState: "connected", bridgePaired: false, bridgePresent: true })).toBe(false);
    expect(providerBrowserReady({ connectionState: "connected", bridgePaired: true, bridgePresent: false })).toBe(false);
  });
});
