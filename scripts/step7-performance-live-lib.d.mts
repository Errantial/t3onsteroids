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
  authoritativeInputProof: true;
  turnId: string;
  finalAssistantSeq: number;
  nativeDrainMs: number;
  toolLikeCount: number;
}

export function directNoToolPrompt(expectedText: string): string;
export function directProviderInput(options: {
  inputId: string;
  expectedText: string;
  projectId: string;
}): {
  id: string;
  text: string;
  projectId: string;
  providerPolicy: { backgroundWork: "disabled" };
};
export function directInputProof(sendRecord: unknown, options: {
  inputId: string;
  sessionId: string;
  inputDelivered: boolean;
}): boolean;
export function analyzeDirectTurn(events: readonly unknown[], options: { inputId: string; expectedText: string; endToEndMs: number }): DirectTurnAnalysis;
export function analyzeProviderTurn(events: readonly unknown[], inputId: string): ProviderTurnAnalysis;
export function slowConsumerPerformanceSample(metrics: unknown, drainedWithinMs: number | null): Record<string, number | null>;
export function withHarnessTimeout<T>(operation: Promise<T>, options: {
  timeoutMs: number;
  onTimeout?: (() => void) | undefined;
  message: string;
}): Promise<T>;
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
