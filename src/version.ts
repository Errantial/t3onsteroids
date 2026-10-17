import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packagePath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
const packageMetadata = JSON.parse(readFileSync(packagePath, "utf8")) as { version?: unknown };

if (typeof packageMetadata.version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(packageMetadata.version)) {
  throw new Error("package.json contains an invalid bridge version");
}

export const BRIDGE_VERSION = packageMetadata.version;
