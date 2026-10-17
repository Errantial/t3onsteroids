export interface TranslationEnvelope<T> {
  readonly generation: number;
  readonly value: T;
}

export {
  ProviderTurnTranslator,
  TranslationError,
  newProviderTurnTranslationState,
} from "./events.js";
export type {
  ProviderTurnTranslationState,
  ProviderTurnTranslatorDependencies,
  ProviderTurnTranslatorOptions,
  StableTerminalStopReason,
  StoredAssistantFinalIdentity,
  TranslationErrorCode,
  TranslatorEffect,
} from "./events.js";
export { driveProviderTurn } from "./driver.js";
export type {
  DriveProviderTurnOptions,
  DriveProviderTurnResult,
  ProviderTurnController,
  ProviderTurnOutputEffect,
} from "./driver.js";
