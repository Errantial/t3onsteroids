import { Readable, Writable } from "node:stream";
import { join } from "node:path";
import * as acp from "@agentclientprotocol/sdk";

import { AcpBridgeRuntime } from "./index.js";
import { BridgeError } from "./index.js";
import { CosControllerError } from "../cos/index.js";
import { CosControllerClient, discoverCosController } from "../cos/index.js";
import { createProductionStateContext } from "../state/index.js";
import type { ProviderTurnOutputEffect } from "../translate/driver.js";
import { TranslationError } from "../translate/events.js";
import { BridgeMetrics } from "../metrics.js";

export interface ProductionAcpOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly stdin?: Readable;
  readonly stdout?: Writable;
  readonly metrics?: BridgeMetrics;
}

function cosUserDataDirectory(env: NodeJS.ProcessEnv): string {
  if (env.T3ONSTEROIDS_COS_USER_DATA_DIR) return env.T3ONSTEROIDS_COS_USER_DATA_DIR;
  if (!env.APPDATA) throw new Error("APPDATA is required unless T3ONSTEROIDS_COS_USER_DATA_DIR is set");
  return join(env.APPDATA, "chat-on-steroids");
}

function toolStatus(outcome: string): "completed" | "failed" {
  return /^(?:ok|success|succeeded|completed)$/i.test(outcome) ? "completed" : "failed";
}

function safeRequestError(error: unknown): never {
  if (error instanceof BridgeError || error instanceof TranslationError || error instanceof CosControllerError) {
    throw new acp.RequestError(-32000, "Bridge request failed", { code: error.code });
  }
  throw new acp.RequestError(-32000, "Bridge internal error", { code: "internal_error" });
}

export function updateForEffect(effect: ProviderTurnOutputEffect, notices = false): acp.SessionUpdate | null {
  switch (effect.kind) {
    case "assistant_chunk":
      return {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: effect.text },
      };
    case "tool_call":
      return {
        sessionUpdate: "tool_call",
        toolCallId: effect.id,
        title: effect.title,
        status: toolStatus(effect.outcome),
        ...(effect.changes.length > 0
          ? { locations: effect.changes.map((change) => ({ path: change.path })) }
          : {}),
      };
    case "page_tool":
      return {
        sessionUpdate: "tool_call",
        toolCallId: effect.id,
        title: effect.title,
        kind: "other",
        status: "completed",
      };
    case "provider_error":
      return notices
        ? { sessionUpdate: "notice", severity: "error", title: "Provider error" }
        : null;
    case "activity":
      return notices && (effect.category === "progress" || effect.category === "note")
        ? {
            sessionUpdate: "notice",
            severity: "info",
            title: effect.category === "progress" ? "Provider progress" : "Provider note",
            ...(effect.text ? { description: effect.text } : {}),
          }
        : null;
    case "terminal":
      return null;
  }
}

export async function runProductionAcpStdio(options: ProductionAcpOptions = {}): Promise<void> {
  const env = options.env ?? process.env;
  const metrics = options.metrics ?? new BridgeMetrics();
  const userDataDir = cosUserDataDirectory(env);
  const state = await createProductionStateContext(userDataDir, env);
  const controller = new CosControllerClient(() => discoverCosController(userDataDir), undefined, undefined, metrics);
  let clientNotices = false;
  const runtime = new AcpBridgeRuntime({
    controller,
    durableStore: state.sessionStore,
    durableLease: state.admissionLease,
    metrics,
  });

  const app = acp
    .agent({ name: "t3onsteroids" })
    .onRequest(acp.methods.agent.initialize, ({ params }) => {
      clientNotices = params.clientCapabilities?.session?.notices != null;
      return runtime.initialize(params.protocolVersion);
    })
    .onRequest(acp.methods.agent.session.new, ({ params }) => {
      try {
        return runtime.newSession(params);
      } catch (error) {
        return safeRequestError(error);
      }
    })
    .onRequest(acp.methods.agent.session.resume, async ({ params }) => {
      try {
        return await runtime.resumeSession(params);
      } catch (error) {
        return safeRequestError(error);
      }
    })
    .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
      try {
        await runtime.prompt(params);
        const admission = await runtime.awaitDurableProviderTurnOrCancelledNotSent(params.sessionId);
        if (admission.kind === "cancelled_not_sent") {
          metrics.increment("acpTerminalSent");
          return { stopReason: "cancelled" };
        }
        const result = await runtime.driveDurableProviderTurn(controller, {
          sessionId: params.sessionId,
          emit: async (effect) => {
            const update = updateForEffect(effect, clientNotices);
            if (!update) return;
            await client.notify(acp.methods.client.session.update, {
              sessionId: params.sessionId,
              update,
            });
          },
        });
        if (!result.terminal) throw new Error("Provider event stream ended before authoritative terminal proof");
        metrics.increment("acpTerminalSent");
        const terminalSession = await state.sessionStore.readSession(params.sessionId);
        if (terminalSession.status === "found" && terminalSession.value.generation) {
          metrics.markTurn(params.sessionId, terminalSession.value.generation, "acp_terminal_sent");
        }
        return { stopReason: result.terminal.stopReason };
      } catch (error) {
        return safeRequestError(error);
      }
    })
    .onNotification(acp.methods.agent.session.cancel, async ({ params }) => {
      try {
        await runtime.cancel(params.sessionId);
      } catch (error) {
        safeRequestError(error);
      }
    });

  const stdout = options.stdout ?? process.stdout;
  const stdin = options.stdin ?? process.stdin;
  const stream = acp.ndJsonStream(
    Writable.toWeb(stdout) as unknown as WritableStream<Uint8Array>,
    Readable.toWeb(stdin) as unknown as ReadableStream<Uint8Array>,
  );
  const connection = app.connect(stream);
  await connection.closed;
}
