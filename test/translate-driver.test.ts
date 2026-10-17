import { describe, expect, it, vi } from "vitest";

import type { CosEvent, CosProviderTurnAttestation } from "../src/cos/index.js";
import {
  driveProviderTurn,
  type ProviderTurnController,
  type ProviderTurnOutputEffect,
} from "../src/translate/driver.js";
import type { ProviderTurnTranslationState } from "../src/translate/events.js";

const sessionId = "session-1";
const inputId = "11111111-1111-4111-8111-111111111111";
const turnId = "turn-1";

function event(seq: number, kind: string, extra: Record<string, unknown> = {}): CosEvent {
  return { seq, position: seq, time: seq, kind, source: "extension", turnId, ...extra };
}

function final(seq: number): CosEvent {
  return event(seq, "assistant_message", {
    final: true,
    messageId: `message-${seq}`,
    message: { text: "snapshot", truncated: false, chars: 8 },
  });
}

function turn(state: CosProviderTurnAttestation["state"], drainedSeq: number | null, finalAssistantSeq: number | null): CosProviderTurnAttestation {
  return { inputId, state, turnId, drainedSeq, finalAssistantSeq };
}

function controllerFixture(rows: readonly CosEvent[], full = "authoritative final"): ProviderTurnController & {
  session: ReturnType<typeof vi.fn>;
  requireBackgroundWorkDisabled: ReturnType<typeof vi.fn>;
  assistantContentChunk: ReturnType<typeof vi.fn>;
  streamEvents: ReturnType<typeof vi.fn>;
} {
  let current = turn("active", null, null);
  const drain = rows.find((row) => row.kind === "turn_drained");
  return {
    session: vi.fn(async () => ({ id: sessionId, providerTurn: current })),
    requireBackgroundWorkDisabled: vi.fn(async () => ({ backgroundWork: "disabled" as const, enforced: true as const })),
    assistantContentChunk: vi.fn(async (_sessionId: string, seq: number, offset = 0, limit = 16_384) => {
      const text = full.slice(offset, offset + limit);
      return { sessionId, seq, field: "assistantText" as const, offset, text, totalLength: full.length, complete: offset + text.length === full.length };
    }),
    streamEvents: vi.fn(async function* (_sessionId: string, options: { from?: number; signal?: AbortSignal } = {}) {
      const from = options.from ?? 0;
      for (const row of rows) {
        if (options.signal?.aborted) return;
        if (row.seq < from) continue;
        if (row.kind === "turn_drained") {
          current = turn("drained", row.seq, row.finalAssistantSeq as number | null);
        }
        yield row;
      }
      if (drain && current.state !== "drained") current = turn("drained", drain.seq, drain.finalAssistantSeq as number | null);
    }),
  };
}

describe("provider turn controller driver", () => {
  it("drives a complete turn through ranged final output and terminal acceptance using only controller methods", async () => {
    const rows = [
      final(1),
      event(2, "turn_end", { outcome: "completed" }),
      event(3, "tool_call", { tool: {
        callId: "call-1",
        outcome: "ok",
        summary: { title: "Saved file" },
        changes: [{ path: "a.ts", added: 1, removed: 0 }],
        args: { text: "hidden" },
        result: { text: "hidden" },
      } }),
      event(4, "turn_drained", { inputId, highWaterSeq: 4, finalAssistantSeq: 1 }),
    ];
    const controller = controllerFixture(rows, "abcdefghij");
    const emitted: ProviderTurnOutputEffect[] = [];
    const persisted: ProviderTurnTranslationState[] = [];

    const result = await driveProviderTurn(controller, {
      sessionId,
      inputId,
      generation: 1,
      chunkSize: 4,
      emit: async (effect) => { emitted.push(effect); },
      persist: async (state) => { persisted.push(structuredClone(state)); },
    });

    expect(emitted.map((effect) => effect.kind)).toEqual([
      "tool_call",
      "assistant_chunk",
      "assistant_chunk",
      "assistant_chunk",
      "terminal",
    ]);
    expect(emitted.filter((effect) => effect.kind === "assistant_chunk").map((effect) => effect.text).join("")).toBe("abcdefghij");
    expect(JSON.stringify(emitted)).not.toContain("hidden");
    expect(result.terminal).toMatchObject({ stopReason: "end_turn", seq: 4, turnId, inputId });
    expect(result.state).toMatchObject({ cursor: 4, finalAssistantSeq: 1, finalAssistantEmittedSeq: 1, terminal: "end_turn" });
    expect(persisted.at(-1)).toMatchObject({ cursor: 4, terminal: "end_turn" });
    expect(controller.requireBackgroundWorkDisabled).toHaveBeenCalledTimes(1);
  });

  it("does not persist the drain cursor before a failed final-chunk delivery, so replay safely resumes from the drain", async () => {
    const rows = [
      final(1),
      event(2, "turn_end", { outcome: "completed" }),
      event(3, "turn_drained", { inputId, highWaterSeq: 3, finalAssistantSeq: 1 }),
    ];
    const firstController = controllerFixture(rows, "abcdef");
    const persisted: ProviderTurnTranslationState[] = [];
    await expect(driveProviderTurn(firstController, {
      sessionId,
      inputId,
      generation: 1,
      chunkSize: 3,
      emit: async (effect) => {
        if (effect.kind === "assistant_chunk") throw new Error("downstream unavailable");
      },
      persist: async (state) => { persisted.push(structuredClone(state)); },
    })).rejects.toThrow("downstream unavailable");

    const checkpoint = persisted.at(-1)!;
    expect(checkpoint.cursor).toBe(2);
    expect(checkpoint.drainSeq).toBeUndefined();
    expect(checkpoint.assistantFinals["1"]).toMatchObject({ turnId, final: true });

    const replayController = controllerFixture(rows, "abcdef");
    const replayed: ProviderTurnOutputEffect[] = [];
    const result = await driveProviderTurn(replayController, {
      sessionId,
      inputId,
      generation: 1,
      state: checkpoint,
      chunkSize: 3,
      emit: async (effect) => { replayed.push(effect); },
    });
    expect(replayController.streamEvents.mock.calls[0]?.[1]).toMatchObject({ from: 3 });
    expect(replayed.filter((effect) => effect.kind === "assistant_chunk").map((effect) => effect.text).join("")).toBe("abcdef");
    expect(result.state.terminal).toBe("end_turn");
  });

  it("re-reads cancellation before each event so a concurrent exact Stop maps stopped to cancelled", async () => {
    let current = turn("active", null, null);
    let cancelled = false;
    const rows = [
      event(1, "turn_end", { outcome: "stopped" }),
      event(2, "turn_drained", { inputId, highWaterSeq: 2, finalAssistantSeq: null }),
    ];
    const controller: ProviderTurnController = {
      session: async () => ({ id: sessionId, providerTurn: current }),
      requireBackgroundWorkDisabled: async () => ({ backgroundWork: "disabled", enforced: true }),
      assistantContentChunk: async () => { throw new Error("no assistant content expected"); },
      streamEvents: async function* () {
        cancelled = true;
        yield rows[0]!;
        current = turn("drained", 2, null);
        yield rows[1]!;
      },
    };
    const emitted: ProviderTurnOutputEffect[] = [];

    const result = await driveProviderTurn(controller, {
      sessionId,
      inputId,
      generation: 1,
      cancellationRequested: async () => cancelled,
      emit: async (effect) => { emitted.push(effect); },
    });

    expect(result.terminal).toMatchObject({ stopReason: "cancelled", turnId, inputId });
    expect(result.state.cancelRequested).toBe(true);
    expect(emitted.at(-1)).toMatchObject({ kind: "terminal", stopReason: "cancelled" });
  });

  it("resumes ranged assistant output from an already-persisted drain without waiting for another event", async () => {
    const checkpoint: ProviderTurnTranslationState = {
      sessionId,
      inputId,
      generation: 1,
      cursor: 3,
      turnId,
      turnEndSeq: 2,
      turnOutcome: "completed",
      drainSeq: 3,
      finalAssistantSeq: 1,
      finalAssistantOffset: 3,
      finalAssistantTotalLength: 6,
      cancelRequested: false,
      assistantFinals: { "1": { turnId, final: true } },
    };
    const streamEvents = vi.fn(async function* () {
      yield* [];
      throw new Error("post-drain event stream must not be needed");
    });
    const controller: ProviderTurnController = {
      session: async () => ({ id: sessionId, providerTurn: turn("drained", 3, 1) }),
      requireBackgroundWorkDisabled: async () => ({ backgroundWork: "disabled", enforced: true }),
      assistantContentChunk: async (_session, seq, offset = 0) => ({
        sessionId, seq, field: "assistantText", offset, text: "abcdef".slice(offset), totalLength: 6, complete: true,
      }),
      streamEvents,
    };
    const emitted: ProviderTurnOutputEffect[] = [];

    const result = await driveProviderTurn(controller, {
      sessionId, inputId, generation: 1, state: checkpoint, chunkSize: 3,
      emit: async (effect) => { emitted.push(effect); },
    });

    expect(streamEvents).not.toHaveBeenCalled();
    expect(emitted).toEqual([
      expect.objectContaining({ kind: "assistant_chunk", offset: 3, text: "def", complete: true }),
      expect.objectContaining({ kind: "terminal", stopReason: "end_turn" }),
    ]);
    expect(result.state).toMatchObject({ finalAssistantOffset: 6, finalAssistantEmittedSeq: 1, terminal: "end_turn" });
  });

  it("settles terminal directly when the final assistant was already accepted before a crash", async () => {
    const checkpoint: ProviderTurnTranslationState = {
      sessionId,
      inputId,
      generation: 1,
      cursor: 3,
      turnId,
      turnEndSeq: 2,
      turnOutcome: "completed",
      drainSeq: 3,
      finalAssistantSeq: 1,
      finalAssistantOffset: 6,
      finalAssistantTotalLength: 6,
      finalAssistantEmittedSeq: 1,
      cancelRequested: false,
      assistantFinals: { "1": { turnId, final: true } },
    };
    const streamEvents = vi.fn(async function* () {
      yield* [];
      throw new Error("post-drain event stream must not be needed");
    });
    const controller: ProviderTurnController = {
      session: async () => ({ id: sessionId, providerTurn: turn("drained", 3, 1) }),
      requireBackgroundWorkDisabled: async () => ({ backgroundWork: "disabled", enforced: true }),
      assistantContentChunk: async () => { throw new Error("final content is already accepted"); },
      streamEvents,
    };
    const emitted: ProviderTurnOutputEffect[] = [];
    const result = await driveProviderTurn(controller, {
      sessionId, inputId, generation: 1, state: checkpoint,
      emit: async (effect) => { emitted.push(effect); },
    });

    expect(streamEvents).not.toHaveBeenCalled();
    expect(emitted).toEqual([expect.objectContaining({ kind: "terminal", stopReason: "end_turn" })]);
    expect(result.state.terminal).toBe("end_turn");
  });

  it("re-reads cancellation after async drain attestations before mapping a stopped terminal", async () => {
    let current = turn("active", null, null);
    let cancelled = false;
    const controller: ProviderTurnController = {
      session: async () => ({ id: sessionId, providerTurn: current }),
      requireBackgroundWorkDisabled: async () => {
        cancelled = true;
        await Promise.resolve();
        return { backgroundWork: "disabled", enforced: true };
      },
      assistantContentChunk: async () => { throw new Error("no assistant expected"); },
      streamEvents: async function* () {
        yield event(1, "turn_end", { outcome: "stopped" });
        current = turn("drained", 2, null);
        yield event(2, "turn_drained", { inputId, highWaterSeq: 2, finalAssistantSeq: null });
      },
    };

    const result = await driveProviderTurn(controller, {
      sessionId, inputId, generation: 1,
      cancellationRequested: async () => cancelled,
      emit: async () => undefined,
    });
    expect(result.terminal?.stopReason).toBe("cancelled");
    expect(result.state.cancelRequested).toBe(true);
  });
});
