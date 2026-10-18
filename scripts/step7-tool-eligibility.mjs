/* global console, process, URL */
import { readFile } from "node:fs/promises";

function eventOrder(event) {
  if (Number.isFinite(event?.position)) return Number(event.position);
  if (Number.isFinite(event?.seq)) return Number(event.seq);
  if (Number.isFinite(event?.time)) return Number(event.time);
  return Number.POSITIVE_INFINITY;
}

export function step7ToolEligibility(events, { inputId, turnId }) {
  const user = events.find((event) =>
    event?.kind === "user_message" && event?.inputId === inputId && event?.inputDelivery === "confirmed",
  );
  const drain = [...events].reverse().find((event) =>
    event?.kind === "turn_drained" && event?.turnId === turnId && event?.inputId === inputId,
  );
  if (!user || !drain) {
    return {
      eligibleNoTool: false,
      reason: "turn_window_unprovable",
      toolLikeCount: 0,
      toolLike: [],
    };
  }

  const start = eventOrder(user);
  const end = eventOrder(drain);
  const toolLike = events.filter((event) => {
    const order = eventOrder(event);
    if (order < start || order > end) return false;
    if (event?.kind === "page_tool") return true;
    return event?.kind === "tool_call" &&
      event?.tool?.attribution === "request_id" &&
      event?.tool?.name === "read";
  });

  return {
    eligibleNoTool: toolLike.length === 0,
    reason: toolLike.length === 0 ? null : "request_owned_read_or_page_tool",
    toolLikeCount: toolLike.length,
    toolLike: toolLike.map((event) => ({
      seq: event.seq ?? null,
      position: event.position ?? null,
      kind: event.kind,
      turnId: event.turnId ?? null,
      name: event.kind === "tool_call" ? event.tool?.name ?? null : null,
      attribution: event.kind === "tool_call" ? event.tool?.attribution ?? null : null,
      label: event.kind === "page_tool" ? event.label ?? null : null,
    })),
  };
}

async function main() {
  const [eventsPath, inputId, turnId] = process.argv.slice(2);
  if (!eventsPath || !inputId || !turnId) {
    console.error("usage: node scripts/step7-tool-eligibility.mjs <events.json> <inputId> <turnId>");
    process.exit(2);
  }
  const parsed = JSON.parse((await readFile(eventsPath, "utf8")).replace(/^\uFEFF/, ""));
  const events = Array.isArray(parsed) ? parsed : parsed.events;
  if (!Array.isArray(events)) throw new TypeError("events JSON must be an array or {events:[...]}");
  process.stdout.write(`${JSON.stringify(step7ToolEligibility(events, { inputId, turnId }))}\n`);
}

if (process.argv[1] && new URL(import.meta.url).pathname.replace(/^\/[A-Za-z]:/, (value) => value.slice(1)).replaceAll("/", "\\").toLowerCase() === process.argv[1].replaceAll("/", "\\").toLowerCase()) {
  await main();
}
