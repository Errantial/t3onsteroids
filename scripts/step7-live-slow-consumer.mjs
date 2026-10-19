/* global clearTimeout, process, setTimeout */
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import { TransformStream } from "node:stream/web";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

import {
  controllerMetadata,
  createNewEvidenceRoot,
  parseOptions,
  readJson,
  requiredOption,
  writeEvidence,
} from "./step7-live-smoke-lib.mjs";
import {
  analyzeProviderTurn,
  evaluateSlowConsumerEvidence,
  slowConsumerPerformanceSample,
} from "./step7-performance-live-lib.mjs";

function moduleSpecifier(value) {
  return value.startsWith("file:") ? value : pathToFileURL(resolve(value)).href;
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function integerOption(value, fallback, name, minimum) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < minimum) throw new Error(`--${name} must be an integer >= ${minimum}`);
  return parsed;
}

function throttledReadable(input, { bytesPerTick, delayMs }) {
  return input.pipeThrough(new TransformStream({
    async transform(chunk, controller) {
      for (let offset = 0; offset < chunk.length; offset += bytesPerTick) {
        await delay(delayMs);
        controller.enqueue(chunk.subarray(offset, Math.min(offset + bytesPerTick, chunk.length)));
      }
    },
  }));
}

const options = parseOptions(process.argv.slice(2));
const profile = requiredOption(options, "profile");
const projectPath = resolve(requiredOption(options, "project"));
const bridgeCli = resolve(requiredOption(options, "bridge-cli"));
const stateDir = resolve(requiredOption(options, "state-dir"));
const outRoot = await createNewEvidenceRoot(requiredOption(options, "out-dir"));
const minOutputChars = integerOption(options["min-output-chars"], 20_000, "min-output-chars", 4_001);
const consumerDelayMs = integerOption(options["consumer-delay-ms"], 25, "consumer-delay-ms", 1);
const consumerChunkBytes = integerOption(options["consumer-chunk-bytes"], 256, "consumer-chunk-bytes", 1);
const timeoutMs = integerOption(options["timeout-ms"], 300_000, "timeout-ms", 30_000);
const cosModule = moduleSpecifier(options["cos-module"] ?? resolve("dist/cos/index.js"));
const acpModule = moduleSpecifier(options["acp-module"] ?? resolve("node_modules/@agentclientprotocol/sdk/dist/acp.js"));
await mkdir(stateDir, { recursive: false });

const acp = await import(acpModule);
const { CosControllerClient, discoverCosController } = await import(cosModule);
const discoveryBefore = await discoverCosController(profile);
const browserBefore = await controllerMetadata(discoveryBefore);
const metricsPath = resolve(outRoot, "bridge.metrics.json");
const child = spawn(process.execPath, [bridgeCli], {
  cwd: projectPath,
  env: {
    ...process.env,
    T3ONSTEROIDS_COS_USER_DATA_DIR: profile,
    T3ONSTEROIDS_STATE_DIR: stateDir,
    T3ONSTEROIDS_METRICS_PATH: metricsPath,
  },
  windowsHide: true,
  stdio: ["pipe", "pipe", "pipe"],
});
let stderrBytes = 0;
child.stderr.on("data", (chunk) => { stderrBytes += chunk.length; });
const rawInput = Readable.toWeb(child.stdout);
const throttledInput = throttledReadable(rawInput, { bytesPerTick: consumerChunkBytes, delayMs: consumerDelayMs });
const stream = acp.ndJsonStream(Writable.toWeb(child.stdin), throttledInput);
let sessionId = null;
let stopReason = null;
let assistantChars = 0;
let projectedToolLikeCount = 0;
const assistantHash = createHash("sha256");
const timeout = setTimeout(() => child.kill(), timeoutMs);
try {
  await acp.client({ name: "step7-live-slow-consumer" })
    .onNotification(acp.methods.client.session.update, async ({ params }) => {
      if (params.update?.sessionUpdate === "agent_message_chunk" && typeof params.update.content?.text === "string") {
        assistantChars += params.update.content.text.length;
        assistantHash.update(params.update.content.text, "utf16le");
      }
      if (params.update?.sessionUpdate === "tool_call" || params.update?.sessionUpdate === "tool_call_update") {
        projectedToolLikeCount += 1;
      }
    })
    .connectWith(stream, async (ctx) => {
      const initialized = await ctx.request(acp.methods.agent.initialize, { protocolVersion: 2, clientCapabilities: {} });
      if (initialized.protocolVersion !== 1) throw new Error("ACP protocol mismatch");
      const created = await ctx.request(acp.methods.agent.session.new, { cwd: projectPath, mcpServers: [] });
      sessionId = created.sessionId;
      const result = await ctx.request(acp.methods.agent.session.prompt, {
        sessionId,
        prompt: [{
          type: "text",
          text: `Without using tools, produce a plain-text response of at least ${minOutputChars} characters about deterministic software interfaces. Continue until the requested length is reached. Do not use code blocks.`,
        }],
      });
      stopReason = result.stopReason;
    });
} finally {
  clearTimeout(timeout);
  if (!child.stdin.destroyed) child.stdin.end();
}
const exitCode = child.exitCode ?? await new Promise((resolveExit) => child.once("exit", (code) => resolveExit(code)));
if (exitCode !== 0) throw new Error(`bridge child exited unsuccessfully; stderrBytes=${stderrBytes}`);
if (!sessionId) throw new Error("bridge did not allocate a session");

const metrics = await readJson(metricsPath);
const controller = new CosControllerClient(() => discoverCosController(profile));
const events = await controller.events(sessionId, 0);
const turn = analyzeProviderTurn(events, sessionId);
const session = await controller.session(sessionId);
const policyEnforced = session.providerPolicy?.backgroundWork === "disabled" && session.providerPolicy?.enforced === true;
let controllerChars = 0;
const controllerHash = createHash("sha256");
for await (const chunk of controller.assistantContentChunks(sessionId, turn.finalAssistantSeq)) {
  controllerChars += chunk.text.length;
  controllerHash.update(chunk.text, "utf16le");
}
const exactFinalContent = assistantChars === controllerChars && assistantHash.digest("hex") === controllerHash.digest("hex");
const slowConsumer = slowConsumerPerformanceSample(metrics, turn.nativeDrainMs);
const browserAfter = await controllerMetadata(await discoverCosController(profile));
const evidence = {
  schemaVersion: 1,
  kind: "step7-live-slow-consumer",
  promptClass: "long-plain-text-no-tool",
  minOutputChars,
  throttle: { consumerDelayMs, consumerChunkBytes },
  browserBefore,
  browserAfter,
  sessionId,
  stopReason,
  policyEnforced,
  assistantChars,
  controllerChars,
  exactFinalContent,
  toolLikeCount: turn.toolLikeCount,
  projectedToolLikeCount,
  slowConsumer,
};
const evaluation = evaluateSlowConsumerEvidence(evidence);
await writeEvidence(resolve(outRoot, "slow-consumer.json"), { ...evidence, evaluation });
process.stdout.write(`${JSON.stringify({ kind: evidence.kind, pass: evaluation.pass, assistantChars, checks: evaluation.checks })}\n`);
process.exit(evaluation.pass ? 0 : 1);
