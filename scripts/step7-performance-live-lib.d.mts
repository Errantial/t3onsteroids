export interface DirectTurnAnalysis {
  inputDelivered: boolean;
  turnEndObserved: boolean;
  turnId: string | null;
  finalObserved: boolean;
  finalMatched: boolean;
  finalAssistantChars: number;
  toolLikeCount: number;
  endToEndMs: number;
}

export interface ProviderTurnAnalysis {
  turnId: string;
  finalAssistantSeq: number;
  nativeDrainMs: number;
  toolLikeCount: number;
}

export function analyzeDirectTurn(events: readonly unknown[], options: { inputId: string; expectedText: string; endToEndMs: number }): DirectTurnAnalysis;
export function analyzeProviderTurn(events: readonly unknown[], inputId: string): ProviderTurnAnalysis;
export function slowConsumerPerformanceSample(metrics: unknown, drainedWithinMs: number | null): Record<string, number | null>;
export function evaluateDirectPairedEvidence(evidence: unknown): { pass: boolean; checks: Record<string, boolean> };
export function evaluateSlowConsumerEvidence(evidence: unknown): { pass: boolean; checks: Record<string, boolean> };
export function buildStep7PerformanceInput(options: {
  bridgedRows: readonly unknown[];
  directEvidence: unknown;
  slowEvidence: unknown;
}): {
  bridged: readonly Record<string, number>[];
  direct: readonly { endToEndMs: number }[];
  slowConsumer: Record<string, number | null>;
};
