/* global process, URL, Response, ReadableStream, TextEncoder, TextDecoder, fetch */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { runProductionAcpStdio } from "../dist/acp/stdio.js";

const qualificationRoot = resolve(process.cwd(), ".local-evidence", "post-v1-concurrency");

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error("Missing required qualification environment");
  return value;
}

function isWithin(root, candidate) {
  const rel = relative(root, candidate);
  return rel !== "" && rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel);
}

const profile = resolve(requiredEnv("T3ONSTEROIDS_COS_USER_DATA_DIR"));
const stateDir = resolve(requiredEnv("T3ONSTEROIDS_STATE_DIR"));
const metricsPath = resolve(requiredEnv("T3ONSTEROIDS_METRICS_PATH"));
if (!isWithin(qualificationRoot, profile) || !isWithin(qualificationRoot, stateDir) ||
    !isWithin(qualificationRoot, metricsPath)) {
  throw new Error("Qualification profile, state and metrics must remain inside the isolated qualification root");
}
if (profile === stateDir || isWithin(profile, stateDir) || isWithin(stateDir, profile)) {
  throw new Error("CoS profile and bridge state must be separate directories");
}

const slots = Number(process.env.POST_V1_QUALIFICATION_SLOTS ?? "1");
const queueCapacity = Number(process.env.POST_V1_QUALIFICATION_QUEUE_CAPACITY ?? (slots === 1 ? "0" : "2"));
if (![1, 2, 4].includes(slots) || !Number.isInteger(queueCapacity) ||
    queueCapacity < 0 || queueCapacity > 8 || (slots === 1 && queueCapacity !== 0) ||
    (slots > 1 && queueCapacity < 1)) {
  throw new Error("Invalid qualification scheduler settings");
}

const dropSseOnce = process.env.POST_V1_QUALIFICATION_DROP_SSE_ONCE === "1";
const staleEventPath = process.env.POST_V1_QUALIFICATION_STALE_EVENT_PATH
  ? resolve(process.env.POST_V1_QUALIFICATION_STALE_EVENT_PATH)
  : null;
const faultEvidencePath = process.env.POST_V1_QUALIFICATION_FAULT_EVIDENCE_PATH
  ? resolve(process.env.POST_V1_QUALIFICATION_FAULT_EVIDENCE_PATH)
  : null;
if ((dropSseOnce || staleEventPath) &&
    (!faultEvidencePath || !isWithin(qualificationRoot, faultEvidencePath) || slots === 1 || (dropSseOnce && staleEventPath))) {
  throw new Error("Qualification fault injection requires a multi-slot run and isolated evidence path");
}
if (staleEventPath && !isWithin(qualificationRoot, staleEventPath)) {
  throw new Error("Stale-event fixture must remain inside the isolated qualification root");
}

const faultEvidence = {
  schemaVersion: 1,
  sseDropRequested: dropSseOnce,
  sseDropPerformed: false,
  afterSeq: null,
  reconnectFrom: null,
  streamRequests: 0,
  staleEventRequested: Boolean(staleEventPath),
  staleEventInjected: false,
  staleSeq: null,
  staleSessionKey: null,
};

async function saveFaultEvidence() {
  if (!faultEvidencePath) return;
  await mkdir(dirname(faultEvidencePath), { recursive: true });
  await writeFile(faultEvidencePath, JSON.stringify(faultEvidence, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
}

function frameBoundary(buffer) {
  const lf = buffer.indexOf("\n\n");
  const crlf = buffer.indexOf("\r\n\r\n");
  if (lf < 0 && crlf < 0) return null;
  if (crlf >= 0 && (lf < 0 || crlf < lf)) return { end: crlf + 4 };
  return { end: lf + 2 };
}

async function readStaleFixture() {
  if (!staleEventPath || faultEvidence.staleEventInjected) return null;
  try {
    const event = JSON.parse(await readFile(staleEventPath, "utf8"));
    if (!Number.isSafeInteger(event.seq) || event.seq < 1 ||
        typeof event.turnId !== "string" || typeof event.inputId !== "string" ||
        typeof event.sessionId !== "string" || event.kind !== "turn_end") {
      throw new Error("Invalid stale-event fixture");
    }
    return event;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return null;
    throw error;
  }
}

function responseWithStaleEvent(response, event) {
  const reader = response.body.getReader();
  const encoder = new TextEncoder();
  const frame = encoder.encode("id: " + event.seq + "\ndata: " + JSON.stringify(event) + "\n\n");
  const body = new ReadableStream({
    async start(controller) {
      controller.enqueue(frame);
      faultEvidence.staleEventInjected = true;
      faultEvidence.staleSeq = event.seq;
      faultEvidence.staleSessionKey = createHash("sha256").update(event.sessionId).digest("hex").slice(0, 16);
      await saveFaultEvidence();
      try {
        for (;;) {
          const result = await reader.read();
          if (result.done) {
            controller.close();
            return;
          }
          controller.enqueue(result.value);
        }
      } catch {
        controller.error(new Error("Qualification stream forwarding failed"));
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => undefined);
    },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

function responseWithDroppedSse(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    async start(controller) {
      let buffer = "";
      try {
        for (;;) {
          const result = await reader.read();
          if (result.done) {
            controller.close();
            return;
          }
          buffer += decoder.decode(result.value, { stream: true });
          let boundary;
          while ((boundary = frameBoundary(buffer))) {
            const frame = buffer.slice(0, boundary.end);
            const normalized = frame.replace(/\r/g, "");
            const idMatch = /^id:\s*(\d+)\s*$/m.exec(normalized);
            if (idMatch && /^data:/m.test(normalized)) {
              controller.enqueue(encoder.encode(frame));
              faultEvidence.sseDropPerformed = true;
              faultEvidence.afterSeq = Number(idMatch[1]);
              await saveFaultEvidence();
              await reader.cancel("post-v1 qualification SSE reconnect").catch(() => undefined);
              controller.close();
              return;
            }
            controller.enqueue(encoder.encode(frame));
            buffer = buffer.slice(boundary.end);
          }
        }
      } catch {
        controller.error(new Error("Qualification SSE stream was interrupted"));
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => undefined);
    },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

function qualificationTransport() {
  return {
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const isStream = url.pathname.endsWith("/events/stream");
      if (isStream) {
        faultEvidence.streamRequests += 1;
        if (faultEvidence.sseDropPerformed && faultEvidence.reconnectFrom === null && url.searchParams.has("from")) {
          const from = Number(url.searchParams.get("from"));
          faultEvidence.reconnectFrom = Number.isInteger(from) ? from : null;
          await saveFaultEvidence();
        }
      }
      const response = await fetch(input, init);
      if (!isStream || !response.ok || !response.body) return response;
      const stale = await readStaleFixture();
      if (stale) return responseWithStaleEvent(response, stale);
      if (dropSseOnce && !faultEvidence.sseDropPerformed) return responseWithDroppedSse(response);
      return response;
    },
  };
}

const env = {
  ...process.env,
  T3ONSTEROIDS_COS_USER_DATA_DIR: profile,
  T3ONSTEROIDS_STATE_DIR: stateDir,
  T3ONSTEROIDS_METRICS_PATH: metricsPath,
};
const qualification = slots === 1
  ? undefined
  : {
      maxConcurrentTurns: slots,
      maxQueuedTurns: queueCapacity,
      ...(dropSseOnce || staleEventPath ? { transport: qualificationTransport() } : {}),
    };
await saveFaultEvidence();
await runProductionAcpStdio({ env, ...(qualification ? { qualification } : {}) });
