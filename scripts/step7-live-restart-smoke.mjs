/* global fetch, process, setTimeout */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import { pathToFileURL } from "node:url";

import {
  aggregateBridgeMetrics,
  controllerMetadata,
  createNewEvidenceRoot,
  evaluateRestartEvidence,
  isRestartCheckpointLifecycleUpdate,
  parseOptions,
  proveProviderSessionInputs,
  readJson,
  requiredOption,
  writeEvidence,
} from "./step7-live-smoke-lib.mjs";
import { directNoToolPrompt } from "./step7-performance-live-lib.mjs";

function moduleSpecifier(value) {
  return value.startsWith("file:") ? value : pathToFileURL(resolve(value)).href;
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function policyOk(session) {
  return session?.providerPolicy?.backgroundWork === "disabled" && session?.providerPolicy?.enforced === true;
}

async function readPolicy(discovery, sessionId) {
  const response = await fetch(`${discovery.baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}`, {
    headers: { Authorization: `Bearer ${discovery.token}`, Accept: "application/json" },
  });
  if (!response.ok) throw new Error("provider session policy read failed");
  const value = await response.json();
  const session = value?.session ?? value;
  return policyOk(session);
}

async function waitForProviderRotation(discover, profile, before, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (Date.now() >= deadline) throw new Error("provider restart was not observed before timeout");
    try {
      const current = await discover(profile);
      const identityChanged = current.pid !== before.pid || current.startedAt !== before.startedAt || current.baseUrl !== before.baseUrl;
      const tokenChanged = current.token !== before.token;
      if (identityChanged || tokenChanged) {
        for (;;) {
          if (Date.now() >= deadline) throw new Error("provider restarted but did not become browser-ready before timeout");
          try {
            const readyDiscovery = await discover(profile);
            const browser = await controllerMetadata(readyDiscovery);
            if (browser.connectionState === "connected" && browser.bridgePaired && browser.bridgePresent) {
              return {
                discovery: readyDiscovery,
                browser,
                identityChanged: readyDiscovery.pid !== before.pid || readyDiscovery.startedAt !== before.startedAt || readyDiscovery.baseUrl !== before.baseUrl,
                tokenChanged: readyDiscovery.token !== before.token,
              };
            }
          } catch {
            // Controller files can rotate before the restarted desktop/browser surfaces are ready.
          }
          await delay(250);
        }
      }
    } catch {
      // A short missing/unreadable discovery interval is expected during provider restart.
    }
    await delay(250);
  }
}

async function bridgeConnection({ acp, bridgeCli, projectPath, profile, stateDir, metricsPath, sessionId, expected }) {
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
  const stream = acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
  let resolvedSessionId = sessionId ?? null;
  let stopReason = null;
  let assistant = "";
  let toolLikeCount = 0;
  try {
    await acp.client({ name: "step7-live-restart-smoke" })
      .onNotification(acp.methods.client.session.update, async ({ params }) => {
        if (params.update?.sessionUpdate === "agent_message_chunk" && typeof params.update.content?.text === "string") {
          assistant += params.update.content.text;
        }
        if ((params.update?.sessionUpdate === "tool_call" || params.update?.sessionUpdate === "tool_call_update")
          && !isRestartCheckpointLifecycleUpdate(params.update)) toolLikeCount += 1;
      })
      .connectWith(stream, async (ctx) => {
        const initialized = await ctx.request(acp.methods.agent.initialize, { protocolVersion: 2, clientCapabilities: {} });
        if (initialized.protocolVersion !== 1) throw new Error("ACP protocol mismatch");
        if (resolvedSessionId) {
          await ctx.request(acp.methods.agent.session.resume, { sessionId: resolvedSessionId, cwd: projectPath, mcpServers: [] });
        } else {
          const created = await ctx.request(acp.methods.agent.session.new, { cwd: projectPath, mcpServers: [] });
          resolvedSessionId = created.sessionId;
        }
        const result = await ctx.request(acp.methods.agent.session.prompt, {
          sessionId: resolvedSessionId,
          prompt: [{ type: "text", text: directNoToolPrompt(expected) }],
        });
        stopReason = result.stopReason;
      });
  } finally {
    if (!child.stdin.destroyed) child.stdin.end();
  }
  const exitCode = await new Promise((resolveExit) => child.once("exit", (code) => resolveExit(code)));
  if (!resolvedSessionId) throw new Error("bridge did not allocate a session");
  if (exitCode !== 0) throw new Error(`bridge child exited unsuccessfully; stderrBytes=${stderrBytes}`);
  return {
    pid: child.pid,
    sessionId: resolvedSessionId,
    turn: { stopReason, finalMatched: assistant === expected, assistantChars: assistant.length, toolLikeCount },
    metrics: await readJson(metricsPath),
  };
}

async function providerRestartConnection({ acp, bridgeCli, projectPath, profile, stateDir, metricsPath, discover, timeoutMs }) {
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
  const stream = acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
  const expectedFirst = `STEP7-RESTART-A-${randomUUID()}`;
  const expectedSecond = `STEP7-RESTART-B-${randomUUID()}`;
  let sessionId = null;
  let firstTurn = null;
  let secondTurn = null;
  let firstAssistant = "";
  let secondAssistant = "";
  let firstToolLikeCount = 0;
  let secondToolLikeCount = 0;
  let collectingSecond = false;
  let beforeRestart = null;
  let rotated = null;
  let policyBefore = false;
  try {
    await acp.client({ name: "step7-live-provider-restart-smoke" })
      .onNotification(acp.methods.client.session.update, async ({ params }) => {
        if (params.update?.sessionUpdate === "agent_message_chunk" && typeof params.update.content?.text === "string") {
          if (collectingSecond) secondAssistant += params.update.content.text;
          else firstAssistant += params.update.content.text;
        }
        if ((params.update?.sessionUpdate === "tool_call" || params.update?.sessionUpdate === "tool_call_update")
          && !isRestartCheckpointLifecycleUpdate(params.update)) {
          if (collectingSecond) secondToolLikeCount += 1;
          else firstToolLikeCount += 1;
        }
      })
      .connectWith(stream, async (ctx) => {
        const initialized = await ctx.request(acp.methods.agent.initialize, { protocolVersion: 2, clientCapabilities: {} });
        if (initialized.protocolVersion !== 1) throw new Error("ACP protocol mismatch");
        const created = await ctx.request(acp.methods.agent.session.new, { cwd: projectPath, mcpServers: [] });
        sessionId = created.sessionId;
        const first = await ctx.request(acp.methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: "text", text: directNoToolPrompt(expectedFirst) }],
        });
        firstTurn = { stopReason: first.stopReason, finalMatched: firstAssistant === expectedFirst, assistantChars: firstAssistant.length, toolLikeCount: firstToolLikeCount };
        beforeRestart = await discover(profile);
        policyBefore = await readPolicy(beforeRestart, sessionId);
        process.stdout.write(`${JSON.stringify({ phase: "awaiting-provider-restart", sessionReady: true })}\n`);
        rotated = await waitForProviderRotation(discover, profile, beforeRestart, timeoutMs);
        collectingSecond = true;
        const second = await ctx.request(acp.methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: "text", text: directNoToolPrompt(expectedSecond) }],
        });
        secondTurn = { stopReason: second.stopReason, finalMatched: secondAssistant === expectedSecond, assistantChars: secondAssistant.length, toolLikeCount: secondToolLikeCount };
      });
  } finally {
    if (!child.stdin.destroyed) child.stdin.end();
  }
  const exitCode = await new Promise((resolveExit) => child.once("exit", (code) => resolveExit(code)));
  if (!sessionId || !firstTurn || !secondTurn || !beforeRestart || !rotated) throw new Error("provider restart smoke did not complete");
  if (exitCode !== 0) throw new Error(`bridge child exited unsuccessfully; stderrBytes=${stderrBytes}`);
  return {
    pid: child.pid,
    sessionId,
    firstTurn,
    secondTurn,
    providerIdentityChanged: rotated.identityChanged,
    tokenChanged: rotated.tokenChanged,
    policyBefore,
    browserAfterRotation: rotated.browser,
    metrics: await readJson(metricsPath),
  };
}

const options = parseOptions(process.argv.slice(2));
const mode = requiredOption(options, "mode");
if (mode !== "bridge" && mode !== "provider") throw new Error("--mode must be bridge or provider");
const profile = requiredOption(options, "profile");
const projectPath = resolve(requiredOption(options, "project"));
const bridgeCli = resolve(requiredOption(options, "bridge-cli"));
const stateDir = resolve(requiredOption(options, "state-dir"));
const outRoot = await createNewEvidenceRoot(requiredOption(options, "out-dir"));
await mkdir(stateDir, { recursive: false });
const cosModule = moduleSpecifier(options["cos-module"] ?? resolve("dist/cos/index.js"));
const acpModule = moduleSpecifier(options["acp-module"] ?? resolve("node_modules/@agentclientprotocol/sdk/dist/acp.js"));
const timeoutMs = Number(options["timeout-ms"] ?? 180_000);
if (!Number.isFinite(timeoutMs) || timeoutMs < 5_000) throw new Error("--timeout-ms must be at least 5000");

const acp = await import(acpModule);
const { CosControllerClient, discoverCosController } = await import(cosModule);
const discoveryBefore = await discoverCosController(profile);
const browserBefore = await controllerMetadata(discoveryBefore);

let sessionId;
let firstTurn;
let secondTurn;
let metrics;
let bridgeProcessRestarted = false;
let providerIdentityChanged = false;
let tokenChanged = false;
let policyBefore = false;
let browserAfterRestart = null;

if (mode === "bridge") {
  const first = await bridgeConnection({
    acp, bridgeCli, projectPath, profile, stateDir,
    metricsPath: resolve(outRoot, "bridge-before.metrics.json"),
    expected: `STEP7-RESTART-A-${randomUUID()}`,
  });
  sessionId = first.sessionId;
  firstTurn = first.turn;
  const firstPolicyClient = new CosControllerClient(() => discoverCosController(profile));
  policyBefore = policyOk(await firstPolicyClient.session(sessionId));
  browserAfterRestart = await controllerMetadata(await discoverCosController(profile));
  const second = await bridgeConnection({
    acp, bridgeCli, projectPath, profile, stateDir,
    metricsPath: resolve(outRoot, "bridge-after.metrics.json"),
    sessionId,
    expected: `STEP7-RESTART-B-${randomUUID()}`,
  });
  secondTurn = second.turn;
  bridgeProcessRestarted = first.pid !== undefined && second.pid !== undefined && first.pid !== second.pid;
  metrics = aggregateBridgeMetrics(first.metrics, second.metrics);
} else {
  const run = await providerRestartConnection({
    acp, bridgeCli, projectPath, profile, stateDir,
    metricsPath: resolve(outRoot, "provider-restart.metrics.json"),
    discover: discoverCosController,
    timeoutMs,
  });
  sessionId = run.sessionId;
  firstTurn = run.firstTurn;
  secondTurn = run.secondTurn;
  providerIdentityChanged = run.providerIdentityChanged;
  tokenChanged = run.tokenChanged;
  policyBefore = run.policyBefore;
  browserAfterRestart = run.browserAfterRotation;
  metrics = aggregateBridgeMetrics(run.metrics);
}

const freshClient = new CosControllerClient(() => discoverCosController(profile));
const session = await freshClient.session(sessionId);
const discoveryAfter = await discoverCosController(profile);
const browserAfter = await controllerMetadata(discoveryAfter);
const sessionEvents = await freshClient.events(sessionId, 0);
const authoritativeInputProof = proveProviderSessionInputs(sessionEvents, 2);
const evidence = {
  schemaVersion: 1,
  kind: "step7-live-restart-smoke",
  mode,
  firstTurn,
  secondTurn,
  sameSession: true,
  authoritativeInputProof,
  policyBefore,
  policyAfter: policyOk(session),
  browserBefore,
  browserAfterRestart,
  browserAfter,
  bridgeProcessRestarted,
  providerIdentityChanged,
  tokenChanged,
  metrics,
};
const evaluation = evaluateRestartEvidence(evidence);
await writeEvidence(resolve(outRoot, "restart-smoke.json"), { ...evidence, evaluation });
process.stdout.write(`${JSON.stringify({ kind: evidence.kind, mode, pass: evaluation.pass, checks: evaluation.checks })}\n`);
process.exit(evaluation.pass ? 0 : 1);
