export type BindingState = "unbound" | "create_pending" | "bound" | "broken";
export type InteractionMode = "default" | "plan";
export type CancelIntent = "none" | "requested";

export interface SessionState {
  readonly sessionId: string;
  readonly bindingState: BindingState;
  readonly interactionMode: InteractionMode;
  readonly cwd?: string;
  readonly canonicalCwd?: string;
  readonly cosProjectId?: string;
  readonly activeInputId?: string;
  readonly activeCosTurnId?: string;
  readonly cancelIntent?: CancelIntent;
  readonly cancelTargetTurnId?: string;
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
