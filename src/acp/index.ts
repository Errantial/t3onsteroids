import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { ContentBlock, InitializeResponse, NewSessionRequest, NewSessionResponse, PromptRequest, ResumeSessionRequest, ResumeSessionResponse } from "@agentclientprotocol/sdk";

import type { CosControllerReadiness, CosInputRecord, CosSessionSummary } from "../cos/index.js";
import { v1ProviderSessionPolicy } from "../policy/index.js";
import { newUnboundSession, type InteractionMode, type SessionState, withInteractionMode } from "../session/index.js";
import type { AdmissionLease, StateStore } from "../state/index.js";

export const PINNED_T3_SHA = "ffb4af8d5d4fcfc5e9322295ff846a6d1e7ffbf8";
export const MAX_COS_INPUT_CHARS = 64_000;

export type BridgeErrorCode =
  | "session_not_found"
  | "additional_directories_unsupported"
  | "t3_prompt_contract_mismatch"
  | "unsupported_command"
  | "unsupported_prompt_content"
  | "resource_link_unavailable"
  | "input_too_large"
  | "project_unmapped"
  | "input_busy"
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
  cancelPendingInput?(inputId: string): Promise<void>;
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
  readonly store: StateStore<SessionState>;
  readonly lease?: AdmissionLease;
  readonly controllerIdentity?: string;
  readonly ownerId?: string;
  readonly makeUuid?: () => string;
  readonly canonicalize?: (path: string) => Promise<string>;
}

const PLAN_GUIDANCE = "Plan mode: investigate read-only and return a plan. Do not make changes.";

function rejectAdditionalDirectories(additionalDirectories: readonly string[] | undefined): void {
  if (additionalDirectories && additionalDirectories.length > 0) {
    throw new BridgeError("additional_directories_unsupported", "additionalDirectories are not supported in v1");
  }
}

function parseKnownT3Envelope(text: string, currentMode: InteractionMode): { text: string; mode: InteractionMode } {
  if (text.startsWith("/")) throw new BridgeError("unsupported_command", "Native T3 slash commands are not supported in v1");
  if (!text.includes("<t3_code_instructions>")) return { text, mode: currentMode };

  const match = text.match(/^<t3_code_instructions>[\s\S]*?<user_request>([\s\S]*?)<\/user_request>[\s\S]*?<\/t3_code_instructions>$/);
  if (!match) throw new BridgeError("t3_prompt_contract_mismatch", "Pinned T3 prompt wrapper did not match the supported contract");
  const instructions = text.slice(0, text.indexOf("<user_request>"));
  let mode = currentMode;
  if (/\bplan\b/i.test(instructions)) mode = "plan";
  else if (/\bdefault\b/i.test(instructions)) mode = "default";
  return { text: match[1]!, mode };
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
  private readonly makeUuid: () => string;
  private readonly canonicalize: (path: string) => Promise<string>;
  private readonly ownerId: string;

  constructor(private readonly options: BridgeRuntimeOptions) {
    this.makeUuid = options.makeUuid ?? (() => randomUUID().toLowerCase());
    this.canonicalize = options.canonicalize ?? realpath;
    this.ownerId = options.ownerId ?? randomUUID().toLowerCase();
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
        const broken = { ...session, bindingState: "broken" as const };
        await this.options.store.write(session.sessionId, broken);
        this.sessions.set(session.sessionId, broken);
        throw new BridgeError("provider_policy_unavailable", "Provider-session policy attestation was lost");
      }
    }
  }

  private async acquireLease(sessionId: string, inputId: string): Promise<void> {
    if (!this.options.lease || !this.options.controllerIdentity) return;
    const acquired = await this.options.lease.acquire({
      controllerIdentity: this.options.controllerIdentity,
      sessionId,
      inputId,
      generation: 0,
      ownerId: this.ownerId,
    });
    if (!acquired) throw new BridgeError("input_busy", "Another T3→CoS turn is already active for this CoS controller identity");
  }

  private async releaseLease(): Promise<void> {
    if (!this.options.lease || !this.options.controllerIdentity) return;
    await this.options.lease.release(this.options.controllerIdentity, this.ownerId);
  }

  initialize(protocolVersion: number): InitializeResponse {
    return {
      protocolVersion,
      agentCapabilities: {
        promptCapabilities: {},
        sessionCapabilities: { resume: {} },
      },
      agentInfo: { name: "t3onsteroids", version: "0.0.0" },
    };
  }

  newSession(request: NewSessionRequest): NewSessionResponse {
    rejectAdditionalDirectories(request.additionalDirectories);
    const sessionId = this.makeUuid();
    this.sessions.set(sessionId, newUnboundSession(sessionId, request.cwd));
    return { sessionId };
  }

  async resumeSession(request: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    rejectAdditionalDirectories(request.additionalDirectories);
    const persisted = await this.options.store.read(request.sessionId);
    const existing = this.sessions.get(request.sessionId) ?? persisted ?? newUnboundSession(request.sessionId, request.cwd);
    if (existing.bindingState === "broken") throw new BridgeError("session_broken", "Session is marked broken and cannot be resumed automatically");
    if (existing.canonicalCwd) {
      const actual = await this.canonicalize(request.cwd);
      if (actual !== existing.canonicalCwd) throw new BridgeError("project_unmapped", "Resume cwd does not match the persisted canonical project root");
    }
    this.sessions.set(request.sessionId, { ...existing, cwd: request.cwd });
    return {};
  }

  async prompt(request: PromptRequest): Promise<{ input: CosInputRecord; session: SessionState }> {
    let session = this.sessions.get(request.sessionId) ?? (await this.options.store.read(request.sessionId));
    if (!session) throw new BridgeError("session_not_found", "ACP session is unknown");
    if (session.bindingState === "broken") throw new BridgeError("session_broken", "Session is marked broken and requires recovery");
    if (session.cancelIntent === "requested") throw new BridgeError("session_broken", "Pending cancellation must be reconciled before a new prompt");
    const cwd = session.cwd;
    if (!cwd) throw new BridgeError("project_unmapped", "Session has no cwd");

    const project = await this.options.controller.resolveProject(cwd);
    const canonicalRoot = await this.canonicalize(project.canonicalPath);
    const normalized = await normalizePrompt(request.prompt, session.interactionMode, canonicalRoot, this.canonicalize);

    if (session.bindingState === "create_pending") {
      if (!session.activeInputId || !this.options.controller.input) {
        throw new BridgeError("project_unmapped", "Pending first CoS send requires reconciliation before retry");
      }
      const existing = await this.options.controller.input(session.activeInputId);
      if (!existing) throw new BridgeError("project_unmapped", "Pending first CoS send could not be reconciled safely");
      session = {
        ...session,
        bindingState: "bound",
        canonicalCwd: canonicalRoot,
        cosProjectId: project.projectId,
      };
      await this.options.store.write(session.sessionId, session);
      this.sessions.set(session.sessionId, session);
    }

    if (session.bindingState === "bound") {
      if (session.canonicalCwd !== canonicalRoot || session.cosProjectId !== project.projectId) {
        const broken = { ...session, bindingState: "broken" as const };
        await this.options.store.write(session.sessionId, broken);
        this.sessions.set(session.sessionId, broken);
        throw new BridgeError("project_unmapped", "Bound project root no longer resolves to the same CoS project");
      }
    }

    await this.requirePromptReadiness(session);

    const first = session.bindingState === "unbound";
    const inputId = first ? session.sessionId : this.makeUuid();
    await this.acquireLease(session.sessionId, inputId);
    session = withInteractionMode(session, normalized.interactionMode);
    if (first) {
      session = {
        ...session,
        bindingState: "create_pending",
        canonicalCwd: canonicalRoot,
        cosProjectId: project.projectId,
        activeInputId: inputId,
      };
      await this.options.store.write(session.sessionId, session);
    }

    const input = await this.options.controller.send({
      id: inputId,
      text: normalized.text,
      ...(first ? { projectId: project.projectId, providerPolicy: v1ProviderSessionPolicy } : { sessionId: session.sessionId }),
    });

    session = {
      ...session,
      bindingState: "bound",
      canonicalCwd: canonicalRoot,
      cosProjectId: project.projectId,
      activeInputId: input.id,
    };
    await this.options.store.write(session.sessionId, session);
    this.sessions.set(session.sessionId, session);
    return { input, session };
  }

  async cancel(sessionId: string): Promise<void> {
    let session = this.sessions.get(sessionId) ?? (await this.options.store.read(sessionId));
    if (!session) throw new BridgeError("session_not_found", "ACP session is unknown");
    const activeInputId = session.activeInputId;
    if (!activeInputId) return;

    if (session.activeCosTurnId) {
      const cancelTargetTurnId = session.activeCosTurnId;
      session = { ...session, cancelIntent: "requested", cancelTargetTurnId };
      await this.options.store.write(sessionId, session);
      this.sessions.set(sessionId, session);
      if (!this.options.controller.stopExactTurn) throw new BridgeError("session_broken", "Exact-turn Stop is unavailable");
      await this.options.controller.stopExactTurn(sessionId, cancelTargetTurnId);
    } else {
      session = { ...session, cancelIntent: "requested" };
      await this.options.store.write(sessionId, session);
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
    await this.options.store.write(sessionId, cleared);
    this.sessions.set(sessionId, cleared);
    await this.releaseLease();
  }
}
