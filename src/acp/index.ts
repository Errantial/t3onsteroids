import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { ContentBlock, InitializeResponse, NewSessionRequest, NewSessionResponse, PromptRequest, ResumeSessionRequest, ResumeSessionResponse } from "@agentclientprotocol/sdk";

import type { CosControllerReadiness, CosInputRecord, CosSessionSummary } from "../cos/index.js";
import { v1ProviderSessionPolicy } from "../policy/index.js";
import { newUnboundSession, type InteractionMode, type SessionState, withInteractionMode } from "../session/index.js";
import {
  driveProviderTurn,
  type DriveProviderTurnResult,
  type ProviderTurnController,
  type ProviderTurnOutputEffect,
} from "../translate/driver.js";
import { newProviderTurnTranslationState, type ProviderTurnTranslationState } from "../translate/events.js";
import { StateLockBusyError } from "../state/index.js";
import type {
  AdmissionLease,
  DurableAdmissionLease,
  DurableSessionStore,
  DurableSessionTransition,
  LeaseReleaseProof,
  StateStore,
} from "../state/index.js";
import type { BridgeMetrics } from "../metrics.js";
import { BRIDGE_VERSION } from "../version.js";

export const PINNED_T3_SHA = "ffb4af8d5d4fcfc5e9322295ff846a6d1e7ffbf8";
export const MAX_COS_INPUT_CHARS = 64_000;

export type BridgeErrorCode =
  | "session_not_found"
  | "additional_directories_unsupported"
  | "mcp_servers_unsupported"
  | "t3_prompt_contract_mismatch"
  | "unsupported_command"
  | "unsupported_prompt_content"
  | "resource_link_unavailable"
  | "input_too_large"
  | "project_unmapped"
  | "input_busy"
  | "cancelled"
  | "provider_policy_unavailable"
  | "actions_disabled"
  | "session_broken";

export class BridgeError extends Error {
  constructor(readonly code: BridgeErrorCode, message: string) {
    super(message);
    this.name = "BridgeError";
  }
}

export interface AcpSessionDraft {
  readonly sessionId: string;
  readonly cwd: string;
}

export function createSessionDraft(sessionId: string, cwd: string): AcpSessionDraft {
  return { sessionId, cwd };
}

export interface ProjectBinding {
  readonly projectId: string;
  readonly canonicalPath: string;
}

export interface BridgeController {
  health?(): Promise<CosControllerReadiness>;
  requireProviderExtension?(): Promise<CosControllerReadiness>;
  requireBackgroundWorkDisabled?(sessionId: string): Promise<{ backgroundWork: "disabled"; enforced: true }>;
  resolveProject(path: string): Promise<ProjectBinding>;
  input?(inputId: string): Promise<CosInputRecord | undefined>;
  session?(sessionId: string): Promise<CosSessionSummary>;
  assistantContentChunk?: ProviderTurnController["assistantContentChunk"];
  streamEvents?: ProviderTurnController["streamEvents"];
  cancelPendingInput?(inputId: string): Promise<void>;
  requestStopExactTurn?(sessionId: string, turnId: string): Promise<void>;
  stopExactTurn?(sessionId: string, turnId: string): Promise<unknown>;
  send(input: {
    id: string;
    text: string;
    sessionId?: string;
    projectId?: string;
    providerPolicy?: typeof v1ProviderSessionPolicy;
  }): Promise<CosInputRecord>;
}

export interface PromptNormalizationResult {
  readonly text: string;
  readonly interactionMode: InteractionMode;
}

export interface BridgeRuntimeOptions {
  readonly controller: BridgeController;
  /** Reference/test persistence. Production should provide durableStore instead. */
  readonly store?: StateStore<SessionState>;
  /** Production narrow-transition persistence. Never combined with store. */
  readonly durableStore?: DurableSessionStore;
  readonly lease?: AdmissionLease;
  /** Production profile-wide admission lease. Never reclaimed from PID/age alone. */
  readonly durableLease?: DurableAdmissionLease;
  readonly controllerIdentity?: string;
  readonly ownerId?: string;
  readonly makeUuid?: () => string;
  readonly canonicalize?: (path: string) => Promise<string>;
  readonly metrics?: BridgeMetrics;
}

export interface DurableProviderTurnDriveOptions {
  readonly sessionId: string;
  readonly emit: (effect: ProviderTurnOutputEffect) => Promise<void>;
  readonly chunkSize?: number;
  readonly signal?: AbortSignal;
}

export type PendingProviderTurnCompletion =
  | { readonly kind: "turn_ready" }
  | { readonly kind: "cancelled_not_sent" };

const PLAN_GUIDANCE = "Plan mode: investigate read-only and return a plan. Do not make changes.";

function rejectAdditionalDirectories(additionalDirectories: readonly string[] | undefined): void {
  if (additionalDirectories && additionalDirectories.length > 0) {
    throw new BridgeError("additional_directories_unsupported", "additionalDirectories are not supported in v1");
  }
}

function parseKnownT3Envelope(text: string, currentMode: InteractionMode): { text: string; mode: InteractionMode } {
  if (text.startsWith("/")) throw new BridgeError("unsupported_command", "Native T3 slash commands are not supported in v1");
  if (!text.includes("<t3_code_instructions>")) return { text, mode: currentMode };

  const match = text.match(/^<t3_code_instructions>\n([\s\S]*?)\n<\/t3_code_instructions>\n\n<user_request>\n([\s\S]*?)\n<\/user_request>$/);
  if (!match) throw new BridgeError("t3_prompt_contract_mismatch", "Pinned T3 prompt wrapper did not match the supported contract");
  const instructions = match[1]!;
  let mode = currentMode;
  if (/\bplan\b/i.test(instructions)) mode = "plan";
  else if (/\bdefault\b/i.test(instructions)) mode = "default";
  return { text: match[2]!, mode };
}

function looksLikeT3RuntimeBlock(text: string): boolean {
  const lowered = text.toLowerCase();
  return lowered.includes("runtime_info") || lowered.includes("pull_request_linking");
}

async function resourceLinkToText(block: Extract<ContentBlock, { type: "resource_link" }>, canonicalRoot: string, canonicalize: (path: string) => Promise<string>): Promise<string> {
  let url: URL;
  try {
    url = new URL(block.uri);
  } catch {
    throw new BridgeError("resource_link_unavailable", "ResourceLink URI is invalid");
  }
  if (url.protocol !== "file:" || url.host !== "") throw new BridgeError("resource_link_unavailable", "Only local file: ResourceLinks are supported");

  let localPath: string;
  try {
    localPath = fileURLToPath(url);
  } catch {
    throw new BridgeError("resource_link_unavailable", "ResourceLink file URI could not be decoded safely");
  }
  if (!isAbsolute(localPath)) throw new BridgeError("resource_link_unavailable", "ResourceLink path must be absolute");
  const canonical = await canonicalize(localPath);
  const rel = relative(canonicalRoot, canonical);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new BridgeError("resource_link_unavailable", "ResourceLink must remain inside the bound project root");
  return `[resource:${JSON.stringify(canonical)}]`;
}

export async function normalizePrompt(
  prompt: readonly ContentBlock[],
  currentMode: InteractionMode,
  canonicalRoot: string,
  canonicalize: (path: string) => Promise<string> = realpath,
): Promise<PromptNormalizationResult> {
  const textBlocks: string[] = [];
  let nextMode = currentMode;
  for (const block of prompt) {
    if (block.type === "text") {
      if (looksLikeT3RuntimeBlock(block.text)) continue;
      const parsed = parseKnownT3Envelope(block.text, nextMode);
      nextMode = parsed.mode;
      textBlocks.push(parsed.text);
    } else if (block.type === "resource_link") {
      textBlocks.push(await resourceLinkToText(block, canonicalRoot, canonicalize));
    } else {
      throw new BridgeError("unsupported_prompt_content", `Prompt content type ${block.type} is not supported in v1`);
    }
  }

  let text = textBlocks.join("\n");
  if (nextMode === "plan") text = `${PLAN_GUIDANCE}\n\n${text}`;
  if (text.length > MAX_COS_INPUT_CHARS) throw new BridgeError("input_too_large", "Normalized CoS input exceeds 64,000 characters");
  return { text, interactionMode: nextMode };
}

export class AcpBridgeRuntime {
  private readonly sessions = new Map<string, SessionState>();
  private readonly resumedCwds = new Map<string, string>();
  private readonly makeUuid: () => string;
  private readonly canonicalize: (path: string) => Promise<string>;
  private readonly ownerId: string;

  constructor(private readonly options: BridgeRuntimeOptions) {
    if (!!options.store === !!options.durableStore) {
      throw new Error("Exactly one of store or durableStore must be configured");
    }
    if (options.lease && options.durableLease) throw new Error("Configure only one admission lease implementation");
    if (!!options.durableStore !== !!options.durableLease) {
      throw new Error("Production durable runtime requires both durableStore and durableLease");
    }
    if (options.durableStore && (options.lease || options.controllerIdentity)) {
      throw new Error("Production durable runtime cannot use reference admission-lease configuration");
    }
    this.makeUuid = options.makeUuid ?? (() => randomUUID().toLowerCase());
    this.canonicalize = options.canonicalize ?? realpath;
    this.ownerId = options.ownerId ?? randomUUID().toLowerCase();
  }

  private async readPersisted(sessionId: string): Promise<SessionState | null> {
    if (this.options.durableStore) {
      const tagged = await this.options.durableStore.readSession(sessionId);
      if (tagged.status === "found") return tagged.value;
      if (tagged.status === "missing") return null;
      // Tagged corruption/future schema is already quarantined by the durable store. Keep the
      // original bytes untouched and expose only a logical broken session to the ACP layer.
      return {
        sessionId,
        bindingState: "broken",
        interactionMode: "default",
        cancelIntent: "none",
        recoveryReason: tagged.status === "corrupt" ? "state_corrupt" : "state_schema_unsupported",
      };
    }
    return (await this.options.store!.read(sessionId)) ?? null;
  }

  private async persistWholeForReference(state: SessionState): Promise<void> {
    if (this.options.durableStore) throw new Error("Production durable runtime cannot write whole session snapshots");
    await this.options.store!.write(state.sessionId, state);
  }

  private async markBroken(session: SessionState, reason: SessionState["recoveryReason"]): Promise<SessionState> {
    const broken: SessionState = { ...session, bindingState: "broken", ...(reason ? { recoveryReason: reason } : {}) };
    if (this.options.durableStore) {
      const result = await this.options.durableStore.updateSession(session.sessionId, { kind: "mark_broken", reason: reason ?? "ambiguous_recovery" });
      if (result.status === "updated" || result.status === "already_terminal") {
        const latest = await this.readPersisted(session.sessionId);
        if (latest) this.sessions.set(session.sessionId, latest);
        return latest ?? broken;
      }
      // Active corruption quarantine cannot be overwritten. Keep an in-memory broken view.
      this.sessions.set(session.sessionId, broken);
      return broken;
    }
    await this.persistWholeForReference(broken);
    this.sessions.set(session.sessionId, broken);
    return broken;
  }

  private async refreshDurable(sessionId: string): Promise<SessionState> {
    const latest = await this.readPersisted(sessionId);
    if (!latest) throw new BridgeError("session_not_found", "ACP session is unknown");
    this.sessions.set(sessionId, latest);
    return latest;
  }

  private async ensureDurableCreated(session: SessionState): Promise<SessionState> {
    if (!this.options.durableStore) return session;
    const tagged = await this.options.durableStore.readSession(session.sessionId);
    if (tagged.status === "found") return tagged.value;
    if (tagged.status !== "missing") {
      const broken: SessionState = {
        ...session,
        bindingState: "broken",
        recoveryReason: tagged.status === "corrupt" ? "state_corrupt" : "state_schema_unsupported",
      };
      this.sessions.set(session.sessionId, broken);
      return broken;
    }
    const result = await this.options.durableStore.updateSession(session.sessionId, { kind: "create", state: session });
    if (result.status === "updated" || result.status === "exists") {
      this.sessions.set(session.sessionId, result.value);
      return result.value;
    }
    throw new BridgeError("session_broken", "Durable ACP session could not be created safely");
  }

  private async applyDurableTransition(
    sessionId: string,
    transition: DurableSessionTransition,
  ): Promise<SessionState> {
    if (!this.options.durableStore) throw new Error("Durable transition requested without durable store");
    const committedPromotion = async (): Promise<SessionState | undefined> => {
      if (transition.kind !== "promote_mode") return undefined;
      const tagged = await this.options.durableStore!.readSession(sessionId);
      if (tagged.status !== "found") return undefined;
      const record = tagged.value;
      const translation = record.providerTranslation;
      if (record.generation !== transition.generation ||
          record.activeInputId !== transition.inputId ||
          translation?.generation !== transition.generation ||
          translation.inputId !== transition.inputId ||
          record.pendingInteractionMode !== undefined ||
          record.modeTransitionInputId !== undefined) {
        return undefined;
      }
      return record;
    };
    let result;
    try {
      result = await this.options.durableStore.updateSession(sessionId, transition);
    } catch (error) {
      if (!(error instanceof StateLockBusyError) || transition.kind !== "promote_mode") throw error;
      // promote_mode is scoped to the exact durable input generation and is idempotent. A mutex
      // release can fail after the atomic session replace has already committed. Prefer proving
      // that exact commit from the lock-free durable read; this avoids requiring a second mutex
      // release to succeed merely to observe an already-committed transition.
      const committed = await committedPromotion();
      if (committed) {
        this.sessions.set(sessionId, committed);
        return committed;
      }
      // A pre-write lock loss has no durable promotion to prove, so retain one exact retry. If that
      // retry itself reports an ambiguous post-write release failure, accept it only after the same
      // generation/input proof appears durably; otherwise fail closed with the original error path.
      try {
        result = await this.options.durableStore.updateSession(sessionId, transition);
      } catch (retryError) {
        if (retryError instanceof StateLockBusyError) {
          const committedAfterRetry = await committedPromotion();
          if (committedAfterRetry) {
            this.sessions.set(sessionId, committedAfterRetry);
            return committedAfterRetry;
          }
        }
        throw retryError;
      }
    }
    if (result.status === "cancelled" && transition.kind === "mark_dispatched") {
      throw new BridgeError("cancelled", "Provider input was cancelled before dispatch");
    }
    if (result.status === "updated" || result.status === "unchanged") {
      this.sessions.set(sessionId, result.value);
      return result.value;
    }
    throw new BridgeError("session_broken", `Durable session transition ${transition.kind} was rejected (${result.status})`);
  }

  private async requirePromptReadiness(session: SessionState): Promise<void> {
    const readiness = this.options.controller.requireProviderExtension
      ? await this.options.controller.requireProviderExtension()
      : await this.options.controller.health?.();
    if (readiness && !readiness.actionsEnabled) {
      throw new BridgeError("actions_disabled", "CoS controller actions are disabled");
    }
    if (session.bindingState === "bound") {
      if (!this.options.controller.requireBackgroundWorkDisabled) {
        throw new BridgeError("provider_policy_unavailable", "Provider-session policy attestation is unavailable");
      }
      try {
        await this.options.controller.requireBackgroundWorkDisabled(session.sessionId);
      } catch {
        await this.markBroken(session, "policy_lost");
        throw new BridgeError("provider_policy_unavailable", "Provider-session policy attestation was lost");
      }
    }
  }

  private async acquireLease(sessionId: string, inputId: string, generation: number, leaseId?: string): Promise<void> {
    if (this.options.durableLease) {
      if (!leaseId) throw new BridgeError("session_broken", "Durable admission requires a journaled exact lease id");
      const result = await this.options.durableLease.acquire({ sessionId, inputId, generation, ownerId: this.ownerId, leaseId });
      if (result.status === "cancelled") {
        throw new BridgeError("cancelled", "Queued provider input was cancelled before dispatch");
      }
      if (result.status !== "acquired") {
        throw new BridgeError("input_busy", "No admission slot is available for this CoS controller identity");
      }
      if (result.lease.leaseId !== leaseId) throw new BridgeError("session_broken", "Acquired durable lease id did not match the journaled generation");
      return;
    }
    if (!this.options.lease || !this.options.controllerIdentity) return;
    const acquired = await this.options.lease.acquire({
      controllerIdentity: this.options.controllerIdentity,
      sessionId,
      inputId,
      generation,
      ownerId: this.ownerId,
    });
    if (!acquired) throw new BridgeError("input_busy", "Another T3→CoS turn is already active for this CoS controller identity");
  }
  private async releaseLeaseAfterProof(sessionId: string, proof: LeaseReleaseProof): Promise<void> {
    if (this.options.durableLease) {
      const journal = await this.readPersisted(sessionId);
      const expectedLeaseId = journal?.admissionLeaseId;
      if (!expectedLeaseId) throw new BridgeError("session_broken", "Durable session has no exact admission lease id for proof-gated release");
      const result = await this.options.durableLease.releaseAfterProof(expectedLeaseId, proof);
      if (result !== "released" && result !== "missing") {
        throw new BridgeError("session_broken", `Durable admission lease could not be released safely (${result})`);
      }
      return;
    }
    if (!this.options.lease || !this.options.controllerIdentity) return;
    await this.options.lease.release(this.options.controllerIdentity, this.ownerId);
  }

  private async durableLeaseState(
    session: SessionState,
    inputId: string,
    generation: number,
  ): Promise<"active" | "queued" | "missing"> {
    if (!this.options.durableLease) throw new Error("Durable lease check requested without durable lease");
    const leaseId = session.admissionLeaseId;
    if (!leaseId) return "missing";
    const current = await this.options.durableLease.readLease(leaseId);
    if (current.status === "corrupt") {
      throw new BridgeError("session_broken", "Durable admission lease is corrupt and cannot be reconciled safely");
    }
    if (current.status === "missing") return "missing";
    if (current.lease.leaseId !== leaseId || current.lease.sessionId !== session.sessionId ||
        current.lease.inputId !== inputId || current.lease.generation !== generation) {
      throw new BridgeError("session_broken", "Durable admission lease does not match the exact session generation");
    }
    return current.status;
  }
  private async requireInputIdentity(session: SessionState, input: CosInputRecord, expectedInputId: string): Promise<void> {
    const wrongId = input.id !== expectedInputId;
    const wrongSession = input.sessionId !== undefined && input.sessionId !== session.sessionId;
    const missingSentSession = input.delivery === "sent" && input.sessionId !== session.sessionId;
    if (!wrongId && !wrongSession && !missingSentSession) return;
    await this.markBroken(session, "ambiguous_recovery");
    throw new BridgeError("session_broken", "CoS input identity does not match the exact durable provider input/session");
  }

  private async refreshExactDurableGeneration(
    sessionId: string,
    inputId: string,
    generation: number,
  ): Promise<{ session: SessionState; translation: ProviderTurnTranslationState }> {
    const session = await this.refreshDurable(sessionId);
    const translation = session.providerTranslation;
    if (!translation || session.activeInputId !== inputId || session.generation !== generation ||
        translation.inputId !== inputId || translation.generation !== generation) {
      throw new BridgeError("session_broken", "Pending provider input changed its exact durable generation during reconciliation");
    }
    return { session, translation };
  }

  private async requestStopForBoundCancellation(
    sessionId: string,
    inputId: string,
    generation: number,
    turnId: string,
  ): Promise<SessionState> {
    let exact = await this.refreshExactDurableGeneration(sessionId, inputId, generation);
    let { session, translation } = exact;
    if (translation.turnId !== turnId || session.activeCosTurnId !== turnId) {
      throw new BridgeError("session_broken", "Bound provider turn identity changed during cancellation reconciliation");
    }
    if (session.cancelIntent !== "requested" && translation.cancelRequested !== true) return session;
    if (session.cancelTargetTurnId !== undefined && session.cancelTargetTurnId !== turnId) {
      throw new BridgeError("session_broken", "Pending cancellation targets a different provider turn");
    }

    // A pending-input cancel can race the provider creating its native turn. Retarget that already
    // durable cancellation to the exact bound turn before issuing Stop. The exact-turn action is
    // intentionally idempotent: a concurrent cancel path or crash recovery may safely request the
    // same Stop again, but drive must never be allowed to complete normally before one is issued.
    session = await this.applyDurableTransition(sessionId, {
      kind: "set_cancel",
      inputId,
      generation,
      turnId,
    });
    exact = await this.refreshExactDurableGeneration(sessionId, inputId, generation);
    ({ session, translation } = exact);
    if (translation.turnId !== turnId || session.activeCosTurnId !== turnId ||
        session.cancelIntent !== "requested" || translation.cancelRequested !== true ||
        session.cancelTargetTurnId !== turnId) {
      throw new BridgeError("session_broken", "Exact provider cancellation target was not durably retained");
    }
    if (!this.options.controller.requestStopExactTurn) {
      throw new BridgeError("session_broken", "Non-blocking exact-turn Stop is unavailable during cancellation reconciliation");
    }
    await this.options.controller.requestStopExactTurn(sessionId, turnId);
    return (await this.refreshExactDurableGeneration(sessionId, inputId, generation)).session;
  }

  private async reconcilePersistedCancellation(session: SessionState): Promise<SessionState> {
    if (!this.options.durableStore || !this.options.durableLease || session.cancelIntent !== "requested") return session;
    const translation = session.providerTranslation;
    const inputId = session.activeInputId;
    if (!translation || !inputId || translation.inputId !== inputId || translation.generation !== session.generation) {
      throw new BridgeError("session_broken", "Persisted cancellation lacks an exact provider input generation");
    }

    const matchingLease = await this.durableLeaseState(session, inputId, translation.generation);
    if (translation.turnId) {
      if (session.activeCosTurnId !== translation.turnId ||
          (session.cancelTargetTurnId !== undefined && session.cancelTargetTurnId !== translation.turnId)) {
        throw new BridgeError("session_broken", "Persisted cancellation turn identity is inconsistent");
      }
      if (matchingLease !== "active") {
        await this.markBroken(session, "ambiguous_recovery");
        throw new BridgeError("session_broken", "Delivered cancelled turn no longer owns its exact durable lease");
      }
      if (this.options.controller.session) {
        const summary = await this.options.controller.session(session.sessionId);
        const attested = summary.providerTurn;
        if (attested?.inputId === inputId && attested.turnId === translation.turnId && attested.state === "drained") {
          if (attested.drainedSeq === null) {
            throw new BridgeError("session_broken", "Drained provider cancellation attestation lacks durable high-water proof");
          }
          const requireBackgroundWorkDisabled = this.options.controller.requireBackgroundWorkDisabled;
          const assistantContentChunk = this.options.controller.assistantContentChunk;
          const streamEvents = this.options.controller.streamEvents;
          if (!requireBackgroundWorkDisabled || !assistantContentChunk || !streamEvents) {
            throw new BridgeError("session_broken", "Drained provider cancellation cannot be reconciled without the provider event contract");
          }
          const provider: ProviderTurnController = {
            session: this.options.controller.session.bind(this.options.controller),
            requireBackgroundWorkDisabled: requireBackgroundWorkDisabled.bind(this.options.controller),
            assistantContentChunk: assistantContentChunk.bind(this.options.controller),
            streamEvents: streamEvents.bind(this.options.controller),
          };
          const recovered = await this.driveDurableProviderTurn(provider, {
            sessionId: session.sessionId,
            // The original ACP request is already gone after restart. Reconciliation accepts the
            // authoritative historical output only to finish its durable range/terminal checkpoint;
            // it never replays that old assistant body into the next user prompt.
            emit: async () => undefined,
          });
          if (!recovered.terminal) {
            throw new BridgeError("session_broken", "Drained provider cancellation ended without authoritative terminal proof");
          }
          const settled = await this.refreshDurable(session.sessionId);
          if (settled.cancelIntent === "requested" || settled.providerTranslation) {
            throw new BridgeError("session_broken", "Drained provider cancellation did not settle its durable generation");
          }
          return settled;
        }
      }
      if (!this.options.controller.stopExactTurn) throw new BridgeError("session_broken", "Exact-turn Stop is unavailable");
      await this.options.controller.stopExactTurn(session.sessionId, translation.turnId);
      return this.refreshDurable(session.sessionId);
    }

    // A prepared pending input without its matching lease never had authority to POST. This also
    // recovers a crash after proof-gated lease deletion but before settle_not_sent persistence.
    if (matchingLease === "missing") {
      return this.applyDurableTransition(session.sessionId, {
        kind: "settle_not_sent",
        inputId,
        generation: translation.generation,
      });
    }

    if (session.inputDispatchState === "prepared" && session.dispatchInputId === inputId) {
      await this.releaseLeaseAfterProof(session.sessionId, {
        kind: "not_sent",
        sessionId: session.sessionId,
        inputId,
        generation: translation.generation,
      });
      return this.applyDurableTransition(session.sessionId, {
        kind: "settle_not_sent",
        inputId,
        generation: translation.generation,
      });
    }

    if (!this.options.controller.input || !this.options.controller.cancelPendingInput) {
      throw new BridgeError("session_broken", "Pending-input cancellation reconciliation is unavailable");
    }
    const before = await this.options.controller.input(inputId);
    if (before) await this.requireInputIdentity(session, before, inputId);
    if (before?.delivery === "not_sent") {
      await this.releaseLeaseAfterProof(session.sessionId, {
        kind: "not_sent",
        sessionId: session.sessionId,
        inputId,
        generation: translation.generation,
      });
      return this.applyDurableTransition(session.sessionId, {
        kind: "settle_not_sent",
        inputId,
        generation: translation.generation,
      });
    }

    await this.options.controller.cancelPendingInput(inputId);
    const after = await this.options.controller.input(inputId);
    if (after) await this.requireInputIdentity(session, after, inputId);
    if (after?.delivery === "not_sent") {
      await this.releaseLeaseAfterProof(session.sessionId, {
        kind: "not_sent",
        sessionId: session.sessionId,
        inputId,
        generation: translation.generation,
      });
      return this.applyDurableTransition(session.sessionId, {
        kind: "settle_not_sent",
        inputId,
        generation: translation.generation,
      });
    }
    return this.refreshDurable(session.sessionId);
  }

  /**
   * Persist one translator checkpoint through exact, guarded durable transitions. This is the
   * production persistence hook for driveProviderTurn; it never writes the translator snapshot
   * wholesale, so a concurrent cancellation transition cannot be erased by an older checkpoint.
   */
  async checkpointProviderTranslation(snapshot: ProviderTurnTranslationState): Promise<SessionState> {
    if (!this.options.durableStore || !this.options.durableLease) {
      throw new Error("Provider translation checkpoints require durable production state");
    }
    let session = await this.refreshDurable(snapshot.sessionId);
    let current = session.providerTranslation;
    if (!current) {
      if ((session.generation ?? 0) >= snapshot.generation && (session.cosEventCursor ?? 0) >= snapshot.cursor) return session;
      throw new BridgeError("session_broken", "Durable provider translation is missing for the checkpoint generation");
    }
    if (current.inputId !== snapshot.inputId || current.generation !== snapshot.generation) {
      throw new BridgeError("session_broken", "Durable provider translation checkpoint identity does not match the active generation");
    }

    const refreshCurrent = (): ProviderTurnTranslationState => {
      const next = session.providerTranslation;
      if (!next) throw new BridgeError("session_broken", "Durable provider translation disappeared before terminal finalization");
      return next;
    };
    const apply = async (transition: DurableSessionTransition): Promise<void> => {
      session = await this.applyDurableTransition(snapshot.sessionId, transition);
      current = refreshCurrent();
    };

    if (snapshot.turnId && current.turnId !== snapshot.turnId) {
      await apply({ kind: "bind_turn", inputId: snapshot.inputId, generation: snapshot.generation, turnId: snapshot.turnId });
    }

    const finalSeqs = Object.keys(snapshot.assistantFinals)
      .map((value) => Number(value))
      .filter((value) => Number.isSafeInteger(value) && value > 0)
      .sort((a, b) => a - b);
    for (const seq of finalSeqs) {
      if (current.assistantFinals[String(seq)]) continue;
      const final = snapshot.assistantFinals[String(seq)];
      if (!final) continue;
      await apply({
        kind: "record_assistant_final",
        inputId: snapshot.inputId,
        generation: snapshot.generation,
        turnId: final.turnId,
        seq,
      });
    }

    if (snapshot.turnEndSeq !== undefined && current.turnEndSeq !== snapshot.turnEndSeq) {
      if (!snapshot.turnId || !snapshot.turnOutcome) {
        throw new BridgeError("session_broken", "Translator checkpoint has turn_end without exact turn identity/outcome");
      }
      await apply({
        kind: "record_turn_end",
        inputId: snapshot.inputId,
        generation: snapshot.generation,
        turnId: snapshot.turnId,
        seq: snapshot.turnEndSeq,
        outcome: snapshot.turnOutcome,
      });
      this.options.metrics?.increment("matchingTurnEndObserved");
      this.options.metrics?.markTurn(snapshot.sessionId, snapshot.generation, "turn_end");
    }

    if (snapshot.drainSeq !== undefined && current.drainSeq !== snapshot.drainSeq) {
      if (!snapshot.turnId || snapshot.finalAssistantSeq === undefined) {
        throw new BridgeError("session_broken", "Translator checkpoint has drain without exact turn/final identity");
      }
      await apply({
        kind: "record_drain",
        inputId: snapshot.inputId,
        generation: snapshot.generation,
        turnId: snapshot.turnId,
        seq: snapshot.drainSeq,
        finalAssistantSeq: snapshot.finalAssistantSeq,
      });
      this.options.metrics?.increment("matchingTurnDrainedObserved");
      this.options.metrics?.observeDrainHighWater(snapshot.drainSeq);
      this.options.metrics?.markTurn(snapshot.sessionId, snapshot.generation, "turn_drained");
    }

    const currentOffset = current.finalAssistantOffset ?? 0;
    const targetOffset = snapshot.finalAssistantOffset ?? 0;
    const snapshotFinalComplete = snapshot.finalAssistantSeq !== undefined && snapshot.finalAssistantSeq !== null &&
      snapshot.finalAssistantEmittedSeq === snapshot.finalAssistantSeq;
    const persistedFinalComplete = snapshot.finalAssistantSeq !== undefined && snapshot.finalAssistantSeq !== null &&
      current.finalAssistantEmittedSeq === snapshot.finalAssistantSeq;
    const needsRangeCheckpoint = targetOffset > currentOffset ||
      (snapshotFinalComplete && !persistedFinalComplete) ||
      (snapshot.finalAssistantTotalLength !== undefined && current.finalAssistantTotalLength === undefined);
    if (needsRangeCheckpoint) {
      if (!snapshot.turnId || snapshot.finalAssistantSeq === undefined || snapshot.finalAssistantSeq === null ||
          snapshot.finalAssistantTotalLength === undefined) {
        throw new BridgeError("session_broken", "Translator checkpoint has assistant range without exact final identity/length");
      }
      await apply({
        kind: "advance_assistant_range",
        inputId: snapshot.inputId,
        generation: snapshot.generation,
        turnId: snapshot.turnId,
        finalAssistantSeq: snapshot.finalAssistantSeq,
        expectedOffset: currentOffset,
        nextOffset: targetOffset,
        totalLength: snapshot.finalAssistantTotalLength,
        complete: snapshot.finalAssistantEmittedSeq === snapshot.finalAssistantSeq,
      });
    }

    if (snapshot.cursor > current.cursor) {
      await apply({ kind: "advance_cursor", inputId: snapshot.inputId, generation: snapshot.generation, seq: snapshot.cursor });
    }

    if (snapshot.terminal && current.terminal !== snapshot.terminal) {
      if (!snapshot.turnId) throw new BridgeError("session_broken", "Terminal translator checkpoint has no exact turn id");
      await apply({
        kind: "settle_terminal",
        inputId: snapshot.inputId,
        generation: snapshot.generation,
        turnId: snapshot.turnId,
        stopReason: snapshot.terminal,
      });
    }

    if (snapshot.terminal) {
      current = refreshCurrent();
      if (!current.turnId || current.drainSeq === undefined || current.terminal !== snapshot.terminal) {
        throw new BridgeError("session_broken", "Persisted terminal proof is incomplete");
      }
      if (!this.options.controller.session || !this.options.controller.requireBackgroundWorkDisabled) {
        throw new BridgeError("provider_policy_unavailable", "Terminal lease release requires fresh provider turn/policy attestation");
      }
      const summary = await this.options.controller.session(snapshot.sessionId);
      const attested = summary.providerTurn;
      if (!attested || attested.inputId !== snapshot.inputId || attested.turnId !== current.turnId ||
          attested.state !== "drained" || attested.drainedSeq !== current.drainSeq ||
          attested.finalAssistantSeq !== (current.finalAssistantSeq ?? null)) {
        throw new BridgeError("session_broken", "Fresh provider-turn attestation does not match persisted terminal proof");
      }
      try {
        await this.options.controller.requireBackgroundWorkDisabled(snapshot.sessionId);
      } catch {
        throw new BridgeError("provider_policy_unavailable", "Fresh backgroundWork=disabled attestation failed before lease release");
      }
      await this.releaseLeaseAfterProof(snapshot.sessionId, {
        kind: "drained",
        sessionId: snapshot.sessionId,
        inputId: snapshot.inputId,
        generation: snapshot.generation,
        turnId: current.turnId,
        drainSeq: current.drainSeq,
        cursor: current.cursor,
        terminal: current.terminal,
        policyAttested: true,
      });
      session = await this.applyDurableTransition(snapshot.sessionId, {
        kind: "finalize_terminal",
        inputId: snapshot.inputId,
        generation: snapshot.generation,
        turnId: current.turnId,
        stopReason: current.terminal,
      });
    }
    return session;
  }

  /**
   * Production controller-only turn driver. Every accepted output/cursor checkpoint is projected
   * through the narrow durable transition layer, and cancellation is re-read by exact generation
   * before each provider event so a concurrent ACP cancel cannot be lost inside the translator.
   */
  async driveDurableProviderTurn(
    controller: ProviderTurnController,
    options: DurableProviderTurnDriveOptions,
  ): Promise<DriveProviderTurnResult> {
    if (!this.options.durableStore || !this.options.durableLease) {
      throw new Error("Durable provider turn driving requires durable production state");
    }
    const session = await this.refreshDurable(options.sessionId);
    const active = session.providerTranslation;
    if (!active || session.activeInputId !== active.inputId || session.generation !== active.generation) {
      throw new BridgeError("session_broken", "No exact durable provider generation is available to drive");
    }

    return driveProviderTurn(controller, {
      sessionId: options.sessionId,
      inputId: active.inputId,
      generation: active.generation,
      state: active,
      cancelRequested: active.cancelRequested === true || session.cancelIntent === "requested",
      ...(options.chunkSize === undefined ? {} : { chunkSize: options.chunkSize }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      emit: options.emit,
      cancellationRequested: async () => {
        const latest = await this.readPersisted(options.sessionId);
        if (!latest) throw new BridgeError("session_broken", "Durable provider session disappeared while driving its turn");
        const translation = latest.providerTranslation;
        if (!translation || translation.inputId !== active.inputId || translation.generation !== active.generation) {
          throw new BridgeError("session_broken", "Durable provider generation changed while driving its turn");
        }
        return latest.cancelIntent === "requested" || translation.cancelRequested === true;
      },
      persist: async (snapshot) => {
        await this.checkpointProviderTranslation(snapshot);
      },
    });
  }

  /**
   * Resolve the narrow race where CoS accepted the provider input record but has not created a
   * native turn yet. A concurrent ACP cancel may authoritatively win as `not_sent`; that completes
   * the original prompt as cancelled without inventing a drain marker for a turn that never existed.
   */
  async awaitDurableProviderTurnOrCancelledNotSent(
    sessionId: string,
    options: { readonly pollMs?: number; readonly signal?: AbortSignal } = {},
  ): Promise<PendingProviderTurnCompletion> {
    if (!this.options.durableStore || !this.options.durableLease) {
      throw new Error("Pending provider-turn reconciliation requires durable production state");
    }
    if (!this.options.controller.session || !this.options.controller.input) {
      throw new BridgeError("session_broken", "Provider turn/input reconciliation APIs are unavailable");
    }
    // CoS exposes a 600 authenticated-read/minute controller budget. This wait runs before the
    // provider event SSE can take over, so a tight 25 ms loop can exhaust that entire budget in a
    // few seconds and then starve the stream that would deliver the authoritative turn events.
    // One active provider turn is supported; 500 ms keeps this reconciliation bounded while
    // adding at most half a second to the variance-sensitive end-to-end metric, not pre-send.
    const pollMs = options.pollMs ?? 500;
    let sentInputProven = false;
    for (;;) {
      if (options.signal?.aborted) throw options.signal.reason ?? new Error("Provider turn wait aborted");
      let session = await this.refreshDurable(sessionId);
      let current = session.providerTranslation;
      const inputId = session.activeInputId;
      if (!current || !inputId || current.inputId !== inputId || current.generation !== session.generation) {
        throw new BridgeError("session_broken", "Pending provider input lost its exact durable generation");
      }
      const generation = current.generation;

      const cancellationPending = session.cancelIntent === "requested" || current.cancelRequested === true;
      let input: Awaited<ReturnType<NonNullable<BridgeController["input"]>>> | undefined;
      if (!sentInputProven || cancellationPending) {
        try {
          input = await this.options.controller.input(inputId);
        } catch (cause) {
          if (cause && typeof cause === "object" && "retryable" in cause && (cause as { retryable?: unknown }).retryable === true) {
            await new Promise((resolve) => setTimeout(resolve, pollMs));
            continue;
          }
          throw cause;
        }
        if (input) {
          const exact = await this.refreshExactDurableGeneration(sessionId, inputId, generation);
          session = exact.session;
          current = exact.translation;
          await this.requireInputIdentity(session, input, inputId);
        }
        if (input?.delivery === "sent") {
          // `pending` is only admission authority, not proof that CoS created/accepted the
          // provider session. Keep first-session binding and interaction-mode promotion
          // provisional until an exact input read proves `sent`. This matters when ACP cancel
          // wins while the input is still pending: authoritative `not_sent` must be able to
          // unwind the create_pending binding and discard the pending mode transition.
          if (session.bindingState === "create_pending") {
            if (!session.canonicalCwd || !session.cosProjectId) {
              throw new BridgeError("session_broken", "Sent provider input lacks its tentative project binding");
            }
            session = await this.applyDurableTransition(sessionId, {
              kind: "binding",
              inputId,
              generation,
              bindingState: "bound",
              canonicalCwd: session.canonicalCwd,
              cosProjectId: session.cosProjectId,
            });
          }
          session = await this.applyDurableTransition(sessionId, { kind: "promote_mode", inputId, generation });
          const exact = await this.refreshExactDurableGeneration(sessionId, inputId, generation);
          session = exact.session;
          current = exact.translation;
          sentInputProven = true;
        }
      }

      if (sentInputProven) {
        let summary: Awaited<ReturnType<NonNullable<BridgeController["session"]>>>;
        try {
          summary = await this.options.controller.session(sessionId);
        } catch (cause) {
          if (cause && typeof cause === "object" && "retryable" in cause && (cause as { retryable?: unknown }).retryable === true) {
            await new Promise((resolve) => setTimeout(resolve, pollMs));
            continue;
          }
          throw cause;
        }
        {
          const exact = await this.refreshExactDurableGeneration(sessionId, inputId, generation);
          session = exact.session;
          current = exact.translation;
        }
        const turn = summary.providerTurn;
        if (turn && turn.inputId === inputId) {
          if (turn.state === "broken") throw new BridgeError("session_broken", "CoS marked the pending provider input broken");
          if (turn.state === "not_sent") {
            const exact = await this.refreshExactDurableGeneration(sessionId, inputId, generation);
            session = exact.session;
            current = exact.translation;
            if (session.cancelIntent !== "requested" && current.cancelRequested !== true) {
              throw new BridgeError("session_broken", "CoS reported not_sent without an authoritative cancellation intent");
            }
            await this.releaseLeaseAfterProof(sessionId, {
              kind: "not_sent",
              sessionId,
              inputId,
              generation,
            });
            session = await this.applyDurableTransition(sessionId, {
              kind: "settle_not_sent",
              inputId,
              generation,
            });
            this.sessions.set(sessionId, session);
            return { kind: "cancelled_not_sent" };
          }
          if (turn.turnId) {
            const exact = await this.refreshExactDurableGeneration(sessionId, inputId, generation);
            session = exact.session;
            current = exact.translation;
            session = await this.applyDurableTransition(sessionId, {
              kind: "bind_turn",
              inputId,
              generation,
              turnId: turn.turnId,
            });
            const rebound = await this.refreshExactDurableGeneration(sessionId, inputId, generation);
            session = rebound.session;
            current = rebound.translation;
            if (current.turnId !== turn.turnId || session.activeCosTurnId !== turn.turnId) {
              throw new BridgeError("session_broken", "Observed provider turn did not remain exactly bound");
            }
            if (session.cancelIntent === "requested" || current.cancelRequested === true) {
              session = await this.requestStopForBoundCancellation(sessionId, inputId, generation, turn.turnId);
              current = session.providerTranslation;
              if (!current || current.inputId !== inputId || current.generation !== generation) {
                throw new BridgeError("session_broken", "Provider generation changed after exact Stop reconciliation");
              }
            }
            this.sessions.set(sessionId, session);
            return { kind: "turn_ready" };
          }
        }
      }

      const authoritativeNotSent = input?.delivery === "not_sent";
      if (authoritativeNotSent) {
        const exact = await this.refreshExactDurableGeneration(sessionId, inputId, generation);
        session = exact.session;
        current = exact.translation;
        if (session.cancelIntent !== "requested" && current.cancelRequested !== true) {
          throw new BridgeError("session_broken", "CoS reported not_sent without an authoritative cancellation intent");
        }
        await this.releaseLeaseAfterProof(sessionId, {
          kind: "not_sent",
          sessionId,
          inputId,
          generation,
        });
        session = await this.applyDurableTransition(sessionId, {
          kind: "settle_not_sent",
          inputId,
          generation,
        });
        this.sessions.set(sessionId, session);
        return { kind: "cancelled_not_sent" };
      }

      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }

  /** Complete a terminal checkpoint left durable by a crash between settlement and lease delete. */
  async reconcilePersistedTerminal(sessionId: string): Promise<SessionState> {
    if (!this.options.durableStore || !this.options.durableLease) {
      throw new Error("Terminal reconciliation requires durable production state");
    }
    let session = await this.refreshDurable(sessionId);
    const current = session.providerTranslation;
    if (!current?.terminal) return session;
    if (!current.turnId || current.drainSeq === undefined || current.cursor < current.drainSeq) {
      throw new BridgeError("session_broken", "Persisted terminal proof is incomplete");
    }
    if (!this.options.controller.session || !this.options.controller.requireBackgroundWorkDisabled) {
      throw new BridgeError("provider_policy_unavailable", "Terminal reconciliation requires provider turn/policy attestation");
    }
    const summary = await this.options.controller.session(sessionId);
    const attested = summary.providerTurn;
    if (!attested || attested.inputId !== current.inputId || attested.turnId !== current.turnId ||
        attested.state !== "drained" || attested.drainedSeq !== current.drainSeq ||
        attested.finalAssistantSeq !== (current.finalAssistantSeq ?? null)) {
      throw new BridgeError("session_broken", "Persisted terminal proof no longer matches the provider turn attestation");
    }
    await this.options.controller.requireBackgroundWorkDisabled(sessionId);
    await this.releaseLeaseAfterProof(sessionId, {
      kind: "drained",
      sessionId,
      inputId: current.inputId,
      generation: current.generation,
      turnId: current.turnId,
      drainSeq: current.drainSeq,
      cursor: current.cursor,
      terminal: current.terminal,
      policyAttested: true,
    });
    session = await this.applyDurableTransition(sessionId, {
      kind: "finalize_terminal",
      inputId: current.inputId,
      generation: current.generation,
      turnId: current.turnId,
      stopReason: current.terminal,
    });
    return session;
  }

  initialize(_protocolVersion: number): InitializeResponse {
    void _protocolVersion;
    return {
      protocolVersion: 1,
      agentCapabilities: {
        promptCapabilities: {},
        sessionCapabilities: { resume: {} },
      },
      agentInfo: { name: "t3onsteroids", version: BRIDGE_VERSION },
    };
  }

  newSession(request: NewSessionRequest): NewSessionResponse {
    rejectAdditionalDirectories(request.additionalDirectories);
    const sessionId = this.makeUuid();
    this.sessions.set(sessionId, newUnboundSession(sessionId, request.cwd));
    return { sessionId };
  }

  async resumeSession(request: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    if (this.options.durableStore) {
      const persisted = await this.readPersisted(request.sessionId);
      const draft = this.sessions.get(request.sessionId);
      let existing = persisted ?? draft;

      if (!existing) {
        const reason: SessionState["recoveryReason"] = request.additionalDirectories?.length
          ? "additional_directories"
          : "unknown_resume";
        const broken: SessionState = {
          ...newUnboundSession(request.sessionId, request.cwd),
          bindingState: "broken",
          recoveryReason: reason,
        };
        const created = await this.options.durableStore.updateSession(request.sessionId, { kind: "create", state: broken });
        if (created.status === "updated" || created.status === "exists") this.sessions.set(request.sessionId, created.value);
        else this.sessions.set(request.sessionId, broken);
        return {};
      }

      if (existing.bindingState === "broken") {
        this.sessions.set(request.sessionId, existing);
        return {};
      }

      if (request.additionalDirectories?.length) {
        if (!persisted) existing = await this.ensureDurableCreated(existing);
        await this.markBroken(existing, "additional_directories");
        return {};
      }

      if (existing.canonicalCwd) {
        let actual: string;
        try {
          actual = await this.canonicalize(request.cwd);
        } catch {
          if (!persisted) existing = await this.ensureDurableCreated(existing);
          await this.markBroken(existing, "cwd_mismatch");
          return {};
        }
        if (actual !== existing.canonicalCwd) {
          if (!persisted) existing = await this.ensureDurableCreated(existing);
          await this.markBroken(existing, "cwd_mismatch");
          return {};
        }
      }
      this.resumedCwds.set(request.sessionId, request.cwd);
      this.sessions.set(request.sessionId, { ...existing, cwd: request.cwd });
      return {};
    }

    rejectAdditionalDirectories(request.additionalDirectories);
    const persisted = await this.readPersisted(request.sessionId);
    const existing = persisted ?? this.sessions.get(request.sessionId) ?? newUnboundSession(request.sessionId, request.cwd);
    if (existing.bindingState === "broken") throw new BridgeError("session_broken", "Session is marked broken and cannot be resumed automatically");
    if (existing.canonicalCwd) {
      const actual = await this.canonicalize(request.cwd);
      if (actual !== existing.canonicalCwd) throw new BridgeError("project_unmapped", "Resume cwd does not match the persisted canonical project root");
    }
    this.sessions.set(request.sessionId, { ...existing, cwd: request.cwd });
    return {};
  }

  async prompt(request: PromptRequest): Promise<{ input: CosInputRecord; session: SessionState }> {
    const promptReceivedAt = this.options.metrics?.monotonicTimestampMs();
    this.options.metrics?.increment("promptReceived");
    const inMemory = this.sessions.get(request.sessionId);
    let phaseStartedAt = this.options.metrics?.monotonicTimestampMs();
    const persisted = await this.readPersisted(request.sessionId);
    const persistedReadMs = phaseStartedAt === undefined ? 0 : this.options.metrics!.monotonicTimestampMs() - phaseStartedAt;
    let session = persisted ?? inMemory;
    const resumedCwd = this.resumedCwds.get(request.sessionId);
    if (this.options.durableStore && persisted && resumedCwd &&
        inMemory?.sessionId === persisted.sessionId &&
        inMemory.bindingState === persisted.bindingState &&
        inMemory.canonicalCwd === persisted.canonicalCwd) {
      // resumeSession validates canonical identity but intentionally keeps the caller's current raw
      // cwd as a process-local overlay. Preserve that validated spelling across every durable
      // transition in this process rather than letting an older persisted spelling replace it.
      session = { ...persisted, cwd: resumedCwd };
    }
    if (!session) throw new BridgeError("session_not_found", "ACP session is unknown");
    if (session.bindingState === "broken") throw new BridgeError("session_broken", "Session is marked broken and requires recovery");

    if (this.options.durableStore && session.providerTranslation?.terminal) {
      session = await this.reconcilePersistedTerminal(session.sessionId);
    }
    if (this.options.durableStore && session.cancelIntent === "requested") {
      session = await this.reconcilePersistedCancellation(session);
      if (session.cancelIntent === "requested") {
        throw new BridgeError("input_busy", "Persisted cancellation is still awaiting exact provider settlement");
      }
    } else if (session.cancelIntent === "requested") {
      throw new BridgeError("session_broken", "Pending cancellation must be reconciled before a new prompt");
    }
    const cwd = session.cwd;
    if (!cwd) throw new BridgeError("project_unmapped", "Session has no cwd");

    phaseStartedAt = this.options.metrics?.monotonicTimestampMs();
    const project = await this.options.controller.resolveProject(cwd);
    const projectResolveMs = phaseStartedAt === undefined ? 0 : this.options.metrics!.monotonicTimestampMs() - phaseStartedAt;
    phaseStartedAt = this.options.metrics?.monotonicTimestampMs();
    const canonicalRoot = await this.canonicalize(project.canonicalPath);
    const normalized = await normalizePrompt(request.prompt, session.interactionMode, canonicalRoot, this.canonicalize);
    const promptNormalizeMs = phaseStartedAt === undefined ? 0 : this.options.metrics!.monotonicTimestampMs() - phaseStartedAt;

    if (this.options.durableStore && session.providerTranslation) {
      const pendingInputId = session.providerTranslation.inputId;
      const generation = session.providerTranslation.generation;
      if (session.activeInputId !== pendingInputId) {
        throw new BridgeError("session_broken", "Active durable input identity does not match provider translation state");
      }

      if (session.bindingState === "create_pending" &&
          (session.canonicalCwd !== canonicalRoot || session.cosProjectId !== project.projectId)) {
        await this.markBroken(session, "project_remapped");
        throw new BridgeError("project_unmapped", "Pending provider binding no longer resolves to the same CoS project");
      }

      if (session.activeCosTurnId) {
        if (await this.durableLeaseState(session, pendingInputId, generation) !== "active") {
          await this.markBroken(session, "ambiguous_recovery");
          throw new BridgeError("session_broken", "Delivered provider turn no longer owns its exact durable lease");
        }
        if (session.bindingState === "create_pending") {
          session = await this.applyDurableTransition(session.sessionId, {
            kind: "binding",
            inputId: pendingInputId,
            generation,
            bindingState: "bound",
            canonicalCwd: canonicalRoot,
            cosProjectId: project.projectId,
          });
        }
        session = await this.applyDurableTransition(session.sessionId, { kind: "promote_mode", inputId: pendingInputId, generation });
        throw new BridgeError("input_busy", "The previously delivered provider turn must finish before a new prompt is admitted");
      }

      const matchingLease = await this.durableLeaseState(session, pendingInputId, generation);
      if (matchingLease === "missing") {
        // No matching profile lease means this prepared input never had authority to POST (or a
        // proven-not-sent release already won). Clear only this exact generation and continue.
        session = await this.applyDurableTransition(session.sessionId, {
          kind: "settle_not_sent",
          inputId: pendingInputId,
          generation,
        });
      } else if (session.inputDispatchState === "prepared" && session.dispatchInputId === pendingInputId) {
        // Crash after acquiring the lease but before the durable dispatched marker: POST was not
        // authorized yet, so exact not-sent proof is local and deterministic.
        await this.releaseLeaseAfterProof(session.sessionId, {
          kind: "not_sent",
          sessionId: session.sessionId,
          inputId: pendingInputId,
          generation,
        });
        session = await this.applyDurableTransition(session.sessionId, {
          kind: "settle_not_sent",
          inputId: pendingInputId,
          generation,
        });
      } else {

        if (!this.options.controller.input) {
          throw new BridgeError("input_busy", "Outstanding provider input cannot be reconciled without the input read API");
        }
        const existing = await this.options.controller.input(pendingInputId);
        if (!existing) {
          // An accepted provider input is durable in both the input journal and
          // `currentProviderTurn`. If the exact row is absent but CoS still attests a
          // different, already-drained provider turn whose drain marker is no newer than
          // the cursor this bridge had persisted before this dispatch, the missing input
          // never advanced CoS's provider owner. That is exact no-admission proof, not a
          // silence timeout. Keep every other missing-row case ambiguous.
          if (!this.options.controller.session) {
            throw new BridgeError("input_busy", "Outstanding provider input is still delivery-unconfirmed");
          }
          const summary = await this.options.controller.session(session.sessionId);
          const prior = summary.providerTurn;
          const cursor = session.cosEventCursor ?? 0;
          const provenNotAdmitted = prior?.inputId !== pendingInputId &&
            prior?.state === "drained" &&
            prior.drainedSeq !== null &&
            prior.drainedSeq <= cursor;
          if (!provenNotAdmitted) {
            throw new BridgeError("input_busy", "Outstanding provider input is still delivery-unconfirmed");
          }
          await this.releaseLeaseAfterProof(session.sessionId, {
            kind: "not_sent",
            sessionId: session.sessionId,
            inputId: pendingInputId,
            generation,
          });
          session = await this.applyDurableTransition(session.sessionId, {
            kind: "settle_not_sent",
            inputId: pendingInputId,
            generation,
          });
        } else if (existing.delivery === "unconfirmed" || existing.delivery === undefined) {
          throw new BridgeError("input_busy", "Outstanding provider input is still delivery-unconfirmed");
        } else {
          await this.requireInputIdentity(session, existing, pendingInputId);
          if (existing.delivery === "not_sent") {
          await this.releaseLeaseAfterProof(session.sessionId, {
            kind: "not_sent",
            sessionId: session.sessionId,
            inputId: pendingInputId,
            generation,
          });
          session = await this.applyDurableTransition(session.sessionId, { kind: "settle_not_sent", inputId: pendingInputId, generation });
          } else {
            this.options.metrics?.increment("cosInputAcceptedOrReconciled");
            if (session.bindingState === "create_pending") {
              session = await this.applyDurableTransition(session.sessionId, {
                kind: "binding",
                inputId: pendingInputId,
                generation,
                bindingState: "bound",
                canonicalCwd: canonicalRoot,
                cosProjectId: project.projectId,
              });
            }
            session = await this.applyDurableTransition(session.sessionId, { kind: "promote_mode", inputId: pendingInputId, generation });
            throw new BridgeError("input_busy", "The previously accepted provider input must finish before a new prompt is admitted");
          }
        }
      }
    }

    if (!this.options.durableStore && session.bindingState === "create_pending") {
      if (!session.activeInputId || !this.options.controller.input) {
        throw new BridgeError("project_unmapped", "Pending first CoS send requires reconciliation before retry");
      }
      const pendingInputId = session.activeInputId;
      const existing = await this.options.controller.input(pendingInputId);
      if (!existing) throw new BridgeError("project_unmapped", "Pending first CoS send could not be reconciled safely");
      session = {
        ...session,
        bindingState: "bound",
        canonicalCwd: canonicalRoot,
        cosProjectId: project.projectId,
      };
      await this.persistWholeForReference(session);
      this.sessions.set(session.sessionId, session);
    }

    if (session.bindingState === "bound") {
      if (session.canonicalCwd !== canonicalRoot || session.cosProjectId !== project.projectId) {
        await this.markBroken(session, "project_remapped");
        throw new BridgeError("project_unmapped", "Bound project root no longer resolves to the same CoS project");
      }
    }

    phaseStartedAt = this.options.metrics?.monotonicTimestampMs();
    await this.requirePromptReadiness(session);
    const readinessMs = phaseStartedAt === undefined ? 0 : this.options.metrics!.monotonicTimestampMs() - phaseStartedAt;

    const first = session.bindingState === "unbound";
    const inputId = first ? session.sessionId : this.makeUuid();
    const generation = (session.generation ?? 0) + 1;
    this.options.metrics?.beginTurn(request.sessionId, generation, promptReceivedAt);
    let durablePrepareMs = 0;
    let leaseAcquireMs = 0;
    let markDispatchedMs = 0;
    if (this.options.durableStore) {
      const leaseId = randomUUID().toLowerCase();
      phaseStartedAt = this.options.metrics?.monotonicTimestampMs();
      if (first && !persisted) {
        // session/new is intentionally memory-only. On the first prompt, persist the complete
        // pre-POST recovery checkpoint atomically instead of serializing three separate session
        // writes (create -> begin_input -> create_pending binding). This state is still strictly
        // before send authority: inputDispatchState=prepared, and a crash before lease acquisition
        // is reconciled as proven not-sent exactly like the previous multi-transition sequence.
        const prepared: SessionState = {
          ...session,
          bindingState: "create_pending",
          canonicalCwd: canonicalRoot,
          cosProjectId: project.projectId,
          activeInputId: inputId,
          inputDispatchState: "prepared",
          dispatchInputId: inputId,
          admissionLeaseId: leaseId,
          generation,
          providerTranslation: newProviderTurnTranslationState({
            sessionId: session.sessionId,
            inputId,
            generation,
            cancelRequested: false,
          }),
          pendingInteractionMode: normalized.interactionMode,
          modeTransitionInputId: inputId,
        };
        const created = await this.options.durableStore.updateSession(session.sessionId, { kind: "create", state: prepared });
        if (created.status !== "updated") {
          throw new BridgeError("input_busy", "Concurrent durable state appeared while the first provider input was being prepared");
        }
        session = created.value;
        this.sessions.set(session.sessionId, session);
      } else {
        session = await this.applyDurableTransition(session.sessionId, {
          kind: "begin_input",
          inputId,
          generation,
          leaseId,
          pendingInteractionMode: normalized.interactionMode,
        });
        if (first) {
          session = await this.applyDurableTransition(session.sessionId, {
            kind: "binding",
            inputId,
            generation,
            bindingState: "create_pending",
            canonicalCwd: canonicalRoot,
            cosProjectId: project.projectId,
          });
        }
      }
      durablePrepareMs = phaseStartedAt === undefined ? 0 : this.options.metrics!.monotonicTimestampMs() - phaseStartedAt;
      try {
        phaseStartedAt = this.options.metrics?.monotonicTimestampMs();
        await this.acquireLease(session.sessionId, inputId, generation, leaseId);
        leaseAcquireMs = phaseStartedAt === undefined ? 0 : this.options.metrics!.monotonicTimestampMs() - phaseStartedAt;
        phaseStartedAt = this.options.metrics?.monotonicTimestampMs();
        session = await this.applyDurableTransition(session.sessionId, { kind: "mark_dispatched", inputId, generation });
        markDispatchedMs = phaseStartedAt === undefined ? 0 : this.options.metrics!.monotonicTimestampMs() - phaseStartedAt;
      } catch (error) {
        const latest = await this.readPersisted(session.sessionId);
        if (latest?.generation === generation && latest.providerTranslation?.inputId === inputId &&
            latest.activeInputId === inputId) {
          if (await this.durableLeaseState(latest, inputId, generation) !== "missing") {
            await this.releaseLeaseAfterProof(session.sessionId, {
              kind: "not_sent", sessionId: session.sessionId, inputId, generation,
            });
          }
          try {
            await this.applyDurableTransition(session.sessionId, { kind: "settle_not_sent", inputId, generation });
          } catch (settleError) {
            const settled = await this.readPersisted(session.sessionId);
            if (settleError instanceof BridgeError && settleError.code === "session_broken" &&
                settled?.generation === generation && !settled.activeInputId && !settled.activeCosTurnId &&
                !settled.providerTranslation && !settled.cancelTargetTurnId && settled.cancelIntent === "none" &&
                !settled.inputDispatchState && !settled.dispatchInputId && !settled.admissionLeaseId &&
                !settled.pendingInteractionMode && !settled.modeTransitionInputId &&
                settled.bindingState !== "create_pending") {
              throw new BridgeError("cancelled", "Provider input was cancelled before dispatch");
            }
            throw settleError;
          }
        } else if (latest?.generation === generation && !latest.providerTranslation && !latest.activeInputId &&
            error instanceof BridgeError && (error.code === "session_broken" || error.code === "cancelled")) {
          throw new BridgeError("cancelled", "Provider input was cancelled before dispatch");
        }
        throw error;
      }
    } else {
      await this.acquireLease(session.sessionId, inputId, generation);
      session = withInteractionMode(session, normalized.interactionMode);
      if (first) {
        session = {
          ...session,
          bindingState: "create_pending",
          canonicalCwd: canonicalRoot,
          cosProjectId: project.projectId,
          activeInputId: inputId,
        };
        await this.persistWholeForReference(session);
      }
    }

    phaseStartedAt = this.options.metrics?.monotonicTimestampMs();
    const input = await this.options.controller.send({
      id: inputId,
      text: normalized.text,
      ...(first ? { projectId: project.projectId, providerPolicy: v1ProviderSessionPolicy } : { sessionId: session.sessionId }),
    });
    const inputSendMs = phaseStartedAt === undefined ? 0 : this.options.metrics!.monotonicTimestampMs() - phaseStartedAt;
    this.options.metrics?.observePreSendPhases(session.sessionId, generation, {
      persistedReadMs,
      projectResolveMs,
      promptNormalizeMs,
      readinessMs,
      durablePrepareMs,
      leaseAcquireMs,
      markDispatchedMs,
      inputSendMs,
    });

    if (this.options.durableStore) {
      await this.requireInputIdentity(session, input, inputId);
      if (input.delivery === "not_sent") {
        await this.releaseLeaseAfterProof(session.sessionId, { kind: "not_sent", sessionId: session.sessionId, inputId, generation });
        session = await this.applyDurableTransition(session.sessionId, { kind: "settle_not_sent", inputId, generation });
        throw new BridgeError("session_broken", "CoS authoritatively reported that the provider input was not sent");
      }
      if (input.delivery !== "sent" && input.delivery !== "pending") {
        throw new BridgeError("input_busy", "CoS input delivery remains unconfirmed; the durable lease is retained for reconciliation");
      }
      this.options.metrics?.increment("cosInputAcceptedOrReconciled");
      this.options.metrics?.markTurn(session.sessionId, generation, "cos_input_accepted");
      if (input.delivery === "sent") {
        if (first) {
          session = await this.applyDurableTransition(session.sessionId, {
            kind: "binding",
            inputId,
            generation,
            bindingState: "bound",
            canonicalCwd: canonicalRoot,
            cosProjectId: project.projectId,
          });
        }
        session = await this.applyDurableTransition(session.sessionId, { kind: "promote_mode", inputId, generation });
      }
    } else {
      if (input.delivery === "sent" || input.delivery === "pending") {
        this.options.metrics?.increment("cosInputAcceptedOrReconciled");
        this.options.metrics?.markTurn(session.sessionId, generation, "cos_input_accepted");
      }
      session = {
        ...session,
        bindingState: "bound",
        canonicalCwd: canonicalRoot,
        cosProjectId: project.projectId,
        activeInputId: input.id,
      };
      await this.persistWholeForReference(session);
      this.sessions.set(session.sessionId, session);
    }
    return { input, session };
  }

  async cancel(sessionId: string): Promise<void> {
    const persisted = await this.readPersisted(sessionId);
    let session = this.options.durableStore ? (persisted ?? this.sessions.get(sessionId)) : (this.sessions.get(sessionId) ?? persisted);
    if (!session) throw new BridgeError("session_not_found", "ACP session is unknown");
    const activeInputId = session.activeInputId;
    if (!activeInputId) return;

    if (this.options.durableStore) {
      const generation = session.generation;
      if (!generation || !session.providerTranslation || session.providerTranslation.inputId !== activeInputId) {
        throw new BridgeError("session_broken", "Durable cancellation target is not bound to an exact provider generation");
      }
      const turnId = session.activeCosTurnId;
      session = await this.applyDurableTransition(sessionId, {
        kind: "set_cancel",
        inputId: activeInputId,
        generation,
        ...(turnId ? { turnId } : {}),
      });
      if (turnId) {
        if (this.options.controller.requestStopExactTurn) {
          await this.options.controller.requestStopExactTurn(sessionId, turnId);
        } else {
          if (!this.options.controller.stopExactTurn) throw new BridgeError("session_broken", "Exact-turn Stop is unavailable");
          await this.options.controller.stopExactTurn(sessionId, turnId);
        }
      } else {
        const latest = await this.refreshDurable(sessionId);
        if (latest.generation !== generation) {
          throw new BridgeError("session_broken", "Pending cancellation generation changed during reconciliation");
        }
        if (latest.activeInputId !== activeInputId) {
          if (!latest.providerTranslation && !latest.activeInputId && latest.cancelIntent === "none") return;
          throw new BridgeError("session_broken", "Pending cancellation target changed during reconciliation");
        }
        if (latest.inputDispatchState === "prepared") {
          const leaseId = latest.admissionLeaseId;
          if (leaseId && this.options.durableLease) {
            const queued = await this.options.durableLease.cancelQueued(leaseId);
            if (queued === "active") {
              await this.releaseLeaseAfterProof(sessionId, {
                kind: "not_sent", sessionId, inputId: activeInputId, generation,
              });
            }
          }
          try {
            await this.applyDurableTransition(sessionId, {
              kind: "settle_not_sent", inputId: activeInputId, generation,
            });
          } catch (error) {
            // The waiting prompt can observe its removed queue ticket and settle the same exact
            // not-sent generation before this cancel request reaches the journal transition.
            // Accept only that fully settled generation; any changed or still-pending state
            // remains a hard failure.
            const settled = await this.readPersisted(sessionId);
            if (!(error instanceof BridgeError) || error.code !== "session_broken" ||
                settled?.generation !== generation || settled.activeInputId || settled.providerTranslation ||
                settled.cancelIntent !== "none") {
              throw error;
            }
          }
          return;
        }
        if (!this.options.controller.cancelPendingInput) throw new BridgeError("session_broken", "Pending-input cancellation is unavailable");
        await this.options.controller.cancelPendingInput(activeInputId);
      }
      // A delivered provider turn remains owned by this exact durable lease through turn_drained.
      // Pending-input non-delivery is likewise reconciled separately before release.
      return;
    }

    if (session.activeCosTurnId) {
      const cancelTargetTurnId = session.activeCosTurnId;
      session = { ...session, cancelIntent: "requested", cancelTargetTurnId };
      await this.persistWholeForReference(session);
      this.sessions.set(sessionId, session);
      if (!this.options.controller.stopExactTurn) throw new BridgeError("session_broken", "Exact-turn Stop is unavailable");
      await this.options.controller.stopExactTurn(sessionId, cancelTargetTurnId);
    } else {
      session = { ...session, cancelIntent: "requested" };
      await this.persistWholeForReference(session);
      this.sessions.set(sessionId, session);
      if (!this.options.controller.cancelPendingInput) throw new BridgeError("session_broken", "Pending-input cancellation is unavailable");
      await this.options.controller.cancelPendingInput(activeInputId);
    }

    const cleared: SessionState = {
      sessionId: session.sessionId,
      bindingState: session.bindingState,
      interactionMode: session.interactionMode,
      cancelIntent: "none",
      ...(session.cwd === undefined ? {} : { cwd: session.cwd }),
      ...(session.canonicalCwd === undefined ? {} : { canonicalCwd: session.canonicalCwd }),
      ...(session.cosProjectId === undefined ? {} : { cosProjectId: session.cosProjectId }),
      ...(session.activeInputId === undefined ? {} : { activeInputId: session.activeInputId }),
      ...(session.activeCosTurnId === undefined ? {} : { activeCosTurnId: session.activeCosTurnId }),
    };
    await this.persistWholeForReference(cleared);
    this.sessions.set(sessionId, cleared);
    if (this.options.lease && this.options.controllerIdentity) {
      await this.options.lease.release(this.options.controllerIdentity, this.ownerId);
    }
  }
}
