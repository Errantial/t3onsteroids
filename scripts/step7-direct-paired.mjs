/* global AbortController, clearTimeout, process, setTimeout */
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  controllerMetadata,
  createNewEvidenceRoot,
  parseOptions,
  requiredOption,
  writeEvidence,
} from "./step7-live-smoke-lib.mjs";
import { analyzeDirectTurn, evaluateDirectPairedEvidence } from "./step7-performance-live-lib.mjs";

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

async function runSample(client, projectId, index, timeoutMs, settleMs) {
  const inputId = randomUUID();
  const expected = `STEP7-DIRECT-${String(index).padStart(2, "0")}-${randomUUID()}`;
  const started = performance.now();
  const sent = await client.send({ id: inputId, text: `Reply exactly: ${expected}`, projectId });
  if (sent.delivery === "not_sent" || sent.delivery === "unconfirmed") throw new Error("direct CoS input was not authoritatively delivered");
  const sessionId = sent.sessionId ?? inputId;
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(new Error("Step 7 direct CoS turn timeout")), timeoutMs);
  let endToEndMs = null;
  try {
    for await (const event of client.streamEvents(sessionId, { signal: abort.signal })) {
      if (event.kind === "turn_end") {
        endToEndMs = performance.now() - started;
        break;
      }
    }
  } finally {
    clearTimeout(timeout);
    abort.abort();
  }
  if (endToEndMs === null) throw new Error("direct CoS turn_end was not observed");
  await delay(settleMs);
  const events = await client.events(sessionId, 0);
  const analysis = analyzeDirectTurn(events, { inputId, expectedText: expected, endToEndMs });
  return {
    index,
    sessionId,
    inputId,
    ...analysis,
  };
}

const options = parseOptions(process.argv.slice(2));
const profile = requiredOption(options, "profile");
const projectPath = resolve(requiredOption(options, "project"));
const outRoot = await createNewEvidenceRoot(requiredOption(options, "out-dir"));
const count = integerOption(options.count, 10, "count", 10);
const timeoutMs = integerOption(options["timeout-ms"], 120_000, "timeout-ms", 5_000);
const settleMs = integerOption(options["settle-ms"], 1_000, "settle-ms", 0);
const cosModule = moduleSpecifier(options["cos-module"] ?? resolve("dist/cos/index.js"));

const { CosControllerClient, discoverCosController } = await import(cosModule);
const client = new CosControllerClient(() => discoverCosController(profile));
const discoveryBefore = await discoverCosController(profile);
const browserBefore = await controllerMetadata(discoveryBefore);
const project = await client.resolveProject(projectPath);
const samples = [];
for (let index = 1; index <= count; index += 1) {
  samples.push(await runSample(client, project.projectId, index, timeoutMs, settleMs));
}
const browserAfter = await controllerMetadata(await discoverCosController(profile));
const evidence = {
  schemaVersion: 1,
  kind: "step7-direct-cos-paired",
  promptClass: "short-exact-reply",
  browserBefore,
  browserAfter,
  samples,
  direct: samples.map((sample) => ({ endToEndMs: sample.endToEndMs })),
};
const evaluation = evaluateDirectPairedEvidence(evidence);
await writeEvidence(resolve(outRoot, "direct-paired.json"), { ...evidence, evaluation });
process.stdout.write(`${JSON.stringify({ kind: evidence.kind, pass: evaluation.pass, count: samples.length, checks: evaluation.checks })}\n`);
process.exit(evaluation.pass ? 0 : 1);
