/* global process */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { parseOptions, readJson, requiredOption, writeEvidence } from "./step7-live-smoke-lib.mjs";
import { buildStep7PerformanceInput } from "./step7-performance-live-lib.mjs";

const options = parseOptions(process.argv.slice(2));
const bridgedPath = resolve(requiredOption(options, "bridged-jsonl"));
const directPath = resolve(requiredOption(options, "direct"));
const slowPath = resolve(requiredOption(options, "slow"));
const outPath = resolve(requiredOption(options, "out"));

const bridgedRows = (await readFile(bridgedPath, "utf8"))
  .replace(/^\uFEFF/, "")
  .split(/\r?\n/)
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line));
const [directEvidence, slowEvidence] = await Promise.all([readJson(directPath), readJson(slowPath)]);
const input = buildStep7PerformanceInput({ bridgedRows, directEvidence, slowEvidence });
await writeEvidence(outPath, input);
process.stdout.write(`${JSON.stringify({ bridged: input.bridged.length, direct: input.direct.length, out: outPath })}\n`);
