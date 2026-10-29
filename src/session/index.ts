import type { ProviderTurnTranslationState } from "../translate/events.js";

export type BindingState = "unbound" | "create_pending" | "bound" | "broken";
export type InteractionMode = "default" | "plan";
/** The ChatGPT reasoning levels a model may offer, as published by the controller. */
export const REASONING_EFFORTS = ['pro','none','minimal','low','medium','high','xhigh','max','ultra'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];
export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === 'string' && (REASONING_EFFORTS as readonly string[]).includes(value);
}
export type CancelIntent = "none" | "requested";
export type InputDispatchState = "prepared" | "dispatched";
export type RecoveryReason =
  | "unknown_resume"
  | "cwd_mismatch"
  | "additional_directories"
  | "project_remapped"
  | "policy_lost"
  | "ambiguous_recovery"
  | "state_corrupt"
  | "state_schema_unsupported";

export interface SessionState {
  readonly sessionId: string;
  readonly bindingState: BindingState;
  readonly interactionMode: InteractionMode;
  /** Mode chosen for the exact input currently crossing the send boundary. */
  readonly pendingInteractionMode?: InteractionMode;
  readonly modeTransitionInputId?: string;
  readonly cwd?: string;
  readonly canonicalCwd?: string;
  readonly cosProjectId?: string;
  readonly activeInputId?: string;
  readonly activeCosTurnId?: string;
  /** Crash boundary for the exact active input. `prepared` means no POST was authorized yet. */
  readonly inputDispatchState?: InputDispatchState;
  readonly dispatchInputId?: string;
  /** Exact profile-wide lease generation journaled before lease acquisition. */
  readonly admissionLeaseId?: string;
  /** Monotonic bridged provider-turn generation for this ACP session. */
  readonly generation?: number;
  /** Last CoS event seq whose externally visible effects were accepted/persisted. */
  readonly cosEventCursor?: number;
  /** Durable in-progress provider-turn translation state. Cleared only after terminal acceptance. */
  readonly providerTranslation?: ProviderTurnTranslationState;
  /** Model and effort selected for this ACP session; applied to every subsequent prompt. */
  readonly model?: string;
  readonly reasoningEffort?: ReasoningEffort;
  readonly cancelIntent?: CancelIntent;
  readonly cancelTargetTurnId?: string;
  readonly recoveryReason?: RecoveryReason;
}

export function newUnboundSession(sessionId: string, cwd?: string): SessionState {
  return {
    sessionId,
    bindingState: "unbound",
    interactionMode: "default",
    cancelIntent: "none",
    ...(cwd === undefined ? {} : { cwd }),
  };
}

export function withBinding(state: SessionState, binding: Pick<SessionState, "bindingState" | "canonicalCwd" | "cosProjectId">): SessionState {
  return { ...state, ...binding };
}

export function withInteractionMode(state: SessionState, interactionMode: InteractionMode): SessionState {
  return { ...state, interactionMode };
}

export function withProviderTranslation(state: SessionState, providerTranslation: ProviderTurnTranslationState): SessionState {
  return {
    ...state,
    generation: providerTranslation.generation,
    cosEventCursor: providerTranslation.cursor,
    providerTranslation,
    ...(providerTranslation.turnId ? { activeCosTurnId: providerTranslation.turnId } : {}),
  };
}

export function completeProviderTranslation(state: SessionState, providerTranslation: ProviderTurnTranslationState): SessionState {
  if (!providerTranslation.terminal) throw new Error("provider translation is not terminal");
  const {
    activeInputId: _activeInputId,
    activeCosTurnId: _activeCosTurnId,
    providerTranslation: _providerTranslation,
    cancelTargetTurnId: _cancelTargetTurnId,
    ...rest
  } = state;
  void _activeInputId;
  void _activeCosTurnId;
  void _providerTranslation;
  void _cancelTargetTurnId;
  return {
    ...rest,
    generation: providerTranslation.generation,
    cosEventCursor: providerTranslation.cursor,
    cancelIntent: "none",
  };
}
