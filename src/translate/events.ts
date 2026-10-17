import type {
  CosAssistantContentChunk,
  CosEvent,
  CosProviderSessionPolicyAttestation,
  CosProviderTurnAttestation,
} from "../cos/index.js";

export type StableTerminalStopReason = "end_turn" | "cancelled" | "refusal";

export type TranslationErrorCode =
  | "provider_turn_mismatch"
  | "provider_turn_broken"
  | "drain_mismatch"
  | "final_assistant_invalid"
  | "assistant_range_mismatch"
  | "post_drain_activity"
  | "provider_policy_violation"
  | "provider_terminal_failure"
  | "schema_mismatch";

export class TranslationError extends Error {
  constructor(readonly code: TranslationErrorCode, message: string) {
    super(message);
    this.name = "TranslationError";
  }
}

export interface StoredAssistantFinalIdentity {
  readonly turnId: string;
  readonly final: true;
}

export interface ProviderTurnTranslationState {
  readonly sessionId: string;
  readonly inputId: string;
  readonly generation: number;
  readonly cursor: number;
  readonly turnId?: string;
  readonly turnEndSeq?: number;
  readonly turnOutcome?: string;
  readonly drainSeq?: number;
  readonly finalAssistantSeq?: number | null;
  readonly finalAssistantOffset?: number;
  readonly finalAssistantTotalLength?: number;
  readonly finalAssistantEmittedSeq?: number;
  readonly terminal?: StableTerminalStopReason;
  readonly cancelRequested?: boolean;
  readonly assistantFinals: Readonly<Record<string, StoredAssistantFinalIdentity>>;
}

export type TranslatorEffect =
  | {
      readonly kind: "tool_call";
      readonly seq: number;
      readonly id: string;
      readonly title: string;
      readonly outcome: string;
      readonly changes: readonly { readonly path: string; readonly added: number; readonly removed: number }[];
    }
  | { readonly kind: "page_tool"; readonly seq: number; readonly id: string; readonly title: string }
  | { readonly kind: "activity"; readonly seq: number; readonly category: "progress" | "note" | "native_image" | "handoff"; readonly text?: string }
  | { readonly kind: "provider_error"; readonly seq: number; readonly text?: string; readonly recoverable: boolean; readonly blocking: boolean }
  | { readonly kind: "assistant_final_ready"; readonly seq: number; readonly turnId: string }
  | {
      readonly kind: "assistant_chunk";
      readonly seq: number;
      readonly turnId: string;
      readonly offset: number;
      readonly text: string;
      readonly totalLength: number;
      readonly complete: boolean;
    }
  | { readonly kind: "terminal"; readonly seq: number; readonly turnId: string; readonly inputId: string; readonly stopReason: StableTerminalStopReason };

export interface ProviderTurnTranslatorDependencies {
  readonly providerTurn: () => Promise<CosProviderTurnAttestation | undefined>;
  readonly requirePolicy: () => Promise<CosProviderSessionPolicyAttestation>;
  readonly assistantContentChunk: (seq: number, offset: number, limit: number) => Promise<CosAssistantContentChunk>;
  readonly cancellationRequested?: () => boolean | Promise<boolean>;
}

export interface ProviderTurnTranslatorOptions {
  readonly sessionId: string;
  readonly inputId: string;
  readonly generation: number;
  readonly state?: ProviderTurnTranslationState;
  readonly cancelRequested?: boolean;
  readonly chunkSize?: number;
}

const providerVisibleKinds = new Set([
  "assistant_message",
  "native_image",
  "progress",
  "page_tool",
  "turn_start",
  "turn_end",
  "turn_drained",
  "chat_error",
  "tool_call",
  "note",
  "agent_message",
  "handoff",
]);

function textOf(event: CosEvent): string | undefined {
  const message = event.message;
  if (!message || typeof message !== "object" || Array.isArray(message)) return undefined;
  const text = (message as Record<string, unknown>).text;
  return typeof text === "string" ? text : undefined;
}

function stringField(event: CosEvent, name: string): string | undefined {
  const value = event[name];
  return typeof value === "string" ? value : undefined;
}

function booleanField(event: CosEvent, name: string): boolean | undefined {
  const value = event[name];
  return typeof value === "boolean" ? value : undefined;
}

function integerField(event: CosEvent, name: string): number | undefined {
  const value = event[name];
  return Number.isSafeInteger(value) ? (value as number) : undefined;
}

function nullableIntegerField(event: CosEvent, name: string): number | null | undefined {
  const value = event[name];
  if (value === null) return null;
  return Number.isSafeInteger(value) ? (value as number) : undefined;
}

function toolEffect(event: CosEvent): Extract<TranslatorEffect, { kind: "tool_call" }> {
  const tool = event.tool;
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) throw new TranslationError("schema_mismatch", "tool_call.tool must be an object");
  const row = tool as Record<string, unknown>;
  const callId = typeof row.callId === "string" ? row.callId : undefined;
  const outcome = typeof row.outcome === "string" ? row.outcome : undefined;
  const summary = row.summary && typeof row.summary === "object" && !Array.isArray(row.summary) ? row.summary as Record<string, unknown> : undefined;
  const title = summary && typeof summary.title === "string" ? summary.title : undefined;
  if (!callId || !outcome || !title) throw new TranslationError("schema_mismatch", "tool_call safe projection is incomplete");
  const changes = Array.isArray(row.changes)
    ? row.changes.map((change) => {
        if (!change || typeof change !== "object" || Array.isArray(change)) throw new TranslationError("schema_mismatch", "tool_call change must be an object");
        const item = change as Record<string, unknown>;
        if (typeof item.path !== "string" || !Number.isFinite(item.added) || !Number.isFinite(item.removed)) {
          throw new TranslationError("schema_mismatch", "tool_call change projection is invalid");
        }
        return { path: item.path, added: Number(item.added), removed: Number(item.removed) };
      })
    : [];
  return { kind: "tool_call", seq: event.seq, id: callId, title, outcome, changes };
}

function terminalStopReason(outcome: string, cancelRequested: boolean): StableTerminalStopReason {
  if (outcome === "completed") return "end_turn";
  if (outcome === "stopped" && cancelRequested) return "cancelled";
  throw new TranslationError("provider_terminal_failure", `Provider turn ended as ${outcome}; no stable ACP stop reason may be invented`);
}

export function newProviderTurnTranslationState(options: Pick<ProviderTurnTranslatorOptions, "sessionId" | "inputId" | "generation" | "cancelRequested">): ProviderTurnTranslationState {
  return {
    sessionId: options.sessionId,
    inputId: options.inputId,
    generation: options.generation,
    cursor: 0,
    cancelRequested: options.cancelRequested === true,
    assistantFinals: {},
  };
}

export class ProviderTurnTranslator {
  private stateValue: ProviderTurnTranslationState;
  private readonly chunkSize: number;

  constructor(
    options: ProviderTurnTranslatorOptions,
    private readonly dependencies: ProviderTurnTranslatorDependencies,
  ) {
    this.stateValue = options.state ?? newProviderTurnTranslationState(options);
    if (this.stateValue.sessionId !== options.sessionId || this.stateValue.inputId !== options.inputId || this.stateValue.generation !== options.generation) {
      throw new TranslationError("provider_turn_mismatch", "Persisted translator state does not belong to this provider turn generation");
    }
    this.chunkSize = options.chunkSize ?? 16_384;
    if (!Number.isInteger(this.chunkSize) || this.chunkSize < 2 || this.chunkSize > 65_536) {
      throw new TranslationError("schema_mismatch", "Assistant chunk size must be between 2 and 65536 UTF-16 code units");
    }
    if (options.cancelRequested && !this.stateValue.cancelRequested) this.stateValue = { ...this.stateValue, cancelRequested: true };
  }

  state(): ProviderTurnTranslationState {
    return {
      ...this.stateValue,
      assistantFinals: { ...this.stateValue.assistantFinals },
    };
  }

  requestCancellation(): void {
    if (!this.stateValue.cancelRequested) this.stateValue = { ...this.stateValue, cancelRequested: true };
  }

  /** Re-evaluate terminal settlement for a previously consumed authoritative drain. */
  async pendingTerminal(): Promise<Extract<TranslatorEffect, { kind: "terminal" }> | null> {
    return this.terminalIfReady();
  }

  private fail(code: TranslationErrorCode, message: string): never {
    throw new TranslationError(code, message);
  }

  private async exactProviderTurn(): Promise<CosProviderTurnAttestation> {
    const turn = await this.dependencies.providerTurn();
    if (!turn || turn.inputId !== this.stateValue.inputId) this.fail("provider_turn_mismatch", "CoS provider-turn attestation no longer names this input");
    if (turn.state === "broken") this.fail("provider_turn_broken", "CoS marked this provider turn broken");
    if (turn.state === "not_sent") this.fail("provider_turn_mismatch", "Delivered provider turn became not_sent");
    if (turn.turnId) {
      if (this.stateValue.turnId && this.stateValue.turnId !== turn.turnId) this.fail("provider_turn_mismatch", "CoS provider turn id changed");
      if (!this.stateValue.turnId) this.stateValue = { ...this.stateValue, turnId: turn.turnId };
    }
    return turn;
  }

  private async eventBelongsToProviderTurn(event: CosEvent): Promise<boolean> {
    if (!event.turnId) return false;
    if (this.stateValue.turnId) return event.turnId === this.stateValue.turnId;
    const attested = await this.exactProviderTurn();
    return attested.turnId !== null && event.turnId === attested.turnId;
  }

  private sameSealedTurn(event: CosEvent): boolean {
    return Boolean(this.stateValue.drainSeq && this.stateValue.turnId && event.turnId === this.stateValue.turnId);
  }

  private async terminalIfReady(): Promise<Extract<TranslatorEffect, { kind: "terminal" }> | null> {
    if (this.stateValue.terminal) return null;
    const { drainSeq, turnEndSeq, turnOutcome, turnId, finalAssistantSeq, finalAssistantEmittedSeq } = this.stateValue;
    if (!drainSeq || !turnEndSeq || !turnOutcome || !turnId) return null;
    if (finalAssistantSeq !== null && finalAssistantSeq !== undefined && finalAssistantEmittedSeq !== finalAssistantSeq) return null;
    const attested = await this.exactProviderTurn();
    if (attested.state !== "drained" || attested.drainedSeq !== drainSeq ||
        attested.turnId !== turnId || attested.finalAssistantSeq !== (finalAssistantSeq ?? null)) {
      this.fail("drain_mismatch", "Fresh CoS provider-turn attestation does not match the consumed drain marker");
    }
    try {
      await this.dependencies.requirePolicy();
    } catch {
      this.fail("provider_policy_violation", "Fresh backgroundWork=disabled attestation failed before terminal settlement");
    }
    // Re-read exact durable cancel intent after all asynchronous terminal attestations. A cancel
    // can be persisted while provider-turn/policy reads are in flight; terminal mapping must see
    // that intent before interpreting a stopped turn.
    if (await this.dependencies.cancellationRequested?.()) this.requestCancellation();
    const stopReason = terminalStopReason(turnOutcome, this.stateValue.cancelRequested === true);
    return {
      kind: "terminal",
      seq: drainSeq,
      turnId,
      inputId: this.stateValue.inputId,
      stopReason,
    };
  }

  acknowledgeTerminal(effect: Extract<TranslatorEffect, { kind: "terminal" }>): void {
    if (this.stateValue.terminal) {
      if (this.stateValue.terminal !== effect.stopReason) {
        this.fail("provider_terminal_failure", "Terminal acknowledgement conflicts with the settled stop reason");
      }
      return;
    }
    if (!this.stateValue.drainSeq || !this.stateValue.turnId ||
        effect.seq !== this.stateValue.drainSeq || effect.turnId !== this.stateValue.turnId ||
        effect.inputId !== this.stateValue.inputId) {
      this.fail("provider_terminal_failure", "Terminal acknowledgement does not match the drained provider turn");
    }
    const expected = terminalStopReason(this.stateValue.turnOutcome ?? "", this.stateValue.cancelRequested === true);
    if (effect.stopReason !== expected) {
      this.fail("provider_terminal_failure", "Terminal acknowledgement stop reason is invalid");
    }
    this.stateValue = { ...this.stateValue, terminal: effect.stopReason };
  }

  async consume(event: CosEvent): Promise<readonly TranslatorEffect[]> {
    if (!Number.isSafeInteger(event.seq) || event.seq < 1) this.fail("schema_mismatch", "CoS event sequence must be a positive integer");
    if (event.seq <= this.stateValue.cursor) return [];
    if (this.stateValue.drainSeq && this.sameSealedTurn(event) && event.seq > this.stateValue.drainSeq && providerVisibleKinds.has(event.kind)) {
      this.fail("post_drain_activity", `Provider-visible ${event.kind} arrived after the authoritative drain high-water`);
    }

    if (event.agent && await this.eventBelongsToProviderTurn(event)) {
      this.fail("provider_policy_violation", "Provider session emitted worker-attributed activity despite backgroundWork=disabled");
    }

    const effects: TranslatorEffect[] = [];
    switch (event.kind) {
      case "session_start":
        break;
      case "user_message": {
        if (stringField(event, "inputId") === this.stateValue.inputId) {
          const turn = await this.exactProviderTurn();
          if (event.turnId && turn.turnId && event.turnId !== turn.turnId) this.fail("provider_turn_mismatch", "Provider input delivery row names a different turn");
        }
        break;
      }
      case "turn_start":
        if (await this.eventBelongsToProviderTurn(event)) {
          // Exact provider-turn binding is owned by CoS; the translator only mirrors the attested id.
        }
        break;
      case "assistant_message": {
        if (booleanField(event, "final") === true && await this.eventBelongsToProviderTurn(event)) {
          const turnId = this.stateValue.turnId;
          if (!turnId) this.fail("provider_turn_mismatch", "Final assistant row lacks an exact provider turn");
          this.stateValue = {
            ...this.stateValue,
            assistantFinals: {
              ...this.stateValue.assistantFinals,
              [String(event.seq)]: { turnId, final: true },
            },
          };
        }
        break;
      }
      case "tool_call":
        if (await this.eventBelongsToProviderTurn(event)) effects.push(toolEffect(event));
        break;
      case "page_tool":
        if (await this.eventBelongsToProviderTurn(event)) {
          const label = stringField(event, "label");
          if (!label) this.fail("schema_mismatch", "page_tool label is missing");
          effects.push({ kind: "page_tool", seq: event.seq, id: `cos-event:${event.seq}`, title: label });
        }
        break;
      case "progress":
      case "note": {
        if (await this.eventBelongsToProviderTurn(event)) {
          const text = textOf(event);
          effects.push({ kind: "activity", seq: event.seq, category: event.kind, ...(text === undefined ? {} : { text }) });
        }
        break;
      }
      case "native_image":
        if (await this.eventBelongsToProviderTurn(event)) effects.push({ kind: "activity", seq: event.seq, category: "native_image" });
        break;
      case "handoff":
        if (await this.eventBelongsToProviderTurn(event)) effects.push({ kind: "activity", seq: event.seq, category: "handoff" });
        break;
      case "agent_message":
        if (await this.eventBelongsToProviderTurn(event)) this.fail("provider_policy_violation", "Provider session emitted agent_message despite backgroundWork=disabled");
        break;
      case "chat_error":
        if (await this.eventBelongsToProviderTurn(event)) {
          const text = textOf(event);
          effects.push({
            kind: "provider_error",
            seq: event.seq,
            ...(text === undefined ? {} : { text }),
            recoverable: booleanField(event, "recoverable") === true,
            blocking: booleanField(event, "blocking") === true,
          });
        }
        break;
      case "turn_end":
        if (await this.eventBelongsToProviderTurn(event)) {
          const outcome = stringField(event, "outcome");
          if (!outcome) this.fail("schema_mismatch", "turn_end outcome is missing");
          if (this.stateValue.turnEndSeq && (this.stateValue.turnEndSeq !== event.seq || this.stateValue.turnOutcome !== outcome)) {
            this.fail("provider_turn_mismatch", "Provider turn produced conflicting terminal evidence");
          }
          this.stateValue = { ...this.stateValue, turnEndSeq: event.seq, turnOutcome: outcome };
        }
        break;
      case "turn_drained": {
        const inputId = stringField(event, "inputId");
        const highWaterSeq = integerField(event, "highWaterSeq");
        const finalAssistantSeq = nullableIntegerField(event, "finalAssistantSeq");
        if (!event.turnId || inputId !== this.stateValue.inputId || highWaterSeq !== event.seq || finalAssistantSeq === undefined) {
          this.fail("drain_mismatch", "turn_drained identity or high-water is invalid");
        }
        const attested = await this.exactProviderTurn();
        if (attested.turnId !== event.turnId || attested.state !== "drained" || attested.drainedSeq !== event.seq || attested.finalAssistantSeq !== finalAssistantSeq) {
          this.fail("drain_mismatch", "turn_drained does not match fresh provider-turn attestation");
        }
        if (!this.stateValue.turnEndSeq || !this.stateValue.turnOutcome || this.stateValue.turnId !== event.turnId || this.stateValue.turnEndSeq >= event.seq) {
          this.fail("drain_mismatch", "turn_drained arrived without matching earlier turn_end");
        }
        if (finalAssistantSeq !== null) {
          if (finalAssistantSeq >= event.seq) this.fail("final_assistant_invalid", "finalAssistantSeq must precede the drain marker");
          const final = this.stateValue.assistantFinals[String(finalAssistantSeq)];
          if (!final || final.turnId !== event.turnId || final.final !== true) {
            this.fail("final_assistant_invalid", "finalAssistantSeq does not name an observed same-turn final assistant row");
          }
        }
        const sameFinal = this.stateValue.finalAssistantSeq === finalAssistantSeq;
        const {
          finalAssistantTotalLength: oldFinalAssistantTotalLength,
          finalAssistantEmittedSeq: oldFinalAssistantEmittedSeq,
          ...baseState
        } = this.stateValue;
        this.stateValue = {
          ...baseState,
          drainSeq: event.seq,
          finalAssistantSeq,
          finalAssistantOffset: sameFinal ? this.stateValue.finalAssistantOffset ?? 0 : 0,
          ...(sameFinal && oldFinalAssistantTotalLength !== undefined
            ? { finalAssistantTotalLength: oldFinalAssistantTotalLength }
            : {}),
          ...(sameFinal && oldFinalAssistantEmittedSeq !== undefined
            ? { finalAssistantEmittedSeq: oldFinalAssistantEmittedSeq }
            : {}),
        };
        if (finalAssistantSeq !== null && this.stateValue.finalAssistantEmittedSeq !== finalAssistantSeq) {
          effects.push({ kind: "assistant_final_ready", seq: finalAssistantSeq, turnId: event.turnId });
        }
        break;
      }
      default:
        this.fail("schema_mismatch", `Unsupported CoS event kind ${event.kind}`);
    }

    this.stateValue = { ...this.stateValue, cursor: event.seq };
    if (event.kind === "turn_drained" && this.stateValue.finalAssistantSeq === null) {
      const terminal = await this.terminalIfReady();
      if (terminal) effects.push(terminal);
    }
    return effects;
  }

  async nextAssistantChunk(): Promise<Extract<TranslatorEffect, { kind: "assistant_chunk" }> | null> {
    const seq = this.stateValue.finalAssistantSeq;
    const turnId = this.stateValue.turnId;
    if (seq === undefined || seq === null || !turnId || this.stateValue.finalAssistantEmittedSeq === seq) return null;
    if (!this.stateValue.drainSeq) this.fail("final_assistant_invalid", "Assistant content cannot be read before turn_drained");
    const offset = this.stateValue.finalAssistantOffset ?? 0;
    const chunk = await this.dependencies.assistantContentChunk(seq, offset, this.chunkSize);
    if (chunk.sessionId !== this.stateValue.sessionId || chunk.seq !== seq || chunk.offset !== offset) {
      this.fail("assistant_range_mismatch", "Assistant content chunk identity or offset changed");
    }
    if (this.stateValue.finalAssistantTotalLength !== undefined && chunk.totalLength !== this.stateValue.finalAssistantTotalLength) {
      this.fail("assistant_range_mismatch", "Assistant content totalLength changed during retrieval");
    }
    if (!chunk.complete && chunk.text.length === 0) this.fail("assistant_range_mismatch", "Assistant content returned an empty nonterminal chunk");
    if (offset + chunk.text.length > chunk.totalLength) this.fail("assistant_range_mismatch", "Assistant content exceeded totalLength");
    return {
      kind: "assistant_chunk",
      seq,
      turnId,
      offset,
      text: chunk.text,
      totalLength: chunk.totalLength,
      complete: chunk.complete,
    };
  }

  async acknowledgeAssistantChunk(effect: Extract<TranslatorEffect, { kind: "assistant_chunk" }>): Promise<Extract<TranslatorEffect, { kind: "terminal" }> | null> {
    const seq = this.stateValue.finalAssistantSeq;
    if (seq === undefined || seq === null || effect.seq !== seq || effect.turnId !== this.stateValue.turnId || effect.offset !== (this.stateValue.finalAssistantOffset ?? 0)) {
      this.fail("assistant_range_mismatch", "Assistant chunk acknowledgement does not match the pending range");
    }
    const nextOffset = effect.offset + effect.text.length;
    if (nextOffset > effect.totalLength || (effect.complete && nextOffset !== effect.totalLength)) {
      this.fail("assistant_range_mismatch", "Assistant chunk completion does not match totalLength");
    }
    this.stateValue = {
      ...this.stateValue,
      finalAssistantOffset: nextOffset,
      finalAssistantTotalLength: effect.totalLength,
      ...(effect.complete ? { finalAssistantEmittedSeq: seq } : {}),
    };
    return effect.complete ? this.terminalIfReady() : null;
  }
}
