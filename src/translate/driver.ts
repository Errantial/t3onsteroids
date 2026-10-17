import type {
  CosAssistantContentChunk,
  CosEvent,
  CosProviderSessionPolicyAttestation,
  CosSessionSummary,
} from "../cos/index.js";
import {
  ProviderTurnTranslator,
  newProviderTurnTranslationState,
  type ProviderTurnTranslationState,
  type TranslatorEffect,
} from "./events.js";

export type ProviderTurnOutputEffect = Exclude<TranslatorEffect, { kind: "assistant_final_ready" }>;

export interface ProviderTurnController {
  session(sessionId: string): Promise<CosSessionSummary>;
  requireBackgroundWorkDisabled(sessionId: string): Promise<CosProviderSessionPolicyAttestation>;
  assistantContentChunk(sessionId: string, seq: number, offset?: number, limit?: number): Promise<CosAssistantContentChunk>;
  streamEvents(sessionId: string, options?: { from?: number; signal?: AbortSignal }): AsyncIterable<CosEvent>;
}

export interface DriveProviderTurnOptions {
  readonly sessionId: string;
  readonly inputId: string;
  readonly generation: number;
  readonly state?: ProviderTurnTranslationState;
  readonly cancelRequested?: boolean;
  readonly chunkSize?: number;
  readonly signal?: AbortSignal;
  /** Re-read exact durable cancellation intent before each provider event. */
  readonly cancellationRequested?: () => boolean | Promise<boolean>;
  /** Resolves only once the downstream transport has accepted the effect. */
  readonly emit: (effect: ProviderTurnOutputEffect) => Promise<void>;
  /** Persist the returned snapshot after accepted externally visible work or cursor-only progress. */
  readonly persist?: (state: ProviderTurnTranslationState) => Promise<void>;
}

export interface DriveProviderTurnResult {
  readonly state: ProviderTurnTranslationState;
  readonly terminal: Extract<TranslatorEffect, { kind: "terminal" }> | null;
}

/**
 * Drives one exact provider-owned CoS turn using only the public controller contract.
 *
 * The translator remains transport-agnostic. This coordinator merely establishes the ordering
 * required by any future ACP loop: emit first, acknowledge only after the sink resolves, then
 * persist the new cursor/range/terminal snapshot. A later durable store can make that handoff
 * crash-safe without changing event semantics.
 */
export async function driveProviderTurn(
  controller: ProviderTurnController,
  options: DriveProviderTurnOptions,
): Promise<DriveProviderTurnResult> {
  const initial = options.state ?? newProviderTurnTranslationState({
    sessionId: options.sessionId,
    inputId: options.inputId,
    generation: options.generation,
    ...(options.cancelRequested === undefined ? {} : { cancelRequested: options.cancelRequested }),
  });
  const translator = new ProviderTurnTranslator({
    sessionId: options.sessionId,
    inputId: options.inputId,
    generation: options.generation,
    state: initial,
    ...(options.cancelRequested === undefined ? {} : { cancelRequested: options.cancelRequested }),
    ...(options.chunkSize === undefined ? {} : { chunkSize: options.chunkSize }),
  }, {
    providerTurn: async () => (await controller.session(options.sessionId)).providerTurn,
    requirePolicy: () => controller.requireBackgroundWorkDisabled(options.sessionId),
    assistantContentChunk: (seq, offset, limit) => controller.assistantContentChunk(options.sessionId, seq, offset, limit),
    ...(options.cancellationRequested === undefined ? {} : { cancellationRequested: options.cancellationRequested }),
  });

  const persist = async (): Promise<void> => {
    await options.persist?.(translator.state());
  };
  const refreshCancellation = async (): Promise<void> => {
    if (await options.cancellationRequested?.()) translator.requestCancellation();
  };
  const acceptTerminal = async (
    terminal: Extract<TranslatorEffect, { kind: "terminal" }>,
  ): Promise<DriveProviderTurnResult> => {
    await options.emit(terminal);
    translator.acknowledgeTerminal(terminal);
    await persist();
    return { state: translator.state(), terminal };
  };
  const finishDrainedCheckpoint = async (): Promise<DriveProviderTurnResult | null> => {
    if (translator.state().drainSeq === undefined) return null;
    await refreshCancellation();
    for (;;) {
      const chunk = await translator.nextAssistantChunk();
      if (!chunk) break;
      if (chunk.text.length > 0) await options.emit(chunk);
      const terminal = await translator.acknowledgeAssistantChunk(chunk);
      await persist();
      if (terminal) return acceptTerminal(terminal);
    }
    const terminal = await translator.pendingTerminal();
    return terminal ? acceptTerminal(terminal) : null;
  };

  // A crash may happen after the authoritative drain cursor is persisted but before all ranged
  // assistant output or the terminal response is accepted. Finish that sealed work before asking
  // CoS for events beyond the drain high-water; there may never be another event to wake us up.
  const resumed = await finishDrainedCheckpoint();
  if (resumed) return resumed;

  const from = translator.state().cursor > 0 ? translator.state().cursor + 1 : 0;
  for await (const event of controller.streamEvents(options.sessionId, {
    from,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })) {
    await refreshCancellation();
    const effects = await translator.consume(event);
    if (effects.length === 0) {
      await persist();
      continue;
    }

    for (const effect of effects) {
      if (effect.kind === "assistant_final_ready") {
        for (;;) {
          const chunk = await translator.nextAssistantChunk();
          if (!chunk) break;
          // Empty authoritative final content has no prose to emit, but still advances the
          // accepted range so terminal settlement is not blocked forever.
          if (chunk.text.length > 0) await options.emit(chunk);
          const terminal = await translator.acknowledgeAssistantChunk(chunk);
          await persist();
          if (terminal) return acceptTerminal(terminal);
        }
        continue;
      }
      if (effect.kind === "terminal") return acceptTerminal(effect);
      await options.emit(effect);
      await persist();
    }
  }

  return { state: translator.state(), terminal: null };
}
