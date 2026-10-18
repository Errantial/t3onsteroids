/* global fetch */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function parseOptions(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    if (!raw?.startsWith("--")) throw new Error("arguments must use --name value form");
    const name = raw.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for --${name}`);
    result[name] = value;
    index += 1;
  }
  return result;
}

export function requiredOption(options, name) {
  const value = options[name]?.trim();
  if (!value) throw new Error(`missing --${name}`);
  return value;
}

export async function createNewEvidenceRoot(path) {
  const root = resolve(path);
  await mkdir(root, { recursive: false });
  return root;
}

export async function writeEvidence(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export function browserHealthy(snapshot) {
  return snapshot?.connectionState === "connected" && snapshot?.bridgePaired === true && snapshot?.bridgePresent === true;
}

export function summarizeStatus(status) {
  const row = asObject(status);
  const connection = asObject(row.connection);
  const bridge = asObject(row.bridge);
  return {
    connectionState: typeof connection.state === "string" ? connection.state : null,
    bridgePaired: bridge.paired === true,
    bridgePresent: bridge.present === true,
  };
}

export async function controllerMetadata(discovery) {
  const headers = { Authorization: `Bearer ${discovery.token}`, Accept: "application/json" };
  const [statusResponse, inputsResponse] = await Promise.all([
    fetch(`${discovery.baseUrl}/v1/status`, { headers }),
    fetch(`${discovery.baseUrl}/v1/inputs?limit=500`, { headers }),
  ]);
  if (!statusResponse.ok || !inputsResponse.ok) throw new Error("controller metadata read failed");
  const status = summarizeStatus(await statusResponse.json());
  const inputsValue = asObject(await inputsResponse.json());
  const inputs = Array.isArray(inputsValue.inputs) ? inputsValue.inputs : [];
  return { ...status, inputCount: inputs.length };
}

export async function sessionInputCount(discovery, sessionId) {
  const response = await fetch(`${discovery.baseUrl}/v1/inputs?limit=500`, {
    headers: { Authorization: `Bearer ${discovery.token}`, Accept: "application/json" },
  });
  if (!response.ok) throw new Error("controller input read failed");
  const value = asObject(await response.json());
  const inputs = Array.isArray(value.inputs) ? value.inputs : [];
  return inputs.filter((entry) => asObject(entry).sessionId === sessionId).length;
}

export function aggregateBridgeMetrics(...snapshots) {
  const rows = snapshots.filter(Boolean).map(asObject);
  const sum = (key) => rows.reduce((total, row) => total + (Number.isFinite(row[key]) ? row[key] : 0), 0);
  return {
    controllerReadCount: sum("controllerReadCount"),
    controllerActionCount: sum("controllerActionCount"),
    sseConnectCount: sum("sseConnectCount"),
    sseReconnectCount: sum("sseReconnectCount"),
    backoffCount: sum("backoffCount"),
    maxQueueDepth: rows.reduce((max, row) => Math.max(max, Number.isFinite(row.maxQueueDepth) ? row.maxQueueDepth : 0), 0),
    rssHighWaterBytes: rows.reduce((max, row) => Math.max(max, Number.isFinite(row.rssHighWaterBytes) ? row.rssHighWaterBytes : 0), 0),
  };
}

export function evaluateSseReconnectEvidence(evidence) {
  const metrics = asObject(evidence.metrics);
  const drop = asObject(evidence.intentionalDrop);
  const checks = {
    intentionalDrop: drop.performed === true,
    exactCursorResume: Number.isInteger(drop.afterSeq) && drop.reconnectFrom === drop.afterSeq + 1,
    oneReconnect: metrics.sseReconnects === 1 && metrics.sseConnectAttempts === 2,
    boundedBackoff: metrics.sseBackoffs === 1,
    noDuplicateRows: evidence.duplicateSeqCount === 0,
    terminalAndDrain: evidence.turnEndObserved === true && evidence.turnDrainedObserved === true,
    finalMatched: evidence.finalMatched === true,
    noToolActivity: evidence.toolLikeCount === 0,
    browserBefore: browserHealthy(evidence.browserBefore),
    browserAfter: browserHealthy(evidence.browserAfter),
  };
  return { pass: Object.values(checks).every(Boolean), checks };
}

export function evaluateRestartEvidence(evidence) {
  const metrics = asObject(evidence.metrics);
  const checks = {
    supportedMode: evidence.mode === "bridge" || evidence.mode === "provider",
    firstTurn: evidence.firstTurn?.stopReason === "end_turn" && evidence.firstTurn?.finalMatched === true && evidence.firstTurn?.toolLikeCount === 0,
    secondTurn: evidence.secondTurn?.stopReason === "end_turn" && evidence.secondTurn?.finalMatched === true && evidence.secondTurn?.toolLikeCount === 0,
    sameSession: evidence.sameSession === true,
    exactInputDelta: evidence.sessionInputDelta === 2,
    policyBefore: evidence.policyBefore === true,
    policyAfter: evidence.policyAfter === true,
    browserBefore: browserHealthy(evidence.browserBefore),
    browserAfterRestart: browserHealthy(evidence.browserAfterRestart),
    browserAfter: browserHealthy(evidence.browserAfter),
    restartObserved: evidence.mode === "bridge"
      ? evidence.bridgeProcessRestarted === true
      : evidence.providerIdentityChanged === true && evidence.tokenChanged === true,
    noMutationSpin: Number.isFinite(metrics.controllerActionCount) && metrics.controllerActionCount <= 4,
    boundedRecovery: Number.isFinite(metrics.backoffCount) && metrics.backoffCount <= 4 &&
      Number.isFinite(metrics.sseReconnectCount) && metrics.sseReconnectCount <= 2,
  };
  return { pass: Object.values(checks).every(Boolean), checks };
}
