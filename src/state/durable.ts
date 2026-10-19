import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import type { ProviderTurnTranslationState, StableTerminalStopReason } from "../translate/events.js";
import type { InputDispatchState, InteractionMode, RecoveryReason, SessionState } from "../session/index.js";
import {
  HardLinkMutex,
  PowerShellWindowsProcessIdentity,
  type HardLinkMutexOptions,
  probeHardLinkStateFilesystem,
} from "./mutex.js";

export const DURABLE_SESSION_SCHEMA_VERSION = 1 as const;

export interface DurableSessionRecord extends SessionState {
  readonly schemaVersion: typeof DURABLE_SESSION_SCHEMA_VERSION;
  readonly revision: number;
  readonly updatedAt: number;
}

export type TaggedSessionRead =
  | { readonly status: "found"; readonly value: DurableSessionRecord }
  | { readonly status: "missing" }
  | { readonly status: "corrupt"; readonly sha256: string }
  | { readonly status: "unsupportedSchema"; readonly sha256: string; readonly schemaVersion: number };

export type SessionTransitionResult =
  | { readonly status: "updated"; readonly value: DurableSessionRecord }
  | { readonly status: "unchanged"; readonly value: DurableSessionRecord }
  | { readonly status: "missing" }
  | { readonly status: "exists"; readonly value: DurableSessionRecord }
  | { readonly status: "already_terminal"; readonly value: DurableSessionRecord }
  | { readonly status: "stale_generation"; readonly value: DurableSessionRecord }
  | { readonly status: "wrong_input"; readonly value: DurableSessionRecord }
  | { readonly status: "wrong_turn"; readonly value: DurableSessionRecord }
  | { readonly status: "quarantined" };

export type DurableSessionTransition =
  | { readonly kind: "create"; readonly state: SessionState }
  | {
      readonly kind: "binding";
      readonly inputId: string;
      readonly generation: number;
      readonly bindingState: "create_pending" | "bound";
      readonly canonicalCwd?: string;
      readonly cosProjectId?: string;
    }
  | {
      readonly kind: "begin_input";
      readonly inputId: string;
      readonly generation: number;
      readonly leaseId?: string;
      readonly pendingInteractionMode?: InteractionMode;
    }
  | { readonly kind: "mark_dispatched"; readonly inputId: string; readonly generation: number }
  | { readonly kind: "promote_mode"; readonly inputId: string; readonly generation: number }
  | { readonly kind: "revert_mode"; readonly inputId: string; readonly generation: number }
  | { readonly kind: "bind_turn"; readonly generation: number; readonly inputId: string; readonly turnId: string }
  | { readonly kind: "record_assistant_final"; readonly generation: number; readonly inputId: string; readonly turnId: string; readonly seq: number }
  | { readonly kind: "record_turn_end"; readonly generation: number; readonly inputId: string; readonly turnId: string; readonly seq: number; readonly outcome: string }
  | { readonly kind: "record_drain"; readonly generation: number; readonly inputId: string; readonly turnId: string; readonly seq: number; readonly finalAssistantSeq: number | null }
  | { readonly kind: "advance_cursor"; readonly generation: number; readonly inputId: string; readonly seq: number }
  | {
      readonly kind: "advance_assistant_range";
      readonly generation: number;
      readonly inputId: string;
      readonly turnId: string;
      readonly finalAssistantSeq: number;
      readonly expectedOffset: number;
      readonly nextOffset: number;
      readonly totalLength: number;
      readonly complete: boolean;
    }
  | {
      readonly kind: "settle_terminal";
      readonly generation: number;
      readonly inputId: string;
      readonly turnId: string;
      readonly stopReason: StableTerminalStopReason;
    }
  | {
      readonly kind: "finalize_terminal";
      readonly generation: number;
      readonly inputId: string;
      readonly turnId: string;
      readonly stopReason: StableTerminalStopReason;
    }
  | { readonly kind: "settle_not_sent"; readonly generation: number; readonly inputId: string }
  | { readonly kind: "set_cancel"; readonly generation: number; readonly inputId: string; readonly turnId?: string }
  | { readonly kind: "clear_cancel"; readonly generation: number; readonly inputId: string; readonly turnId?: string }
  | { readonly kind: "mark_broken"; readonly reason: RecoveryReason };

interface QuarantineRecord {
  readonly schemaVersion: 1;
  readonly reason: "state_corrupt" | "state_schema_unsupported";
  readonly sourceSha256: string;
  readonly detectedAt: number;
}

const SESSION_ID = /^[0-9a-z-]{8,64}$/i;
const TURN_ID_MAX = 256;
const INPUT_ID_MAX = 64;
const LEASE_ID = /^[0-9a-f-]{36}$/i;
const RECOVERY_REASONS = new Set<RecoveryReason>([
  "unknown_resume",
  "cwd_mismatch",
  "additional_directories",
  "project_remapped",
  "policy_lost",
  "ambiguous_recovery",
  "state_corrupt",
  "state_schema_unsupported",
]);
const INTERACTION_MODES = new Set<InteractionMode>(["default", "plan"]);
const INPUT_DISPATCH_STATES = new Set<InputDispatchState>(["prepared", "dispatched"]);
const BINDING_STATES = new Set(["unbound", "create_pending", "bound", "broken"]);
const TERMINALS = new Set<StableTerminalStopReason>(["end_turn", "cancelled", "refusal"]);

const SESSION_KEYS = new Set([
  "schemaVersion", "revision", "updatedAt",
  "sessionId", "bindingState", "interactionMode", "pendingInteractionMode", "modeTransitionInputId",
  "cwd", "canonicalCwd", "cosProjectId", "activeInputId", "activeCosTurnId", "generation", "cosEventCursor",
  "inputDispatchState", "dispatchInputId", "admissionLeaseId",
  "providerTranslation", "cancelIntent", "cancelTargetTurnId", "recoveryReason",
]);

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function positiveInt(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1;
}

function nonnegativeInt(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function optionalBoundedString(value: unknown, max: number): boolean {
  return value === undefined || (typeof value === "string" && value.length > 0 && value.length <= max);
}

function validTranslation(value: unknown, sessionId: string): value is ProviderTurnTranslationState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const allowed = new Set([
    "sessionId", "inputId", "generation", "cursor", "turnId", "turnEndSeq", "turnOutcome", "drainSeq",
    "finalAssistantSeq", "finalAssistantOffset", "finalAssistantTotalLength", "finalAssistantEmittedSeq", "terminal",
    "cancelRequested", "assistantFinals",
  ]);
  if (Object.keys(row).some((key) => !allowed.has(key))) return false;
  if (row.sessionId !== sessionId || typeof row.inputId !== "string" || row.inputId.length < 1 || row.inputId.length > INPUT_ID_MAX) return false;
  if (!positiveInt(row.generation) || !nonnegativeInt(row.cursor)) return false;
  if (!optionalBoundedString(row.turnId, TURN_ID_MAX) || !optionalBoundedString(row.turnOutcome, 64)) return false;
  for (const key of ["turnEndSeq", "drainSeq", "finalAssistantOffset", "finalAssistantTotalLength", "finalAssistantEmittedSeq"] as const) {
    if (row[key] !== undefined && !nonnegativeInt(row[key])) return false;
  }
  if (row.finalAssistantSeq !== undefined && row.finalAssistantSeq !== null && !positiveInt(row.finalAssistantSeq)) return false;
  if (row.terminal !== undefined && (typeof row.terminal !== "string" || !TERMINALS.has(row.terminal as StableTerminalStopReason))) return false;
  if (row.cancelRequested !== undefined && typeof row.cancelRequested !== "boolean") return false;
  if (!row.assistantFinals || typeof row.assistantFinals !== "object" || Array.isArray(row.assistantFinals)) return false;
  for (const [key, final] of Object.entries(row.assistantFinals as Record<string, unknown>)) {
    if (!/^[1-9][0-9]*$/.test(key) || !final || typeof final !== "object" || Array.isArray(final)) return false;
    const item = final as Record<string, unknown>;
    if (Object.keys(item).some((name) => !["turnId", "final"].includes(name)) ||
        typeof item.turnId !== "string" || item.turnId.length < 1 || item.turnId.length > TURN_ID_MAX || item.final !== true) return false;
  }
  return true;
}

function parseRecord(bytes: Buffer): { kind: "found"; value: DurableSessionRecord } | { kind: "corrupt" } | { kind: "unsupported"; schemaVersion: number } {
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString("utf8"));
  } catch {
    return { kind: "corrupt" };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { kind: "corrupt" };
  const row = raw as Record<string, unknown>;
  if (!Number.isSafeInteger(row.schemaVersion)) return { kind: "corrupt" };
  if (row.schemaVersion !== DURABLE_SESSION_SCHEMA_VERSION) return { kind: "unsupported", schemaVersion: Number(row.schemaVersion) };
  if (Object.keys(row).some((key) => !SESSION_KEYS.has(key))) return { kind: "corrupt" };
  if (!positiveInt(row.revision) || !nonnegativeInt(row.updatedAt)) return { kind: "corrupt" };
  if (typeof row.sessionId !== "string" || !SESSION_ID.test(row.sessionId)) return { kind: "corrupt" };
  if (typeof row.bindingState !== "string" || !BINDING_STATES.has(row.bindingState)) return { kind: "corrupt" };
  if (typeof row.interactionMode !== "string" || !INTERACTION_MODES.has(row.interactionMode as InteractionMode)) return { kind: "corrupt" };
  if (row.pendingInteractionMode !== undefined && (typeof row.pendingInteractionMode !== "string" || !INTERACTION_MODES.has(row.pendingInteractionMode as InteractionMode))) return { kind: "corrupt" };
  for (const key of ["modeTransitionInputId", "activeInputId", "dispatchInputId"] as const) if (!optionalBoundedString(row[key], INPUT_ID_MAX)) return { kind: "corrupt" };
  if (!optionalBoundedString(row.activeCosTurnId, TURN_ID_MAX)) return { kind: "corrupt" };
  if (row.admissionLeaseId !== undefined && (typeof row.admissionLeaseId !== "string" || !LEASE_ID.test(row.admissionLeaseId))) return { kind: "corrupt" };
  if (row.inputDispatchState !== undefined && (typeof row.inputDispatchState !== "string" || !INPUT_DISPATCH_STATES.has(row.inputDispatchState as InputDispatchState))) return { kind: "corrupt" };
  for (const key of ["cwd", "canonicalCwd"] as const) if (row[key] !== undefined && (typeof row[key] !== "string" || row[key].length > 32_768)) return { kind: "corrupt" };
  if (row.cosProjectId !== undefined && (typeof row.cosProjectId !== "string" || row.cosProjectId.length > 256)) return { kind: "corrupt" };
  if (row.generation !== undefined && !positiveInt(row.generation)) return { kind: "corrupt" };
  if (row.cosEventCursor !== undefined && !nonnegativeInt(row.cosEventCursor)) return { kind: "corrupt" };
  if (row.cancelIntent !== undefined && row.cancelIntent !== "none" && row.cancelIntent !== "requested") return { kind: "corrupt" };
  if (!optionalBoundedString(row.cancelTargetTurnId, TURN_ID_MAX)) return { kind: "corrupt" };
  if (row.recoveryReason !== undefined && (typeof row.recoveryReason !== "string" || !RECOVERY_REASONS.has(row.recoveryReason as RecoveryReason))) return { kind: "corrupt" };
  if (row.providerTranslation !== undefined && !validTranslation(row.providerTranslation, row.sessionId)) return { kind: "corrupt" };
  return { kind: "found", value: row as unknown as DurableSessionRecord };
}

async function writeAndSync(file: string, contents: string): Promise<void> {
  const handle = await fs.open(file, "wx", 0o600);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

const WINDOWS_RENAME_SHARING_ERRORS = new Set(["EPERM", "EACCES", "EBUSY"]);

async function replaceSyncedFile(temp: string, target: string, contents: string): Promise<void> {
  const maxAttempts = process.platform === "win32" ? 8 : 1;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      await fs.rename(temp, target);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== "win32" || !code || !WINDOWS_RENAME_SHARING_ERRORS.has(code)) throw error;

      // A Windows replace can race a lock-free reader/virus scanner that temporarily holds the
      // destination open. Never unlink the authoritative journal and never replay the state
      // transition: retry only this already-written+fsynced temp replacement. If the syscall
      // actually committed before surfacing a sharing error, exact byte equality proves it.
      try {
        if (await fs.readFile(target, "utf8") === contents) return;
      } catch {
        // Missing or temporarily unreadable target is not proof of commit; keep the old journal
        // intact and retry the same temp file below.
      }
      if (attempt + 1 >= maxAttempts) throw error;
      const delayMs = Math.min(5 * (2 ** attempt), 40);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

function withoutUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

function translationFor(record: DurableSessionRecord, generation: number, inputId: string): ProviderTurnTranslationState | SessionTransitionResult {
  const translation = record.providerTranslation;
  if (!translation) return { status: "wrong_input", value: record };
  if (translation.generation !== generation) return { status: "stale_generation", value: record };
  if (translation.inputId !== inputId) return { status: "wrong_input", value: record };
  return translation;
}

function withTranslation(record: DurableSessionRecord, providerTranslation: ProviderTurnTranslationState): SessionState {
  return {
    ...record,
    providerTranslation,
    generation: providerTranslation.generation,
    cosEventCursor: Math.max(record.cosEventCursor ?? 0, providerTranslation.cursor),
    ...(providerTranslation.turnId ? { activeCosTurnId: providerTranslation.turnId } : {}),
  };
}

function normalTransition(record: DurableSessionRecord, transition: Exclude<DurableSessionTransition, { kind: "create" | "mark_broken" }>): SessionTransitionResult | SessionState {
  if (record.bindingState === "broken") return { status: "quarantined" };
  switch (transition.kind) {
    case "binding": {
      const current = translationFor(record, transition.generation, transition.inputId);
      if (!("cursor" in current)) return current;
      if (record.activeInputId !== transition.inputId) return { status: "wrong_input", value: record };
      if (record.bindingState === transition.bindingState &&
          (transition.canonicalCwd === undefined || record.canonicalCwd === transition.canonicalCwd) &&
          (transition.cosProjectId === undefined || record.cosProjectId === transition.cosProjectId)) return { status: "unchanged", value: record };
      return {
        ...record,
        bindingState: transition.bindingState,
        ...(transition.canonicalCwd === undefined ? {} : { canonicalCwd: transition.canonicalCwd }),
        ...(transition.cosProjectId === undefined ? {} : { cosProjectId: transition.cosProjectId }),
      };
    }
    case "begin_input": {
      if (!positiveInt(transition.generation)) return { status: "stale_generation", value: record };
      if (transition.leaseId !== undefined && !LEASE_ID.test(transition.leaseId)) return { status: "wrong_input", value: record };
      const current = record.providerTranslation;
      if (current && !current.terminal) {
        if (current.generation === transition.generation && current.inputId === transition.inputId) return { status: "unchanged", value: record };
        return current.generation >= transition.generation ? { status: "stale_generation", value: record } : { status: "wrong_input", value: record };
      }
      if ((record.generation ?? 0) >= transition.generation) return { status: "stale_generation", value: record };
      const providerTranslation: ProviderTurnTranslationState = {
        sessionId: record.sessionId,
        inputId: transition.inputId,
        generation: transition.generation,
        cursor: record.cosEventCursor ?? 0,
        cancelRequested: false,
        assistantFinals: {},
      };
      return {
        ...record,
        activeInputId: transition.inputId,
        inputDispatchState: "prepared",
        dispatchInputId: transition.inputId,
        ...(transition.leaseId ? { admissionLeaseId: transition.leaseId } : {}),
        generation: transition.generation,
        providerTranslation,
        ...(transition.pendingInteractionMode === undefined ? {} : {
          pendingInteractionMode: transition.pendingInteractionMode,
          modeTransitionInputId: transition.inputId,
        }),
      };
    }
    case "mark_dispatched": {
      const current = translationFor(record, transition.generation, transition.inputId);
      if (!("cursor" in current)) return current;
      if (record.activeInputId !== transition.inputId || record.dispatchInputId !== transition.inputId) return { status: "wrong_input", value: record };
      if (record.inputDispatchState === "dispatched") return { status: "unchanged", value: record };
      if (record.inputDispatchState !== "prepared") return { status: "wrong_input", value: record };
      return { ...record, inputDispatchState: "dispatched" };
    }
    case "promote_mode": {
      const current = translationFor(record, transition.generation, transition.inputId);
      if (!("cursor" in current)) return current;
      if (record.activeInputId !== transition.inputId) return { status: "wrong_input", value: record };
      if (record.pendingInteractionMode === undefined && record.modeTransitionInputId === undefined) return { status: "unchanged", value: record };
      if (record.modeTransitionInputId !== transition.inputId) return { status: "wrong_input", value: record };
      if (record.pendingInteractionMode === undefined) return { status: "unchanged", value: record };
      const { pendingInteractionMode, modeTransitionInputId: _mode, ...rest } = record;
      void _mode;
      return { ...rest, interactionMode: pendingInteractionMode };
    }
    case "revert_mode": {
      const current = translationFor(record, transition.generation, transition.inputId);
      if (!("cursor" in current)) return current;
      if (record.modeTransitionInputId !== transition.inputId) return { status: "wrong_input", value: record };
      const { pendingInteractionMode: _pending, modeTransitionInputId: _mode, ...rest } = record;
      void _pending;
      void _mode;
      return rest;
    }
    case "bind_turn": {
      const current = translationFor(record, transition.generation, transition.inputId);
      if (!("cursor" in current)) return current;
      if (current.turnId && current.turnId !== transition.turnId) return { status: "wrong_turn", value: record };
      if (current.turnId === transition.turnId) return { status: "unchanged", value: record };
      return withTranslation(record, { ...current, turnId: transition.turnId });
    }
    case "record_assistant_final": {
      const current = translationFor(record, transition.generation, transition.inputId);
      if (!("cursor" in current)) return current;
      if (current.turnId !== transition.turnId) return { status: "wrong_turn", value: record };
      if (transition.seq <= current.cursor) {
        return current.assistantFinals[String(transition.seq)] ? { status: "unchanged", value: record } : { status: "stale_generation", value: record };
      }
      return withTranslation(record, {
        ...current,
        cursor: Math.max(current.cursor, transition.seq),
        assistantFinals: { ...current.assistantFinals, [String(transition.seq)]: { turnId: transition.turnId, final: true } },
      });
    }
    case "record_turn_end": {
      const current = translationFor(record, transition.generation, transition.inputId);
      if (!("cursor" in current)) return current;
      if (current.turnId !== transition.turnId) return { status: "wrong_turn", value: record };
      if (current.turnEndSeq !== undefined && (current.turnEndSeq !== transition.seq || current.turnOutcome !== transition.outcome)) return { status: "wrong_turn", value: record };
      if (current.turnEndSeq === transition.seq) return { status: "unchanged", value: record };
      return withTranslation(record, { ...current, cursor: Math.max(current.cursor, transition.seq), turnEndSeq: transition.seq, turnOutcome: transition.outcome });
    }
    case "record_drain": {
      const current = translationFor(record, transition.generation, transition.inputId);
      if (!("cursor" in current)) return current;
      if (current.turnId !== transition.turnId) return { status: "wrong_turn", value: record };
      if (!current.turnEndSeq || !current.turnOutcome || current.turnEndSeq >= transition.seq) return { status: "wrong_turn", value: record };
      if (transition.finalAssistantSeq !== null) {
        const final = current.assistantFinals[String(transition.finalAssistantSeq)];
        if (!final || final.turnId !== transition.turnId || transition.finalAssistantSeq >= transition.seq) return { status: "wrong_turn", value: record };
      }
      if (current.drainSeq !== undefined) {
        return current.drainSeq === transition.seq && current.finalAssistantSeq === transition.finalAssistantSeq
          ? { status: "unchanged", value: record }
          : { status: "already_terminal", value: record };
      }
      return withTranslation(record, {
        ...current,
        cursor: Math.max(current.cursor, transition.seq),
        drainSeq: transition.seq,
        finalAssistantSeq: transition.finalAssistantSeq,
        finalAssistantOffset: 0,
      });
    }
    case "advance_cursor": {
      const current = translationFor(record, transition.generation, transition.inputId);
      if (!("cursor" in current)) return current;
      if (current.drainSeq !== undefined && transition.seq > current.drainSeq) return { status: "already_terminal", value: record };
      if (transition.seq <= current.cursor) return { status: "unchanged", value: record };
      return withTranslation(record, { ...current, cursor: transition.seq });
    }
    case "advance_assistant_range": {
      const current = translationFor(record, transition.generation, transition.inputId);
      if (!("cursor" in current)) return current;
      if (current.turnId !== transition.turnId) return { status: "wrong_turn", value: record };
      if (current.finalAssistantSeq !== transition.finalAssistantSeq) return { status: "wrong_input", value: record };
      const offset = current.finalAssistantOffset ?? 0;
      if (offset !== transition.expectedOffset) return { status: "stale_generation", value: record };
      if (transition.nextOffset < offset || transition.nextOffset > transition.totalLength) return { status: "stale_generation", value: record };
      if (current.finalAssistantTotalLength !== undefined && current.finalAssistantTotalLength !== transition.totalLength) return { status: "stale_generation", value: record };
      if (transition.complete ? transition.nextOffset !== transition.totalLength : transition.nextOffset >= transition.totalLength) return { status: "stale_generation", value: record };
      return withTranslation(record, {
        ...current,
        finalAssistantOffset: transition.nextOffset,
        finalAssistantTotalLength: transition.totalLength,
        ...(transition.complete ? { finalAssistantEmittedSeq: transition.finalAssistantSeq } : {}),
      });
    }
    case "settle_terminal": {
      const current = translationFor(record, transition.generation, transition.inputId);
      if (!("cursor" in current)) return current;
      if (current.turnId !== transition.turnId) return { status: "wrong_turn", value: record };
      if (!current.drainSeq) return { status: "wrong_turn", value: record };
      if (current.terminal) return current.terminal === transition.stopReason ? { status: "unchanged", value: record } : { status: "already_terminal", value: record };
      if (current.cursor < current.drainSeq || !current.turnEndSeq || !current.turnOutcome) return { status: "wrong_turn", value: record };
      if (current.finalAssistantSeq !== null && current.finalAssistantSeq !== undefined && current.finalAssistantEmittedSeq !== current.finalAssistantSeq) {
        return { status: "wrong_turn", value: record };
      }
      if (transition.stopReason === "end_turn" && current.turnOutcome !== "completed") return { status: "wrong_turn", value: record };
      if (transition.stopReason === "cancelled" && (current.turnOutcome !== "stopped" || current.cancelRequested !== true)) return { status: "wrong_turn", value: record };
      if (transition.stopReason === "refusal") return { status: "wrong_turn", value: record };
      return withTranslation(record, { ...current, terminal: transition.stopReason });
    }
    case "finalize_terminal": {
      const current = translationFor(record, transition.generation, transition.inputId);
      if (!("cursor" in current)) return current;
      if (current.turnId !== transition.turnId) return { status: "wrong_turn", value: record };
      if (current.terminal !== transition.stopReason) return current.terminal ? { status: "already_terminal", value: record } : { status: "wrong_turn", value: record };
      const {
        activeInputId: _activeInputId,
        activeCosTurnId: _activeCosTurnId,
        providerTranslation: _providerTranslation,
        cancelTargetTurnId: _cancelTargetTurnId,
        pendingInteractionMode: _pendingInteractionMode,
        modeTransitionInputId: _modeTransitionInputId,
        inputDispatchState: _inputDispatchState,
        dispatchInputId: _dispatchInputId,
        admissionLeaseId: _admissionLeaseId,
        ...rest
      } = record;
      void _activeInputId; void _activeCosTurnId; void _providerTranslation; void _cancelTargetTurnId; void _pendingInteractionMode; void _modeTransitionInputId; void _inputDispatchState; void _dispatchInputId; void _admissionLeaseId;
      return {
        ...rest,
        generation: current.generation,
        cosEventCursor: Math.max(record.cosEventCursor ?? 0, current.cursor),
        cancelIntent: "none",
      };
    }
    case "settle_not_sent": {
      const current = translationFor(record, transition.generation, transition.inputId);
      if (!("cursor" in current)) return current;
      if (current.turnId || current.drainSeq || current.turnEndSeq) return { status: "wrong_turn", value: record };
      const {
        activeInputId: _activeInputId,
        activeCosTurnId: _activeCosTurnId,
        providerTranslation: _providerTranslation,
        cancelTargetTurnId: _cancelTargetTurnId,
        pendingInteractionMode: _pendingInteractionMode,
        modeTransitionInputId: _modeTransitionInputId,
        inputDispatchState: _inputDispatchState,
        dispatchInputId: _dispatchInputId,
        admissionLeaseId: _admissionLeaseId,
        ...rest
      } = record;
      void _activeInputId; void _activeCosTurnId; void _providerTranslation; void _cancelTargetTurnId; void _pendingInteractionMode; void _modeTransitionInputId; void _inputDispatchState; void _dispatchInputId; void _admissionLeaseId;
      const settled: SessionState = {
        ...rest,
        generation: current.generation,
        cosEventCursor: Math.max(record.cosEventCursor ?? 0, current.cursor),
        cancelIntent: "none",
      };
      if (record.bindingState !== "create_pending") return settled;

      // A first-input create_pending binding is only tentative until CoS accepts/delivers that
      // input. Authoritative not_sent means no native session/turn exists, so return to the same
      // unbound state the ACP session had before the POST and discard tentative project binding.
      const {
        canonicalCwd: _canonicalCwd,
        cosProjectId: _cosProjectId,
        ...unbound
      } = settled;
      void _canonicalCwd;
      void _cosProjectId;
      return { ...unbound, bindingState: "unbound" };
    }
    case "set_cancel": {
      const current = translationFor(record, transition.generation, transition.inputId);
      if (!("cursor" in current)) return current;
      if (transition.turnId !== undefined && current.turnId !== transition.turnId) return { status: "wrong_turn", value: record };
      if (record.cancelIntent === "requested" && record.cancelTargetTurnId === transition.turnId && current.cancelRequested) return { status: "unchanged", value: record };
      return withTranslation({ ...record, cancelIntent: "requested", ...(transition.turnId ? { cancelTargetTurnId: transition.turnId } : {}) }, { ...current, cancelRequested: true });
    }
    case "clear_cancel": {
      const current = translationFor(record, transition.generation, transition.inputId);
      if (!("cursor" in current)) return current;
      if (transition.turnId !== undefined && current.turnId !== transition.turnId) return { status: "wrong_turn", value: record };
      const { cancelTargetTurnId: _target, ...rest } = record;
      void _target;
      return withTranslation({ ...rest, cancelIntent: "none" }, { ...current, cancelRequested: false });
    }
  }
}

export interface DurableSessionStoreOptions {
  readonly mutex?: HardLinkMutexOptions;
  readonly now?: () => number;
  readonly probeFilesystem?: boolean;
}

export class DurableSessionStore {
  private readonly now: () => number;
  private readonly mutexOptions: HardLinkMutexOptions;
  private readonly localQueues = new Map<string, Promise<void>>();
  private initialized = false;

  constructor(
    readonly root: string,
    private readonly options: DurableSessionStoreOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.mutexOptions = options.mutex?.identity
      ? options.mutex
      : { ...options.mutex, identity: new PowerShellWindowsProcessIdentity() };
  }

  private sessionPath(sessionId: string): string {
    if (!SESSION_ID.test(sessionId)) throw new Error("invalid session id");
    return path.join(this.root, "sessions", `${sessionId}.json`);
  }

  private quarantinePath(sessionId: string): string {
    if (!SESSION_ID.test(sessionId)) throw new Error("invalid session id");
    return path.join(this.root, "quarantine", `${sessionId}.json`);
  }

  private mutex(sessionId: string): HardLinkMutex {
    return new HardLinkMutex(path.join(this.root, "locks", "sessions"), `session-${sessionId}`, this.mutexOptions);
  }

  /**
   * Serialize mutations from this DurableSessionStore instance before taking the cross-process
   * hard-link mutex. The file mutex is deliberately non-reentrant and fail-closed, so two async
   * mutations from one ACP runtime that overlap on the same session must queue locally instead of
   * competing with one another until the external lock timeout expires.
   */
  private async withLocalSessionQueue<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.localQueues.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.localQueues.set(sessionId, tail);
    await previous.catch(() => undefined);
    try {
      return await work();
    } finally {
      release();
      if (this.localQueues.get(sessionId) === tail) this.localQueues.delete(sessionId);
    }
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    await Promise.all([
      fs.mkdir(path.join(this.root, "sessions"), { recursive: true }),
      fs.mkdir(path.join(this.root, "quarantine"), { recursive: true }),
      fs.mkdir(path.join(this.root, "locks", "sessions"), { recursive: true }),
    ]);
    if (this.options.probeFilesystem !== false) await probeHardLinkStateFilesystem(this.root);
    this.initialized = true;
  }

  private async activeQuarantine(sessionId: string): Promise<QuarantineRecord | null> {
    try {
      const raw = JSON.parse(await fs.readFile(this.quarantinePath(sessionId), "utf8")) as Record<string, unknown>;
      if (raw.schemaVersion !== 1 || (raw.reason !== "state_corrupt" && raw.reason !== "state_schema_unsupported") ||
          typeof raw.sourceSha256 !== "string" || !/^[0-9a-f]{64}$/.test(raw.sourceSha256) ||
          typeof raw.detectedAt !== "number" || !Number.isFinite(raw.detectedAt)) {
        return { schemaVersion: 1, reason: "state_corrupt", sourceSha256: "0".repeat(64), detectedAt: 0 };
      }
      return raw as unknown as QuarantineRecord;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      return { schemaVersion: 1, reason: "state_corrupt", sourceSha256: "0".repeat(64), detectedAt: 0 };
    }
  }

  private async writeQuarantine(sessionId: string, record: QuarantineRecord): Promise<void> {
    await fs.mkdir(path.dirname(this.quarantinePath(sessionId)), { recursive: true });
    if (await this.activeQuarantine(sessionId)) return;
    const temp = `${this.quarantinePath(sessionId)}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeAndSync(temp, JSON.stringify(record));
      await fs.rename(temp, this.quarantinePath(sessionId));
    } catch (error) {
      if (!(await this.activeQuarantine(sessionId))) throw error;
    } finally {
      await fs.rm(temp, { force: true }).catch(() => undefined);
    }
  }

  async readSession(sessionId: string): Promise<TaggedSessionRead> {
    await this.init();
    const quarantined = await this.activeQuarantine(sessionId);
    if (quarantined) {
      if (quarantined.reason === "state_schema_unsupported") {
        try {
          const bytes = await fs.readFile(this.sessionPath(sessionId));
          const parsed = parseRecord(bytes);
          if (parsed.kind === "unsupported") {
            return { status: "unsupportedSchema", sha256: quarantined.sourceSha256, schemaVersion: parsed.schemaVersion };
          }
        } catch { /* Original source disappeared: the active quarantine still fails closed. */ }
      }
      return { status: "corrupt", sha256: quarantined.sourceSha256 };
    }
    let bytes: Buffer;
    try {
      bytes = await fs.readFile(this.sessionPath(sessionId));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" };
      throw error;
    }
    const digest = sha256(bytes);
    const parsed = parseRecord(bytes);
    if (parsed.kind === "found") return { status: "found", value: parsed.value };
    if (parsed.kind === "unsupported") {
      await this.writeQuarantine(sessionId, { schemaVersion: 1, reason: "state_schema_unsupported", sourceSha256: digest, detectedAt: this.now() });
      return { status: "unsupportedSchema", sha256: digest, schemaVersion: parsed.schemaVersion };
    }
    await this.writeQuarantine(sessionId, { schemaVersion: 1, reason: "state_corrupt", sourceSha256: digest, detectedAt: this.now() });
    return { status: "corrupt", sha256: digest };
  }

  private async writeRecord(record: DurableSessionRecord): Promise<void> {
    const target = this.sessionPath(record.sessionId);
    const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
    const contents = JSON.stringify(withoutUndefined(record));
    try {
      await writeAndSync(temp, contents);
      await replaceSyncedFile(temp, target, contents);
    } finally {
      await fs.rm(temp, { force: true }).catch(() => undefined);
    }
  }

  async updateSession(sessionId: string, transition: DurableSessionTransition): Promise<SessionTransitionResult> {
    await this.init();
    return this.withLocalSessionQueue(sessionId, () => this.mutex(sessionId).withLock(async () => {
      // readSession owns the quarantine check. Repeating it here doubled the same ENOENT/read on
      // every durable transition, including both first-prompt commits on the live critical path.
      const currentRead = await this.readSession(sessionId);
      if (currentRead.status === "corrupt" || currentRead.status === "unsupportedSchema") return { status: "quarantined" };
      if (transition.kind === "create") {
        if (currentRead.status === "found") return { status: "exists", value: currentRead.value };
        if (currentRead.status !== "missing") return { status: "quarantined" };
        if (transition.state.sessionId !== sessionId) throw new Error("create transition session id mismatch");
        const created: DurableSessionRecord = withoutUndefined({
          ...transition.state,
          schemaVersion: 1,
          revision: 1,
          updatedAt: this.now(),
        });
        await this.writeRecord(created);
        return { status: "updated", value: created };
      }
      if (currentRead.status !== "found") return { status: currentRead.status === "missing" ? "missing" : "quarantined" };
      const current = currentRead.value;
      if (transition.kind === "mark_broken") {
        if (current.bindingState === "broken") return { status: "already_terminal", value: current };
        const next: SessionState = { ...current, bindingState: "broken", recoveryReason: transition.reason };
        const updated: DurableSessionRecord = withoutUndefined({ ...next, schemaVersion: 1, revision: current.revision + 1, updatedAt: this.now() });
        await this.writeRecord(updated);
        return { status: "updated", value: updated };
      }
      const applied = normalTransition(current, transition);
      if ("status" in applied) return applied;
      const updated: DurableSessionRecord = withoutUndefined({
        ...applied,
        schemaVersion: 1,
        revision: current.revision + 1,
        updatedAt: this.now(),
      });
      await this.writeRecord(updated);
      return { status: "updated", value: updated };
    }));
  }

  async pruneBroken(
    olderThanMs = 30 * 24 * 60 * 60 * 1000,
    protectedSessionIds: ReadonlySet<string> = new Set(),
  ): Promise<number> {
    await this.init();
    const cutoff = this.now() - olderThanMs;
    let removed = 0;
    for (const name of await fs.readdir(path.join(this.root, "sessions"))) {
      if (!name.endsWith(".json")) continue;
      const sessionId = name.slice(0, -5);
      if (!SESSION_ID.test(sessionId)) continue;
      if (protectedSessionIds.has(sessionId)) continue;
      const tagged = await this.readSession(sessionId);
      if (tagged.status !== "found" || tagged.value.bindingState !== "broken" || tagged.value.updatedAt >= cutoff) continue;
      await this.mutex(sessionId).withLock(async () => {
        if (protectedSessionIds.has(sessionId)) return;
        const latest = await this.readSession(sessionId);
        if (latest.status === "found" && latest.value.bindingState === "broken" && latest.value.updatedAt < cutoff) {
          await fs.unlink(this.sessionPath(sessionId)).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
          });
          removed += 1;
        }
      });
    }
    return removed;
  }
}

export function defaultStateDirectory(env: NodeJS.ProcessEnv = process.env): string {
  if (env.T3ONSTEROIDS_STATE_DIR) return path.resolve(env.T3ONSTEROIDS_STATE_DIR);
  if (!env.LOCALAPPDATA) throw new Error("LOCALAPPDATA is required unless T3ONSTEROIDS_STATE_DIR is set");
  return path.join(env.LOCALAPPDATA, "t3onsteroids", "state");
}
