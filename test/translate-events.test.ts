import { describe, expect, it, vi } from "vitest";

import type {
  CosAssistantContentChunk,
  CosEvent,
  CosProviderTurnAttestation,
} from "../src/cos/index.js";
import {
  ProviderTurnTranslator,
  TranslationError,
  newProviderTurnTranslationState,
  type ProviderTurnTranslationState,
  type ProviderTurnTranslatorDependencies,
  type TranslatorEffect,
} from "../src/translate/events.js";

const sessionId = "session-1";
const inputId = "11111111-1111-4111-8111-111111111111";
const turnId = "provider-turn-1";

function event(seq: number, kind: string, extra: Record<string, unknown> = {}): CosEvent {
  return {
    seq,
    position: seq,
    time: 1_700_000_000_000 + seq,
    kind,
    source: "extension",
    turnId,
    ...extra,
  };
}

function activeTurn(overrides: Partial<CosProviderTurnAttestation> = {}): CosProviderTurnAttestation {
  return {
    inputId,
    state: "active",
    turnId,
    drainedSeq: null,
    finalAssistantSeq: null,
    ...overrides,
  };
}

function boundState(overrides: Partial<ProviderTurnTranslationState> = {}): ProviderTurnTranslationState {
  return {
    ...newProviderTurnTranslationState({ sessionId, inputId, generation: 1 }),
    turnId,
    ...overrides,
  };
}

function dependencies(options: {
  getTurn?: () => CosProviderTurnAttestation | undefined;
  content?: (seq: number, offset: number, limit: number) => Promise<CosAssistantContentChunk>;
  policy?: () => Promise<{ backgroundWork: "disabled"; enforced: true }>;
} = {}): ProviderTurnTranslatorDependencies & {
  providerTurn: ReturnType<typeof vi.fn>;
  requirePolicy: ReturnType<typeof vi.fn>;
  assistantContentChunk: ReturnType<typeof vi.fn>;
} {
  const getTurn = options.getTurn ?? (() => activeTurn());
  return {
    providerTurn: vi.fn(async () => getTurn()),
    requirePolicy: vi.fn(options.policy ?? (async () => ({ backgroundWork: "disabled" as const, enforced: true as const }))),
    assistantContentChunk: vi.fn(options.content ?? (async (seq, offset) => ({
      sessionId,
      seq,
      field: "assistantText" as const,
      offset,
      text: "",
      totalLength: offset,
      complete: true,
    }))),
  };
}

function finalEvent(seq: number, text: string): CosEvent {
  return event(seq, "assistant_message", {
    final: true,
    messageId: `assistant-${seq}`,
    message: { text, truncated: false, chars: text.length },
  });
}

function drainEvent(seq: number, finalAssistantSeq: number | null, overrides: Record<string, unknown> = {}): CosEvent {
  return event(seq, "turn_drained", {
    inputId,
    highWaterSeq: seq,
    finalAssistantSeq,
    ...overrides,
  });
}

async function collectFinal(
  translator: ProviderTurnTranslator,
): Promise<{ chunks: Extract<TranslatorEffect, { kind: "assistant_chunk" }>[]; terminal: Extract<TranslatorEffect, { kind: "terminal" }> | null }> {
  const chunks: Extract<TranslatorEffect, { kind: "assistant_chunk" }>[] = [];
  let terminal: Extract<TranslatorEffect, { kind: "terminal" }> | null = null;
  for (;;) {
    const chunk = await translator.nextAssistantChunk();
    if (!chunk) break;
    chunks.push(chunk);
    terminal = await translator.acknowledgeAssistantChunk(chunk);
    if (terminal) {
      translator.acknowledgeTerminal(terminal);
      break;
    }
  }
  return { chunks, terminal };
}

describe("provider turn event translation", () => {
  it("accepts a follow-up user_message correlation turn id while binding the attested native turn", async () => {
    const deps = dependencies();
    const translator = new ProviderTurnTranslator({ sessionId, inputId, generation: 2 }, deps);

    expect(await translator.consume(event(9, "user_message", {
      inputId,
      turnId: "e73199f5-c969-4f8e-bace-c2f9051f4d5e",
      inputDelivery: "confirmed",
    }))).toEqual([]);
    expect(translator.state()).toMatchObject({ cursor: 9, turnId });

    expect(await translator.consume(event(10, "turn_start", { turnId }))).toEqual([]);
    expect(translator.state()).toMatchObject({ cursor: 10, turnId });
    expect(deps.providerTurn).toHaveBeenCalled();
  });

  it("emits no assistant prose before drain and retrieves only corrected final B named by finalAssistantSeq", async () => {
    let turn = activeTurn();
    const full = "Corrected final B — complete.";
    const deps = dependencies({
      getTurn: () => turn,
      content: async (seq, offset, limit) => {
        expect(seq).toBe(4);
        const text = full.slice(offset, offset + limit);
        return { sessionId, seq, field: "assistantText", offset, text, totalLength: full.length, complete: offset + text.length === full.length };
      },
    });
    const translator = new ProviderTurnTranslator({ sessionId, inputId, generation: 1, chunkSize: 8 }, deps);

    expect(await translator.consume(event(1, "user_message", { inputId, inputDelivery: "confirmed" }))).toEqual([]);
    expect(await translator.consume(finalEvent(2, "Final A that will be corrected"))).toEqual([]);
    expect(await translator.consume(event(3, "turn_end", { outcome: "completed" }))).toEqual([]);
    expect(await translator.consume(finalEvent(4, "Corrected final B"))).toEqual([]);
    expect(deps.assistantContentChunk).not.toHaveBeenCalled();

    turn = activeTurn({ state: "drained", drainedSeq: 5, finalAssistantSeq: 4 });
    await expect(translator.consume(drainEvent(5, 4))).resolves.toEqual([
      { kind: "assistant_final_ready", seq: 4, turnId },
    ]);
    expect(deps.requirePolicy).not.toHaveBeenCalled();

    const { chunks, terminal } = await collectFinal(translator);
    expect(chunks.map((chunk) => chunk.text).join("")).toBe(full);
    expect(deps.assistantContentChunk.mock.calls.every((call) => call[0] === 4)).toBe(true);
    expect(terminal).toEqual({ kind: "terminal", seq: 5, turnId, inputId, stopReason: "end_turn" });
    expect(deps.requirePolicy).toHaveBeenCalledTimes(1);
    expect(translator.state()).toMatchObject({ finalAssistantSeq: 4, finalAssistantEmittedSeq: 4, terminal: "end_turn" });
  });

  it("reads only the authoritative final after revision-heavy >4k output, in bounded post-drain ranges", async () => {
    let turn = activeTurn();
    const chunkSize = 1024;
    const full = `authoritative-final:${"0123456789abcdef".repeat(512)}`;
    const requested: { seq: number; offset: number; limit: number }[] = [];
    const deps = dependencies({
      getTurn: () => turn,
      content: async (seq, offset, limit) => {
        requested.push({ seq, offset, limit });
        const text = full.slice(offset, offset + limit);
        return {
          sessionId,
          seq,
          field: "assistantText",
          offset,
          text,
          totalLength: full.length,
          complete: offset + text.length === full.length,
        };
      },
    });
    const translator = new ProviderTurnTranslator({ sessionId, inputId, generation: 1, chunkSize }, deps);

    for (let seq = 1; seq <= 8; seq += 1) {
      const text = `revision-${seq}:${"r".repeat(seq * 257)}`;
      await expect(translator.consume(event(seq, "assistant_message", {
        final: false,
        messageId: `revision-${seq}`,
        message: { text, truncated: false, chars: text.length },
      }))).resolves.toEqual([]);
    }
    await expect(translator.consume(finalEvent(9, "Final A compact snapshot"))).resolves.toEqual([]);
    await expect(translator.consume(event(10, "turn_end", { outcome: "completed" }))).resolves.toEqual([]);
    await expect(translator.consume(event(11, "assistant_message", {
      final: true,
      messageId: "assistant-11",
      message: { text: full.slice(0, 4_096), truncated: true, chars: full.length },
    }))).resolves.toEqual([]);
    expect(full.length).toBeGreaterThan(4_096);
    expect(deps.assistantContentChunk).not.toHaveBeenCalled();

    turn = activeTurn({ state: "drained", drainedSeq: 12, finalAssistantSeq: 11 });
    await expect(translator.consume(drainEvent(12, 11))).resolves.toEqual([
      { kind: "assistant_final_ready", seq: 11, turnId },
    ]);
    expect(deps.assistantContentChunk).not.toHaveBeenCalled();

    const { chunks, terminal } = await collectFinal(translator);
    expect(chunks.map((chunk) => chunk.text).join("")).toBe(full);
    expect(terminal).toEqual({ kind: "terminal", seq: 12, turnId, inputId, stopReason: "end_turn" });
    expect(requested).toEqual(Array.from({ length: Math.ceil(full.length / chunkSize) }, (_, index) => ({
      seq: 11,
      offset: index * chunkSize,
      limit: chunkSize,
    })));
    expect(requested.every((request) => request.seq === 11 && request.limit <= chunkSize)).toBe(true);
  });

  it("persists acknowledged assistant range progress and resumes without duplicating accepted chunks", async () => {
    const full = "abcdefghij";
    const offsets: number[] = [];
    let turn = activeTurn();
    const deps = dependencies({
      getTurn: () => turn,
      content: async (seq, offset, limit) => {
        offsets.push(offset);
        const text = full.slice(offset, offset + limit);
        return { sessionId, seq, field: "assistantText", offset, text, totalLength: full.length, complete: offset + text.length === full.length };
      },
    });
    const first = new ProviderTurnTranslator({ sessionId, inputId, generation: 1, state: boundState(), chunkSize: 4 }, deps);
    await first.consume(finalEvent(1, "snapshot"));
    await first.consume(event(2, "turn_end", { outcome: "completed" }));
    turn = activeTurn({ state: "drained", drainedSeq: 3, finalAssistantSeq: 1 });
    await first.consume(drainEvent(3, 1));

    const firstChunk = await first.nextAssistantChunk();
    expect(firstChunk).toMatchObject({ offset: 0, text: "abcd", complete: false });
    await first.acknowledgeAssistantChunk(firstChunk!);
    const persisted = first.state();
    expect(persisted.finalAssistantOffset).toBe(4);

    const resumed = new ProviderTurnTranslator({ sessionId, inputId, generation: 1, state: persisted, chunkSize: 4 }, deps);
    const result = await collectFinal(resumed);
    expect(result.chunks.map((chunk) => chunk.text).join("")).toBe("efghij");
    expect(offsets).toEqual([0, 4, 8]);
    expect(result.terminal?.stopReason).toBe("end_turn");
  });

  it("advances UTF-16 ranges by returned text.length without splitting non-BMP content", async () => {
    const face = String.fromCodePoint(0x1f600);
    const full = `A${face}B`;
    const offsets: number[] = [];
    let turn = activeTurn();
    const deps = dependencies({
      getTurn: () => turn,
      content: async (seq, offset) => {
        offsets.push(offset);
        const pieces = new Map<number, string>([[0, "A"], [1, face], [3, "B"]]);
        const text = pieces.get(offset) ?? "";
        return { sessionId, seq, field: "assistantText", offset, text, totalLength: full.length, complete: offset + text.length === full.length };
      },
    });
    const translator = new ProviderTurnTranslator({ sessionId, inputId, generation: 1, state: boundState(), chunkSize: 2 }, deps);
    await translator.consume(finalEvent(1, full));
    await translator.consume(event(2, "turn_end", { outcome: "completed" }));
    turn = activeTurn({ state: "drained", drainedSeq: 3, finalAssistantSeq: 1 });
    await translator.consume(drainEvent(3, 1));
    const result = await collectFinal(translator);
    expect(result.chunks.map((chunk) => chunk.text).join("")).toBe(full);
    expect(offsets).toEqual([0, 1, 3]);
  });

  it("projects late tool and page activity before terminal without raw tool bodies", async () => {
    let turn = activeTurn();
    const deps = dependencies({ getTurn: () => turn });
    const translator = new ProviderTurnTranslator({ sessionId, inputId, generation: 1, state: boundState() }, deps);

    await translator.consume(event(1, "turn_end", { outcome: "completed" }));
    const tool = await translator.consume(event(2, "tool_call", {
      tool: {
        callId: "call-1",
        name: "exec_command",
        outcome: "ok",
        durationMs: 12,
        attribution: "request_id",
        summary: { title: "Edited fixture", detail: "safe", metric: "+1", tone: "neutral", kind: "write" },
        args: { text: "SECRET RAW ARG", truncated: false, chars: 14 },
        result: { text: "SECRET RAW RESULT", truncated: false, chars: 17 },
        changes: [{ path: "src/a.ts", added: 1, removed: 0 }],
      },
    }));
    const page = await translator.consume(event(3, "page_tool", { label: "Clicked Save" }));
    expect(tool).toEqual([{
      kind: "tool_call",
      seq: 2,
      id: "call-1",
      title: "Edited fixture",
      outcome: "ok",
      changes: [{ path: "src/a.ts", added: 1, removed: 0 }],
    }]);
    expect(JSON.stringify(tool)).not.toContain("SECRET RAW");
    expect(page).toEqual([{ kind: "page_tool", seq: 3, id: "cos-event:3", title: "Clicked Save" }]);

    turn = activeTurn({ state: "drained", drainedSeq: 4, finalAssistantSeq: null });
    await expect(translator.consume(drainEvent(4, null))).resolves.toEqual([
      { kind: "terminal", seq: 4, turnId, inputId, stopReason: "end_turn" },
    ]);
  });

  it("surfaces provider errors as structured activity without settling the turn", async () => {
    let turn = activeTurn();
    const deps = dependencies({ getTurn: () => turn });
    const translator = new ProviderTurnTranslator({ sessionId, inputId, generation: 1, state: boundState() }, deps);

    await expect(translator.consume(event(1, "chat_error", {
      message: { text: "Temporary provider transport error", truncated: false, chars: 34 },
      recoverable: true,
      blocking: false,
    }))).resolves.toEqual([{
      kind: "provider_error",
      seq: 1,
      text: "Temporary provider transport error",
      recoverable: true,
      blocking: false,
    }]);
    expect(translator.state()).toMatchObject({ sessionId, inputId, generation: 1, turnId, cursor: 1 });
    expect(translator.state()).not.toHaveProperty("terminal");
    expect(deps.requirePolicy).not.toHaveBeenCalled();

    await expect(translator.consume(event(2, "turn_end", { outcome: "completed" }))).resolves.toEqual([]);
    turn = activeTurn({ state: "drained", drainedSeq: 3, finalAssistantSeq: null });
    await expect(translator.consume(drainEvent(3, null))).resolves.toEqual([
      { kind: "terminal", seq: 3, turnId, inputId, stopReason: "end_turn" },
    ]);
  });

  it("keeps the same session and provider turn identity across a compaction handoff", async () => {
    let turn = activeTurn();
    const deps = dependencies({ getTurn: () => turn });
    const translator = new ProviderTurnTranslator({ sessionId, inputId, generation: 1, state: boundState() }, deps);

    await expect(translator.consume(event(1, "handoff", {
      handoffId: "handoff-manual-1",
      chars: 12_345,
      reason: "manual",
      continuation: "continuation-1",
    }))).resolves.toEqual([{ kind: "activity", seq: 1, category: "handoff" }]);
    expect(translator.state()).toMatchObject({ sessionId, inputId, generation: 1, turnId, cursor: 1 });

    await expect(translator.consume(event(2, "turn_end", { outcome: "completed" }))).resolves.toEqual([]);
    turn = activeTurn({ state: "drained", drainedSeq: 3, finalAssistantSeq: null });
    const [terminal] = await translator.consume(drainEvent(3, null));
    expect(terminal).toEqual({ kind: "terminal", seq: 3, turnId, inputId, stopReason: "end_turn" });
    expect(translator.state()).toMatchObject({ sessionId, inputId, generation: 1, turnId, cursor: 3, drainSeq: 3 });
  });

  it("deduplicates replayed sequence rows and refuses malformed drain identities", async () => {
    const deps = dependencies();
    const translator = new ProviderTurnTranslator({ sessionId, inputId, generation: 1, state: boundState() }, deps);
    const row = event(1, "note", { message: { text: "once" } });
    expect(await translator.consume(row)).toHaveLength(1);
    expect(await translator.consume(row)).toEqual([]);
    await translator.consume(event(2, "turn_end", { outcome: "completed" }));
    await expect(translator.consume(drainEvent(3, null, { highWaterSeq: 2 }))).rejects.toMatchObject({ code: "drain_mismatch" });
  });

  it("fails closed when finalAssistantSeq does not name an observed same-turn final", async () => {
    let turn = activeTurn();
    const deps = dependencies({ getTurn: () => turn });
    const translator = new ProviderTurnTranslator({ sessionId, inputId, generation: 1, state: boundState() }, deps);
    await translator.consume(event(1, "turn_end", { outcome: "completed" }));
    turn = activeTurn({ state: "drained", drainedSeq: 3, finalAssistantSeq: 2 });
    await expect(translator.consume(drainEvent(3, 2))).rejects.toMatchObject({ code: "final_assistant_invalid" });
  });

  it("quarantines provider-visible activity after a committed high-water", async () => {
    let turn = activeTurn();
    const deps = dependencies({ getTurn: () => turn });
    const translator = new ProviderTurnTranslator({ sessionId, inputId, generation: 1, state: boundState() }, deps);
    await translator.consume(event(1, "turn_end", { outcome: "completed" }));
    turn = activeTurn({ state: "drained", drainedSeq: 2, finalAssistantSeq: null });
    await translator.consume(drainEvent(2, null));
    await expect(translator.consume(event(3, "page_tool", { label: "Too late" }))).rejects.toMatchObject({ code: "post_drain_activity" });
  });

  it("treats worker-attributed activity as a provider policy violation", async () => {
    const deps = dependencies();
    const translator = new ProviderTurnTranslator({ sessionId, inputId, generation: 1, state: boundState() }, deps);
    await expect(translator.consume(event(1, "tool_call", { agent: "worker-1", tool: {} }))).rejects.toMatchObject({ code: "provider_policy_violation" });
  });

  it("waits for drain before mapping authoritative active cancellation to cancelled", async () => {
    let turn = activeTurn();
    const deps = dependencies({ getTurn: () => turn });
    const translator = new ProviderTurnTranslator({ sessionId, inputId, generation: 1, state: boundState({ cancelRequested: true }) }, deps);
    expect(await translator.consume(event(1, "turn_end", { outcome: "stopped" }))).toEqual([]);
    expect(deps.requirePolicy).not.toHaveBeenCalled();
    turn = activeTurn({ state: "drained", drainedSeq: 2, finalAssistantSeq: null });
    await expect(translator.consume(drainEvent(2, null))).resolves.toEqual([
      { kind: "terminal", seq: 2, turnId, inputId, stopReason: "cancelled" },
    ]);
  });

  it.each(["stopped", "failed", "interrupted", "refusal"])("never invents an ACP terminal stop reason from provider outcome %s", async (outcome) => {
    let turn = activeTurn();
    const deps = dependencies({ getTurn: () => turn });
    const translator = new ProviderTurnTranslator({ sessionId, inputId, generation: 1, state: boundState() }, deps);
    await translator.consume(event(1, "turn_end", { outcome }));
    turn = activeTurn({ state: "drained", drainedSeq: 2, finalAssistantSeq: null });
    await expect(translator.consume(drainEvent(2, null))).rejects.toMatchObject({ code: "provider_terminal_failure" });
  });

  it("fails terminal settlement if the fresh background-work policy attestation is lost", async () => {
    let turn = activeTurn();
    const deps = dependencies({
      getTurn: () => turn,
      policy: async () => { throw new Error("lost policy"); },
    });
    const translator = new ProviderTurnTranslator({ sessionId, inputId, generation: 1, state: boundState() }, deps);
    await translator.consume(event(1, "turn_end", { outcome: "completed" }));
    turn = activeTurn({ state: "drained", drainedSeq: 2, finalAssistantSeq: null });
    await expect(translator.consume(drainEvent(2, null))).rejects.toMatchObject({ code: "provider_policy_violation" });
  });

  it("rejects persisted translator state from another generation before consuming events", () => {
    const deps = dependencies();
    expect(() => new ProviderTurnTranslator({
      sessionId,
      inputId,
      generation: 2,
      state: boundState({ generation: 1 }),
    }, deps)).toThrowError(TranslationError);
  });
});
