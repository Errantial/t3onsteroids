import { describe, expect, it } from "vitest";

import {
  analyzeDirectTurn,
  analyzeProviderTurn,
  buildStep7PerformanceInput,
  evaluateDirectPairedEvidence,
  evaluateSlowConsumerEvidence,
  slowConsumerPerformanceSample,
  withHarnessTimeout,
} from "../scripts/step7-performance-live-lib.mjs";

const healthyBrowser = { connectionState: "connected", bridgePaired: true, bridgePresent: true };

describe("Step 7 live performance harness", () => {
  it("reduces a fresh direct CoS session to content-free timing evidence", () => {
    const inputId = "11111111-1111-4111-8111-111111111111";
    const analysis = analyzeDirectTurn([
      { seq: 1, position: 1, time: 10, kind: "user_message", inputId, inputDelivery: "confirmed" },
      { seq: 2, position: 2, time: 20, kind: "turn_start", turnId: "turn-a" },
      { seq: 3, position: 3, time: 30, kind: "assistant_message", final: true, message: { text: "expected" } },
      { seq: 4, position: 4, time: 40, kind: "turn_end", turnId: "turn-a" },
    ], { inputId, expectedText: "expected", endToEndMs: 123.5 });
    expect(analysis).toEqual({
      inputDelivered: true,
      turnEndObserved: true,
      turnId: "turn-a",
      finalObserved: true,
      finalMatched: true,
      finalAssistantChars: 8,
      toolLikeCount: 0,
      endToEndMs: 123.5,
    });
    expect(JSON.stringify(analysis)).not.toContain("expected");
  });

  it("counts late direct-session tool activity instead of accepting it as a no-tool baseline", () => {
    const inputId = "11111111-1111-4111-8111-111111111111";
    const analysis = analyzeDirectTurn([
      { position: 1, kind: "user_message", inputId, inputDelivery: "confirmed" },
      { position: 2, kind: "assistant_message", final: true, message: { text: "ok" } },
      { position: 3, kind: "turn_end", turnId: "turn-a" },
      { position: 4, kind: "page_tool" },
    ], { inputId, expectedText: "ok", endToEndMs: 10 });
    expect(analysis.toolLikeCount).toBe(1);
  });

  it("extracts provider drain timing and the exact final content locator", () => {
    const inputId = "22222222-2222-4222-8222-222222222222";
    expect(analyzeProviderTurn([
      { seq: 1, position: 1, time: 100, kind: "user_message", inputId, inputDelivery: "confirmed" },
      { seq: 2, position: 2, time: 200, kind: "turn_end", turnId: "turn-b" },
      { seq: 3, position: 3, time: 260, kind: "assistant_message", final: true },
      { seq: 4, position: 4, time: 275, kind: "turn_drained", inputId, turnId: "turn-b", highWaterSeq: 4, finalAssistantSeq: 3 },
    ], inputId)).toEqual({ turnId: "turn-b", finalAssistantSeq: 3, nativeDrainMs: 75, toolLikeCount: 0 });
  });

  it("evaluates direct and slow-consumer evidence without retaining response text", () => {
    const directSamples = Array.from({ length: 10 }, (_, index) => ({
      inputDelivered: true,
      turnEndObserved: true,
      finalObserved: true,
      finalMatched: true,
      toolLikeCount: 0,
      endToEndMs: 100 + index,
    }));
    expect(evaluateDirectPairedEvidence({
      samples: directSamples,
      direct: directSamples.map(({ endToEndMs }) => ({ endToEndMs })),
      browserBefore: { ...healthyBrowser, inputCount: 10 },
      browserAfter: { ...healthyBrowser, inputCount: 20 },
    }).pass).toBe(true);

    const slowConsumer = slowConsumerPerformanceSample({
      rssHighWaterBytes: 100 * 1024 * 1024,
      maxQueueDepth: 0,
      sseReconnectCount: 1,
      backoffCount: 0,
      controllerReadCount: 12,
      controllerActionCount: 3,
    }, 900);
    expect(evaluateSlowConsumerEvidence({
      stopReason: "end_turn",
      policyEnforced: true,
      exactFinalContent: true,
      minOutputChars: 5_000,
      assistantChars: 5_500,
      toolLikeCount: 0,
      projectedToolLikeCount: 0,
      slowConsumer,
      browserBefore: { ...healthyBrowser, inputCount: 20 },
      browserAfter: { ...healthyBrowser, inputCount: 21 },
    }).pass).toBe(true);
  });

  it("preserves the watchdog reason when timeout cleanup closes the ACP operation", async () => {
    let rejectOperation!: (error: Error) => void;
    const operation = new Promise<never>((_resolve, reject) => {
      rejectOperation = reject;
    });
    await expect(withHarnessTimeout(operation, {
      timeoutMs: 5,
      onTimeout: () => rejectOperation(new Error("ACP connection closed")),
      message: "Step 7 slow-consumer turn timed out",
    })).rejects.toThrow("Step 7 slow-consumer turn timed out");
  });

  it("assembles exactly the performance-qualification input schema and rejects ineligible bridged rows", () => {
    const bridgedRows = Array.from({ length: 10 }, (_, index) => ({
      eligibleNoTool: true,
      exactFinal: true,
      preSendMs: 10 + index,
      nativeDrainMs: 20 + index,
      postDrainMs: 30 + index,
      t3DurationMs: 100 + index,
    }));
    const direct = Array.from({ length: 10 }, (_, index) => ({ endToEndMs: 90 + index }));
    const slowConsumer = {
      rssHighWaterBytes: 100,
      maxQueueDepth: 0,
      queueCapacity: null,
      sseReconnectCount: 0,
      backoffCount: 0,
      controllerReadCount: 4,
      controllerActionCount: 2,
      drainedWithinMs: 50,
    };
    const input = buildStep7PerformanceInput({
      bridgedRows,
      directEvidence: { direct, evaluation: { pass: true } },
      slowEvidence: { slowConsumer, evaluation: { pass: true } },
    });
    expect(input).toEqual({
      bridged: bridgedRows.map((row) => ({
        preSendMs: row.preSendMs,
        drainMs: row.nativeDrainMs,
        postDrainMs: row.postDrainMs,
        endToEndMs: row.t3DurationMs,
      })),
      direct,
      slowConsumer,
    });
    expect(() => buildStep7PerformanceInput({
      bridgedRows: [{ ...bridgedRows[0], eligibleNoTool: false }],
      directEvidence: { direct, evaluation: { pass: true } },
      slowEvidence: { slowConsumer, evaluation: { pass: true } },
    })).toThrow("not an eligible exact no-tool turn");
  });
});
