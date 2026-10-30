import { Readable, Writable } from "node:stream";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as acp from "@agentclientprotocol/sdk";

import { AcpBridgeRuntime } from "./index.js";
import { BridgeError } from "./index.js";
import { CosControllerError } from "../cos/index.js";
import { CosControllerClient, discoverCosController, type CosControllerTransport } from "../cos/index.js";
import { createProductionStateContext } from "../state/index.js";
import { StateIoError, StateLockBusyError, UnsupportedStateFilesystemError } from "../state/index.js";
import type { ProviderTurnOutputEffect } from "../translate/driver.js";
import { TranslationError } from "../translate/events.js";
import { BridgeMetrics } from "../metrics.js";

export interface ProductionAcpOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly stdin?: Readable;
  readonly stdout?: Writable;
  readonly metrics?: BridgeMetrics;
  /**
   * Internal live-qualification hook only. The public CLI never sets this, and it does not
   * change releaseReadiness() or the advertised supportedConcurrency capability.
   */
  readonly qualification?: {
    readonly maxConcurrentTurns: 2 | 4;
    readonly maxQueuedTurns: number;
    readonly transport?: CosControllerTransport;
  };
}

function cosUserDataDirectory(env: NodeJS.ProcessEnv): string {
  if (env.T3ONSTEROIDS_COS_USER_DATA_DIR) return env.T3ONSTEROIDS_COS_USER_DATA_DIR;
  if (!env.APPDATA) throw new Error("APPDATA is required unless T3ONSTEROIDS_COS_USER_DATA_DIR is set");
  return join(env.APPDATA, "chat-on-steroids");
}

function toolStatus(outcome: string): "completed" | "failed" {
  return /^(?:ok|success|succeeded|completed)$/i.test(outcome) ? "completed" : "failed";
}

/** @internal Exported for deterministic verification of the production ACP error boundary. */
export function safeRequestError(error: unknown): never {
  if (error instanceof BridgeError || error instanceof TranslationError || error instanceof CosControllerError) {
    throw new acp.RequestError(-32000, "Bridge request failed", { code: error.code });
  }
  if (error instanceof StateIoError || error instanceof StateLockBusyError || error instanceof UnsupportedStateFilesystemError) {
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
  const metricsPath = env.T3ONSTEROIDS_METRICS_PATH?.trim();
  const persistMetrics = async (): Promise<void> => {
    if (!metricsPath) return;
    await mkdir(dirname(metricsPath), { recursive: true });
    await writeFile(metricsPath, `${JSON.stringify(metrics.snapshot(), null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  };
  const userDataDir = cosUserDataDirectory(env);
  const state = await createProductionStateContext(userDataDir, env, {
    warmProcessIdentity: true,
    ...(options.qualification
      ? {
          maxConcurrentTurns: options.qualification.maxConcurrentTurns,
          maxQueuedTurns: options.qualification.maxQueuedTurns,
        }
      : {}),
  });
  const controller = new CosControllerClient(
    () => discoverCosController(userDataDir),
    options.qualification?.transport,
    undefined,
    metrics,
  );
  // Prime Node/fetch/controller discovery while T3 is still completing the ACP handshake. The
  // response is deliberately discarded: prompt admission still takes its own fresh provider
  // readiness snapshot, so a restart, token rotation, disabled actions, or provenance change
  // between startup and the first prompt continues to fail closed. This only removes cold
  // transport/JIT cost from the measured prompt critical path.
  void controller.health().catch(() => undefined);
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
    .onRequest(acp.methods.agent.session.new, async ({ params }) => {
      try {
        const created = runtime.newSession(params);
        const configOptions = await runtime.modelConfigOptions().catch(() => []);
        return configOptions.length > 0 ? { ...created, configOptions } : created;
      } catch (error) {
        return safeRequestError(error);
      }
    })
    .onRequest(acp.methods.agent.session.resume, async ({ params }) => {
      try {
        const resumed = await runtime.resumeSession(params);
        const configOptions = await runtime.modelConfigOptions(params.sessionId).catch(() => []);
        return configOptions.length > 0 ? { ...resumed, configOptions } : resumed;
      } catch (error) {
        return safeRequestError(error);
      }
    })
    .onRequest(acp.methods.agent.session.setConfigOption, async ({ params }) => {
      try {
        return { configOptions: await runtime.setConfigOption(params) };
      } catch (error) {
        return safeRequestError(error);
      }
    })
    .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
      try {
        // Work that finished after an earlier turn was announced out of turn; deliver it here as a
        // notice when the client did not act on that announcement, so it is never silently lost.
        await runtime.deliverAnnouncedFollowUps(params.sessionId, async (followUp) => {
          await client.notify(acp.methods.client.session.update, {
            sessionId: params.sessionId,
            update: {
              sessionUpdate: "notice",
              severity: "info",
              title: "Background work finished",
              description: `${followUp.label.trim() || followUp.id} — ${followUp.outcome ?? "unknown"}.`,
            },
          });
        });
        // An announcement that timed out is retried from this prompt instead of waiting forever.
        void runtime
          .announceRegisteredFollowUps(params.sessionId, async (text) => {
            await client.notify(acp.methods.client.session.update, {
              sessionId: params.sessionId,
              update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
            });
          })
          .catch(() => undefined);
        await runtime.prompt(params);
        const admission = await runtime.awaitDurableProviderTurnOrCancelledNotSent(params.sessionId);
        if (admission.kind === "cancelled_not_sent") {
          metrics.increment("acpTerminalSent");
          await persistMetrics();
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
        await runtime.assertBackgroundWorkSettled(params.sessionId, result.state.inputId);
        // Work that outlived this turn is announced beside the session, never inside the turn:
        // the client already has its terminal and must not wait for native work to finish.
        void runtime
          .announceRegisteredFollowUps(params.sessionId, async (text) => {
            await client.notify(acp.methods.client.session.update, {
              sessionId: params.sessionId,
              update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
            });
          })
          .catch(() => undefined);
        metrics.increment("acpTerminalSent");
        metrics.markTurn(params.sessionId, result.state.generation, "acp_terminal_sent");
        await persistMetrics();
        return { stopReason: result.terminal.stopReason };
      } catch (error) {
        if (error instanceof BridgeError && error.code === "cancelled") {
          metrics.increment("acpTerminalSent");
          await persistMetrics();
          return { stopReason: "cancelled" };
        }
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
  await persistMetrics();
}
