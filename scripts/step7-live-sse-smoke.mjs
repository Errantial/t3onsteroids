/* global AbortController, ReadableStream, Response, TextDecoder, TextEncoder, URL, clearTimeout, fetch, process, setTimeout */
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  controllerMetadata,
  createNewEvidenceRoot,
  evaluateSseReconnectEvidence,
  parseOptions,
  requiredOption,
  writeEvidence,
} from "./step7-live-smoke-lib.mjs";
import { directNoToolPrompt } from "./step7-performance-live-lib.mjs";

function moduleSpecifier(value) {
  return value.startsWith("file:") ? value : pathToFileURL(resolve(value)).href;
}

function completeFrameBoundary(buffer) {
  const lf = buffer.indexOf("\n\n");
  const crlf = buffer.indexOf("\r\n\r\n");
  if (lf < 0 && crlf < 0) return null;
  if (crlf >= 0 && (lf < 0 || crlf < lf)) return { end: crlf + 4, frame: buffer.slice(0, crlf) };
  return { end: lf + 2, frame: buffer.slice(0, lf) };
}

function intentionalDropTransport(observation) {
  let dropped = false;
  return async (input, init) => {
    const url = String(input);
    const response = await fetch(input, init);
    if (dropped || !url.includes("/events/stream") || !response.ok || !response.body) return response;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const body = new ReadableStream({
      async start(controller) {
        let buffer = "";
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) throw new Error("SSE stream ended before a numbered frame could be dropped");
            buffer += decoder.decode(value, { stream: true });
            let boundary;
            while ((boundary = completeFrameBoundary(buffer))) {
              const idMatch = /^id:\s*(\d+)\s*$/m.exec(boundary.frame.replace(/\r/g, ""));
              if (idMatch && /^data:/m.test(boundary.frame.replace(/\r/g, ""))) {
                const afterSeq = Number(idMatch[1]);
                controller.enqueue(new TextEncoder().encode(buffer.slice(0, boundary.end)));
                observation.performed = true;
                observation.afterSeq = afterSeq;
                observation.droppedAtMs = Date.now();
                dropped = true;
                await reader.cancel("step7 intentional SSE drop").catch(() => undefined);
                controller.close();
                return;
              }
              buffer = buffer.slice(boundary.end);
            }
          }
        } catch (error) {
          controller.error(error);
        }
      },
      async cancel(reason) {
        await reader.cancel(reason).catch(() => undefined);
      },
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

const options = parseOptions(process.argv.slice(2));
const profile = requiredOption(options, "profile");
const projectPath = requiredOption(options, "project");
const outRoot = await createNewEvidenceRoot(requiredOption(options, "out-dir"));
const cosModule = moduleSpecifier(options["cos-module"] ?? resolve("dist/cos/index.js"));
const timeoutMs = Number(options["timeout-ms"] ?? 120_000);
if (!Number.isFinite(timeoutMs) || timeoutMs < 1_000) throw new Error("--timeout-ms must be at least 1000");

const { CosControllerClient, discoverCosController } = await import(cosModule);
const beforeDiscovery = await discoverCosController(profile);
const browserBefore = await controllerMetadata(beforeDiscovery);
const drop = { performed: false, afterSeq: null, reconnectFrom: null, droppedAtMs: null };
const streamRequests = [];
const wrappedFetch = intentionalDropTransport(drop);
const client = new CosControllerClient(
  () => discoverCosController(profile),
  {
    fetch: async (input, init) => {
      const url = String(input);
      if (url.includes("/events/stream")) {
        const parsed = new URL(url);
        streamRequests.push(parsed.searchParams.has("from") ? Number(parsed.searchParams.get("from")) : null);
      }
      return wrappedFetch(input, init);
    },
  },
);

const project = await client.resolveProject(projectPath);
const inputId = randomUUID();
const expected = `STEP7-SSE-${randomUUID()}`;
const sent = await client.send({
  id: inputId,
  text: directNoToolPrompt(expected),
  projectId: project.projectId,
  providerPolicy: { backgroundWork: "disabled" },
});
const sessionId = sent.sessionId ?? inputId;
const abort = new AbortController();
const timeout = setTimeout(() => abort.abort(new Error("step7 live SSE smoke timeout")), timeoutMs);
const seqs = [];
const turnEndIds = new Set();
let turnDrainedObserved = false;
let drainTurnId = null;
let finalAssistantSeq = null;
let toolLikeCount = 0;
try {
  for await (const event of client.streamEvents(sessionId, { signal: abort.signal })) {
    seqs.push(event.seq);
    if (/tool|page_tool/.test(event.kind)) toolLikeCount += 1;
    if (event.kind === "turn_end" && event.turnId) turnEndIds.add(event.turnId);
    if (event.kind === "turn_drained" && event.inputId === inputId) {
      turnDrainedObserved = true;
      drainTurnId = typeof event.turnId === "string" ? event.turnId : null;
      finalAssistantSeq = Number.isInteger(event.finalAssistantSeq) ? event.finalAssistantSeq : null;
      break;
    }
  }
} finally {
  clearTimeout(timeout);
  abort.abort();
}

if (drop.performed && streamRequests.length >= 2) drop.reconnectFrom = streamRequests[1];
const finalText = finalAssistantSeq == null ? null : await client.fullAssistantContent(sessionId, finalAssistantSeq);
const afterDiscovery = await discoverCosController(profile);
const browserAfter = await controllerMetadata(afterDiscovery);
const metrics = client.metrics();
const turnEndObserved = drainTurnId !== null && turnEndIds.has(drainTurnId);
const evidence = {
  schemaVersion: 1,
  kind: "step7-live-sse-reconnect-smoke",
  browserBefore,
  browserAfter,
  intentionalDrop: drop,
  metrics,
  eventCount: seqs.length,
  duplicateSeqCount: seqs.length - new Set(seqs).size,
  turnEndObserved,
  turnDrainedObserved,
  finalMatched: finalText === expected,
  toolLikeCount,
};
const evaluation = evaluateSseReconnectEvidence(evidence);
await writeEvidence(resolve(outRoot, "sse-reconnect.json"), { ...evidence, evaluation });
process.stdout.write(`${JSON.stringify({ kind: evidence.kind, pass: evaluation.pass, checks: evaluation.checks })}\n`);
process.exit(evaluation.pass ? 0 : 1);
