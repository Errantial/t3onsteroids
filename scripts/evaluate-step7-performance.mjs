/* global console, process */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const inputPath = process.argv[2];
if (!inputPath) {
  console.error("usage: node scripts/evaluate-step7-performance.mjs <step7-input.json>");
  process.exit(2);
}

const modulePath = resolve("dist/performance-qualification.js");
const { qualifyStep7Performance } = await import(modulePath);
const input = JSON.parse(await readFile(resolve(inputPath), "utf8"));
const result = qualifyStep7Performance(input);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
process.exit(result.pass ? 0 : 1);
