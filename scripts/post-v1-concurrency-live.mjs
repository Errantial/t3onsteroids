/* global process, setTimeout, clearTimeout, fetch, AbortSignal */
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { Readable, Writable } from "node:stream";
import { performance } from "node:perf_hooks";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import * as acp from "@agentclientprotocol/sdk";
import { compatibility } from "../dist/compatibility.js";
import { COS_REQUIRED_ACTION_ROUTES, CosControllerClient, discoverCosController } from "../dist/cos/index.js";
import { canonicalProfileIdentityHash } from "../dist/state/index.js";
import { directNoToolPrompt } from "./step7-performance-live-lib.mjs";
import { buildCrossSessionStaleFixture, controllerMetadata, createNewEvidenceRoot, isRestartCheckpointLifecycleUpdate, parseOptions, providerBrowserReady, requiredOption, writeEvidence } from "./step7-live-smoke-lib.mjs";
import { step7ToolEligibility } from "./step7-tool-eligibility.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const qualificationRoot = resolve(repoRoot, ".local-evidence", "post-v1-concurrency");
const options = parseOptions(process.argv.slice(2));
const profile = resolve(requiredOption(options, "profile"));
const projectPath = resolve(requiredOption(options, "project"));
const outRoot = await createNewEvidenceRoot(requiredOption(options, "out-dir"));
const expectedBuildId = options["expected-build-id"] ?? compatibility.cos.providerExtension.buildId;
const candidateExeSha256 = options["candidate-exe-sha256"] ?? null;
const includeFour = options["include-four"] === "true";
const onlyFour = options["only-four"] === "true";
const onlyCase = options["only-case"] ?? null;
const longOutputWords = Number(options["long-output-words"] ?? "800");
const shortNoToolTarget = 10;
const shortNoToolPairProbeAttempts = 3;
const bridgeCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
const startedAtUtc = new Date().toISOString();

class SetupInvalid extends Error {
  constructor(category) {
    super(category);
    this.name = "SetupInvalid";
    this.category = category;
  }
}
function delay(ms) { return new Promise((resolveDelay) => setTimeout(resolveDelay, ms)); }
function hash(value) { return createHash("sha256").update(value).digest("hex"); }
function hashPath(value) {
  const canonical = process.platform === "win32" ? resolve(value).toLowerCase() : resolve(value);
  return hash(canonical);
}
function isWithin(root, candidate) {
  const rel = relative(root, candidate);
  return rel !== "" && rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel);
}
function errorCategory(error) {
  if (error && typeof error === "object") {
    if (typeof error.code === "string" && /^[a-z0-9_-]{1,48}$/i.test(error.code)) return error.code;
    if (typeof error.category === "string") return error.category;
    if (typeof error.message === "string" && /^[a-z0-9_-]{1,64}$/i.test(error.message)) return error.message;
    if (typeof error.name === "string") return error.name;
  }
  return "unknown";
}
function errorEvidence(error) {
  if (!error || typeof error !== "object") return { category: errorCategory(error) };
  const detail = {
    category: errorCategory(error),
    ...(typeof error.name === "string" ? { name: error.name.slice(0, 80) } : {}),
    ...(typeof error.message === "string" ? { message: error.message.slice(0, 300) } : {}),
    ...(Number.isInteger(error.status) ? { status: error.status } : {}),
    ...(typeof error.retryable === "boolean" ? { retryable: error.retryable } : {}),
    ...(error.qualificationContext && typeof error.qualificationContext === "object"
      ? { qualificationContext: error.qualificationContext } : {}),
  };
  if (error.cause && typeof error.cause === "object") detail.cause = errorEvidence(error.cause);
  return detail;
}
function qualificationFailure(error, qualificationContext) {
  const wrapped = new Error("qualification_stage_failed", { cause: error });
  wrapped.code = errorCategory(error);
  wrapped.qualificationContext = qualificationContext;
  return wrapped;
}
function nearestRank(values, quantile = 0.95) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(quantile * sorted.length) - 1];
}
function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
function summarizeLatency(samples) {
  const preSend = samples.map((sample) => sample.preSendMs).filter(Number.isFinite);
  const drain = samples.map((sample) => sample.drainMs).filter(Number.isFinite);
  const postDrain = samples.map((sample) => sample.postDrainMs).filter(Number.isFinite);
  const endToEnd = samples.map((sample) => sample.endToEndMs).filter(Number.isFinite);
  const preSendP95Ms = nearestRank(preSend);
  const drainP95Ms = nearestRank(drain);
  const postDrainP95Ms = nearestRank(postDrain);
  return {
    sampleCount: samples.length,
    preSendSampleCount: preSend.length,
    drainSampleCount: drain.length,
    postDrainSampleCount: postDrain.length,
    endToEndMedianMs: median(endToEnd),
    endToEndP95Ms: nearestRank(endToEnd),
    preSendP95Ms,
    drainP95Ms,
    postDrainP95Ms,
    nearestRankRule: "sorted[ceil(0.95*N)-1]",
    budgets: { preSendP95Ms: 250, drainP95Ms: 1000, postDrainP95Ms: 250 },
    budgetPass: preSend.length === samples.length && drain.length === samples.length &&
      postDrain.length === samples.length && preSendP95Ms <= 250 && drainP95Ms <= 1000 && postDrainP95Ms <= 250,
  };
}
async function readJson(path) { return JSON.parse(await fs.readFile(path, "utf8")); }
async function readJsonOptional(path) {
  try { return await readJson(path); }
  catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return null;
    throw error;
  }
}
async function createStateDir(caseId) {
  const path = resolve(outRoot, "state-" + caseId);
  await fs.mkdir(path, { recursive: false });
  return path;
}
async function readLeaseState(stateDir) {
  const identity = await canonicalProfileIdentityHash(profile);
  return readJsonOptional(resolve(stateDir, "leases", identity + ".json"));
}
async function waitForLeaseState(stateDir, predicate, timeoutMs = 15000) {  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() < deadline) {
    latest = await readLeaseState(stateDir);
    if (latest && predicate(latest)) return latest;
    await delay(25);
  }
  throw new Error("lease_state_timeout");
}
async function waitForLeaseStateOrPromptFailure(stateDir, predicate, pending, timeoutMs = 15000) {
  const observed = pending.map(() => ({ done: false, value: null }));
  for (let index = 0; index < pending.length; index += 1) {
    void pending[index].then((value) => { observed[index] = { done: true, value }; });
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const failedIndex = observed.findIndex((row) => row.done && row.value?.ok === false);
    if (failedIndex >= 0) {
      const failed = observed[failedIndex];
      const error = new Error("paired_prompt_failed_before_expected_lease_state", {
        ...(failed?.value?.error && typeof failed.value.error === "object" ? { cause: failed.value.error } : {}),
      });
      error.category = failed.value.errorCategory;
      error.qualificationContext = { stage: "paired_prompt_lease_wait", peerIndex: failedIndex };
      throw error;
    }
    const latest = await readLeaseState(stateDir);
    if (latest && predicate(latest)) return latest;
    await delay(25);
  }
  throw new Error("lease_state_timeout");
}
function childStream(child) {
  return acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
}
async function waitForChildExit(child, timeoutMs = 5000) {
  if (child.exitCode !== null || child.signalCode !== null) return { code: child.exitCode, signal: child.signalCode };
  return new Promise((resolveExit) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      resolveExit(value);
    };
    const onExit = (code, signal) => finish({ code, signal });
    const timer = setTimeout(() => finish(null), timeoutMs);
    child.once("exit", onExit);
  });
}
async function startPeer({ label, stateDir, slots = 2, queueCapacity = 2, resumeSessionId = null, dropSseOnce = false, staleEventPath = null, slowConsumer = false }) {
  const metricsPath = resolve(outRoot, "metrics", label + ".json");
  const faultEvidencePath = resolve(outRoot, "faults", label + ".json");
  await fs.mkdir(dirname(metricsPath), { recursive: true });
  const env = {
    ...process.env,
    T3ONSTEROIDS_COS_USER_DATA_DIR: profile,
    T3ONSTEROIDS_STATE_DIR: stateDir,
    T3ONSTEROIDS_METRICS_PATH: metricsPath,
    POST_V1_QUALIFICATION_SLOTS: String(slots),
    POST_V1_QUALIFICATION_QUEUE_CAPACITY: String(queueCapacity),
    POST_V1_QUALIFICATION_DROP_SSE_ONCE: dropSseOnce ? "1" : "0",
    POST_V1_QUALIFICATION_FAULT_EVIDENCE_PATH: faultEvidencePath,
  };
  delete env.POST_V1_QUALIFICATION_STALE_EVENT_PATH;
  if (staleEventPath) env.POST_V1_QUALIFICATION_STALE_EVENT_PATH = staleEventPath;
  const runner = resolve(repoRoot, "scripts", "post-v1-concurrency-runner.mjs");
  const child = spawn(process.execPath, [runner], { cwd: repoRoot, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const peer = { label, child, metricsPath, faultEvidencePath, stateDir, sessionId: null, ctx: null, current: null, slowConsumer,
    stderrBytes: 0, exit: null, closed: false, connectionError: null, stopResolve: null, metrics: null };
  child.stderr.on("data", (chunk) => { peer.stderrBytes += chunk.length; });
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolveReady, rejectReady) => { readyResolve = resolveReady; readyReject = rejectReady; });
  const stopPromise = new Promise((resolveStop) => { peer.stopResolve = resolveStop; });
  child.once("exit", (code, signal) => { peer.exit = { code, signal }; peer.stopResolve?.(); });
  peer.connection = acp.client({ name: "post-v1-concurrency-qualification" })
    .onNotification(acp.methods.client.session.update, async ({ params }) => {
      if (params.sessionId !== peer.sessionId || !peer.current) return;
      const update = params.update;
      if (update?.sessionUpdate === "agent_message_chunk" && typeof update.content?.text === "string") {
        peer.current.assistant += update.content.text;
        if (peer.slowConsumer) await delay(20);
      }
      if ((update?.sessionUpdate === "tool_call" || update?.sessionUpdate === "tool_call_update") &&
          !isRestartCheckpointLifecycleUpdate(update)) peer.current.toolLikeCount += 1;
    })
    .connectWith(childStream(child), async (ctx) => {
      peer.ctx = ctx;
      const initialized = await ctx.request(acp.methods.agent.initialize, {
        protocolVersion: 2, clientCapabilities: { session: { notices: true } },
      });
      if (initialized.protocolVersion !== 1) throw new Error("protocol_mismatch");
      if (resumeSessionId) {
        await ctx.request(acp.methods.agent.session.resume, { sessionId: resumeSessionId, cwd: projectPath, mcpServers: [] });
        peer.sessionId = resumeSessionId;
      } else {
        const created = await ctx.request(acp.methods.agent.session.new, { cwd: projectPath, mcpServers: [] });
        peer.sessionId = created.sessionId;
      }
      readyResolve(peer);
      await stopPromise;
    })
    .catch((error) => { peer.connectionError = error; readyReject(error); });
  await Promise.race([ready, delay(15000).then(() => { throw new Error("bridge_peer_start_timeout"); })])
    .catch(async (error) => { await killPeer(peer); throw error; });
  return peer;
}
async function prompt(peer, text, expectedText = null, timeoutMs = 180000) {
  if (!peer.ctx || !peer.sessionId) throw new Error("peer_not_ready");
  const current = { assistant: "", toolLikeCount: 0 };
  peer.current = current;
  const started = performance.now();
  let timer;
  try {
    const result = await Promise.race([
      peer.ctx.request(acp.methods.agent.session.prompt, { sessionId: peer.sessionId, prompt: [{ type: "text", text }] }),      new Promise((_, reject) => { timer = setTimeout(() => reject(new SetupInvalid("prompt_timeout")), timeoutMs); }),
    ]);
    const endToEndMs = performance.now() - started;
    peer.current = null;
    peer.metrics = await readJsonOptional(peer.metricsPath);
    const timing = peer.metrics?.recentTurns?.at(-1) ?? {};
    return { stopReason: result.stopReason, finalMatched: expectedText === null ? current.assistant.length > 0 : current.assistant.trim() === expectedText,
      assistantChars: current.assistant.length, toolLikeCount: current.toolLikeCount, endToEndMs,
      preSendMs: timing.preSendMs, drainMs: timing.drainMs, postDrainMs: timing.postDrainMs };
  } finally {
    clearTimeout(timer);
    peer.current = null;
  }
}
function shortPromptToken(prefix) { return prefix + "-" + randomUUID(); }
function longNoToolPrompt(words) {
  return "Do not use tools, open links, or create files. Write approximately " + words +
    " words of ordinary prose explaining why independent software sessions need separate state, cancellation, and event cursors. " +
    "Use several paragraphs and do not include code. This is a read-only browser response.";
}
async function safeOutcome(promise) {
  try { return { ok: true, result: await promise }; }
  catch (error) { return { ok: false, errorCategory: errorCategory(error), error }; }
}
async function cancelPeer(peer) {
  await peer.ctx.notify(acp.methods.agent.session.cancel, { sessionId: peer.sessionId });
}
async function closePeer(peer) {
  if (!peer || peer.closed) return;
  peer.closed = true;
  peer.stopResolve?.();
  if (!peer.child.stdin.destroyed) peer.child.stdin.end();
  const exited = await waitForChildExit(peer.child, 5000);
  if (!exited) { peer.child.kill(); await waitForChildExit(peer.child, 2000); }
  await peer.connection.catch(() => undefined);
  peer.metrics = await readJsonOptional(peer.metricsPath);
}
async function killPeer(peer) {
  if (!peer || peer.closed) return;
  peer.closed = true;
  peer.child.kill();
  peer.stopResolve?.();
  await waitForChildExit(peer.child, 5000);
  await peer.connection.catch(() => undefined);
  peer.metrics = await readJsonOptional(peer.metricsPath);
}
async function waitForTurnState(client, sessionId, desired, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const session = await client.session(sessionId);
      if (session.providerTurn?.state === desired) return session;
    } catch { /* A queued, not-yet-sent session intentionally has no CoS session yet. */ }
    await delay(100);
  }
  throw new Error("provider_turn_state_timeout");
}
async function waitForInputAccepted(client, inputId, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() < deadline) {
    latest = await client.input(inputId).catch(() => undefined);
    if (latest?.delivery === "sent" || latest?.delivery === "pending") return latest;
    await delay(100);
  }
  throw new Error("provider_input_acceptance_timeout");
}
async function startRssSampler(peers, stateDir) {
  let running = true;
  let aggregateRssHighWaterBytes = 0;
  let samples = 0;
  let maxActive = 0;
  let maxWaiting = 0;
  const run = async () => {
    while (running) {
      const pids = peers.filter((peer) => peer.child.pid && peer.exit === null).map((peer) => peer.child.pid);
      if (pids.length) {
        try {
          const ids = pids.join(",");
          const output = execFileSync("powershell.exe", ["-NoProfile", "-Command",
            "(Get-Process -Id " + ids + " -ErrorAction SilentlyContinue | Measure-Object -Property WorkingSet64 -Sum).Sum"],
            { encoding: "utf8", timeout: 3000 }).trim();
          const rss = Number(output);
          if (Number.isFinite(rss) && rss >= 0) { aggregateRssHighWaterBytes = Math.max(aggregateRssHighWaterBytes, rss); samples += 1; }
        } catch { /* Sampling failures remain visible through rssSampleCount. */ }
      }
      const lease = await readLeaseState(stateDir).catch(() => null);
      if (lease) {
        maxActive = Math.max(maxActive, Array.isArray(lease.active) ? lease.active.length : 0);
        maxWaiting = Math.max(maxWaiting, Array.isArray(lease.waiting) ? lease.waiting.length : 0);
      }
      await delay(250);
    }
  };
  const task = run();
  return async () => {
    running = false;
    await task;
    return { aggregateRssHighWaterBytes, rssSampleCount: samples, maxActiveLeases: maxActive, maxWaitingLeases: maxWaiting };
  };
}
async function sessionProof(client, sessionId, expectedInputCount) {
  const events = await client.eventHistory(sessionId, { from: 0, maxEvents: 2_000 });
  const userInputs = events.filter((event) => event.kind === "user_message" && event.inputDelivery === "confirmed");
  const drained = events.filter((event) => event.kind === "turn_drained");
  const inputIds = userInputs.map((event) => event.inputId).filter((value) => typeof value === "string");
  const uniqueInputIds = new Set(inputIds);
  const proof = userInputs.length === expectedInputCount && inputIds.length === expectedInputCount &&
    uniqueInputIds.size === expectedInputCount && drained.length >= expectedInputCount &&
    inputIds.every((inputId) => drained.some((event) => event.inputId === inputId && Number.isSafeInteger(event.highWaterSeq) && event.highWaterSeq === event.seq));  return { pass: proof, confirmedInputCount: userInputs.length, uniqueInputIdCount: uniqueInputIds.size,
    drainedTurnCount: drained.length, duplicateSequenceCount: events.length - new Set(events.map((event) => event.seq)).size };
}
const manifest = {
  schemaVersion: 1,
  kind: "post-v1-concurrency-live-qualification",
  startedAtUtc,
  bridgeImplementationCommit: bridgeCommit,
  bridgeVersion: compatibility.bridge.version,
  t3Version: compatibility.t3.version,
  t3Sha: compatibility.t3.sha,
  cosBaseVersion: compatibility.cos.version,
  cosBaseSha: compatibility.cos.sha,
  cosExtensionBuildId: expectedBuildId,
  candidateCosBinarySha256: candidateExeSha256,
  candidateLaunchLane: "side_by_side",
  controlProtocol: compatibility.cos.controlApiProtocol,
  providerExtensionFeatures: compatibility.cos.providerExtension.features,
  cosProfileIdentityHash: null,
  projectLabel: basename(projectPath),
  canonicalProjectIdentityHash: hashPath(projectPath),
  stateNamespaceHash: hashPath(outRoot),
  providerCommandExecutable: basename(process.execPath),
  providerCommandScript: "post-v1-concurrency-runner.mjs",
  cases: [],
  priorTwoChatGate: null,
  finalStatus: "RUNNING",
};
async function saveManifest() {
  await fs.writeFile(resolve(outRoot, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
}
async function recordCase(id, status, started, evidenceFile, error = null, summary = null) {
  const row = { id, status, startedAtUtc: started, endedAtUtc: new Date().toISOString(),
    ...(error ? { errorCategory: errorCategory(error) } : {}), evidenceFiles: evidenceFile ? [evidenceFile] : [],
    ...(summary ? { summary } : {}) };
  manifest.cases.push(row);
  await saveManifest();
  return row;
}
async function runCase(id, body) {
  const started = new Date().toISOString();
  const evidenceName = id + ".json";
  try {
    const result = await body();
    await writeEvidence(resolve(outRoot, evidenceName), result.evidence);
    const status = result.pass ? "PASS" : "FAIL";
    await recordCase(id, status, started, evidenceName, null, result.summary ?? null);
    return { id, status, result };
  } catch (error) {
    const status = error instanceof SetupInvalid ? "SETUP_INVALID" : "FAIL";
    await writeEvidence(resolve(outRoot, evidenceName), {
      schemaVersion: 1, caseId: id, status, errorCategory: errorCategory(error), error: errorEvidence(error),
    });
    await recordCase(id, status, started, evidenceName, error);
    return { id, status, errorCategory: errorCategory(error) };
  }
}
const selectableTwoChatCases = new Set([
  "single-chat-baseline",
  "two-chat-workload",
  "queue-cancel-slot-reuse",
  "independent-active-cancellation",
  "sse-reconnect-with-two-active",
  "crash-restart-with-two-active",
  "cross-session-stale-event",
  "long-output-slow-consumer-rss",
]);
async function maybeRunCase(id, body) {
  if (onlyCase && id !== onlyCase) return null;
  return runCase(id, body);
}
const discovery = await discoverCosController(profile).catch(() => null);
if (!isWithin(qualificationRoot, profile) || resolve(projectPath).toLowerCase() !== repoRoot.toLowerCase() ||
    !isWithin(qualificationRoot, outRoot) || !discovery) {
  manifest.finalStatus = "SETUP_INVALID";
  await recordCase("preflight", "SETUP_INVALID", startedAtUtc, null, new SetupInvalid("isolated_candidate_or_project_unavailable"));
  await saveManifest();
  process.stdout.write(JSON.stringify({ status: manifest.finalStatus, runId: basename(outRoot), failedCase: "preflight" }) + "\n");
  process.exit(2);
}
const cosClient = new CosControllerClient(() => discoverCosController(profile));
async function classifyShortNoToolAttempt(peer, sample) {
  const events = await cosClient.eventHistory(peer.sessionId, { from: 0, maxEvents: 2_000 });
  const user = [...events].reverse().find((event) =>
    event.kind === "user_message" && event.inputDelivery === "confirmed" && typeof event.inputId === "string",
  );
  const drain = user && [...events].reverse().find((event) =>
    event.kind === "turn_drained" && event.inputId === user.inputId && typeof event.turnId === "string",
  );
  if (!user || !drain) {
    return { ...sample, eligibleNoTool: false, noToolReason: "turn_window_unprovable", authoritativeToolLikeCount: 0, inputKey: null };
  }
  const eligibility = step7ToolEligibility(events, { inputId: user.inputId, turnId: drain.turnId });
  const projectedClean = sample.toolLikeCount === 0;
  return {
    ...sample,
    eligibleNoTool: eligibility.eligibleNoTool && projectedClean,
    noToolReason: eligibility.eligibleNoTool ? (projectedClean ? null : "projected_tool_activity") : eligibility.reason,
    authoritativeToolLikeCount: eligibility.toolLikeCount,
    inputKey: hash(user.inputId).slice(0, 16),
  };
}
function shortAttemptEvidence(sample, index, extra = {}) {
  return {
    index,
    ...extra,
    counted: sample.counted ?? (sample.eligibleNoTool === true && sample.stopReason === "end_turn" && sample.finalMatched === true),
    stopReason: sample.stopReason,
    finalMatched: sample.finalMatched,
    projectedToolLikeCount: sample.toolLikeCount,
    authoritativeToolLikeCount: sample.authoritativeToolLikeCount ?? null,
    eligibleNoTool: sample.eligibleNoTool === true,
    noToolReason: sample.noToolReason ?? null,
    inputKey: sample.inputKey ?? null,
    endToEndMs: sample.endToEndMs,
    preSendMs: sample.preSendMs,
    drainMs: sample.drainMs,
    postDrainMs: sample.postDrainMs,
  };
}
async function stopActiveQualificationTurn(peer) {
  if (!peer?.sessionId) return;
  try {
    const session = await cosClient.session(peer.sessionId);
    if (session.providerTurn?.state === "active" && typeof session.providerTurn.turnId === "string") {
      await cosClient.requestStopExactTurn(peer.sessionId, session.providerTurn.turnId);
    }
  } catch { /* Best-effort cleanup must not mask the qualification result. */ }
}
let health;
let browserBefore;
let project;
try {
  health = await cosClient.health();
  browserBefore = await controllerMetadata(discovery);
  project = await cosClient.resolveProject(projectPath);
  manifest.cosProfileIdentityHash = await canonicalProfileIdentityHash(profile);
  // `connectionState` is the app's Core MCP tunnel, not the browser-extension bridge. The
  // provider qualification lane uses the local control API plus the browser bridge and does
  // not require an OpenAI tunnel ID/API key. Gate only on the browser facts here; keep the Core
  // connection state in evidence as a diagnostic so it is never confused with pairing again.
  const browserReady = providerBrowserReady(browserBefore);
  const exactBuild = health.providerExtension?.buildId === expectedBuildId && health.providerExtension?.apiVersion === compatibility.cos.providerExtension.apiVersion;
  const featuresReady = Object.entries(compatibility.cos.providerExtension.features).every(([name, version]) => health.features[name] === version);
  const routesReady = compatibility.cos.controlApiProtocol === health.protocol && health.actionsEnabled === true &&
    COS_REQUIRED_ACTION_ROUTES.every((route) => health.actionRoutes.includes(route));
  const exactProject = resolve(project.canonicalPath).toLowerCase() === projectPath.toLowerCase();
  if (!browserReady || !exactBuild || !featuresReady || !routesReady || !exactProject) throw new SetupInvalid("candidate_health_browser_actions_or_project_mismatch");
  await writeEvidence(resolve(outRoot, "preflight.json"), {
    schemaVersion: 1, status: "PASS",
    candidate: { app: health.app, protocol: health.protocol, extensionBuildId: health.providerExtension.buildId, actionsEnabled: health.actionsEnabled },
    browser: browserBefore,
    project: { label: basename(projectPath), canonicalProjectIdentityHash: manifest.canonicalProjectIdentityHash, exactCanonicalPath: exactProject },
    profileIdentityHash: manifest.cosProfileIdentityHash,
  });  await recordCase("preflight", "PASS", startedAtUtc, "preflight.json", null, {
    browserReady,
    coreConnectionState: browserBefore.connectionState,
    actionsEnabled: health.actionsEnabled,
    exactBuild,
  });
} catch (error) {
  const status = error instanceof SetupInvalid ? "SETUP_INVALID" : "FAIL";
  await writeEvidence(resolve(outRoot, "preflight.json"), { schemaVersion: 1, status, errorCategory: errorCategory(error),
    candidateApp: health?.app ?? null, protocol: health?.protocol ?? null,
    extensionBuildIdMatches: health?.providerExtension?.buildId === expectedBuildId,
    actionsEnabled: health?.actionsEnabled === true,
    browserPaired: browserBefore?.bridgePaired === true,
    browserPresent: browserBefore?.bridgePresent === true,
    coreConnectionState: browserBefore?.connectionState ?? null,
  });
  await recordCase("preflight", status, startedAtUtc, "preflight.json", error);
  manifest.finalStatus = status;
  await saveManifest();
  process.stdout.write(JSON.stringify({ status, runId: basename(outRoot), failedCase: "preflight" }) + "\n");
  process.exit(2);
}

const results = [];
let twoChatStatus = "PENDING";
if (onlyCase && (!selectableTwoChatCases.has(onlyCase) || onlyFour || includeFour)) {
  const error = new SetupInvalid("invalid_only_case_selection");
  await recordCase("only-case-selection", "SETUP_INVALID", new Date().toISOString(), null, error);
  manifest.finalStatus = "SETUP_INVALID";
  await saveManifest();
  process.stdout.write(JSON.stringify({ status: manifest.finalStatus, runId: basename(outRoot), failedCase: "only-case-selection" }) + "\n");
  process.exit(2);
}
if (onlyFour) {
  const priorPath = options["prior-two-chat-manifest"] ? resolve(options["prior-two-chat-manifest"]) : null;
  const prior = priorPath && isWithin(qualificationRoot, priorPath) ? await readJsonOptional(priorPath) : null;
  const requiredCases = ["single-chat-baseline", "two-chat-workload", "queue-cancel-slot-reuse", "independent-active-cancellation", "sse-reconnect-with-two-active", "crash-restart-with-two-active", "cross-session-stale-event", "long-output-slow-consumer-rss"];
  const gatePass = includeFour && prior?.finalStatus === "PASS" && prior.cosExtensionBuildId === expectedBuildId &&
    prior.cosProfileIdentityHash === manifest.cosProfileIdentityHash && prior.candidateCosBinarySha256 === candidateExeSha256 &&
    requiredCases.every((id) => prior.cases.some((row) => row.id === id && row.status === "PASS"));
  if (!gatePass) {
    const error = new SetupInvalid("prior_two_chat_gate_not_passed_or_unreadable");
    await recordCase("prior-two-chat-gate", "SETUP_INVALID", new Date().toISOString(), null, error);
    manifest.finalStatus = "SETUP_INVALID";
    await saveManifest();
    process.stdout.write(JSON.stringify({ status: manifest.finalStatus, runId: basename(outRoot), failedCase: "prior-two-chat-gate" }) + "\n");
    process.exit(2);
  }
  manifest.priorTwoChatGate = { bridgeImplementationCommit: prior.bridgeImplementationCommit, manifestSha256: hash(JSON.stringify(prior)), finalStatus: prior.finalStatus };
  twoChatStatus = "PASS";
}
if (!onlyFour) {
const baseline = await maybeRunCase("single-chat-baseline", async () => {
  const stateDir = await createStateDir("single-chat-baseline");
  const peer = await startPeer({ label: "baseline", stateDir, slots: 1, queueCapacity: 0 });
  const stopSampler = await startRssSampler([peer], stateDir);
  const samples = [];
  try {
    for (let index = 1; index <= shortNoToolTarget; index += 1) {
      const expected = shortPromptToken("PV1-BASELINE");
      const result = await classifyShortNoToolAttempt(peer, await prompt(peer, directNoToolPrompt(expected), expected));
      if (result.stopReason !== "end_turn" || !result.finalMatched) throw new Error("baseline_non_exact_or_nonterminal");
      samples.push(result);
    }
    const rss = await stopSampler();
    const metrics = peer.metrics ?? await readJsonOptional(peer.metricsPath);
    const proof = await sessionProof(cosClient, peer.sessionId, shortNoToolTarget);
    const policy = await cosClient.requireBackgroundWorkDisabled(peer.sessionId);
    const cleanSamples = samples.filter((sample) => sample.eligibleNoTool === true);
    const latency = summarizeLatency(cleanSamples);
    const toolContaminatedTurnCount = samples.length - cleanSamples.length;
    const pass = samples.length === shortNoToolTarget && toolContaminatedTurnCount === 0 &&
      proof.pass && policy.backgroundWork === "disabled" && policy.enforced === true && latency.budgetPass &&
      Number(metrics?.rssHighWaterBytes) < 256 * 1024 * 1024 && rss.rssSampleCount > 0;
    return { pass, evidence: { schemaVersion: 1, promptClass: "short-exact-no-tool", turnCount: samples.length,
      toolContaminatedTurnCount,
      samples: samples.map((sample, index) => shortAttemptEvidence(sample, index + 1)),
      latency, sessionProof: proof, providerPolicyAttested: true, bridgeRssHighWaterBytes: metrics?.rssHighWaterBytes ?? null,
      aggregateBridgeRssHighWaterBytes: rss.aggregateRssHighWaterBytes, aggregateRssSampleCount: rss.rssSampleCount,
      maxActiveLeases: rss.maxActiveLeases, maxWaitingLeases: rss.maxWaitingLeases },
      summary: { turnCount: samples.length, toolContaminatedTurnCount,
        latencyBudgetPass: latency.budgetPass, bridgeRssHighWaterBytes: metrics?.rssHighWaterBytes ?? null } };
  } finally { await stopSampler(); await closePeer(peer); }
});
if (baseline) results.push(baseline);

const twoChat = await maybeRunCase("two-chat-workload", async () => {
  const stateDir = await createStateDir("two-chat-workload");
  let peers = null;
  let eligibilityProbe = null;
  let pairProbeAttempt = 0;
  for (let attempt = 1; attempt <= shortNoToolPairProbeAttempts; attempt += 1) {
    const candidatePeers = await Promise.all([
      startPeer({ label: `two-a-probe-${attempt}`, stateDir, slots: 2, queueCapacity: 2 }),
      startPeer({ label: `two-b-probe-${attempt}`, stateDir, slots: 2, queueCapacity: 2 }),
    ]);
    try {
      const expectedA = shortPromptToken("PV1-TWO-PROBE-A");
      const expectedB = shortPromptToken("PV1-TWO-PROBE-B");
      const pending = [
        safeOutcome(prompt(candidatePeers[0], directNoToolPrompt(expectedA), expectedA)),
        safeOutcome(prompt(candidatePeers[1], directNoToolPrompt(expectedB), expectedB)),
      ];
      await waitForLeaseStateOrPromptFailure(stateDir, (state) => state.active.length === 2 &&
        candidatePeers.every((peer) => state.active.some((row) => row.sessionId === peer.sessionId)), pending, 15000);
      const [a, b] = await Promise.all(pending);
      if (!a.ok || !b.ok) throw new Error("two_chat_probe_prompt_failed");
      const classified = await Promise.all([
        classifyShortNoToolAttempt(candidatePeers[0], a.result),
        classifyShortNoToolAttempt(candidatePeers[1], b.result),
      ]);
      pairProbeAttempt = attempt;
      if (classified.every((sample) => sample.stopReason === "end_turn" && sample.finalMatched && sample.eligibleNoTool === true)) {
        peers = candidatePeers;
        eligibilityProbe = classified;
        break;
      }
    } finally {
      if (peers !== candidatePeers) await Promise.all(candidatePeers.map(closePeer));
    }
  }
  if (!peers || !eligibilityProbe) throw new SetupInvalid("two_chat_clean_pair_unavailable");
  const stopSampler = await startRssSampler(peers, stateDir);
  const samplesByPeer = [[], []];
  try {
    for (let index = 1; index <= shortNoToolTarget; index += 1) {
      const expectedA = shortPromptToken("PV1-TWO-A");
      const expectedB = shortPromptToken("PV1-TWO-B");
      const outcomeA = safeOutcome(prompt(peers[0], directNoToolPrompt(expectedA), expectedA));
      const outcomeB = safeOutcome(prompt(peers[1], directNoToolPrompt(expectedB), expectedB));
      await waitForLeaseStateOrPromptFailure(stateDir, (state) => state.active.length === 2 &&
        state.active.some((row) => row.sessionId === peers[0].sessionId) && state.active.some((row) => row.sessionId === peers[1].sessionId),
      [outcomeA, outcomeB], 15000);
      const [a, b] = await Promise.all([outcomeA, outcomeB]);
      if (!a.ok || !b.ok) throw new Error("two_chat_prompt_failed");
      let classifiedA;
      let classifiedB;
      try {
        [classifiedA, classifiedB] = await Promise.all([
          classifyShortNoToolAttempt(peers[0], a.result),
          classifyShortNoToolAttempt(peers[1], b.result),
        ]);
      } catch (error) {
        throw qualificationFailure(error, { stage: "round_classification", round: index });
      }
      const classified = [classifiedA, classifiedB];
      for (let peerIndex = 0; peerIndex < classified.length; peerIndex += 1) {
        const sample = classified[peerIndex];
        if (sample.stopReason !== "end_turn" || !sample.finalMatched) throw new Error("two_chat_non_exact_or_nonterminal");
        samplesByPeer[peerIndex].push({ ...sample, peerIndex, round: index, counted: true });
      }
      const measuredSoFar = [...samplesByPeer[0], ...samplesByPeer[1]];
      const preSendOverBudget = measuredSoFar.filter((sample) => Number.isFinite(sample.preSendMs) && sample.preSendMs > 250);
      // With exactly 20 measured samples, nearest-rank p95 is the 19th sorted value. Two
      // samples above 250 ms therefore make the unchanged pre-send gate mathematically
      // impossible to pass, so stop instead of consuming the remaining qualification turns.
      if (preSendOverBudget.length >= 2) {
        throw qualificationFailure(new Error("two_chat_pre_send_p95_doomed"), {
          stage: "measured_round",
          round: index,
          measuredSampleCount: measuredSoFar.length,
          preSendOverBudgetCount: preSendOverBudget.length,
          measuredPreSendMs: measuredSoFar.map((sample) => sample.preSendMs),
        });
      }
    }
    const samples = [...samplesByPeer[0], ...samplesByPeer[1]];
    const cleanSamples = samples.filter((sample) => sample.eligibleNoTool === true);
    const rss = await stopSampler();
    const metrics = await Promise.all(peers.map((peer) => readJson(peer.metricsPath)));
    const proof = await Promise.all(peers.map((peer) => sessionProof(cosClient, peer.sessionId, shortNoToolTarget + 1)));
    const policy = await Promise.all(peers.map((peer) => cosClient.requireBackgroundWorkDisabled(peer.sessionId)));
    const latency = summarizeLatency(cleanSamples);
    const perProcessRss = metrics.map((row) => row.rssHighWaterBytes);
    const toolContaminatedTurnCount = samples.length - cleanSamples.length;
    const pass = samplesByPeer.every((rows) => rows.length === shortNoToolTarget) && toolContaminatedTurnCount === 0 &&
      proof.every((row) => row.pass) && policy.every((row) => row.backgroundWork === "disabled" && row.enforced === true) &&
      latency.budgetPass && rss.maxActiveLeases === 2 && perProcessRss.every((value) => value < 256 * 1024 * 1024) && rss.rssSampleCount > 0;
    return { pass, evidence: { schemaVersion: 1, chatCount: 2, turnsPerChat: 10,
      eligibilityProbeAttempt: pairProbeAttempt,
      eligibilityProbe: eligibilityProbe.map((sample, index) => shortAttemptEvidence({ ...sample, counted: false }, index + 1, { peerIndex: index })),
      toolContaminatedTurnCount,
      qualifyingTurnsPerChat: samplesByPeer.map((rows) => rows.filter((sample) => sample.eligibleNoTool === true).length),
      samples: samples.map((sample, index) => shortAttemptEvidence(sample, index + 1, { peerIndex: sample.peerIndex, round: sample.round })),
      latency, sessionProofs: proof, providerPoliciesAttested: policy.every((row) => row.backgroundWork === "disabled" && row.enforced === true),
      maxActiveLeases: rss.maxActiveLeases, maxWaitingLeases: rss.maxWaitingLeases, perProcessBridgeRssHighWaterBytes: perProcessRss,
      aggregateBridgeRssHighWaterBytes: rss.aggregateRssHighWaterBytes, aggregateRssSampleCount: rss.rssSampleCount,
      summedSseConnectCount: metrics.reduce((sum, row) => sum + row.sseConnectCount, 0),
      summedSseReconnectCount: metrics.reduce((sum, row) => sum + row.sseReconnectCount, 0),
      summedBackoffCount: metrics.reduce((sum, row) => sum + row.backoffCount, 0) },
      summary: { turns: samples.length, eligibilityProbeAttempt: pairProbeAttempt, toolContaminatedTurnCount,
        maxActiveLeases: rss.maxActiveLeases, latencyBudgetPass: latency.budgetPass, aggregateBridgeRssHighWaterBytes: rss.aggregateRssHighWaterBytes } };
  } finally { await stopSampler(); await Promise.all(peers.map(closePeer)); }
});
if (twoChat) results.push(twoChat);

const queue = await maybeRunCase("queue-cancel-slot-reuse", async () => {
  const stateDir = await createStateDir("queue-cancel-slot-reuse");
  const peers = [];
  const start = async (label) => { const peer = await startPeer({ label, stateDir, slots: 2, queueCapacity: 2 }); peers.push(peer); return peer; };
  const a = await start("queue-a");
  const b = await start("queue-b");
  const stopSampler = await startRssSampler(peers, stateDir);
  const aTask = safeOutcome(prompt(a, longNoToolPrompt(900)));
  const bTask = safeOutcome(prompt(b, longNoToolPrompt(900)));
  try {
    await waitForLeaseState(stateDir, (state) => state.active.length === 2, 20000);
    const c = await start("queue-cancelled");
    const cTask = safeOutcome(prompt(c, directNoToolPrompt(shortPromptToken("PV1-QUEUED-CANCEL"))));
    await waitForLeaseState(stateDir, (state) => state.active.length === 2 && state.waiting.some((row) => row.lease.sessionId === c.sessionId), 15000);
    const queuedInputBefore = await cosClient.input(c.sessionId);
    await cancelPeer(c);
    const cResult = await cTask;
    const queuedInputAfter = await cosClient.input(c.sessionId);
    const afterCancel = await readLeaseState(stateDir);
    if (queuedInputBefore || queuedInputAfter || !cResult.ok || cResult.result.stopReason !== "cancelled" ||
        afterCancel?.waiting?.some((row) => row.lease.sessionId === c.sessionId)) throw new Error("queued_cancel_did_not_remove_exact_ticket");
    const d = await start("queue-slot-reuse");
    const expectedD = shortPromptToken("PV1-SLOT-REUSE");
    const dTask = safeOutcome(prompt(d, directNoToolPrompt(expectedD), expectedD));
    const queuedD = await waitForLeaseState(stateDir, (state) => state.active.length === 2 && state.waiting.some((row) => row.lease.sessionId === d.sessionId), 15000);
    const firstReleased = await Promise.race([aTask, bTask]);
    if (!firstReleased.ok) throw new Error("first_active_turn_failed");
    const dResult = await dTask;
    const [aResult, bResult] = await Promise.all([aTask, bTask]);
    if (!dResult.ok || dResult.result.stopReason !== "end_turn" || !dResult.result.finalMatched ||
        !aResult.ok || !bResult.ok || aResult.result.stopReason !== "end_turn" || bResult.result.stopReason !== "end_turn") throw new Error("slot_reuse_or_active_turn_failed");
    const rss = await stopSampler();
    const dInput = await cosClient.input(d.sessionId);
    const dProof = await sessionProof(cosClient, d.sessionId, 1);
    const pass = queuedD.active.length === 2 && queuedD.waiting.length === 1 && !queuedInputAfter &&
      dInput?.delivery === "sent" && dProof.pass && rss.maxActiveLeases === 2 && rss.maxWaitingLeases >= 1;
    return { pass, evidence: { schemaVersion: 1, maxActiveLeases: rss.maxActiveLeases, maxWaitingLeases: rss.maxWaitingLeases,
      queuedCancel: { cancelled: cResult.result.stopReason === "cancelled", inputWasNeverSent: !queuedInputBefore && !queuedInputAfter, exactTicketRemoved: true },
      slotReuse: { queuedBeforeRelease: true, acceptedAfterRelease: dInput?.delivery === "sent", finalMatched: dResult.result.finalMatched },
      activeTurnsFinished: true, aggregateBridgeRssHighWaterBytes: rss.aggregateRssHighWaterBytes, aggregateRssSampleCount: rss.rssSampleCount,
      cancelledQueuedSessionKey: hash(c.sessionId).slice(0, 16), reusedSlotSessionKey: hash(d.sessionId).slice(0, 16) },
      summary: { queuedCancelPass: true, slotReusePass: true, maxWaitingLeases: rss.maxWaitingLeases } };
  } finally { await stopSampler(); await Promise.all(peers.map(closePeer)); }
});
if (queue) results.push(queue);

const cancellation = await maybeRunCase("independent-active-cancellation", async () => {
  const stateDir = await createStateDir("independent-active-cancellation");
  const peers = await Promise.all([
    startPeer({ label: "cancel-a", stateDir, slots: 2, queueCapacity: 2 }),
    startPeer({ label: "cancel-b", stateDir, slots: 2, queueCapacity: 2 }),
  ]);
  const stopSampler = await startRssSampler(peers, stateDir);
  let aTask = null;
  let bTask = null;
  try {
    // Warm both browser sessions before the cancellation trial. First-turn/new-chat startup can take
    // tens of seconds in the browser and is a separate qualification concern; this case is intended
    // to prove cancellation isolation once two already-established chats have exact active turns.
    const warmAExpected = shortPromptToken("PV1-CANCEL-WARM-A");
    const warmBExpected = shortPromptToken("PV1-CANCEL-WARM-B");
    const [warmA, warmB] = await Promise.all([
      prompt(peers[0], directNoToolPrompt(warmAExpected), warmAExpected),
      prompt(peers[1], directNoToolPrompt(warmBExpected), warmBExpected),
    ]);
    if (warmA.stopReason !== "end_turn" || !warmA.finalMatched || warmB.stopReason !== "end_turn" || !warmB.finalMatched) {
      throw new Error("cancellation_warmup_failed");
    }

    aTask = safeOutcome(prompt(peers[0], longNoToolPrompt(4000)));
    const aLeaseState = await waitForLeaseState(stateDir, (state) => state.active.some((row) => row.sessionId === peers[0].sessionId), 20000);
    const aLease = aLeaseState.active.find((row) => row.sessionId === peers[0].sessionId);
    if (!aLease?.inputId) throw new Error("active_cancel_a_lease_missing_input");
    const acceptedA = await waitForInputAccepted(cosClient, aLease.inputId, 30000);
    await waitForTurnState(cosClient, peers[0].sessionId, "active", 60000);

    bTask = safeOutcome(prompt(peers[1], longNoToolPrompt(1200)));
    const bothLeaseState = await waitForLeaseState(stateDir, (state) => state.active.length === 2 &&
      state.active.some((row) => row.sessionId === peers[0].sessionId) &&
      state.active.some((row) => row.sessionId === peers[1].sessionId), 20000);
    const bLease = bothLeaseState.active.find((row) => row.sessionId === peers[1].sessionId);
    if (!bLease?.inputId) throw new Error("active_cancel_b_lease_missing_input");
    const acceptedB = await waitForInputAccepted(cosClient, bLease.inputId, 30000);
    await waitForTurnState(cosClient, peers[1].sessionId, "active", 60000);
    const before = await readLeaseState(stateDir);
    const aWasActive = before.active.some((row) => row.sessionId === peers[0].sessionId);
    const bWasActive = before.active.some((row) => row.sessionId === peers[1].sessionId);
    const [activeA, activeB] = await Promise.all([
      cosClient.session(peers[0].sessionId),
      cosClient.session(peers[1].sessionId),
    ]);
    if (activeA.providerTurn?.state !== "active" || activeB.providerTurn?.state !== "active") {
      throw new Error("provider_turns_not_simultaneously_active");
    }
    await cancelPeer(peers[0]);
    const [a, b] = await Promise.all([aTask, bTask]);
    const rss = await stopSampler();
    const aSession = await cosClient.session(peers[0].sessionId);
    const bSession = await cosClient.session(peers[1].sessionId);
    const pass = aWasActive && bWasActive && a.ok && b.ok && a.result.stopReason === "cancelled" &&
      b.result.stopReason === "end_turn" && b.result.toolLikeCount === 0 && bSession.providerTurn?.state === "drained" &&
      aSession.providerTurn?.state === "drained" && rss.maxActiveLeases === 2;
    return { pass, evidence: { schemaVersion: 1, bothWereActiveBeforeCancel: aWasActive && bWasActive,
      warmedExistingSessions: true,
      inputsAcceptedBeforeCancel: [acceptedA.delivery, acceptedB.delivery],
      providerTurnsActiveBeforeCancel: activeA.providerTurn?.state === "active" && activeB.providerTurn?.state === "active",
      cancelledSession: { stopReason: a.ok ? a.result.stopReason : "error", sessionKey: hash(peers[0].sessionId).slice(0, 16) },
      unaffectedSession: { stopReason: b.ok ? b.result.stopReason : "error", finalNonempty: b.ok && b.result.assistantChars > 0, sessionKey: hash(peers[1].sessionId).slice(0, 16) },
      providerTurnsDrained: aSession.providerTurn?.state === "drained" && bSession.providerTurn?.state === "drained",
      maxActiveLeases: rss.maxActiveLeases, aggregateBridgeRssHighWaterBytes: rss.aggregateRssHighWaterBytes, aggregateRssSampleCount: rss.rssSampleCount },
      summary: { independentCancellationPass: pass, maxActiveLeases: rss.maxActiveLeases } };
  } finally {
    await stopSampler();
    await Promise.all(peers.map(stopActiveQualificationTurn));
    await Promise.all(peers.map(closePeer));
  }
});
if (cancellation) results.push(cancellation);

const sse = await maybeRunCase("sse-reconnect-with-two-active", async () => {
  const stateDir = await createStateDir("sse-reconnect-with-two-active");
  const peers = await Promise.all([
    startPeer({ label: "sse-drop-a", stateDir, slots: 2, queueCapacity: 2, dropSseOnce: true }),
    startPeer({ label: "sse-peer-b", stateDir, slots: 2, queueCapacity: 2 }),
  ]);
  const stopSampler = await startRssSampler(peers, stateDir);
  try {
    const expectedA = shortPromptToken("PV1-SSE-A");
    const expectedB = shortPromptToken("PV1-SSE-B");
    const aTask = safeOutcome(prompt(peers[0], directNoToolPrompt(expectedA), expectedA));
    const bTask = safeOutcome(prompt(peers[1], directNoToolPrompt(expectedB), expectedB));
    await waitForLeaseState(stateDir, (state) => state.active.length === 2, 15000);
    const [a, b] = await Promise.all([aTask, bTask]);
    const rss = await stopSampler();
    const fault = await readJson(peers[0].faultEvidencePath);
    const metrics = await readJson(peers[0].metricsPath);
    const proofA = await sessionProof(cosClient, peers[0].sessionId, 1);
    const proofB = await sessionProof(cosClient, peers[1].sessionId, 1);
    const pass = a.ok && b.ok && a.result.stopReason === "end_turn" && b.result.stopReason === "end_turn" &&
      a.result.finalMatched && b.result.finalMatched && proofA.pass && proofB.pass && fault.sseDropPerformed === true &&
      Number.isSafeInteger(fault.afterSeq) && fault.reconnectFrom === fault.afterSeq + 1 &&
      metrics.sseReconnectCount === 1 && metrics.sseConnectCount === 2 && metrics.backoffCount <= 1 && rss.maxActiveLeases === 2;
    return { pass, evidence: { schemaVersion: 1, bothSessionsActiveDuringFaultCase: rss.maxActiveLeases === 2,
      intentionalSseDrop: { performed: fault.sseDropPerformed, afterSeq: fault.afterSeq, reconnectFrom: fault.reconnectFrom },
      reconnectMetrics: { sseConnectCount: metrics.sseConnectCount, sseReconnectCount: metrics.sseReconnectCount, backoffCount: metrics.backoffCount },
      bothFinalsMatched: a.result?.finalMatched === true && b.result?.finalMatched === true, sessionProofs: [proofA, proofB],
      promptOutcomes: [a.ok ? "ok" : a.errorCategory, b.ok ? "ok" : b.errorCategory],
      maxActiveLeases: rss.maxActiveLeases, aggregateBridgeRssHighWaterBytes: rss.aggregateRssHighWaterBytes, aggregateRssSampleCount: rss.rssSampleCount },
      summary: { reconnectPass: pass, sseReconnectCount: metrics.sseReconnectCount, maxActiveLeases: rss.maxActiveLeases } };
  } finally { await stopSampler(); await Promise.all(peers.map(closePeer)); }
});
if (sse) results.push(sse);

const restart = await maybeRunCase("crash-restart-with-two-active", async () => {
  const stateDir = await createStateDir("crash-restart-with-two-active");  const a = await startPeer({ label: "restart-a-before", stateDir, slots: 2, queueCapacity: 2 });
  const b = await startPeer({ label: "restart-b", stateDir, slots: 2, queueCapacity: 2 });
  const peers = [a, b];
  const stopSampler = await startRssSampler(peers, stateDir);
  const aTask = safeOutcome(prompt(a, longNoToolPrompt(1000)));
  const bTask = safeOutcome(prompt(b, longNoToolPrompt(1000)));
  try {
    const active = await waitForLeaseState(stateDir, (state) => state.active.length === 2 &&
      state.active.some((row) => row.sessionId === a.sessionId) && state.active.some((row) => row.sessionId === b.sessionId), 20000);
    // An active lease proves send authority, not that the controller has already durably accepted
    // the POST. Killing in the narrow mark_dispatched -> send gap deliberately creates an
    // ambiguous operation that production must fail closed rather than replay. This case is meant
    // to qualify recovery *after* exact provider acceptance, so wait for both input journals first.
    const [acceptedA, acceptedB] = await Promise.all([
      waitForInputAccepted(cosClient, a.sessionId),
      waitForInputAccepted(cosClient, b.sessionId),
    ]);
    await killPeer(a);
    const crashedPrompt = await aTask;
    const afterCrash = await readLeaseState(stateDir);
    const bStillActiveAfterCrash = Boolean(afterCrash?.active?.some((row) => row.sessionId === b.sessionId));
    await waitForTurnState(cosClient, a.sessionId, "drained", 180000);
    const resumed = await startPeer({ label: "restart-a-after", stateDir, slots: 2, queueCapacity: 2, resumeSessionId: a.sessionId });
    peers.push(resumed);
    const expected = shortPromptToken("PV1-RESTART-RESUMED");
    const resumedTurn = await prompt(resumed, directNoToolPrompt(expected), expected);
    const bResult = await bTask;
    const events = await cosClient.eventHistory(a.sessionId, { from: 0, maxEvents: 2_000 });
    const inputs = events.filter((event) => event.kind === "user_message" && event.inputDelivery === "confirmed");
    const inputIds = inputs.map((event) => event.inputId).filter((value) => typeof value === "string");
    const drained = events.filter((event) => event.kind === "turn_drained");
    const rss = await stopSampler();
    const proof = await sessionProof(cosClient, a.sessionId, 2);
    const pass = active.active.length === 2 && crashedPrompt.ok === false && bStillActiveAfterCrash &&
      resumedTurn.stopReason === "end_turn" && resumedTurn.finalMatched && bResult.ok && bResult.result.stopReason === "end_turn" &&
      proof.pass && new Set(inputIds).size === 2 && drained.length >= 2 && rss.maxActiveLeases === 2;
    return { pass, evidence: { schemaVersion: 1, crashObservedWhileTwoLeasesActive: active.active.length === 2,
      inputsAcceptedBeforeCrash: [acceptedA.delivery, acceptedB.delivery],
      crashedSessionKey: hash(a.sessionId).slice(0, 16), unaffectedSessionKey: hash(b.sessionId).slice(0, 16),
      unaffectedLeaseRetainedAfterCrash: bStillActiveAfterCrash, promptPipeClosedOnCrash: crashedPrompt.ok === false,
      resumeSucceededOnSameSession: resumed.sessionId === a.sessionId, resumedTurnFinalMatched: resumedTurn.finalMatched,
      unaffectedTurnCompleted: bResult.ok && bResult.result.stopReason === "end_turn", confirmedInputCount: inputs.length,
      uniqueInputIdCount: new Set(inputIds).size, drainedTurnCount: drained.length, sessionProof: proof,
      maxActiveLeases: rss.maxActiveLeases, aggregateBridgeRssHighWaterBytes: rss.aggregateRssHighWaterBytes, aggregateRssSampleCount: rss.rssSampleCount },
      summary: { crashRecoveryPass: pass, uniqueInputIdCount: new Set(inputIds).size, maxActiveLeases: rss.maxActiveLeases } };
  } finally { await stopSampler(); await Promise.all(peers.map(closePeer)); }
});
if (restart) results.push(restart);

const stale = await maybeRunCase("cross-session-stale-event", async () => {
  const stateDir = await createStateDir("cross-session-stale-event");
  const staleFixturePath = resolve(outRoot, "faults", "stale-event-fixture.json");
  const b = await startPeer({ label: "stale-target-b", stateDir, slots: 2, queueCapacity: 2, staleEventPath: staleFixturePath });
  const a = await startPeer({ label: "stale-source-a", stateDir, slots: 2, queueCapacity: 2 });
  try {
    const expectedA = shortPromptToken("PV1-STALE-SOURCE");
    const expectedB1 = shortPromptToken("PV1-STALE-B1");
    const first = await Promise.all([
      prompt(a, directNoToolPrompt(expectedA), expectedA),
      prompt(b, directNoToolPrompt(expectedB1), expectedB1),
    ]);
    const expectedB2 = shortPromptToken("PV1-STALE-B2");
    const second = await prompt(b, directNoToolPrompt(expectedB2), expectedB2);
    if (!first.every((row) => row.stopReason === "end_turn" && row.finalMatched) ||
        second.stopReason !== "end_turn" || !second.finalMatched) throw new Error("stale_event_fixture_setup_turn_failed");
    const sourceEvents = await cosClient.eventHistory(a.sessionId, { from: 0, maxEvents: 2_000 });
    const targetEvents = await cosClient.eventHistory(b.sessionId, { from: 0, maxEvents: 2_000 });
    const staleSetup = buildCrossSessionStaleFixture(sourceEvents, targetEvents, a.sessionId);
    if (!staleSetup) throw new SetupInvalid("could_not_prepare_old_cross_session_event");
    const { fixture, sourceEventSequence, targetLastSeq } = staleSetup;
    await fs.mkdir(dirname(staleFixturePath), { recursive: true });
    await fs.writeFile(staleFixturePath, JSON.stringify(fixture) + "\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
    const expectedB3 = shortPromptToken("PV1-STALE-B3");
    const third = await prompt(b, directNoToolPrompt(expectedB3), expectedB3);
    const fault = await readJson(b.faultEvidencePath);
    const finalEvents = await cosClient.eventHistory(b.sessionId, { from: 0, maxEvents: 2_000 });
    const proof = await sessionProof(cosClient, b.sessionId, 3);
    const pass = third.stopReason === "end_turn" && third.finalMatched && third.toolLikeCount === 0 &&
      fault.staleEventInjected === true && fault.staleSeq < targetLastSeq && proof.pass && proof.duplicateSequenceCount === 0;
    return { pass, evidence: { schemaVersion: 1, staleEventInjectedFromOtherSession: fault.staleEventInjected,
      staleEventSequence: fault.staleSeq, sourceEventSequence, targetCursorBeforeInjection: targetLastSeq,
      staleSourceSessionKey: fault.staleSessionKey,
      targetFinalMatched: third.finalMatched, targetSessionProof: proof, targetPersistedEventCount: finalEvents.length,
      targetDuplicateSequenceCount: proof.duplicateSequenceCount },
      summary: { staleEventIgnored: pass, targetFinalMatched: third.finalMatched, duplicateSequenceCount: proof.duplicateSequenceCount } };
  } finally { await Promise.all([closePeer(a), closePeer(b)]); }
});
if (stale) results.push(stale);

const longOutput = await maybeRunCase("long-output-slow-consumer-rss", async () => {
  const stateDir = await createStateDir("long-output-slow-consumer-rss");
  const peer = await startPeer({ label: "long-output-slow", stateDir, slots: 2, queueCapacity: 2, slowConsumer: true });
  const stopSampler = await startRssSampler([peer], stateDir);
  try {
    const result = await prompt(peer, longNoToolPrompt(longOutputWords), null, 240000);
    const rss = await stopSampler();
    const metrics = peer.metrics ?? await readJsonOptional(peer.metricsPath);
    const proof = await sessionProof(cosClient, peer.sessionId, 1);
    const pass = result.stopReason === "end_turn" && result.assistantChars >= 500 && result.toolLikeCount === 0 &&
      proof.pass && Number(metrics?.rssHighWaterBytes) < 256 * 1024 * 1024 && rss.rssSampleCount > 0;
    return { pass, evidence: { schemaVersion: 1, stopReason: result.stopReason, assistantChars: result.assistantChars,
      toolLikeCount: result.toolLikeCount, endToEndMs: result.endToEndMs, preSendMs: result.preSendMs, drainMs: result.drainMs,
      postDrainMs: result.postDrainMs, bridgeRssHighWaterBytes: metrics?.rssHighWaterBytes ?? null,
      aggregateBridgeRssHighWaterBytes: rss.aggregateRssHighWaterBytes, aggregateRssSampleCount: rss.rssSampleCount, sessionProof: proof },
      summary: { longOutputPass: pass, assistantChars: result.assistantChars, bridgeRssHighWaterBytes: metrics?.rssHighWaterBytes ?? null } };
  } finally { await stopSampler(); await closePeer(peer); }
});
if (longOutput) results.push(longOutput);
twoChatStatus = results.every((row) => row.status === "PASS") ? "PASS" : "FAIL";
}

if (includeFour && twoChatStatus === "PASS") {
  const four = await runCase("four-chat-workload", async () => {
    const stateDir = await createStateDir("four-chat-workload");
    const peers = await Promise.all([1, 2, 3, 4].map((number) => startPeer({ label: "four-" + number, stateDir, slots: 4, queueCapacity: 2 })));
    const stopSampler = await startRssSampler(peers, stateDir);
    const samples = [];
    let fifthStreamStatus = 0;
    try {
      for (let index = 1; index <= 10; index += 1) {
        const pending = peers.map((peer, peerIndex) => {
          const expected = shortPromptToken("PV1-FOUR-" + String(peerIndex + 1));
          return safeOutcome(prompt(peer, directNoToolPrompt(expected), expected));
        });
        await waitForLeaseState(stateDir, (state) => state.active.length === 4, 15000);
        if (index === 1) {
          const discoveryNow = await discoverCosController(profile);
          const probe = await fetch(discoveryNow.baseUrl + "/v1/sessions/" + encodeURIComponent(peers[0].sessionId) + "/events/stream?from=0", {
            headers: { Authorization: "Bearer " + discoveryNow.token, Accept: "text/event-stream" }, signal: AbortSignal.timeout(5000),
          }).catch((error) => ({ status: 0, error: errorCategory(error) }));
          fifthStreamStatus = typeof probe.status === "number" ? probe.status : 0;
          if (probe.body) await probe.body.cancel().catch(() => undefined);
        }
        const outcomes = await Promise.all(pending);
        if (outcomes.some((row) => !row.ok)) throw new Error("four_chat_prompt_failed");
        samples.push(...outcomes.map((row) => row.result));
      }
      const rss = await stopSampler();
      const metrics = await Promise.all(peers.map((peer) => readJson(peer.metricsPath)));
      const proofs = await Promise.all(peers.map((peer) => sessionProof(cosClient, peer.sessionId, 10)));
      const latency = summarizeLatency(samples);
      const perProcessRss = metrics.map((row) => row.rssHighWaterBytes);
      const pass = samples.every((sample) => sample.stopReason === "end_turn" && sample.finalMatched && sample.toolLikeCount === 0) &&
        proofs.every((row) => row.pass) && latency.budgetPass && rss.maxActiveLeases === 4 &&
        perProcessRss.every((value) => value < 256 * 1024 * 1024) && rss.rssSampleCount > 0 && fifthStreamStatus === 200;
      return { pass, evidence: { schemaVersion: 1, chatCount: 4, turnsPerChat: 10, latency, sessionProofs: proofs,
        maxActiveLeases: rss.maxActiveLeases, maxWaitingLeases: rss.maxWaitingLeases, perProcessBridgeRssHighWaterBytes: perProcessRss,
        aggregateBridgeRssHighWaterBytes: rss.aggregateRssHighWaterBytes, aggregateRssSampleCount: rss.rssSampleCount,
        fifthStreamStatus, fifthSseProbeFitsAlongsideFourBridgedChats: fifthStreamStatus === 200 },
        summary: { turns: samples.length, maxActiveLeases: rss.maxActiveLeases, latencyBudgetPass: latency.budgetPass, fifthStreamStatus } };
    } finally { await stopSampler(); await Promise.all(peers.map(closePeer)); }
  });
  results.push(four);
} else if (includeFour) {
  const error = new SetupInvalid("two_chat_gate_not_passed");
  await recordCase("four-chat-workload", "SETUP_INVALID", new Date().toISOString(), null, error);
  results.push({ id: "four-chat-workload", status: "SETUP_INVALID", errorCategory: "two_chat_gate_not_passed" });
}

const browserAfter = await controllerMetadata(await discoverCosController(profile)).catch(() => null);
manifest.browserBefore = browserBefore;
manifest.browserAfter = browserAfter;
manifest.finalStatus = results.every((row) => row.status === "PASS") ? "PASS" :
  results.some((row) => row.status === "FAIL") ? "FAIL" : "SETUP_INVALID";
await saveManifest();
process.stdout.write(JSON.stringify({
  status: manifest.finalStatus,
  runId: basename(outRoot),
  cases: results.map((row) => ({ id: row.id, status: row.status, ...(row.result?.summary ? { summary: row.result.summary } : {}), ...(row.errorCategory ? { errorCategory: row.errorCategory } : {}) })),
}) + "\n");
process.exit(manifest.finalStatus === "PASS" ? 0 : manifest.finalStatus === "FAIL" ? 1 : 2);
